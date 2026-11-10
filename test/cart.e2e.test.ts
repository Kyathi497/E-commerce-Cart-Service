// End-to-end checks for Phase 3's cart against the running stack
// (`docker compose up --build` in auth-service, api-gateway, catalog-service,
// inventory-service, cart-service, promotion-service and shipping-service),
// then:  pnpm test:e2e
// GATEWAY_URL and AUTH_CONTAINER override the defaults.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { Browser, signedInAdmin, signedInUser } from "./helpers.js";

// Seeded by catalog-service from the old catalog.ts.
const SKU = "TURM-1KG";
const OTHER_SKU = "TURM-500G";

let admin: Browser;

const add = (b: Browser, sku = SKU, qty = 1) => b.call("POST", "/api/v1/cart/items", { kind: "product", sku, qty });

beforeAll(async () => {
  admin = await signedInAdmin();
}, 60_000);

describe("guest cart", () => {
  it("starts empty without creating anything, then keeps lines by cookie", async () => {
    const guest = new Browser();
    const empty = await guest.call("GET", "/api/v1/cart");
    expect(empty.status).toBe(200);
    expect(empty.data.cart).toMatchObject({ lines: [], canCheckout: false, totals: { totalPaise: 0 } });
    expect(guest.cookies.has("tej_cart")).toBe(false);
    expect(empty.headers.get("cache-control")).toBe("private, no-store");

    const added = await add(guest, SKU, 2);
    expect(added.status).toBe(200);
    expect(guest.cookies.has("tej_cart")).toBe(true);
    const line = added.data.cart.lines[0];
    expect(line).toMatchObject({ key: `p:${SKU}`, sku: SKU, qty: 2, status: "ok", stock: expect.stringMatching(/in_stock|low/) });
    expect(added.data.cart.totals.subtotalPaise).toBe(line.unitPaise * 2);
    expect(added.data.cart.totals.shippingPaise).toBeGreaterThanOrEqual(0);

    // Adding again sums, capped at 20.
    expect((await add(guest, SKU, 19)).data.cart.lines[0].qty).toBe(20);
    expect((await guest.call("PATCH", `/api/v1/cart/items/p:${SKU}`, { qty: 3 })).data.cart.lines[0].qty).toBe(3);
    expect((await guest.call("DELETE", `/api/v1/cart/items/p:${SKU}`)).data.cart.lines).toEqual([]);

    // Another browser never sees it.
    expect((await new Browser().call("GET", "/api/v1/cart")).data.cart.lines).toEqual([]);
  });

  it("refuses products the catalog doesn't sell", async () => {
    const guest = new Browser();
    const res = await add(guest, "NOT-A-REAL-SKU");
    expect(res).toMatchObject({ status: 404, data: { code: "NOT_FOUND" } });
    expect((await guest.call("GET", "/api/v1/cart")).data.cart.lines).toEqual([]);
    expect((await add(guest, "bad sku")).status).toBe(422);
  });

  it("imports a cart kept in the browser, dropping what no longer exists", async () => {
    const guest = new Browser();
    const res = await guest.call("POST", "/api/v1/cart/import", {
      lines: [
        { kind: "product", sku: SKU, qty: 1 },
        { kind: "product", sku: "GONE-1KG", qty: 1 },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.data.cart.lines.map((l: { key: string }) => l.key)).toEqual([`p:${SKU}`]);
  });
});

describe("coupons in the cart", () => {
  it("applies a valid code, explains an invalid one, and keeps the cart unchanged", async () => {
    const code = `E2E${randomUUID().slice(0, 8).toUpperCase()}`;
    expect((await admin.call("POST", "/api/v1/admin/coupons", { code, type: "percent", value: 10 })).status).toBe(201);
    const guest = new Browser();
    await add(guest, SKU, 1);

    const applied = await guest.call("POST", "/api/v1/cart/coupon", { code: code.toLowerCase() });
    expect(applied.status).toBe(200);
    const { totals, coupon, lines } = applied.data.cart;
    expect(coupon).toMatchObject({ code, applied: true, discountPaise: Math.floor(lines[0].unitPaise / 10) });
    expect(totals.totalPaise).toBe(totals.subtotalPaise - totals.discountPaise + totals.shippingPaise);

    const wrong = await guest.call("POST", "/api/v1/cart/coupon", { code: "NOT-A-CODE" });
    expect(wrong).toMatchObject({ status: 422, data: { reason: "NOT_FOUND", fields: { code: expect.any(String) } } });
    // The good code is still on the cart.
    expect((await guest.call("GET", "/api/v1/cart")).data.cart.coupon).toMatchObject({ code, applied: true });

    expect((await guest.call("DELETE", "/api/v1/cart/coupon")).data.cart.coupon).toBeNull();
  });

  it("needs something in the cart first", async () => {
    const res = await new Browser().call("POST", "/api/v1/cart/coupon", { code: "ANYTHING" });
    expect(res).toMatchObject({ status: 422, data: { code: "CART_EMPTY" } });
  });
});

describe("delivery", () => {
  it("shows the delivery estimate for a PIN code and blocks undeliverable ones", async () => {
    const guest = new Browser();
    await add(guest);
    const near = await guest.call("PUT", "/api/v1/cart/pincode", { pincode: "520010" });
    expect(near.data.cart).toMatchObject({ pincode: "520010", delivery: { serviceable: true }, canCheckout: true });
    expect(near.data.cart.delivery.message).toMatch(/^Delivers to 520010/);

    const far = await guest.call("PUT", "/api/v1/cart/pincode", { pincode: "999999" });
    expect(far.data.cart).toMatchObject({ delivery: { serviceable: false }, canCheckout: false });
    expect(far.data.cart.notices.map((n: { code: string }) => n.code)).toContain("NOT_DELIVERABLE");

    expect((await guest.call("PUT", "/api/v1/cart/pincode", { pincode: "12345" })).status).toBe(422);
  });

  it("answers the public PIN code check", async () => {
    const res = await new Browser().call("GET", "/api/v1/shipping/serviceability?pincode=520003");
    expect(res).toMatchObject({ status: 200, data: { pincode: "520003", serviceable: true } });
  });
});

describe("signed-in shoppers", () => {
  it("merges the guest cart on sign-in and clears the guest cookie", async () => {
    const { browser: shopper } = await signedInUser();
    await add(shopper, OTHER_SKU, 1);

    // Same person, logged out on another visit, adds more as a guest...
    const guestSession = new Browser();
    await add(guestSession, SKU, 2);
    await add(guestSession, OTHER_SKU, 1);
    // ...then signs in in that browser.
    for (const [name, c] of shopper.cookies) guestSession.cookies.set(name, c);

    const merged = await guestSession.call("POST", "/api/v1/cart/merge");
    expect(merged.status).toBe(200);
    const qty = Object.fromEntries(merged.data.cart.lines.map((l: { sku: string; qty: number }) => [l.sku, l.qty]));
    expect(qty).toEqual({ [OTHER_SKU]: 2, [SKU]: 2 });
    expect(guestSession.cookies.has("tej_cart")).toBe(false);

    // The cart follows the account to another device.
    expect((await shopper.call("GET", "/api/v1/cart")).data.cart.lines).toHaveLength(2);
  }, 30_000);

  it("asks for a fresh session instead of showing the guest cart when the token is gone", async () => {
    const res = await new Browser().call("GET", "/api/v1/cart", undefined, { "x-signed-in": "1" });
    expect(res.status).toBe(401);
  });
});

describe("live prices", () => {
  it("points out a price change until the shopper accepts it", async () => {
    const guest = new Browser();
    await add(guest, OTHER_SKU, 1);
    const product = (await guest.call("GET", "/api/v1/products/turmeric-powder")).data.product;
    let sku = (await admin.call("GET", `/api/v1/admin/products/${product.id}`)).data.product.skus.find(
      (s: { code: string }) => s.code === OTHER_SKU,
    );
    const original = sku.pricePaise as number;
    try {
      // A price can't go above MRP, so the test lowers it by ₹1.
      const changed = await admin.call("PATCH", `/api/v1/admin/skus/${sku.id}`, { version: sku.version, pricePaise: original - 100 });
      expect(changed.status).toBe(200);
      sku = changed.data.product.skus.find((s: { code: string }) => s.code === OTHER_SKU);

      const cart = (await guest.call("GET", "/api/v1/cart")).data.cart;
      expect(cart.lines[0]).toMatchObject({ unitPaise: original - 100, priceChange: { fromPaise: original, toPaise: original - 100 } });
      expect(cart.notices.map((n: { code: string }) => n.code)).toContain("PRICE_CHANGED");

      const accepted = (await guest.call("POST", "/api/v1/cart/prices/accept")).data.cart;
      expect(accepted.lines[0].priceChange).toBeNull();
    } finally {
      await admin.call("PATCH", `/api/v1/admin/skus/${sku.id}`, { version: sku.version, pricePaise: original });
    }
  }, 30_000);
});

describe("combos", () => {
  it("prices a combo like any other line", async () => {
    const guest = new Browser();
    const combo = (await guest.call("GET", "/api/v1/bundles")).data.items[0];
    if (!combo) return; // no combo on sale right now
    const res = await guest.call("POST", "/api/v1/cart/items", { kind: "combo", slug: combo.slug, qty: 1 });
    expect(res.data.cart.lines[0]).toMatchObject({ key: `c:${combo.slug}`, slug: combo.slug, status: "ok", unitPaise: combo.pricePaise });
  });
});
