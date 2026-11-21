# BariFollow

Instagram growth storefront: a static marketing site, a wallet-based store, automatic
order fulfilment through SMM panels, manual UPI top-ups verified by an admin, and a
finance-aware admin dashboard.

Two deployable pieces live in this one repo:

| Piece | What it is | Where it runs |
| --- | --- | --- |
| Landing page | `index.html`, `styles.css`, `script.js`, `assets/` | GitHub Pages (static) or the store server |
| Store + admin | Node 24 server, `node:sqlite`, no runtime dependencies | Railway, Fly, a VPS — anything that runs a container |

When the landing page is served by the store server, `/store/config.js` upgrades every
"Order" button and the "Store" nav link to the real store checkout. On GitHub Pages that
script does not exist, so the same buttons fall back to the WhatsApp number in
`script.js`.

## Stack

- **Node 24** — `node:sqlite` is built in, so there is no `npm install` and no native build.
- **Plain `node:http`** router with server-rendered HTML. No framework, no bundler.
- **SQLite** in WAL mode. Money is stored as integer **paise**; floats never touch a balance.
- Sessions are random tokens stored hashed; CSRF is double-submit (`bf_csrf` cookie +
  `_csrf` field or `x-csrf-token` header).
- Provider API keys are encrypted at rest with AES-256-GCM using `APP_SECRET`.

## Run it locally

```bash
cp .env.example .env      # edit values
npm start                 # http://localhost:3000
```

Development defaults (when `NODE_ENV` is not `production`):

- A mock provider is seeded so orders complete without real credentials.
- An admin is created as `admin@barifollow.local` / `admin12345`.

Both are refused in production: the server will not boot without `ADMIN_EMAIL` /
`ADMIN_PASSWORD`, and the mock provider is only seeded when `SEED_MOCK=1`.

```bash
npm test                  # end-to-end suite against a throwaway database
```

## How the money works

1. **Top-up request.** The customer pays the UPI ID shown on `/store/account`, then
   submits the amount and the UTR. The request is stored as `pending`; no balance moves.
2. **Admin approval.** In **Admin → Top-ups**, after matching the UTR against the bank/UPI
   statement, the admin approves. A `topup` ledger entry credits the wallet. Rejection
   changes nothing in the ledger.
3. **Order.** Checkout debits the wallet in the same transaction that creates the order.
   There is no way to place an order without the balance.
4. **Fulfilment.**
   - Auto packages are dispatched to the selected provider immediately. Failed dispatch
     (no provider, bad key, network error, provider rejection) refunds the full price to
     the wallet automatically.
   - Blue tick is `manual`: the amount is debited, the order sits in `manual_review`, and
     an admin marks it `completed` when the work is done. Meta makes the final call; no
     approval is promised anywhere in the UI.
5. **Provider sync.** Open orders are polled every `SYNC_INTERVAL_MS` (default 2 min). A
   provider `Cancel`/`Refund` status triggers an automatic wallet refund. Admin can also
   sync, complete, or refund any order by hand. Double refunds are refused at the
   transaction level.

Every movement is appended to `wallet_txns`, so the balance is always
`SUM(delta_paise)` for that user — never a mutable column. Admin liability is the sum of
positive customer balances.

## Environment

| Variable | Required | Notes |
| --- | --- | --- |
| `PORT` | no | Default `3000`. |
| `NODE_ENV` | prod | `production` enables Secure cookies, HSTS, and the boot checks. |
| `APP_SECRET` | prod | 32+ random chars. Encrypts provider API keys. Changing it invalidates stored keys. `openssl rand -hex 32` |
| `DATABASE_PATH` | no | Default `./data/barifollow.db`. Put this on a persistent volume. |
| `BASE_URL` | no | Public origin, used in copy and links. |
| `TRUST_PROXY` | behind proxy | Set `1` on Railway/nginx/Caddy so `x-forwarded-for` is used for rate limits. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | prod (first boot) | Creates the first admin. Password 8+ chars. |
| `ADMIN_NAME` | no | Display name for that admin. |
| `UPI_ID` / `UPI_NAME` | yes for top-ups | Shown on the account page and encoded into the `upi://` deep link. |
| `SUPPORT_WHATSAPP` | no | Digits only, default `917877311536`. |
| `AUTO_SYNC` | no | `1` (default) runs the poll loop; `0` disables it. |
| `SYNC_INTERVAL_MS` | no | Default `120000`, floor `15000`. |
| `SEED_MOCK` | no | `1` seeds a mock provider (non-production only). Never set in production. |
| `MOCK_COMPLETE_SECONDS` | no | How long the mock takes to "deliver" (default 20). |

