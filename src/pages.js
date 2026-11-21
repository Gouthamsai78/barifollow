import {
  esc,
  inr,
  displayDate,
  parseMoney,
  HttpError,
  sendHtml,
  redirect,
  safeNext,
  rateLimit,
  clientIp,
} from "./util.js";
import {
  authenticate,
  createSession,
  destroySession,
  registerUser,
} from "./auth.js";
import {
  listActivePackages,
  getPackageBySlug,
  placeOrder,
  listOrdersForUser,
  getOrderByPublicId,
  orderPublic,
  syncOrder,
} from "./orders.js";
import {
  balanceOf,
  createTopup,
  listTopupsForUser,
  listWalletTxns,
  TOPUP_MIN_PAISE,
  TOPUP_MAX_PAISE,
} from "./wallet.js";
import { audit } from "./db.js";

const SUPPORT = process.env.SUPPORT_WHATSAPP || "917877311536";
const UPI_ID = process.env.UPI_ID || "";
const UPI_NAME = process.env.UPI_NAME || "BariFollow";

/* ── copy ──────────────────────────────────────────────────────────────── */

const OK_MSG = {
  topup_submitted:
    "Top-up submitted. We verify the UTR by hand and credit your wallet — usually within a few minutes.",
  order_placed: "Order placed. Delivery starts automatically; this page tracks it.",
  order_refunded:
    "We couldn't start that order, so the full amount was returned to your wallet automatically.",
  status_refreshed: "Status refreshed from the provider.",
  logged_out: "Signed out.",
  welcome: "Account created. Top up your wallet to place your first order.",
  welcome_back: "Signed in.",
};

const ERR_MSG = {
  insufficient: "Not enough wallet balance. Add funds below, then try again.",
  invalid: "That email and password combination didn't work.",
  invalid_input: "Check the form and try again.",
  invalid_username: "That Instagram username doesn't look right.",
  invalid_amount: "Enter an amount between ₹10 and ₹50,000.",
  invalid_utr: "Enter the 8–24 character UTR from your UPI app.",
  duplicate_utr: "That UTR has already been submitted. Check your top-up history.",
  exists: "An account with that email already exists — sign in instead.",
  rate_limited: "Too many attempts. Wait a minute and try again.",
  forbidden: "You don't have access to that page.",
  package_missing: "That package is no longer available.",
  sync_failed: "Couldn't reach the provider just now. We'll retry automatically.",
  auth_required: "Sign in to continue.",
  not_found: "That order wasn't found.",
};

const STATUS = {
  queued: { label: "Queued", cls: "is-wait" },
  submitted: { label: "Submitted", cls: "is-live" },
  in_progress: { label: "In progress", cls: "is-live" },
  completed: { label: "Completed", cls: "is-done" },
  partial: { label: "Partial", cls: "is-warn" },
  manual_review: { label: "Manual review", cls: "is-warn" },
  refunded: { label: "Refunded", cls: "is-muted" },
  cancelled: { label: "Cancelled", cls: "is-muted" },
  failed: { label: "Failed", cls: "is-bad" },
};

function statusPill(status) {
  const s = STATUS[status] || { label: status, cls: "is-muted" };
  return `<span class="pill ${s.cls}">${esc(s.label)}</span>`;
}

const nf = new Intl.NumberFormat("en-IN");

function per1k(pricePaise, quantity) {
  const qty = Number(quantity);
  if (!qty || qty < 100) return null;
  return inr(Math.round((Number(pricePaise) * 1000) / qty));
}

function csrfField(ctx) {
  return `<input type="hidden" name="_csrf" value="${esc(ctx.csrf)}">`;
}

function flashHtml(ctx) {
  const ok = OK_MSG[ctx.url.searchParams.get("msg")];
  const err = ERR_MSG[ctx.url.searchParams.get("err")];
  return (
    (ok ? `<div class="flash flash--ok" role="status">${esc(ok)}</div>` : "") +
    (err ? `<div class="flash flash--err" role="alert">${esc(err)}</div>` : "")
  );
}

function loginHref(ctx) {
  return `/store/login?next=${encodeURIComponent(ctx.url.pathname + ctx.url.search)}`;
}

function waLink(message) {
  return `https://wa.me/${SUPPORT}?text=${encodeURIComponent(message)}`;
}

function brandMark(size = 30) {
  return `<svg class="brand__mark" width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true">
    <rect width="32" height="32" rx="9" fill="#d2ff57"/>
    <path d="M10 22 22 10M22 10h-8M22 10v8" stroke="#0a0a0b" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  </svg>`;
}

