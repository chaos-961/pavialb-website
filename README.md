# Pavia Lebanon — Elegant E-commerce Website

A responsive static boutique website built for Pavia. It includes a polished home page, product catalog, cart drawer, wishlist, checkout form, WhatsApp order flow, local product admin, and offline-ready service worker.

## Included features

- Elegant responsive storefront inspired by Pavia's Instagram identity
- Product search, category filtering, size filtering, and sorting
- Quick-view product modal with size, color, quantity, and stock
- Persistent cart using `localStorage`
- Persistent wishlist using `localStorage`
- Checkout form that calculates delivery fee and creates a WhatsApp order message
- Beirut delivery logic, Lebanon delivery logic, and free delivery threshold
- Newsletter capture demo using `localStorage`
- `admin.html` local product manager for demo editing
- Custom SVG logo and product illustrations
- No external dependencies

## How to run

Open `index.html` directly in a browser, or run a local server from this folder:

```bash
python -m http.server 8080
```

Then visit:

```text
http://localhost:8080
```

## Pages

- `index.html` — main storefront
- `admin.html` — local demo admin panel

## Going live

This is a front-end static version. Before using it as a real production shop, connect it to one of these:

- Shopify Storefront API
- WooCommerce
- Medusa.js
- Supabase/Firebase custom backend
- Stripe, Tap Payments, MontyPay, or another supported payment gateway

Update the WhatsApp number in `js/app.js` if needed:

```js
const WHATSAPP_NUMBER = '9613017725';
```

Update delivery prices in `js/app.js`:

```js
const FREE_DELIVERY_AT = 100;
const DELIVERY_BEIRUT = 3;
const DELIVERY_LEBANON = 5;
```

## Product images

The demo uses SVG illustrations stored in `assets/products/`. Replace them with real product photos and update the image paths in `js/products.js` or through the local admin page.
