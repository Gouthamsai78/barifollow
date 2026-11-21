# BariFollow

Instagram growth storefront — a landing page and a package store, built as plain
**HTML, CSS and JavaScript** and deployed on **GitHub Pages**. No build step, no framework,
no backend required.

| Piece | Files | URL |
| --- | --- | --- |
| Landing page | `index.html`, `styles.css`, `script.js`, `assets/` | `/` |
| Store + checkout | `store/index.html`, `store/store.css`, `store/store.js` | `/store/` |

Every package CTA on the landing page deep-links to the store:
`store/?package=followers-5k`. The store opens that package's checkout, takes the
customer's public Instagram username, and hands the order to WhatsApp with the package,
price and username already filled in. Payment (UPI) is confirmed in the chat.

There is also an optional Node 24 backend in `src/` for a wallet/order engine with UPI
top-ups and an admin dashboard. It is not used by GitHub Pages; see
[Optional backend](#optional-backend) at the end.

## Deploy on GitHub Pages

The repository is already set up for Pages: deploy from branch `main`, folder `/ (root)`.

1. Push `index.html`, `styles.css`, `script.js`, `assets/`, `store/` and `public/`.
2. In **Settings → Pages**, set **Source** to *Deploy from a branch*, branch `main`,
   folder `/ (root)`.
3. The site is served at `https://<user>.github.io/<repo>/`:
   - landing: `https://<user>.github.io/<repo>/`
   - store: `https://<user>.github.io/<repo>/store/`

All store URLs are relative, so the same files work at a domain root or under a project
path. To publish elsewhere, copy the whole folder to any static host.

### Test the static build locally

```bash
python3 -m http.server 4173
# landing → http://localhost:4173/
# store   → http://localhost:4173/store/
```

## The store

- Packages and prices live in one array at the top of `store/store.js`; the cards are
  rendered from it.
- `?package=<slug>` opens checkout directly — the landing page uses this for every price
  row and the blue tick card.
- The username is validated as an Instagram handle before anything opens.
- **Continue on WhatsApp** opens `wa.me/917877311536` with a prefilled message containing
  the package, price and `@username`. The customer sends it; you reply with the UPI ID and
  confirm the amount.
- If JavaScript is unavailable, every card still has a direct prefilled WhatsApp link.

Current packages: 5K ₹180 · 10K ₹280 · 20K ₹380 · 50K ₹580 · 100K ₹780 · 500K ₹1,100 ·
blue tick ₹669 (manual review; Meta decides approval).

## Editing

| Change | Where |
| --- | --- |
| WhatsApp number | `WHATSAPP_NUMBER` in `script.js` and `store/store.js` |
| Prices, package names, taglines | `PACKAGES` in `store/store.js` |
| Landing price rows | `index.html` (`.board__row` blocks) and `style` copy |
| Store copy / steps | `store/index.html` |
| Design tokens | `styles.css` (landing) and `public/store.css` (store) |
| Proof images | `assets/` |

The landing's `[data-store]` links are upgraded by `script.js`: by default they point at
`store/`; if the optional backend serves the page, `/store/config.js` sets
`window.BF_STORE_BASE` and they point at the server checkout instead.

## Browser support

Chromium, Firefox and Safari (current versions). The store needs JavaScript only for the
package cards and checkout panel; the WhatsApp fallbacks work without it. Reduced-motion
and keyboard focus states are respected.

## Optional backend

`server.js`, `src/`, `public/` and `tests/` contain a dependency-free Node 24 + SQLite
wallet/order engine: accounts, UPI top-up requests with admin approval, wallet ledger,
provider dispatch, auto-refunds, manual blue-tick fulfilment, and an admin dashboard.

Run it:

```bash
cp .env.example .env
npm start        # http://localhost:3000  (store at /store, admin at /store/admin)
npm test         # 16 end-to-end checks
```

It ships with a `Dockerfile` and `railway.json`. This backend is **not** deployable on
GitHub Pages — Pages serves static files only. It is here for when you want real accounts,
wallet balances and an operations dashboard on Railway or a VPS. Until then, the static
store plus WhatsApp is the live product.

Backend notes:

- Money is stored as integer paise; balances are derived from an append-only ledger.
- Top-ups credit only after an admin matches the UTR against the bank statement.
- Orders debit the wallet in the same transaction; failed dispatch refunds automatically.
- Provider keys are encrypted at rest with AES-256-GCM using `APP_SECRET`.
- Production boot requires `APP_SECRET` (32+ chars) and an admin account.
- Deployment: Railway (`railway.json`, volume at `/app/data`) or `docker run` on a VPS.
  See `.env.example` for the full environment contract.

## Layout

```
index.html, styles.css, script.js   landing page
store/index.html                    static store + checkout
store/store.css                     store-only additions
store/store.js                      packages, checkout, WhatsApp handoff
public/store.css                    shared store design system
public/store.js, public/admin.js    optional backend assets
src/                                optional Node backend
tests/e2e.test.js                   backend end-to-end suite
Dockerfile, railway.json            optional backend deployment
```

BariFollow is an independent service. Not affiliated with, endorsed by, or sponsored by
Instagram or Meta Platforms, Inc. Results vary by account. Blue tick approval is decided
by Meta and cannot be guaranteed.
