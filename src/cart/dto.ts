import { Transform, Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, IsIn, IsInt, IsString, Matches, Max, MaxLength, Min, ValidateIf, ValidateNested } from "class-validator";

const trim = () => Transform(({ value }) => (typeof value === "string" ? value.trim() : value));
export const MAX_QTY = 20;
export const MAX_LINES = 40;
const SKU = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// { kind: "product", sku: "TURM-1KG", qty } or { kind: "combo", slug: "gift-hamper", qty },
// the same shape as the store's cart lines.
export class AddLineDto {
  @IsIn(["product", "combo"]) kind: "product" | "combo";
  @ValidateIf((o) => o.kind === "product") @Matches(SKU, { message: "Unknown product size." }) @MaxLength(80) sku?: string;
  @ValidateIf((o) => o.kind === "combo") @Matches(SLUG, { message: "Unknown combo." }) @MaxLength(80) slug?: string;
  @IsInt() @Min(1) @Max(MAX_QTY, { message: `At most ${MAX_QTY} of each item.` }) qty: number;
}

// Lines saved in the browser before carts moved to the server.
export class ImportDto {
  @ValidateNested({ each: true }) @Type(() => AddLineDto) @ArrayMinSize(1) @ArrayMaxSize(MAX_LINES) lines: AddLineDto[];
}

export class SetQtyDto {
  @IsInt() @Min(1) @Max(MAX_QTY, { message: `At most ${MAX_QTY} of each item.` }) qty: number;
}

export class CouponDto {
  @trim() @IsString() @Matches(/^[A-Za-z0-9_-]{3,40}$/, { message: "That code isn't valid. Check the spelling and try again." })
  code: string;
}

export class PincodeDto {
  // null clears it.
  @ValidateIf((o) => o.pincode !== null) @trim() @Matches(/^[1-9]\d{5}$/, { message: "Enter a 6-digit PIN code." }) pincode: string | null;
}
