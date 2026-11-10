import { HttpException, Injectable } from "@nestjs/common";
import type { Request, Response } from "express";
import { config } from "../config.js";
import type { Prisma } from "../generated/prisma/client.js";
import { unauthenticated } from "../lib/auth-guard/index.js";
import { AppError } from "../lib/common/index.js";
import { logger } from "../logger.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { type AddLineDto, MAX_LINES, MAX_QTY } from "./dto.js";
import { clearCartCookie, hashToken, newCartToken, readCartToken, setCartCookie } from "./identity.js";
import { type CatalogLine, emptyCart, type Kind, lineKey, parcel, parseKey, type PricedCart, pricedCart, type StoredLine } from "./pricing.js";
import { type EvalRequest, Upstream } from "./upstream.js";

type Tx = Prisma.TransactionClient;
type CartRow = Prisma.CartGetPayload<{ include: { lines: true } }>;

// Who is asking: the signed-in shopper (from the access token) and/or the
// guest cart cookie. Set by the controller from the request.
export interface Ctx {
  req: Request;
  res: Response;
}

const withLines = { lines: { orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }] } } satisfies Prisma.CartInclude;

const notInCart = () => new AppError(404, "NOT_IN_CART", "That item isn't in your cart any more.");

@Injectable()
export class CartService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly upstream: Upstream,
  ) {}

  async get(ctx: Ctx) {
    const cart = await this.find(ctx);
    return { cart: cart ? await this.price(cart, ctx) : emptyCart() };
  }

  async add(ctx: Ctx, dto: AddLineDto) {
    const cart = await this.find(ctx, true);
    const line = { kind: dto.kind, ref: (dto.kind === "product" ? dto.sku : dto.slug)!, qty: dto.qty };
    await this.addLines(cart!, [line]);
    const priced = await this.reprice(cart!.id, ctx);
    // Never a line the catalog doesn't know: take it back out.
    if (priced.lines.find((l) => l.key === lineKey(line))?.status === "not_found") {
      await this.prisma.cartLine.deleteMany({ where: { cartId: cart!.id, kind: line.kind, ref: line.ref } });
      throw new AppError(404, "NOT_FOUND", "We couldn't find that product. It may no longer be sold.");
    }
    return { cart: priced };
  }

  // Brings over a cart that was kept in the browser. Lines the catalog no
  // longer knows are dropped.
  async import(ctx: Ctx, lines: AddLineDto[]) {
    const cart = await this.find(ctx, true);
    await this.addLines(cart!, lines.map((l) => ({ kind: l.kind, ref: (l.kind === "product" ? l.sku : l.slug)!, qty: l.qty })), true);
    let priced = await this.reprice(cart!.id, ctx);
    const unknown = priced.lines.filter((l) => l.status === "not_found");
    if (unknown.length) {
      await this.prisma.cartLine.deleteMany({
        where: { cartId: cart!.id, OR: unknown.map((l) => parseKey(l.key)!) },
      });
      priced = await this.reprice(cart!.id, ctx);
    }
    return { cart: priced };
  }

  async setQty(ctx: Ctx, key: string, qty: number) {
    const cart = await this.find(ctx);
    const target = parseKey(key);
    if (!cart || !target) throw notInCart();
    const { count } = await this.prisma.cartLine.updateMany({ where: { cartId: cart.id, ...target }, data: { qty } });
    if (count === 0) throw notInCart();
    return { cart: await this.reprice(cart.id, ctx) };
  }

  async remove(ctx: Ctx, key: string) {
    const cart = await this.find(ctx);
    const target = parseKey(key);
    if (!cart || !target) throw notInCart();
    await this.prisma.cartLine.deleteMany({ where: { cartId: cart.id, ...target } });
    return { cart: await this.reprice(cart.id, ctx) };
  }

  async clear(ctx: Ctx) {
    const cart = await this.find(ctx);
    if (!cart) return { cart: emptyCart() };
    await this.prisma.$transaction([
      this.prisma.cartLine.deleteMany({ where: { cartId: cart.id } }),
      this.prisma.cart.update({ where: { id: cart.id }, data: { couponCode: null } }),
    ]);
    return { cart: emptyCart(cart.pincode) };
  }

  // Saves the code only if it applies; otherwise answers why not (§6.6).
  async applyCoupon(ctx: Ctx, rawCode: string) {
    const code = rawCode.trim().toUpperCase();
    const cart = await this.find(ctx);
    if (!cart || cart.lines.length === 0) {
      throw new AppError(422, "CART_EMPTY", "Add something to your cart first.", { code: "Add something to your cart first." });
    }
    const previous = cart.couponCode;
    await this.prisma.cart.update({ where: { id: cart.id }, data: { couponCode: code } });
    const priced = await this.reprice(cart.id, ctx);
    const result = priced.coupon;
    if (result?.applied) return { cart: priced };

    await this.prisma.cart.update({ where: { id: cart.id }, data: { couponCode: previous } });
    if (!result || result.reason === "UNAVAILABLE") {
      throw new AppError(503, "PROMOTIONS_UNAVAILABLE", "We couldn't check coupons just now. Please try again in a minute.");
    }
    throw new HttpException(
      { error: result.message, code: "COUPON_NOT_APPLICABLE", reason: result.reason, fields: { code: result.message } },
      422,
    );
  }

  async removeCoupon(ctx: Ctx) {
    const cart = await this.find(ctx);
    if (!cart) return { cart: emptyCart() };
    await this.prisma.cart.update({ where: { id: cart.id }, data: { couponCode: null } });
    return { cart: await this.reprice(cart.id, ctx) };
  }

  async setPincode(ctx: Ctx, pincode: string | null) {
    const cart = await this.find(ctx, true);
    await this.prisma.cart.update({ where: { id: cart!.id }, data: { pincode } });
    return { cart: await this.reprice(cart!.id, ctx) };
  }

  // The shopper has seen the new prices: stop pointing them out.
  async acceptPrices(ctx: Ctx) {
    const cart = await this.find(ctx);
    if (!cart || !cart.lines.length) return { cart: emptyCart(cart?.pincode ?? null) };
    const catalog = await this.upstream.price(cart.lines, ctx.req.requestId);
    await this.prisma.$transaction(
      cart.lines.flatMap((l, i) => {
        const c = catalog[i]!;
        return c.status === "ok" ? [this.prisma.cartLine.update({ where: { id: l.id }, data: { seenPaise: c.unitPaise } })] : [];
      }),
    );
    return { cart: await this.reprice(cart.id, ctx) };
  }

  // Signing in merges the guest cart (find does it); this is the explicit call.
  async merge(ctx: Ctx) {
    return this.get(ctx);
  }

  // Guest carts nobody touched for GUEST_CART_DAYS.
  async deleteStaleGuestCarts() {
    const before = new Date(Date.now() - config.GUEST_CART_DAYS * 24 * 3600 * 1000);
    const { count } = await this.prisma.cart.deleteMany({ where: { userId: null, updatedAt: { lt: before } } });
    if (count) logger.info({ deleted: count }, "deleted stale guest carts");
    return count;
  }

  // The shopper's cart, or null. A signed-in shopper who still has a guest
  // cart cookie gets the two merged and the cookie cleared.
  private async find(ctx: Ctx, create = false): Promise<CartRow | null> {
    const user = ctx.req.user;
    // The 15-minute access cookie expires in the browser, so a signed-in
    // shopper's call can arrive with no token at all. The store marks calls
    // it believes are signed in; answering 401 makes it refresh the session
    // and retry, instead of quietly showing the guest cart.
    if (!user && ctx.req.header("x-signed-in") === "1") throw unauthenticated();
    const token = readCartToken(ctx.req);
    const guest = token ? await this.prisma.cart.findUnique({ where: { tokenHash: hashToken(token) }, include: withLines }) : null;

    if (user) {
      if (token) clearCartCookie(ctx.res);
      if (guest && guest.userId === null) return this.mergeInto(user.id, guest);
      const mine = await this.prisma.cart.findUnique({ where: { userId: user.id }, include: withLines });
      if (mine || !create) return mine;
      try {
        return await this.prisma.cart.create({ data: { userId: user.id }, include: withLines });
      } catch (err) {
        // A parallel request created it first.
        if ((err as { code?: string }).code === "P2002") return this.prisma.cart.findUnique({ where: { userId: user.id }, include: withLines });
        throw err;
      }
    }

    if (guest || !create) return guest;
    const fresh = newCartToken();
    const cart = await this.prisma.cart.create({ data: { tokenHash: hashToken(fresh) }, include: withLines });
    setCartCookie(ctx.res, fresh);
    return cart;
  }

  // Sum quantities (capped like today), keep the user's coupon and PIN code
  // if they have them, then drop the guest cart.
  private async mergeInto(userId: string, guest: CartRow): Promise<CartRow> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const mine = await tx.cart.findUnique({ where: { userId }, include: withLines });
        if (!mine) {
          await tx.cart.update({ where: { id: guest.id }, data: { userId, tokenHash: null } });
          return tx.cart.findUniqueOrThrow({ where: { id: guest.id }, include: withLines });
        }
        await this.addLines(mine, guest.lines, true, tx);
        await tx.cart.update({
          where: { id: mine.id },
          data: { couponCode: mine.couponCode ?? guest.couponCode, pincode: mine.pincode ?? guest.pincode },
        });
        await tx.cart.delete({ where: { id: guest.id } });
        logger.info({ lines: guest.lines.length }, "guest cart merged into user cart");
        return tx.cart.findUniqueOrThrow({ where: { id: mine.id }, include: withLines });
      });
    } catch (err) {
      // Two requests merged at once and the other finished first.
      const mine = await this.prisma.cart.findUnique({ where: { userId }, include: withLines });
      if (mine) return mine;
      throw err;
    }
  }

  // Adds quantities to existing lines (capped at MAX_QTY) in one statement
  // per line, so parallel adds never lose a quantity. With `skipOverflow`,
  // lines past MAX_LINES are dropped instead of refused.
  private async addLines(cart: CartRow, lines: { kind: Kind; ref: string; qty: number }[], skipOverflow = false, db: Tx | PrismaService = this.prisma) {
    const have = new Set(cart.lines.map(lineKey));
    let room = MAX_LINES - have.size;
    for (const line of lines) {
      if (!have.has(lineKey(line))) {
        if (room <= 0) {
          if (skipOverflow) continue;
          throw new AppError(422, "CART_FULL", `Your cart can hold up to ${MAX_LINES} different items.`);
        }
        room--;
        have.add(lineKey(line));
      }
      await db.$executeRaw`
        INSERT INTO CartLine (id, cartId, kind, ref, qty, seenPaise, createdAt, updatedAt)
        VALUES (UUID(), ${cart.id}, ${line.kind}, ${line.ref}, ${Math.min(line.qty, MAX_QTY)}, NULL, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)) AS incoming
        ON DUPLICATE KEY UPDATE qty = LEAST(CartLine.qty + incoming.qty, ${MAX_QTY}), updatedAt = UTC_TIMESTAMP(3)`;
    }
    await db.$executeRaw`UPDATE Cart SET updatedAt = UTC_TIMESTAMP(3) WHERE id = ${cart.id}`;
  }

  private async reprice(cartId: string, ctx: Ctx) {
    const cart = await this.prisma.cart.findUniqueOrThrow({ where: { id: cartId }, include: withLines });
    return this.price(cart, ctx);
  }

  // A live-priced cart (§6.5): prices from catalog, stock from inventory,
  // discounts from promotion and shipping from shipping-service.
  private async price(cart: CartRow, ctx: Ctx): Promise<PricedCart> {
    const lines: StoredLine[] = cart.lines;
    if (!lines.length) return emptyCart(cart.pincode);
    const rid = ctx.req.requestId;
    const catalog = await this.upstream.price(lines, rid);

    const ok = lines.flatMap((l, i) => (catalog[i]!.status === "ok" ? [{ line: l, c: catalog[i] as Extract<CatalogLine, { status: "ok" }> }] : []));
    const productIds = [...new Set(ok.flatMap(({ c }) => c.components.map((x) => x.productId)))];
    const gross = ok.reduce((s, { c }) => s + c.lineTotalPaise, 0);
    const { grams, units } = parcel(lines, catalog);
    const quoteFor = (subtotalPaise: number) =>
      this.upstream.quote({ pincode: cart.pincode ?? undefined, subtotalPaise, weightGrams: grams, units }, rid);

    const [levels, firstQuote] = await Promise.all([this.upstream.levels(productIds, rid), ok.length ? quoteFor(gross) : null]);
    let quote = firstQuote;
    let evaluation = null;
    if (ok.length) {
      const request: EvalRequest = {
        lines: ok.map(({ line, c }) => ({
          key: lineKey(line),
          productId: c.productId,
          categoryId: c.categoryId,
          bundleId: c.bundleId,
          qty: line.qty,
          lineTotalPaise: c.lineTotalPaise,
        })),
        shippingPaise: quote?.shippingPaise ?? config.FALLBACK_SHIPPING_PAISE,
        ...(cart.couponCode && { couponCode: cart.couponCode }),
        ...(cart.userId && { userId: cart.userId }),
      };
      evaluation = await this.upstream.evaluate(request, rid);
      // Shipping rules look at the total after discounts ("free over ₹999"),
      // so a discount can change the shipping, and with it a free-shipping saving.
      if (evaluation && evaluation.discountPaise > 0 && quote) {
        const net = await quoteFor(gross - evaluation.discountPaise);
        if (net && net.shippingPaise !== quote.shippingPaise) {
          evaluation = (await this.upstream.evaluate({ ...request, shippingPaise: net.shippingPaise }, rid)) ?? evaluation;
        }
        quote = net ?? quote;
      }
    }

    // First time a line is priced: remember what the shopper saw.
    const unseen = ok.filter(({ line }) => line.seenPaise === null);
    if (unseen.length) {
      await this.prisma.$transaction(
        unseen.map(({ line, c }) => this.prisma.cartLine.updateMany({ where: { cartId: cart.id, kind: line.kind, ref: line.ref, seenPaise: null }, data: { seenPaise: c.unitPaise } })),
      );
    }

    return pricedCart({
      lines,
      catalog,
      levels,
      evaluation,
      couponCode: cart.couponCode,
      quote,
      fallbackShippingPaise: config.FALLBACK_SHIPPING_PAISE,
      pincode: cart.pincode,
    });
  }
}