/* ── layout ────────────────────────────────────────────────────────────── */

function layout(ctx, { title, body, active = "", wide = false, scripts = "" }) {
  const user = ctx.user;
  const balance = user ? ctx.balance ?? balanceOf(user.id) : null;
  const year = new Date().getFullYear();

  const side = user
    ? `<a class="wallet-chip" href="/store/account" title="Wallet balance">
         <span>Wallet</span><strong>${inr(balance)}</strong>
       </a>
       <a class="toplink ${active === "account" ? "is-on" : ""}" href="/store/account">Account</a>
       ${user.role === "admin" ? `<a class="toplink ${active === "admin" ? "is-on" : ""}" href="/store/admin">Admin</a>` : ""}
       <form method="post" action="/store/logout" class="inline-form">
         ${csrfField(ctx)}
         <button class="toplink topbtn" type="submit">Sign out</button>
       </form>`
    : `<a class="toplink" href="/store/login">Sign in</a>
       <a class="btn btn--lime btn--sm" href="/store/register">Create account</a>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — BariFollow</title>
<meta name="theme-color" content="#0a0a0b">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='9' fill='%23d2ff57'/%3E%3Cpath d='M10 22 22 10M22 10h-8M22 10v8' stroke='%230a0a0b' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round' fill='none'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter+Tight:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/store.css">
<script src="/store.js" defer></script>
</head>
<body class="store-body">

<header class="topbar">
  <div class="shell topbar__in">
    <a class="brand" href="/" aria-label="BariFollow home">
      ${brandMark()}
      <span class="brand__word">Bari<span>Follow</span></span>
    </a>
    <nav class="topnav" aria-label="Store">
      <a class="${active === "store" ? "is-on" : ""}" href="/store">Store</a>
      <a href="/#proof">Proof</a>
      <a href="/#faq">FAQ</a>
    </nav>
    <div class="topbar__side">${side}</div>
  </div>
</header>

<main class="shell${wide ? " shell--wide" : ""} page">
  ${flashHtml(ctx)}
  ${body}
</main>

<footer class="sfoot">
  <div class="shell sfoot__in">
    <div class="sfoot__brand">
      ${brandMark(26)}
      <p>Grow your Instagram. Quietly.</p>
    </div>
    <nav class="sfoot__links" aria-label="Footer">
      <a href="/store">Store</a>
      <a href="/store/account">Account</a>
      <a href="/#packages">Price list</a>
      <a href="/#proof">Receipts</a>
      <a href="${waLink("Hi BariFollow — I need help with an order.")}" target="_blank" rel="noopener noreferrer">WhatsApp</a>
    </nav>
    <p class="sfoot__fine">
      BariFollow is an independent service. Not affiliated with, endorsed by, or sponsored by
      Instagram or Meta Platforms, Inc. Wallet credits are verified manually against the UTR
      before they are added. Results vary by account. © ${year} BariFollow.
    </p>
  </div>
</footer>

${scripts}
</body>
</html>`;
}

function authShell(ctx, { title, body, wide = false }) {
  return layout(ctx, { title, body, active: "", wide });
}

/* ── storefront ────────────────────────────────────────────────────────── */

function pkgCard(p) {
  const isTick = p.fulfillment === "manual";
  const unit = per1k(p.price_paise, p.quantity);
  const label = isTick ? "Blue tick" : `${nf.format(Number(p.quantity))} followers`;

  return `<article class="pkg${isTick ? " pkg--tick" : ""}">
    <div class="pkg__top">
      <span class="mono">${esc(label)}</span>
      ${unit ? `<span class="pkg__rate">${unit} / 1K</span>` : `<span class="pkg__rate">${isTick ? "lifetime" : "one-time"}</span>`}
    </div>
    <h3 class="pkg__name">${esc(p.name)}</h3>
    <div class="pkg__price">${inr(p.price_paise)}<span>one-time</span></div>
    <p class="pkg__note">${esc(p.tagline)}</p>
    <a class="btn ${isTick ? "btn--lime" : "btn--ghost"} pkg__cta" href="/store/checkout?package=${encodeURIComponent(p.slug)}">
      ${isTick ? "Start verification" : "Order now"}
    </a>
  </article>`;
}

