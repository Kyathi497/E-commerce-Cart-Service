import { loadConfig, nodeEnv } from "./lib/common/index.js";
import { z } from "zod";

// Dev-only default so services agree out of the box; production must set its own.
const DEV_SERVICE_TOKEN_SECRET = "dev-only-service-token-secret-change-me-in-production";

const schema = z
  .object({
    NODE_ENV: nodeEnv,
    PORT: z.coerce.number().int().default(4004),

    DB_HOST: z.string().default("localhost"),
    DB_PORT: z.coerce.number().int().default(3306),
    MYSQL_USER: z.string().min(1),
    MYSQL_PASSWORD: z.string().min(1),
    MYSQL_DATABASE: z.string().min(1),

    // auth-service's public keys, for knowing which shopper is signed in.
    AUTH_JWKS_URL: z.url().default("http://localhost:4001/internal/.well-known/jwks.json"),
    // Shared by every service for service-to-service tokens (§7). At least 32 characters.
    SERVICE_TOKEN_SECRET: z.string().min(32).default(DEV_SERVICE_TOKEN_SECRET),

    // What every GET /cart asks (§6.5): prices, stock, discounts, shipping.
    CATALOG_URL: z.url().default("http://localhost:4002"),
    INVENTORY_URL: z.url().default("http://localhost:4003"),
    PROMOTION_URL: z.url().default("http://localhost:4005"),
    SHIPPING_URL: z.url().default("http://localhost:4008"),
    // Shipping shown when shipping-service can't be reached (§7). Today's flat ₹70.
    FALLBACK_SHIPPING_PAISE: z.coerce.number().int().min(0).default(7000),

    // Guest carts nobody touched for this long are deleted. Signed-in
    // shoppers' carts are kept.
    GUEST_CART_DAYS: z.coerce.number().int().positive().default(30),
    // The tej_cart cookie is Secure (HTTPS only) by default in production.
    COOKIE_SECURE: z.enum(["true", "false"]).optional(),
  })
  .refine((c) => c.NODE_ENV !== "production" || c.SERVICE_TOKEN_SECRET !== DEV_SERVICE_TOKEN_SECRET, {
    message: "SERVICE_TOKEN_SECRET must be set in production",
    path: ["SERVICE_TOKEN_SECRET"],
  });

export const config = loadConfig(schema);
export type Config = typeof config;

export const SERVICE_NAME = "cart-service";
export const cookieSecure = config.COOKIE_SECURE ? config.COOKIE_SECURE === "true" : config.NODE_ENV === "production";
