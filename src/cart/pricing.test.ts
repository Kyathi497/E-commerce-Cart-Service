import { describe, expect, it } from "vitest";
import { type CatalogLine, type Evaluation, lineStock, parcel, parseKey, pricedCart, type StoredLine } from "./pricing.js";

const TURMERIC = "p-turmeric";
const GHEE = "p-ghee";

const lines: StoredLine[] = [
  { kind: "product", ref: "TURM-1KG", qty: 2, seenPaise: 29900 },
  { kind: "combo", ref: "gift-hamper", qty: 1, seenPaise: 89900 },
];

const catalog: CatalogLine[] = [
  {
    status: "ok",
    name: "Turmeric Powder",
    detail: "1 kg",
    unitPaise: 29900,
    mrpPaise: 29900,
    lineTotalPaise: 59800,
    productId: TURMERIC,
    categoryId: "c-spices",
    bundleId: null,
    components: [{ productId: TURMERIC, grams: 1000 }],
  },
  {
    status: "ok",
    name: "Gift Hamper",
    detail: "2 jars",
    unitPaise: 99900,
    mrpPaise: 149900,
    lineTotalPaise: 99900,
    productId: null,
    categoryId: null,
    bundleId: "b-hamper",
    components: [
      { productId: TURMERIC, grams: 180 },
      { productId: GHEE, grams: 200 },
    ],
  },
];

const evaluation: Evaluation = {
  discountPaise: 15970,
  shippingDiscountPaise: 7000,
  lines: [
    { key: "p:TURM-1KG", discountPaise: 5980 },
    { key: "c:gift-hamper", discountPaise: 9990 },
  ],
  offers: [{ id: "o1", name: "Free shipping over ₹999", description: null, discountPaise: 7000, freeShipping: true }],
  coupon: { code: "TEJ10", applied: true, description: "10% off", discountPaise: 15970, freeShipping: false },
};

const base = {
  lines,
  catalog,
  levels: { [TURMERIC]: "in_stock", [GHEE]: "low" } as const,
  evaluation,
  couponCode: "TEJ10",
  quote: { shippingPaise: 7000, serviceability: null },
  fallbackShippingPaise: 7000,
  pincode: null,
};

describe("line keys", () => {
  it("reads the store's keys and rejects anything else", () => {
    expect(parseKey("p:TURM-1KG")).toEqual({ kind: "product", ref: "TURM-1KG" });
    expect(parseKey("c:gift-hamper")).toEqual({ kind: "combo", ref: "gift-hamper" });
    expect(parseKey("x:TURM")).toBeNull();
    expect(parseKey("p:../etc")).toBeNull();
  });
});

describe("priced cart", () => {
  it("adds up prices, discounts and shipping from the services' answers", () => {
    const cart = pricedCart(base);
    expect(cart.totals).toEqual({
      itemCount: 3,
      subtotalPaise: 159700,
      discountPaise: 15970,
      shippingPaise: 0,
      shippingDiscountPaise: 7000,
      totalPaise: 143730,
    });
    expect(cart.lines[0]).toMatchObject({ key: "p:TURM-1KG", sku: "TURM-1KG", discountPaise: 5980, stock: "in_stock", priceChange: null });
    // The hamper uses ghee, which is running low.
    expect(cart.lines[1]).toMatchObject({ slug: "gift-hamper", stock: "low", priceChange: { fromPaise: 89900, toPaise: 99900 } });
    expect(cart.notices.map((n) => n.code)).toEqual(["PRICE_CHANGED"]);
    expect(cart.canCheckout).toBe(true);
  });

  it("keeps working when promotions, shipping and stock can't be reached", () => {
    const cart = pricedCart({ ...base, evaluation: null, quote: null, levels: null });
    expect(cart.totals).toMatchObject({ discountPaise: 0, shippingPaise: 7000, totalPaise: 159700 + 7000 });
    expect(cart.coupon).toMatchObject({ code: "TEJ10", applied: false, reason: "UNAVAILABLE" });
    expect(cart.lines.every((l) => l.stock === "unknown")).toBe(true);
    expect(cart.notices.map((n) => n.code)).toEqual(["PROMOTIONS_UNAVAILABLE", "SHIPPING_ESTIMATED", "STOCK_UNKNOWN", "PRICE_CHANGED"]);
    expect(cart.canCheckout).toBe(true);
  });

  it("leaves unsold and sold-out lines out of the total and blocks checkout", () => {
    const soldOut = pricedCart({ ...base, levels: { [TURMERIC]: "out", [GHEE]: "in_stock" } });
    expect(soldOut.lines.map((l) => l.stock)).toEqual(["out", "out"]);
    expect(soldOut.canCheckout).toBe(false);

    const gone = pricedCart({ ...base, catalog: [catalog[0]!, { status: "unavailable" }], evaluation: null });
    expect(gone.lines[1]).toMatchObject({ status: "unavailable" });
    expect(gone.totals.subtotalPaise).toBe(59800);
    expect(gone.canCheckout).toBe(false);
  });

  it("blocks checkout when the courier doesn't deliver to the PIN code", () => {
    const quote = {
      shippingPaise: 7000,
      serviceability: { pincode: "999999", serviceable: false, codAvailable: false, minDays: null, maxDays: null, message: "Sorry, we don't deliver to 999999 yet." },
    };
    const cart = pricedCart({ ...base, quote, pincode: "999999" });
    expect(cart.canCheckout).toBe(false);
    expect(cart.notices.at(-1)).toEqual({ code: "NOT_DELIVERABLE", message: "Sorry, we don't deliver to 999999 yet." });
  });

  it("treats a product missing from inventory as out of stock", () => {
    expect(lineStock([{ productId: "new" }], {})).toBe("out");
    expect(lineStock([{ productId: "x" }], null)).toBe("unknown");
  });

  it("weighs the parcel from the raw stock each line uses", () => {
    expect(parcel(lines, catalog)).toEqual({ grams: 2000 + 380, units: 3 });
  });
});