function storeHome(ctx) {
  const packages = listActivePackages();
  const user = ctx.user;

  const heroAction = user
    ? `<a class="btn btn--lime" href="/store/account#topup">Top up wallet</a>
       <a class="btn btn--ghost" href="/store/account">Your orders</a>`
    : `<a class="btn btn--lime" href="/store/register">Create an account</a>
       <a class="btn btn--ghost" href="/store/login">Sign in</a>`;

  const walletStrip = user
    ? `<div class="wallet-strip">
         <div><span class="mono">Wallet balance</span><strong>${inr(ctx.balance ?? balanceOf(user.id))}</strong></div>
         <p>Orders are paid from your wallet. Top up by UPI — we verify the UTR and credit it.</p>
         <a class="btn btn--lime btn--sm" href="/store/account#topup">Add funds</a>
       </div>`
    : `<div class="wallet-strip wallet-strip--guest">
         <div><span class="mono">How payment works</span><strong>UPI → wallet → order</strong></div>
         <p>Create an account, top up by UPI, and pay for any package from your balance.</p>
         <a class="btn btn--ghost btn--sm" href="/store/login">Sign in</a>
       </div>`;

  const body = `
  <section class="store-hero">
    <p class="eyebrow"><span class="dot"></span>Store</p>
    <h1>Pick a number.<br><em>Pay once.</em></h1>
    <p class="lede">Same prices as the price list. Every order is paid from your wallet, dispatched
    to a fulfilment provider, and tracked on its own page. No passwords, ever.</p>
    <div class="hero-actions">${heroAction}</div>
    <ul class="micro">
      <li>Username only</li>
      <li>Wallet + UPI</li>
      <li>Live order status</li>
    </ul>
  </section>

  ${walletStrip}

  <section class="packages-block">
    <div class="block-head">
      <h2>Packages</h2>
      <p class="mono">${packages.length} available</p>
    </div>
    <div class="pkg-grid">${packages.map(pkgCard).join("")}</div>
    <p class="fineprint">Blue tick is handled by our team: audit, document kit, submission and
    follow-up. Meta makes the final call on every badge — approval cannot be guaranteed.</p>
  </section>`;

  sendHtml(ctx.res, layout(ctx, { title: "Store", body, active: "store" }));
}

function checkoutPage(ctx) {
  if (!ctx.user) return redirect(ctx.res, loginHref(ctx));
  const errCode = ctx.url.searchParams.get("err");
  const err = errCode ? ERR_MSG[errCode] : null;

  const slug = String(ctx.url.searchParams.get("package") || "");
  const pkg = getPackageBySlug(slug);
  if (!pkg || !pkg.active) throw new HttpError(404, "That package is not available");

  const balance = ctx.balance ?? balanceOf(ctx.user.id);
  const short = balance < pkg.price_paise;
  const isTick = pkg.fulfillment === "manual";

  const body = `
  <section class="narrow">
    <p class="eyebrow"><span class="dot"></span>Checkout</p>
    <h1 class="h2">${esc(pkg.name)}</h1>

    ${err ? `<div class="flash flash--err" role="alert">${esc(err)}</div>` : ""}

    <div class="checkout-grid">
      <form class="panel" method="post" action="/store/checkout" novalidate>
        ${csrfField(ctx)}
        <input type="hidden" name="package" value="${esc(pkg.slug)}">

        <label class="field">
          <span class="field__label">Instagram username</span>
          <div class="field__prefix">@</div>
          <input class="input input--prefixed" name="username" placeholder="yourhandle"
                 autocomplete="off" autocapitalize="none" spellcheck="false"
                 pattern="[A-Za-z0-9._]{1,30}" required>
          <span class="field__hint">Public handle only. We never ask for your password or login.</span>
        </label>

        ${isTick ? `<p class="field-note">For the blue tick we'll message you on WhatsApp to
          collect the profile details and documents. Nothing sensitive goes in this form.</p>` : ""}

        <div class="summary">
          <div><span>Package</span><strong>${esc(pkg.name)}</strong></div>
          <div><span>Quantity</span><strong>${isTick ? "Verification" : nf.format(Number(pkg.quantity)) + " followers"}</strong></div>
          <div><span>Wallet balance</span><strong>${inr(balance)}</strong></div>
          <div class="summary__total"><span>Total now</span><strong>${inr(pkg.price_paise)}</strong></div>
        </div>

        ${
          short
            ? `<div class="flash flash--warn">You need ${inr(pkg.price_paise - balance)} more in your
                 wallet. <a href="/store/account#topup">Add funds</a> then come back.</div>
               <a class="btn btn--lime btn--full" href="/store/account#topup">Top up wallet</a>`
            : `<button class="btn btn--lime btn--full" type="submit">Pay ${inr(pkg.price_paise)} from wallet</button>`
        }
        <p class="terms">By ordering you agree that delivery begins immediately, so the order is
        no longer refundable once it starts. If we can't start it, the amount is refunded to your
        wallet automatically.</p>
      </form>

      <aside class="panel panel--soft">
        <h2 class="panel__title">What happens next</h2>
        <ol class="steps-mini">
          <li><span>01</span>The amount leaves your wallet instantly.</li>
          <li><span>02</span>${isTick ? "Our team reviews the profile and contacts you." : "The order is sent to our fulfilment provider."}</li>
          <li><span>03</span>${isTick ? "We submit and follow up until Meta answers." : "Delivery fills in at a natural pace."}</li>
        </ol>
        <a class="linkline" href="/store">Back to packages</a>
      </aside>
    </div>
  </section>`;

  sendHtml(ctx.res, layout(ctx, { title: `Checkout — ${pkg.name}`, body, active: "store" }));
}

