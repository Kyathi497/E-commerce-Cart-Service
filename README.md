# cart-service

Shopping carts for guests and signed-in shoppers, priced live on every read. Port 4004.

## Run

```sh
docker network create tej-net   # once per machine
docker compose up --build       # service + MySQL (3310)
```

A priced cart asks catalog-service (prices, required), inventory-service (stock), promotion-service
(offers and coupons) and shipping-service (shipping and delivery). If one of the last three is down the cart
still loads, with a notice and a fallback (no discount, `FALLBACK_SHIPPING_PAISE`, stock "unknown").

Hot reload: `docker compose up mysql`, then `pnpm install && pnpm dev` (uses `.env`, see `.env.example`).

## How carts are found

- Guests: the httpOnly `tej_cart` cookie (random 128 bits; only its SHA-256 is stored). Created on the first write.
- Signed in: by user id from the access token, so the cart follows the account across devices.
- A signed-in request that still carries a guest cookie merges the guest cart into the user's (quantities summed,
  capped at 20) and clears the cookie.
- The store sends `x-signed-in: 1` when it thinks someone is signed in; without a valid token that answers 401, so
  the store renews the session instead of showing the guest cart.

Carts are in MySQL only (the plan's Redis layer isn't used). Guest carts untouched for 30 days are deleted.

## API

Every answer is the whole priced cart: `{ cart: { lines, coupon, offers, pincode, delivery, totals, notices, canCheckout } }`.
Line keys are the store's: `p:<SKU>` and `c:<combo-slug>`.

| Endpoint | |
|---|---|
| `GET /api/v1/cart`, `DELETE /api/v1/cart` | read / empty |
| `POST /api/v1/cart/items` `{kind:"product",sku,qty}` or `{kind:"combo",slug,qty}` | add (sums) |
| `PATCH /api/v1/cart/items/:key` `{qty}`, `DELETE /api/v1/cart/items/:key` | change / remove |
| `POST /api/v1/cart/import` `{lines}` | move a cart kept in the browser |
| `POST /api/v1/cart/coupon` `{code}`, `DELETE /api/v1/cart/coupon` | saved only if it applies; 422 says why |
| `PUT /api/v1/cart/pincode` `{pincode}` | shipping quote + delivery estimate |
| `POST /api/v1/cart/prices/accept` | stop flagging changed prices |
| `POST /api/v1/cart/merge` | fold the guest cart in after sign-in |

## Commands

- `pnpm test`: unit tests · `pnpm test:e2e`: end-to-end (whole stack running)
- `pnpm migrate:dev` / `pnpm migrate:deploy`: Prisma migrations

## Shared code

`src/lib/common`, `auth-guard` and `http-client` are shared libraries copied into this service. If you fix a bug in
one, make the same fix in every other service that has a copy.