## Provider setup

The adapter speaks the standard SMM-panel API:

```
POST {api_url}   application/x-www-form-urlencoded
key=<api key>&action=add&service=<service id>&link=<profile url>&quantity=<n>
key=<api key>&action=status&order=<provider order id>
key=<api key>&action=balance
```

Setup order:

1. **Admin → Providers** → add the panel name, `https://…/api/v2` URL, API key, priority.
   Lower priority wins when a package has no explicit mapping.
2. **Test** the provider to check the key and read the panel balance.
3. **Admin → Packages** → for each follower package, choose the provider and paste the
   panel's **service ID**, then Save. Packages without a service ID fail closed and refund
   the customer instead of guessing.
4. Leave `active` on for packages you want to sell.

The mock provider is useful for demos and local development; production orders will fail
and refund until a real provider is mapped.

## Deployment

### Railway

`railway.json` + `Dockerfile` are included. Create a project from the repo, then:

1. Add a **volume** mounted at `/app/data` (SQLite must survive deploys).
2. Set the environment variables above — at minimum `NODE_ENV=production`,
   `APP_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `UPI_ID`, `UPI_NAME`, `TRUST_PROXY=1`.
3. Deploy. The health check is `/healthz`.

The container runs as the unprivileged `node` user.

### VPS

```bash
docker build -t barifollow .
docker run -d --name barifollow \
  -p 127.0.0.1:3000:3000 \
  -v /srv/barifollow/data:/app/data \
  --env-file .env \
  --restart unless-stopped \
  barifollow
```

Put Caddy or nginx in front for TLS. Example Caddyfile:

```
barifollow.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

Set `TRUST_PROXY=1` when a reverse proxy terminates TLS.

### Landing page

The static landing deploys to GitHub Pages from `main`. It works standalone: every CTA
opens WhatsApp at `917877311536`. When the same page is served by the store server, the
injected `/store/config.js` rewrites CTAs to `/store/checkout?package=…` and the **Store**
link to `/store`. No duplicate markup, no second landing page.

## Layout

```
index.html, styles.css, script.js   landing page (also served by the app)
public/store.css, store.js          storefront + admin styles and small interactions
public/admin.js                     admin dashboard (vanilla JS)
src/app.js                          HTTP server, security headers, static, routing
src/db.js                           schema, seeds, transactions, audit log
src/auth.js                         scrypt passwords, sessions, registration/login
src/wallet.js                       ledger, top-ups, approval, liability
src/orders.js                       checkout, dispatch, sync, refunds, completion
src/providers.js                    SMM + mock adapters, status mapping, encryption use
src/adminApi.js                     admin JSON APIs
src/pages.js                        storefront, auth, account, order, admin pages
server.js                           entry point, sync loop, graceful shutdown
tests/e2e.test.js                   full flow: register → top-up → order → refund
```

## Security notes

- Passwords: scrypt (N=16384), constant-time verification, dummy hash for unknown emails.
- Sessions: 32-byte random tokens, SHA-256 stored, HttpOnly `bf_sid`, 30-day expiry,
  Secure in production.
- CSRF: every non-GET request requires a matching double-submit token.
- Rate limits on login, registration, top-ups, checkout, and sync.
- All SQL is parameterized; HTML passes through `esc()`.
- CSP, `X-Frame-Options: DENY`, `nosniff`, strict referrer policy, no inline third-party
  scripts. Google Fonts is the only external origin.
- Admin actions write to an append-only `audit` table.
- Raw UPI UTRs are stored because they are needed for reconciliation; they are never shown
  to other customers.

This is a real payment-adjacent service: keep `APP_SECRET` and the database volume backed
up, and reconcile top-ups against the actual bank statement before approving.