/* ── auth pages ────────────────────────────────────────────────────────── */

function loginPage(ctx) {
  if (ctx.user) return redirect(ctx.res, safeNext(ctx.url.searchParams.get("next")) || "/store/account");
  const next = safeNext(ctx.url.searchParams.get("next")) || "";
  const err = ERR_MSG[ctx.url.searchParams.get("err")];

  const body = `
  <section class="auth">
    <p class="eyebrow"><span class="dot"></span>Account</p>
    <h1 class="h2">Welcome back.</h1>
    <p class="lede lede--sm">Sign in to top up your wallet and track orders.</p>
    ${err ? `<div class="flash flash--err" role="alert">${esc(err)}</div>` : ""}
    <form class="panel" method="post" action="/store/login">
      ${csrfField(ctx)}
      <input type="hidden" name="next" value="${esc(next)}">
      <label class="field">
        <span class="field__label">Email</span>
        <input class="input" type="email" name="email" autocomplete="email" required>
      </label>
      <label class="field">
        <span class="field__label">Password</span>
        <input class="input" type="password" name="password" autocomplete="current-password" required>
      </label>
      <button class="btn btn--lime btn--full" type="submit">Sign in</button>
      <p class="switch">New here? <a href="/store/register${next ? `?next=${encodeURIComponent(next)}` : ""}">Create an account</a></p>
    </form>
  </section>`;

  sendHtml(ctx.res, authShell(ctx, { title: "Sign in", body }));
}

function registerPage(ctx) {
  if (ctx.user) return redirect(ctx.res, "/store/account");
  const next = safeNext(ctx.url.searchParams.get("next")) || "";
  const err = ERR_MSG[ctx.url.searchParams.get("err")];

  const body = `
  <section class="auth">
    <p class="eyebrow"><span class="dot"></span>Account</p>
    <h1 class="h2">Create your account.</h1>
    <p class="lede lede--sm">Email, password, done. Top up when you're ready to order.</p>
    ${err ? `<div class="flash flash--err" role="alert">${esc(err)}</div>` : ""}
    <form class="panel" method="post" action="/store/register">
      ${csrfField(ctx)}
      <input type="hidden" name="next" value="${esc(next)}">
      <label class="field">
        <span class="field__label">Name</span>
        <input class="input" name="name" autocomplete="name" maxlength="60" required>
      </label>
      <label class="field">
        <span class="field__label">Email</span>
        <input class="input" type="email" name="email" autocomplete="email" required>
      </label>
      <label class="field">
        <span class="field__label">Password</span>
        <input class="input" type="password" name="password" autocomplete="new-password" minlength="8" required>
        <span class="field__hint">At least 8 characters.</span>
      </label>
      <button class="btn btn--lime btn--full" type="submit">Create account</button>
      <p class="switch">Already have one? <a href="/store/login${next ? `?next=${encodeURIComponent(next)}` : ""}">Sign in</a></p>
    </form>
  </section>`;

  sendHtml(ctx.res, authShell(ctx, { title: "Create account", body }));
}

/* ── account ───────────────────────────────────────────────────────────── */

