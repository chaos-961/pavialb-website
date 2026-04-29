# Pavia Elegant Store

A refined, mobile-first boutique storefront for Pavia. Customers browse the
catalog, build a bag, and check out via WhatsApp. Orders are stored locally
so the boutique manager can review them later from a private studio dashboard.

## What's inside

```
pavia_elegant_store/
├─ index.html               ← storefront
├─ admin.html               ← redirects to /admin/
├─ admin/
│  └─ index.html            ← studio dashboard (login + admin)
├─ css/styles.css
├─ js/
│  ├─ products.js           ← catalog + promo codes
│  ├─ app.js                ← storefront logic
│  └─ admin.js              ← studio logic + auth
├─ assets/                  ← logo + product illustrations (SVG)
├─ manifest.webmanifest     ← PWA manifest
├─ service-worker.js        ← offline caching
└─ README.md
```

## Run it locally

The site is fully static — no build step. Serve the folder from any web
server. The simplest is Python:

```bash
cd pavia_elegant_store
python3 -m http.server 8000
```

Then open <http://localhost:8000> in your browser.

> **Tip:** Opening `index.html` directly with `file://` works for browsing,
> but the service worker and the `/admin/` URL route need a real server.

## Accessing the studio (admin)

The admin area is **not linked from anywhere on the site**. To open it,
type the path manually in your browser's URL bar:

```
http://localhost:8000/admin/
```

(Or `https://yoursite.com/admin/` once deployed.)

### Default credentials

| Field    | Value      |
| -------- | ---------- |
| Username | `admin`    |
| Password | `pavia2025` |

Change the password from the **Settings** tab the first time you sign in.

The session lasts only until you close the browser tab — sign in again
each visit. Passwords are stored as a SHA-256 hash in `localStorage`.

> ⚠️ This is a soft client-side gate. It hides the dashboard from casual
> visitors but is not a substitute for a real backend. Don't use it to
> guard sensitive customer data on a public deployment.

## Studio features

- **Overview** — revenue, orders, items sold, subscribers, average order, recent orders feed
- **Products** — add, edit, delete catalog items (name, price, compare-at price, sizes, colors, stock, tags, image path)
- **Orders** — full list of customer orders with items, totals, payment method
- **Settings** — change password, export subscribers as CSV, clear orders, reset catalog

## Storefront features

- Mobile-first responsive layout with bottom nav bar on phones
- Hero with overlapping product cards and announcement marquee
- Sticky filter toolbar with category pills, price range, sale-only and featured-only toggles, multiple sort orders
- Product modal with size/color picker and stock urgency badge
- Cart, wishlist, and order-history drawers
- Recently viewed strip (last 8 products)
- Promo codes and free-shipping threshold
- Toast notifications, animated counters, scroll-reveal animations
- Floating WhatsApp shortcut and back-to-top button
- PWA-ready (installable, offline-capable)

## Configuration

| Setting             | Where                                        | Default                  |
| ------------------- | -------------------------------------------- | ------------------------ |
| WhatsApp number     | `js/app.js` → `WHATSAPP_NUMBER`              | `9613017725`             |
| Free-ship threshold | `js/app.js` → `FREE_DELIVERY_AT`             | `$100`                   |
| Beirut delivery     | `js/app.js` → `DELIVERY_BEIRUT`              | `$3`                     |
| Lebanon delivery    | `js/app.js` → `DELIVERY_LEBANON`             | `$5`                     |
| Promo codes         | `js/products.js` → `window.PAVIA_PROMO_CODES` | `PAVIA10`, `WELCOME15`, `FREESHIP` |
| Admin credentials   | Studio → Settings → Change password           | `admin` / `pavia2025`    |

## Payment options

The checkout offers two payment methods:

- **Cash on delivery** (default)
- **Whish Money**

Card-on-delivery has been removed.

## Promo codes

| Code         | Effect                |
| ------------ | --------------------- |
| `PAVIA10`    | 10% off subtotal      |
| `WELCOME15`  | 15% off subtotal      |
| `FREESHIP`   | Free delivery         |

Edit the list in `js/products.js`.

## Deploying

This is a static site. Any static host works:

- **Netlify / Vercel / GitHub Pages** — drag-and-drop the folder. The
  `/admin/` route resolves automatically because of the `admin/index.html`
  file.
- **Your own server** — point Apache/nginx at the folder.

## Browser support

Modern evergreen browsers: Chrome, Edge, Firefox, Safari (desktop + iOS).
The studio uses `crypto.subtle` for password hashing, which requires HTTPS
or `localhost`.

## License

For Pavia. All rights reserved.
