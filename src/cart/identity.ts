import { createHash, randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { cookieSecure, config } from "../config.js";
import { readCookie } from "../lib/auth-guard/index.js";

// The guest cart cookie (§6.5): a random 128-bit id, httpOnly so scripts
// can't read it. Path=/ so the store's own server routes receive it too.
export const CART_COOKIE = "tej_cart";

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export function readCartToken(req: Request) {
  const token = readCookie(req.headers.cookie, CART_COOKIE);
  return token && /^[A-Za-z0-9_-]{22}$/.test(token) ? token : undefined;
}

export function newCartToken() {
  return randomBytes(16).toString("base64url");
}

export function setCartCookie(res: Response, token: string) {
  res.cookie(CART_COOKIE, token, {
    httpOnly: true,
    secure: cookieSecure,
    sameSite: "lax",
    path: "/",
    maxAge: config.GUEST_CART_DAYS * 24 * 3600 * 1000,
  });
}

export function clearCartCookie(res: Response) {
  res.clearCookie(CART_COOKIE, { httpOnly: true, secure: cookieSecure, sameSite: "lax", path: "/" });
}