function accountPage(ctx) {
  if (!ctx.user) return redirect(ctx.res, loginHref(ctx));
  const balance = ctx.balance ?? balanceOf(ctx.user.id);
  const orders = listOrdersForUser(ctx.user.id, 30);
  const topups = listTopupsForUser(ctx.user.id, 12);
  const txns = listWalletTxns(ctx.user.id, 10);

  const upiBlock = UPI_ID
    ? `<div class="paybox">
         <div class="paybox__id">
           <span class="mono">Pay to this UPI ID</span>
           <strong>${esc(UPI_ID)}</strong>
           <span class="paybox__name">${esc(UPI_NAME)}</span>
         </div>
         <div class="paybox__actions">
           <button class="btn btn--ghost btn--sm" type="button" data-copy="${esc(UPI_ID)}">Copy UPI ID</button>
           <a class="btn btn--ghost btn--sm" data-upi
              href="upi://pay?pa=${encodeURIComponent(UPI_ID)}&pn=${encodeURIComponent(UPI_NAME)}&cu=INR">
              Open UPI app
           </a>
         </div>
         <p class="paybox__hint">Pay first, then enter the amount and the UTR below. We credit the
         wallet after matching the reference — usually within a few minutes.</p>
       </div>`
    : `<div class="flash flash--warn">UPI is not configured yet. Message support on WhatsApp to
       top up your wallet.</div>`;

  const topupRows = topups.length
    ? topups
        .map(
          (t) => `<tr>
            <td class="mono">${esc(t.public_id)}</td>
            <td>${inr(t.amount_paise)}</td>
            <td class="mono">${esc(t.utr)}</td>
            <td>${statusPill(t.status === "pending" ? "manual_review" : t.status === "approved" ? "completed" : "refunded")}</td>
            <td class="muted">${esc(displayDate(t.created_at))}</td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="5" class="empty">No top-ups yet.</td></tr>`;

  const orderRows = orders.length
    ? orders
        .map(
          (o) => `<tr>
            <td><a class="mono linkish" href="/store/orders/${encodeURIComponent(o.public_id)}">${esc(o.public_id)}</a></td>
            <td>${esc(o.package_name)}</td>
            <td class="mono mono--raw">@${esc(o.username)}</td>
            <td>${inr(o.price_paise)}</td>
            <td>${statusPill(o.status)}</td>
            <td class="muted">${esc(displayDate(o.created_at))}</td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="6" class="empty">No orders yet. <a href="/store">Pick a package</a>.</td></tr>`;

  const txnRows = txns.length
    ? txns
        .map(
          (t) => `<li>
            <div><span class="mono">${esc(t.kind)}</span><p>${esc(t.memo || "")}</p></div>
            <div class="txn__right">
              <strong class="${t.delta_paise > 0 ? "is-plus" : "is-minus"}">${t.delta_paise > 0 ? "+" : "−"}${inr(Math.abs(t.delta_paise))}</strong>
              <span class="muted">${esc(displayDate(t.created_at))}</span>
            </div>
          </li>`
        )
        .join("")
    : `<li class="empty">Nothing here yet.</li>`;

  const body = `
  <section class="account-head">
    <div>
      <p class="eyebrow"><span class="dot"></span>Account</p>
      <h1 class="h2">Hi, ${esc(ctx.user.name.split(" ")[0])}.</h1>
      <p class="lede lede--sm">Orders, top-ups and wallet history in one place.</p>
    </div>
    <div class="balance-card">
      <span class="mono">Wallet balance</span>
      <strong>${inr(balance)}</strong>
      <a class="btn btn--lime btn--sm" href="#topup">Add funds</a>
    </div>
  </section>

  <section class="panel" id="topup">
    <div class="panel__head">
      <h2 class="panel__title">Top up with UPI</h2>
      <span class="mono muted">Manual verification</span>
    </div>
    ${upiBlock}
    <form class="topup-form" method="post" action="/store/topup">
      ${csrfField(ctx)}
      <label class="field field--inline">
        <span class="field__label">Amount (₹)</span>
        <input class="input" id="topupAmount" name="amount" type="number" inputmode="decimal"
               min="${TOPUP_MIN_PAISE / 100}" max="${TOPUP_MAX_PAISE / 100}" step="1"
               placeholder="500" required>
      </label>
      <label class="field field--inline field--grow">
        <span class="field__label">UTR / reference number</span>
        <input class="input" name="utr" placeholder="e.g. 412345678901"
               autocapitalize="characters" spellcheck="false" minlength="8" maxlength="24" required>
        <span class="field__hint">Found in your UPI app's payment details.</span>
      </label>
      <button class="btn btn--lime" type="submit">Submit top-up</button>
    </form>
  </section>

  <section class="panel">
    <div class="panel__head">
      <h2 class="panel__title">Orders</h2>
      <a class="linkline" href="/store">New order</a>
    </div>
    <div class="tablewrap">
      <table class="table">
        <thead><tr><th>Order</th><th>Package</th><th>Username</th><th>Amount</th><th>Status</th><th>Placed</th></tr></thead>
        <tbody>${orderRows}</tbody>
      </table>
    </div>
  </section>

  <div class="two-col">
    <section class="panel">
      <div class="panel__head"><h2 class="panel__title">Top-up history</h2></div>
      <div class="tablewrap">
        <table class="table">
          <thead><tr><th>Ref</th><th>Amount</th><th>UTR</th><th>Status</th><th>Submitted</th></tr></thead>
          <tbody>${topupRows}</tbody>
        </table>
      </div>
    </section>

    <section class="panel">
      <div class="panel__head"><h2 class="panel__title">Wallet activity</h2></div>
      <ul class="txns">${txnRows}</ul>
    </section>
  </div>

  <p class="account-meta mono mono--raw">Signed in as ${esc(ctx.user.email)} · member since ${esc(displayDate(ctx.user.created_at))}</p>`;

  sendHtml(ctx.res, layout(ctx, { title: "Account", body, active: "account" }));
}

/* ── order detail ──────────────────────────────────────────────────────── */

function orderPage(ctx) {
  if (!ctx.user) return redirect(ctx.res, loginHref(ctx));

  const order = getOrderByPublicId(ctx.params.id);
  const isOwner = order && Number(order.user_id) === Number(ctx.user.id);
  if (!order || (!isOwner && ctx.user.role !== "admin")) {
    throw new HttpError(404, "Order not found");
  }

  const canSync = order.status === "submitted" || order.status === "in_progress";
  const delivered =
    order.remains == null
      ? null
      : Math.max(0, Math.min(Number(order.quantity), Number(order.quantity) - Number(order.remains)));
  const pct = delivered == null ? 0 : Math.round((delivered / Number(order.quantity)) * 100);

  const body = `
  <section class="order-head">
    <div>
      <p class="eyebrow"><span class="dot"></span>Order</p>
      <h1 class="h2 mono h2--mono">${esc(order.public_id)}</h1>
      <p class="lede lede--sm">${esc(order.package_name)} · @${esc(order.username)}</p>
    </div>
    ${statusPill(order.status)}
  </section>

  ${
    canSync
      ? `<div class="syncbar">
           <p>Delivery updates automatically every couple of minutes.</p>
           <form method="post" action="/store/orders/${encodeURIComponent(order.public_id)}/sync">
             ${csrfField(ctx)}
             <button class="btn btn--ghost btn--sm" type="submit">Refresh status</button>
           </form>
         </div>`
      : ""
  }

  <div class="checkout-grid">
    <section class="panel">
      <h2 class="panel__title">Details</h2>
      <dl class="deflist">
        <div><dt>Package</dt><dd>${esc(order.package_name)}</dd></div>
        <div><dt>Quantity</dt><dd>${nf.format(Number(order.quantity))}${order.package_fulfillment === "manual" ? "" : " followers"}</dd></div>
        <div><dt>Username</dt><dd class="mono mono--raw">@${esc(order.username)}</dd></div>
        <div><dt>Paid from wallet</dt><dd>${inr(order.price_paise)}</dd></div>
        <div><dt>Placed</dt><dd>${esc(displayDate(order.created_at))}</dd></div>
        ${order.completed_at ? `<div><dt>Completed</dt><dd>${esc(displayDate(order.completed_at))}</dd></div>` : ""}
        ${order.refunded_at ? `<div><dt>Refunded</dt><dd>${esc(displayDate(order.refunded_at))}</dd></div>` : ""}
        ${order.provider_status ? `<div><dt>Provider status</dt><dd>${esc(order.provider_status)}</dd></div>` : ""}
      </dl>

      ${
        delivered != null && order.status !== "refunded"
          ? `<div class="progress">
               <div class="progress__head"><span>Delivery</span><span>${nf.format(delivered)} / ${nf.format(Number(order.quantity))}</span></div>
               <div class="progress__bar"><span style="width:${pct}%"></span></div>
             </div>`
          : ""
      }

      ${order.note ? `<p class="order-note">${esc(order.note)}</p>` : ""}
      ${order.last_error ? `<p class="order-note order-note--warn">${esc(order.last_error)}</p>` : ""}

      <div class="order-links">
        <a class="linkline" href="/store/account">All orders</a>
        <a class="linkline" href="${waLink(`Hi BariFollow — help with order ${order.public_id} (@${order.username}).`)}" target="_blank" rel="noopener noreferrer">Ask about this order</a>
      </div>
    </section>

    <aside class="panel panel--soft">
      <h2 class="panel__title">What this status means</h2>
      ${
        order.status === "manual_review"
          ? `<p class="panel__body">Our team is handling this one. We'll message you on WhatsApp for
             the profile details and documents — nothing else is needed from you here.</p>`
          : order.status === "refunded"
            ? `<p class="panel__body">The amount was returned to your wallet. If you were charged
               by UPI for a top-up and it isn't showing, send us the UTR on WhatsApp.</p>`
            : order.status === "completed"
              ? `<p class="panel__body">Delivery has finished. If the count drops afterwards, message
                 us with the order ID and we'll look at a refill.</p>`
              : `<p class="panel__body">The order is with the provider and filling in. Larger packages
                 take longer — the count updates here as the provider reports progress.</p>`
      }
      <a class="btn btn--ghost btn--full" href="/store">Order another package</a>
    </aside>
  </div>`;

  sendHtml(ctx.res, layout(ctx, { title: `Order ${order.public_id}`, body, active: "account" }));
}

/* ── admin shell ───────────────────────────────────────────────────────── */

function adminPage(ctx) {
  if (!ctx.user) {
    return redirect(ctx.res, `/store/login?next=${encodeURIComponent("/store/admin")}`);
  }
  if (ctx.user.role !== "admin") throw new HttpError(403, "Admin access only");

  const body = `
  <section class="admin-head">
    <div>
      <p class="eyebrow"><span class="dot"></span>Operations</p>
      <h1 class="h2">Admin.</h1>
    </div>
    <p class="muted mono">Signed in as ${esc(ctx.user.email)}</p>
  </section>

  <div id="adminApp" class="admin">
    <nav class="tabs" id="adminTabs">
      <button class="tab is-on" data-tab="overview" type="button">Overview</button>
      <button class="tab" data-tab="orders" type="button">Orders</button>
      <button class="tab" data-tab="topups" type="button">Top-ups</button>
      <button class="tab" data-tab="providers" type="button">Providers</button>
      <button class="tab" data-tab="packages" type="button">Packages</button>
    </nav>
    <div id="adminPanel" class="admin-panel">
      <p class="muted">Loading…</p>
    </div>
    <div id="adminToast" class="toast" role="status" aria-live="polite"></div>
  </div>
  <noscript><p class="flash flash--warn">The admin dashboard needs JavaScript.</p></noscript>`;

  sendHtml(ctx.res, layout(ctx, { title: "Admin", body, active: "admin", wide: true, scripts: '<script src="/admin.js" defer></script>' }));
}

/* ── POST handlers ─────────────────────────────────────────────────────── */

async function checkoutPost(ctx) {
  if (!ctx.user) return redirect(ctx.res, loginHref(ctx));

  const slug = String(ctx.body.package || "");
  if (!rateLimit(`order:${ctx.user.id}`, 20, 60 * 60 * 1000)) {
    return redirect(ctx.res, `/store/checkout?package=${encodeURIComponent(slug)}&err=rate_limited`);
  }

  try {
    const order = await placeOrder(ctx.user.id, slug, ctx.body.username);
    const msg = order.status === "refunded" ? "order_refunded" : "order_placed";
    redirect(ctx.res, `/store/orders/${encodeURIComponent(order.public_id)}?msg=${msg}`);
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    let code = "invalid_input";
    if (err.status === 402) code = "insufficient";
    else if (err.status === 404) code = "package_missing";
    else if (/username/i.test(err.message)) code = "invalid_username";
    redirect(ctx.res, `/store/checkout?package=${encodeURIComponent(slug)}&err=${code}`);
  }
}

function topupPost(ctx) {
  if (!ctx.user) return redirect(ctx.res, loginHref(ctx));
  if (!rateLimit(`topup:${ctx.user.id}`, 10, 60 * 60 * 1000)) {
    return redirect(ctx.res, "/store/account?err=rate_limited#topup");
  }

  const amount = parseMoney(ctx.body.amount);
  try {
    if (amount == null) throw new HttpError(400, "Invalid amount");
    createTopup(ctx.user.id, amount, ctx.body.utr);
    audit(ctx.user.id, "user", "topup.create", null, `${amount} paise`, clientIp(ctx.req));
    redirect(ctx.res, "/store/account?msg=topup_submitted#topup");
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    let code = "invalid_input";
    if (err.status === 409) code = "duplicate_utr";
    else if (/UTR/i.test(err.message)) code = "invalid_utr";
    else if (/amount/i.test(err.message)) code = "invalid_amount";
    redirect(ctx.res, `/store/account?err=${code}#topup`);
  }
}

