import { Injectable } from "@nestjs/common";
import { config, SERVICE_NAME } from "../config.js";
import { AppError } from "../lib/common/index.js";
import { HttpClient } from "../lib/http-client/index.js";
import { logger } from "../logger.js";
import type { CatalogLine, Evaluation, Level, Quote, StoredLine } from "./pricing.js";

const client = (target: string, baseUrl: string) =>
  new HttpClient({ target, baseUrl, serviceToken: { secret: config.SERVICE_TOKEN_SECRET, from: SERVICE_NAME } });

export interface EvalRequest {
  lines: { key: string; productId: string | null; categoryId: string | null; bundleId: string | null; qty: number; lineTotalPaise: number }[];
  shippingPaise: number;
  couponCode?: string;
  userId?: string;
}

// The four services a priced cart needs (§6.5). Catalog is the only one the
// cart can't do without; the others degrade to "unknown" (§7).
@Injectable()
export class Upstream {
  private readonly catalog = client("catalog-service", config.CATALOG_URL);
  private readonly inventory = client("inventory-service", config.INVENTORY_URL);
  private readonly promotion = client("promotion-service", config.PROMOTION_URL);
  private readonly shipping = client("shipping-service", config.SHIPPING_URL);

  async price(lines: StoredLine[], requestId?: string): Promise<CatalogLine[]> {
    try {
      const res = await this.catalog.post<{ lines: CatalogLine[] }>(
        "/internal/price-lines",
        { lines: lines.map((l) => ({ type: l.kind === "product" ? "sku" : "bundle", ref: l.ref, qty: l.qty })) },
        { requestId },
      );
      if (res.status !== 200) throw new Error(`price-lines answered ${res.status}`);
      return res.data.lines;
    } catch (err) {
      logger.error({ err, requestId }, "catalog pricing failed");
      throw new AppError(503, "PRICES_UNAVAILABLE", "We couldn't load today's prices. Your cart is saved; please try again in a minute.");
    }
  }

  // in_stock / low / out per product, or null if inventory can't be reached.
  async levels(productIds: string[], requestId?: string): Promise<Record<string, Level> | null> {
    if (!productIds.length) return {};
    try {
      const res = await this.inventory.post<{ items: Record<string, Level> }>(
        "/api/v1/availability",
        { products: productIds },
        { requestId },
      );
      if (res.status !== 200) throw new Error(`availability answered ${res.status}`);
      return res.data.items;
    } catch (err) {
      logger.warn({ err, requestId }, "stock check failed; showing stock as unknown");
      return null;
    }
  }

  async evaluate(body: EvalRequest, requestId?: string): Promise<Evaluation | null> {
    try {
      const res = await this.promotion.post<Evaluation>("/internal/promotions/evaluate", body, { requestId });
      if (res.status !== 200) throw new Error(`evaluate answered ${res.status}`);
      return res.data;
    } catch (err) {
      logger.warn({ err, requestId }, "promotion check failed; cart shown without discounts");
      return null;
    }
  }

  async quote(body: { pincode?: string; subtotalPaise: number; weightGrams: number; units: number }, requestId?: string): Promise<Quote | null> {
    try {
      const res = await this.shipping.post<Quote>("/internal/shipping/quote", body, { requestId });
      if (res.status !== 200) throw new Error(`quote answered ${res.status}`);
      return res.data;
    } catch (err) {
      logger.warn({ err, requestId }, "shipping quote failed; using the fallback rate");
      return null;
    }
  }
}
