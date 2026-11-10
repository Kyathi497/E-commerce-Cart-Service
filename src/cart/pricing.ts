// Builds the priced cart the store shows (§6.5) from what the other services
// answered. No I/O here: cart.service.ts makes the calls and this decides
// what the shopper sees, including what happens when a service is down.

export type Kind = "product" | "combo";

export interface StoredLine {
  kind: Kind;
  ref: string;
  qty: number;
  seenPaise: number | null;
}

// catalog-service POST /internal/price-lines, one entry per line.
export type CatalogLine =
  | {
      status: "ok";
      name: string;
      detail: string;
      unitPaise: number;
      mrpPaise: number;
      lineTotalPaise: number;
      productId: string | null;
      categoryId: string | null;
      bundleId: string | null;
      components: { productId: string; grams: number }[];
    }
  | { status: "not_found" | "unavailable" };

export type Level = "in_stock" | "low" | "out";
export type Stock = Level | "unknown";

// promotion-service POST /internal/promotions/evaluate.
export interface Evaluation {
  discountPaise: number;
  shippingDiscountPaise: number;
  lines: { key: string; discountPaise: number }[];
  offers: { id: string; name: string; description: string | null; discountPaise: number; freeShipping: boolean }[];
  coupon:
    | { code: string; applied: true; description: string | null; discountPaise: number; freeShipping: boolean }
    | { code: string; applied: false; reason: string; message: string }
    | null;
}

// shipping-service POST /internal/shipping/quote.
export interface Quote {
  shippingPaise: number;
  serviceability: {
    pincode: string;
    serviceable: boolean | null;
    codAvailable: boolean;
    minDays: number | null;
    maxDays: number | null;
    message: string;
  } | null;
}

export interface Notice {
  code: "PROMOTIONS_UNAVAILABLE" | "SHIPPING_ESTIMATED" | "STOCK_UNKNOWN" | "PRICE_CHANGED" | "NOT_DELIVERABLE";
  message: string;
}

// The same keys the store already uses for its cart lines.
export const lineKey = (l: { kind: Kind; ref: string }) => (l.kind === "product" ? `p:${l.ref}` : `c:${l.ref}`);

export function parseKey(key: string): { kind: Kind; ref: string } | null {
  const m = /^([pc]):([\w.-]{1,80})$/.exec(key);
  if (!m) return null;
  return { kind: m[1] === "p" ? "product" : "combo", ref: m[2]! };
}

// A line is as available as the scarcest product in it.
export function lineStock(components: { productId: string }[], levels: Record<string, Level> | null): Stock {
  if (!levels) return "unknown";
  const found = components.map((c) => levels[c.productId] ?? "out");
  if (found.includes("out")) return "out";
  if (found.includes("low")) return "low";
  return "in_stock";
}

export interface PricedInput {
  lines: StoredLine[];
  catalog: CatalogLine[];
  levels: Record<string, Level> | null;
  evaluation: Evaluation | null;
  // The coupon code saved on the cart, shown even when it can't be checked.
  couponCode: string | null;
  quote: Quote | null;
  fallbackShippingPaise: number;
  pincode: string | null;
}