async function loginPost(ctx) {
  const ip = clientIp(ctx.req);
  const email = String(ctx.body.email || "");
  if (!rateLimit(`login:${ip}`, 25, 5 * 60 * 1000) || !rateLimit(`login:${ip}:${email}`, 10, 5 * 60 * 1000)) {
    return redirect(ctx.res, "/store/login?err=rate_limited");
  }

  const next = safeNext(ctx.body.next) || "";
  const user = await authenticate(email, ctx.body.password);
  if (!user) {
    return redirect(
      ctx.res,
      `/store/login?err=invalid${next ? `&next=${encodeURIComponent(next)}` : ""}`
    );
  }

  createSession(user.id, ctx.req, ctx.res);
  audit(user.id, "user", "auth.login", user.email, "password login", ip);
  redirect(ctx.res, next || "/store/account?msg=welcome_back");
}

async function registerPost(ctx) {
  const ip = clientIp(ctx.req);
  if (!rateLimit(`register:${ip}`, 5, 60 * 60 * 1000)) {
    return redirect(ctx.res, "/store/register?err=rate_limited");
  }

  const next = safeNext(ctx.body.next) || "";
  try {
    const user = await registerUser({
      email: ctx.body.email,
      password: ctx.body.password,
      name: ctx.body.name,
    });
    createSession(user.id, ctx.req, ctx.res);
    audit(user.id, "user", "auth.register", user.email, "created account", ip);
    redirect(ctx.res, next || "/store/account?msg=welcome");
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    const code = err.status === 409 ? "exists" : "invalid_input";
    redirect(
      ctx.res,
      `/store/register?err=${code}${next ? `&next=${encodeURIComponent(next)}` : ""}`
    );
  }
}

