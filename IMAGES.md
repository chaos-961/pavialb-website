# Pavia — product image hosting (imgbb)

Product images are hosted on **imgbb**. The Studio optimizes each image in the
browser (~300 KB webp) and uploads it to imgbb with a public API key; shoppers
load images from imgbb's CDN (`i.ibb.co`). Chosen because it is free, needs no
credit card, and is reachable from Lebanon (Cloudinary and similar enterprise
hosts geo-block it).

## Setup (already wired)

1. Sign in at **https://imgbb.com** → get the API key from **https://api.imgbb.com/**.
2. Put it in `js/backend-config.js` under `imgbb.apiKey`. (Currently set to
   `REDACTED-IMGBB-KEY`.)
3. The CSP already allows `i.ibb.co` (image delivery) and `api.imgbb.com` (upload).

The API key is **public by design** — it ships in the site's JS. It is not an
account login: the only thing it permits is uploading images to your imgbb
library, so exposing it in a static frontend is acceptable.

## How it works in the Studio

- **Library tab → upload**: the image is cropped/optimized in the browser, then
  uploaded to imgbb. The returned URL + image id are saved to the Firebase RTDB
  library index so the image shows up for reuse across products.
- **Browsing**: the Library reads from the saved RTDB index (works offline / no
  imgbb call needed).
- **Delete**: removes the image from your library index and from any product using
  it. The file itself stays on imgbb (a static site can't call imgbb's delete API)
  — each upload's `delete_url` lets you remove it manually from imgbb if you want.

## Switching hosts later

`js/image-store.js` is the only file that talks to imgbb. Product records store a
vendor-neutral `imageProvider: 'external'` + the host's id as `storageKey`, so
swapping to another image host later means editing just that one file — no changes
to the database rules or the rest of the app.
