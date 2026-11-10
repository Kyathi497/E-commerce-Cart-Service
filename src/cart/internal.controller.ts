import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { Type } from "class-transformer";
import { ArrayMaxSize, IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested } from "class-validator";
import { InternalOnly } from "../lib/auth-guard/index.js";
import { AppError } from "../lib/common/index.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { hashToken } from "./identity.js";

export class LookupDto {
  @IsOptional() @IsUUID() userId?: string;
  // The raw tej_cart cookie value; only its hash is stored.
  @IsOptional() @Matches(/^[A-Za-z0-9_-]{22}$/) cartToken?: string;
}

class OrderedLineDto {
  @IsIn(["product", "combo"]) kind: "product" | "combo";
  @IsString() @MaxLength(80) ref: string;
  @IsInt() @Min(1) @Max(1000) qty: number;
}

export class RemoveOrderedDto {
  // Lines changed after this moment are the shopper's new choices: left alone.
  @IsDateString() placedAt: string;
  @IsOptional() @IsString() @MaxLength(40) couponCode: string | null;
  @ValidateNested({ each: true }) @Type(() => OrderedLineDto) @ArrayMaxSize(100) lines: OrderedLineDto[];
}

// order-service (§6.7): checkout reads the stored cart (it prices it again
// itself), and once the order is confirmed what was bought leaves the cart.
@InternalOnly("order-service")
@Controller("internal/carts")
export class InternalCartController {
  constructor(private readonly prisma: PrismaService) {}

  @Post("lookup")
  @HttpCode(200)
  async lookup(@Body() dto: LookupDto) {
    if (!dto.userId && !dto.cartToken) throw new AppError(422, "VALIDATION_FAILED", "Give userId or cartToken.");
    const where = dto.userId ? { userId: dto.userId } : { tokenHash: hashToken(dto.cartToken!) };
    const cart = await this.prisma.cart.findUnique({ where, include: { lines: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } } });
    if (!cart) return { cart: null };
    return {
      cart: {
        id: cart.id,
        lines: cart.lines.map((l) => ({ kind: l.kind, ref: l.ref, qty: l.qty })),
        couponCode: cart.couponCode,
        pincode: cart.pincode,
      },
    };
  }

  // Repeating it is harmless: a line already gone, or changed since the order, is skipped.
  @Post(":id/remove-ordered")
  @HttpCode(200)
  async removeOrdered(@Param("id", new ParseUUIDPipe()) id: string, @Body() dto: RemoveOrderedDto) {
    const placedAt = new Date(dto.placedAt);
    const cart = await this.prisma.cart.findUnique({ where: { id }, include: { lines: true } });
    if (!cart) throw new AppError(404, "NOT_FOUND", "No such cart.");
    await this.prisma.$transaction(async (tx) => {
      for (const ordered of dto.lines) {
        const line = cart.lines.find((l) => l.kind === ordered.kind && l.ref === ordered.ref);
        if (!line || line.updatedAt > placedAt) continue;
        if (line.qty <= ordered.qty) await tx.cartLine.deleteMany({ where: { id: line.id, updatedAt: line.updatedAt } });
        else await tx.cartLine.updateMany({ where: { id: line.id, updatedAt: line.updatedAt }, data: { qty: line.qty - ordered.qty } });
      }
      if (dto.couponCode && cart.couponCode === dto.couponCode) {
        await tx.cart.update({ where: { id }, data: { couponCode: null } });
      }
    });
    return { ok: true };
  }
}