function logoutPost(ctx) {
  if (ctx.user) audit(ctx.user.id, "user", "auth.logout", ctx.user.email, null, clientIp(ctx.req));
  destroySession(ctx.req, ctx.res);
  redirect(ctx.res, "/store?msg=logged_out");
}

async function orderSyncPost(ctx) {
  if (!ctx.user) return redirect(ctx.res, loginHref(ctx));

  const order = getOrderByPublicId(ctx.params.id);
  const allowed =
    order && (Number(order.user_id) === Number(ctx.user.id) || ctx.user.role === "admin");
  if (!allowed) throw new HttpError(404, "Order not found");

  if (!rateLimit(`sync:${ctx.user.id}`, 20, 10 * 60 * 1000)) {
    return redirect(ctx.res, `/store/orders/${encodeURIComponent(order.public_id)}?err=rate_limited`);
  }

  try {
    await syncOrder(order.id, { actorId: ctx.user.id, actorType: "user" });
    redirect(ctx.res, `/store/orders/${encodeURIComponent(order.public_id)}?msg=status_refreshed`);
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    redirect(ctx.res, `/store/orders/${encodeURIComponent(order.public_id)}?err=sync_failed`);
  }
}

/* ── JSON endpoints ────────────────────────────────────────────────────── */

function apiMe(ctx) {
  if (!ctx.user) throw new HttpError(401, "Sign in to continue");
  const orders = listOrdersForUser(ctx.user.id, 10).map(orderPublic);
  sendJsonSafe(ctx, {
    user: {
      id: ctx.user.id,
      name: ctx.user.name,
      email: ctx.user.email,
      role: ctx.user.role,
    },
    balancePaise: ctx.balance ?? balanceOf(ctx.user.id),
    orders,
  });
}

