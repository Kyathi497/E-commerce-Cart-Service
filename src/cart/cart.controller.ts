import { Body, Controller, Delete, Get, Header, HttpCode, Param, Patch, Post, Put, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { Public } from "../lib/auth-guard/index.js";
import { CartService, type Ctx } from "./cart.service.js";
import { AddLineDto, CouponDto, ImportDto, PincodeDto, SetQtyDto } from "./dto.js";

const ctx = (req: Request, res: Response): Ctx => ({ req, res });

// Guests and signed-in shoppers alike (§6.5): a valid access token picks the
// user's cart, otherwise the tej_cart cookie picks the guest cart. Every
// answer is the whole live-priced cart.
@Public()
@Controller("cart")
export class CartController {
  constructor(private readonly carts: CartService) {}

  @Get()
  @Header("Cache-Control", "private, no-store")
  get(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.carts.get(ctx(req, res));
  }

  @Delete()
  @Header("Cache-Control", "private, no-store")
  clear(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.carts.clear(ctx(req, res));
  }

  @Post("items")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  add(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() dto: AddLineDto) {
    return this.carts.add(ctx(req, res), dto);
  }

  @Patch("items/:key")
  @Header("Cache-Control", "private, no-store")
  setQty(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Param("key") key: string, @Body() dto: SetQtyDto) {
    return this.carts.setQty(ctx(req, res), key, dto.qty);
  }

  @Delete("items/:key")
  @Header("Cache-Control", "private, no-store")
  remove(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Param("key") key: string) {
    return this.carts.remove(ctx(req, res), key);
  }

  // One-time move of a cart kept in the browser's storage.
  @Post("import")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  import(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() dto: ImportDto) {
    return this.carts.import(ctx(req, res), dto.lines);
  }

  @Post("coupon")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  applyCoupon(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() dto: CouponDto) {
    return this.carts.applyCoupon(ctx(req, res), dto.code);
  }

  @Delete("coupon")
  @Header("Cache-Control", "private, no-store")
  removeCoupon(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.carts.removeCoupon(ctx(req, res));
  }

  @Put("pincode")
  @Header("Cache-Control", "private, no-store")
  setPincode(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() dto: PincodeDto) {
    return this.carts.setPincode(ctx(req, res), dto.pincode);
  }

  @Post("prices/accept")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  acceptPrices(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.carts.acceptPrices(ctx(req, res));
  }

  // After sign-in: fold the guest cart into the user's cart.
  @Post("merge")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  merge(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.carts.merge(ctx(req, res));
  }
}