export function pricedCart(input: PricedInput) {
  const { lines, catalog, levels, evaluation, quote } = input;
  const discounts = new Map(evaluation?.lines.map((l) => [l.key, l.discountPaise]) ?? []);
  const notices: Notice[] = [];

  const priced = lines.map((stored, i) => {
    const c = catalog[i]!;
    const key = lineKey(stored);
    const identity = { key, kind: stored.kind, ...(stored.kind === "product" ? { sku: stored.ref } : { slug: stored.ref }), qty: stored.qty };
    if (c.status !== "ok") return { ...identity, status: c.status, stock: "out" as Stock, discountPaise: 0, priceChange: null };
    const changed = stored.seenPaise !== null && stored.seenPaise !== c.unitPaise;
    return {
      ...identity,
      status: "ok" as const,
      name: c.name,
      detail: c.detail,
      unitPaise: c.unitPaise,
      mrpPaise: c.mrpPaise,
      lineTotalPaise: c.lineTotalPaise,
      discountPaise: discounts.get(key) ?? 0,
      stock: lineStock(c.components, levels),
      priceChange: changed ? { fromPaise: stored.seenPaise!, toPaise: c.unitPaise } : null,
    };
  });

  const sellable = priced.filter((l) => l.status === "ok");
  const subtotal = sellable.reduce((s, l) => s + (l.lineTotalPaise ?? 0), 0);
  const discount = evaluation?.discountPaise ?? 0;
  const shippingBefore = sellable.length === 0 ? 0 : (quote?.shippingPaise ?? input.fallbackShippingPaise);
  const shippingDiscount = Math.min(evaluation?.shippingDiscountPaise ?? 0, shippingBefore);
  const shipping = shippingBefore - shippingDiscount;

  if (sellable.length && !evaluation) {
    notices.push({ code: "PROMOTIONS_UNAVAILABLE", message: "We couldn't check offers and coupons just now. They'll be applied if they still hold when you check out." });
  }
  if (sellable.length && !quote) {
    notices.push({ code: "SHIPPING_ESTIMATED", message: "Shipping is an estimate right now and will be confirmed at checkout." });
  }
  if (sellable.length && !levels) {
    notices.push({ code: "STOCK_UNKNOWN", message: "We couldn't check stock just now. We'll confirm it when you check out." });
  }
  if (priced.some((l) => l.priceChange)) {
    notices.push({ code: "PRICE_CHANGED", message: "Some prices changed since you added these items." });
  }
  if (quote?.serviceability?.serviceable === false) {
    notices.push({ code: "NOT_DELIVERABLE", message: quote.serviceability.message });
  }

  // A saved code is shown even when promotion-service is down, so the
  // shopper knows it's still there.
  const coupon = evaluation?.coupon
    ? evaluation.coupon.applied
      ? { code: evaluation.coupon.code, applied: true, description: evaluation.coupon.description, discountPaise: evaluation.coupon.discountPaise, freeShipping: evaluation.coupon.freeShipping }
      : { code: evaluation.coupon.code, applied: false, reason: evaluation.coupon.reason, message: evaluation.coupon.message }
    : input.couponCode
      ? { code: input.couponCode, applied: false, reason: "UNAVAILABLE", message: "We couldn't check this code just now." }
      : null;

  const blocked = priced.some((l) => l.status !== "ok" || l.stock === "out") || quote?.serviceability?.serviceable === false;

  return {
    lines: priced,
    coupon,
    offers: (evaluation?.offers ?? []).map(({ name, description, discountPaise, freeShipping }) => ({ name, description, discountPaise, freeShipping })),
    pincode: input.pincode,
    delivery: quote?.serviceability ?? null,
    totals: {
      itemCount: sellable.reduce((n, l) => n + l.qty, 0),
      subtotalPaise: subtotal,
      discountPaise: discount,
      shippingPaise: shipping,
      shippingDiscountPaise: shippingDiscount,
      totalPaise: subtotal - discount + shipping,
    },
    currency: "INR" as const,
    notices,
    canCheckout: sellable.length > 0 && !blocked,
  };
}

export type PricedCart = ReturnType<typeof pricedCart>;

export const emptyCart = (pincode: string | null = null): PricedCart =>
  pricedCart({ lines: [], catalog: [], levels: {}, evaluation: null, couponCode: null, quote: null, fallbackShippingPaise: 0, pincode });

// Grams of raw stock and the number of jars/boxes, for the parcel weight.
export function parcel(lines: StoredLine[], catalog: CatalogLine[]) {
  let grams = 0;
  let units = 0;
  lines.forEach((l, i) => {
    const c = catalog[i]!;
    if (c.status !== "ok") return;
    grams += c.components.reduce((g, x) => g + x.grams, 0) * l.qty;
    units += l.qty;
  });
  return { grams, units };
}
