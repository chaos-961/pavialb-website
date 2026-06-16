# Pavia Lebanon

Static boutique storefront for Pavia Lebanon.

## Website config

Edit `js/config.js` to change the visible website name, version, location, description, phone, WhatsApp, Instagram, and footer tagline.

## Data layer

`js/backend.js` provides the browser-local implementation. `js/backend-firebase.js`
wraps it with an Anonymous Auth plus Realtime Database provider while preserving
the local implementation as an automatic fallback.

The committed default remains `provider: 'local'`. On localhost, append
`?backend=firebase` to use the Firebase emulators after starting and seeding
them.

Firebase Storage is intentionally not required for the current no-paid-plan setup.
Products can use local preset image IDs from `js/image-catalog.js` and `assets/placeholders/`, or a future externally hosted image URL.
When a permanent image host is chosen later, product records should only need their `imageUrl` or resolver mapping updated.

Product uploads in the current local admin remain browser-local convenience behavior for testing. They should not be treated as production image hosting.

## Local launch

Double-click `launch-pavia.bat` to start the local site and open both the storefront and admin dashboard.

## Firebase development

Firebase Anonymous Auth and Realtime Database emulator setup is documented in
[`docs/FIREBASE-SETUP.md`](docs/FIREBASE-SETUP.md).

Firebase-mode admin writes require both the encrypted local admin unlock and an
anonymous UID allowlisted in Realtime Database. Firebase Hosting and Firebase
Storage are not used.

Admin security setup and payload regeneration are documented in
[`docs/ADMIN-SECURITY.md`](docs/ADMIN-SECURITY.md).

Daily product, order, settings, and promo-code workflows are documented in
[`docs/ADMIN-OPERATIONS.md`](docs/ADMIN-OPERATIONS.md).

GitHub Pages deployment, rollback, and the deferred Namecheap/Cloudflare domain
launch plan are documented in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## GitHub Pages

This repository includes a GitHub Actions workflow at `.github/workflows/static.yml`.
After pushing to GitHub, enable GitHub Pages with **GitHub Actions** as the source.

The site deploys from the `main` branch.
The workflow runs syntax and Firebase emulator smoke checks before deployment.
It builds an explicit `_site` artifact so repository files such as this README,
local launchers, notes, and workflow configuration are not published as website pages.
The `.nojekyll` file keeps GitHub Pages in plain static-site mode.

Local artifact checks:

```powershell
npm run pages:build
npm run pages:check
```
