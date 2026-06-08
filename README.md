# Pavia Lebanon

Static boutique storefront for Pavia Lebanon.

## Website config

Edit `js/config.js` to change the visible website name, version, location, description, phone, WhatsApp, Instagram, and footer tagline.

## Data layer

`js/backend.js` is the shared products, orders, statistics, and image interface used by both the storefront and admin page. It currently uses the browser-local provider selected in `js/backend-config.js`, so the included catalog remains available for testing without credentials.

Product uploads are resized, compressed to WebP when supported, and stored locally by content hash. The storefront service worker caches each versioned image separately and only downloads a new version when its hash changes.

## Local launch

Double-click `launch-pavia.bat` to start the local site and open both the storefront and admin dashboard.

## GitHub Pages

This repository includes a GitHub Actions workflow at `.github/workflows/static.yml`.
After pushing to GitHub, enable GitHub Pages with **GitHub Actions** as the source.

The site deploys from the `main` branch.
The workflow builds an explicit `_site` artifact so repository files such as this README, local launchers, notes, and workflow configuration are not published as website pages.
The `.nojekyll` file keeps GitHub Pages in plain static-site mode.