function apiOrder(ctx) {
  if (!ctx.user) throw new HttpError(401, "Sign in to continue");
  const order = getOrderByPublicId(ctx.params.id);
  const allowed =
    order && (Number(order.user_id) === Number(ctx.user.id) || ctx.user.role === "admin");
  if (!allowed) throw new HttpError(404, "Order not found");
  sendJsonSafe(ctx, orderPublic(order));
}

function sendJsonSafe(ctx, data) {
  ctx.res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  ctx.res.end(JSON.stringify(data));
}

/* ── routes ────────────────────────────────────────────────────────────── */

export const storeRoutes = [
  ["GET", "/store", storeHome],
  ["GET", "/store/checkout", checkoutPage],
  ["POST", "/store/checkout", checkoutPost],
  ["GET", "/store/login", loginPage],
  ["POST", "/store/login", loginPost],
  ["GET", "/store/register", registerPage],
  ["POST", "/store/register", registerPost],
  ["POST", "/store/logout", logoutPost],
  ["GET", "/store/account", accountPage],
  ["POST", "/store/topup", topupPost],
  ["GET", "/store/orders/:id", orderPage],
  ["POST", "/store/orders/:id/sync", orderSyncPost],
  ["GET", "/store/admin", adminPage],
  ["GET", "/api/me", apiMe],
  ["GET", "/api/orders/:id", apiOrder],
];
