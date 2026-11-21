import { audit, getDb } from "./db.js";
import { requireAdmin } from "./auth.js";
import {
  completeOrder,
  getOrder,
  listOrders,
  listPackages,
  orderPublic,
  ordersByStatus,
  refundOrder,
  revenuePaise,
  syncOrder,
} from "./orders.js";
import {
  approveTopup,
  listTopups,
  rejectTopup,
  topupStats,
  walletLiabilityPaise,
} from "./wallet.js";
import {
  getProvider,
  listProviders,
  ProviderError,
  providerPublic,
  testConnection,
} from "./providers.js";
import { encryptSecret, HttpError, sendJson, truncate } from "./util.js";

function intParam(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function bool(value) {
  return value === true || value === 1 || value === "1" || value === "true" || value === "on";
}

function providerSummary(p) {
  return providerPublic(p);
}

/* ── overview ──────────────────────────────────────────────────────────── */

function summary(ctx) {
  requireAdmin(ctx.req);
  const db = getDb();
  const users = db.prepare("SELECT COUNT(*) AS n FROM users").get();
  const activeProviders = db
    .prepare("SELECT COUNT(*) AS n FROM providers WHERE active = 1")
    .get();

  sendJson(ctx.res, {
    revenuePaise: revenuePaise(),
    walletLiabilityPaise: walletLiabilityPaise(),
    users: Number(users?.n || 0),
    activeProviders: Number(activeProviders?.n || 0),
    ordersByStatus: ordersByStatus(),
    topups: topupStats(),
    recentOrders: listOrders({ limit: 8 }).map((o) => ({
      ...orderPublic(o),
      userEmail: o.user_email,
    })),
  });
}

/* ── orders ────────────────────────────────────────────────────────────── */

function ordersList(ctx) {
  requireAdmin(ctx.req);
  const status = ctx.url.searchParams.get("status") || null;
  const q = ctx.url.searchParams.get("q") || null;
  const limit = intParam(ctx.url.searchParams.get("limit"), 100);

  const rows = listOrders({ status, q, limit }).map((o) => ({
    ...orderPublic(o),
    userEmail: o.user_email,
    userName: o.user_name,
  }));
  sendJson(ctx.res, { orders: rows });
}

async function orderSync(ctx) {
  const admin = requireAdmin(ctx.req);
  const id = intParam(ctx.params.id);
  await syncOrder(id, { actorId: admin.id, actorType: "admin" });
  sendJson(ctx.res, { ok: true, order: orderPublic(getOrder(id)) });
}

function orderComplete(ctx) {
  const admin = requireAdmin(ctx.req);
  const id = intParam(ctx.params.id);
  completeOrder(id, admin.id, ctx.body.note || "");
  sendJson(ctx.res, { ok: true, order: orderPublic(getOrder(id)) });
}

function orderRefund(ctx) {
  const admin = requireAdmin(ctx.req);
  const id = intParam(ctx.params.id);
  refundOrder(id, admin.id, ctx.body.reason || "");
  sendJson(ctx.res, { ok: true, order: orderPublic(getOrder(id)) });
}

/* ── top-ups ───────────────────────────────────────────────────────────── */

function topupsList(ctx) {
  requireAdmin(ctx.req);
  const status = ctx.url.searchParams.get("status") || null;
  if (status && !["pending", "approved", "rejected"].includes(status)) {
    throw new HttpError(400, "Unknown top-up status");
  }
  const rows = listTopups({ status, limit: 200 }).map((t) => ({
    id: Number(t.id),
    publicId: t.public_id,
    amountPaise: Number(t.amount_paise),
    utr: t.utr,
    status: t.status,
    note: t.note || null,
    userEmail: t.user_email,
    userName: t.user_name,
    createdAt: t.created_at,
    reviewedAt: t.reviewed_at,
  }));
  sendJson(ctx.res, { topups: rows });
}

function topupApprove(ctx) {
  const admin = requireAdmin(ctx.req);
  const id = intParam(ctx.params.id);
  const row = approveTopup(id, admin.id, ctx.body.note || "");
  sendJson(ctx.res, { ok: true, topup: { id: Number(row.id), status: row.status } });
}

function topupReject(ctx) {
  const admin = requireAdmin(ctx.req);
  const id = intParam(ctx.params.id);
  const row = rejectTopup(id, admin.id, ctx.body.note || "");
  sendJson(ctx.res, { ok: true, topup: { id: Number(row.id), status: row.status } });
}

/* ── providers ─────────────────────────────────────────────────────────── */

function providersList(ctx) {
  requireAdmin(ctx.req);
  sendJson(ctx.res, { providers: listProviders().map(providerSummary) });
}

function validHttpUrl(raw) {
  try {
    const url = new URL(String(raw));
    return /^https?:$/.test(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function providerCreate(ctx) {
  const admin = requireAdmin(ctx.req);
  const name = String(ctx.body.name || "").trim();
  const kind = String(ctx.body.kind || "smm");
  const priority = intParam(ctx.body.priority, 100);
  const active = ctx.body.active === undefined ? true : bool(ctx.body.active);

  if (name.length < 1 || name.length > 60) throw new HttpError(400, "Provider name is required");
  if (!["smm", "mock"].includes(kind)) throw new HttpError(400, "Provider type must be smm or mock");
  if (priority < 1 || priority > 9999) throw new HttpError(400, "Priority must be 1–9999");

  let apiUrl = null;
  let apiKeyEnc = null;

  if (kind === "smm") {
    apiUrl = validHttpUrl(ctx.body.apiUrl);
    if (!apiUrl) throw new HttpError(400, "A valid http(s) API URL is required for SMM panels");
    const key = String(ctx.body.apiKey || "").trim();
    if (!key) throw new HttpError(400, "An API key is required for SMM panels");
    apiKeyEnc = encryptSecret(key);
  }

  const info = getDb()
    .prepare(
      "INSERT INTO providers (name, kind, api_url, api_key_enc, priority, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(name, kind, apiUrl, apiKeyEnc, priority, active ? 1 : 0, new Date().toISOString());

  audit(admin.id, "admin", "provider.create", String(name), `${kind} · priority ${priority}`, null);
  sendJson(ctx.res, {
    ok: true,
    provider: providerSummary(getProvider(Number(info.lastInsertRowid))),
  });
}

function providerUpdate(ctx) {
  const admin = requireAdmin(ctx.req);
  const id = intParam(ctx.params.id);
  const provider = getProvider(id);
  if (!provider) throw new HttpError(404, "Provider not found");

  const sets = [];
  const params = [];

  if (ctx.body.name !== undefined) {
    const name = String(ctx.body.name).trim();
    if (name.length < 1 || name.length > 60) throw new HttpError(400, "Provider name is required");
    sets.push("name = ?");
    params.push(name);
  }
  if (ctx.body.priority !== undefined) {
    const priority = intParam(ctx.body.priority, 100);
    if (priority < 1 || priority > 9999) throw new HttpError(400, "Priority must be 1–9999");
    sets.push("priority = ?");
    params.push(priority);
  }
  if (ctx.body.active !== undefined) {
    sets.push("active = ?");
    params.push(bool(ctx.body.active) ? 1 : 0);
  }
  if (ctx.body.apiUrl !== undefined) {
    const url = validHttpUrl(ctx.body.apiUrl);
    if (!url) throw new HttpError(400, "API URL must be a valid http(s) URL");
    sets.push("api_url = ?");
    params.push(url);
  }
  if (ctx.body.apiKey !== undefined) {
    const key = String(ctx.body.apiKey || "").trim();
    sets.push("api_key_enc = ?");
    params.push(key ? encryptSecret(key) : null);
  }

  if (!sets.length) throw new HttpError(400, "Nothing to update");

  params.push(id);
  getDb().prepare(`UPDATE providers SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  audit(admin.id, "admin", "provider.update", String(id), sets.join(", "), null);

  sendJson(ctx.res, { ok: true, provider: providerSummary(getProvider(id)) });
}

async function providerTest(ctx) {
  requireAdmin(ctx.req);
  const id = intParam(ctx.params.id);
  const provider = getProvider(id);
  if (!provider) throw new HttpError(404, "Provider not found");

  try {
    const result = await testConnection(provider);
    sendJson(ctx.res, {
      ok: true,
      balance: result.balance,
      currency: result.currency,
    });
  } catch (err) {
    if (err instanceof ProviderError) throw new HttpError(502, err.message);
    throw err;
  }
}

/* ── packages ──────────────────────────────────────────────────────────── */

function packagesList(ctx) {
  requireAdmin(ctx.req);
  const providers = new Map(listProviders().map((p) => [Number(p.id), p.name]));
  const rows = listPackages().map((p) => ({
    id: Number(p.id),
    slug: p.slug,
    name: p.name,
    tagline: p.tagline,
    quantity: Number(p.quantity),
    pricePaise: Number(p.price_paise),
    fulfillment: p.fulfillment,
    providerId: p.provider_id == null ? null : Number(p.provider_id),
    providerName: p.provider_id == null ? null : providers.get(Number(p.provider_id)) || null,
    providerService: p.provider_service || "",
    sortOrder: Number(p.sort_order),
    active: Boolean(p.active),
  }));
  sendJson(ctx.res, { packages: rows });
}

function packageUpdate(ctx) {
  const admin = requireAdmin(ctx.req);
  const id = intParam(ctx.params.id);
  const pkg = getDb().prepare("SELECT * FROM packages WHERE id = ?").get(id);
  if (!pkg) throw new HttpError(404, "Package not found");

  const sets = [];
  const params = [];

  if (ctx.body.pricePaise !== undefined) {
    const price = intParam(ctx.body.pricePaise, -1);
    if (price < 100) throw new HttpError(400, "Price must be at least ₹1");
    sets.push("price_paise = ?");
    params.push(price);
  }
  if (ctx.body.providerId !== undefined) {
    if (ctx.body.providerId === null || ctx.body.providerId === "") {
      sets.push("provider_id = ?");
      params.push(null);
    } else {
      const provider = getProvider(intParam(ctx.body.providerId));
      if (!provider) throw new HttpError(400, "That provider does not exist");
      sets.push("provider_id = ?");
      params.push(Number(provider.id));
    }
  }
  if (ctx.body.providerService !== undefined) {
    const service = String(ctx.body.providerService || "").trim();
    if (service.length > 64) throw new HttpError(400, "Provider service ID is too long");
    sets.push("provider_service = ?");
    params.push(service);
  }
  if (ctx.body.active !== undefined) {
    sets.push("active = ?");
    params.push(bool(ctx.body.active) ? 1 : 0);
  }

  if (!sets.length) throw new HttpError(400, "Nothing to update");
  params.push(id);
  getDb().prepare(`UPDATE packages SET ${sets.join(", ")} WHERE id = ?`).run(...params);

  audit(admin.id, "admin", "package.update", pkg.slug, truncate(sets.join(", "), 120), null);
  sendJson(ctx.res, { ok: true });
}

/* ── routes ────────────────────────────────────────────────────────────── */

export const adminRoutes = [
  ["GET", "/api/admin/summary", summary],
  ["GET", "/api/admin/orders", ordersList],
  ["POST", "/api/admin/orders/:id/sync", orderSync],
  ["POST", "/api/admin/orders/:id/complete", orderComplete],
  ["POST", "/api/admin/orders/:id/refund", orderRefund],
  ["GET", "/api/admin/topups", topupsList],
  ["POST", "/api/admin/topups/:id/approve", topupApprove],
  ["POST", "/api/admin/topups/:id/reject", topupReject],
  ["GET", "/api/admin/providers", providersList],
  ["POST", "/api/admin/providers", providerCreate],
  ["PATCH", "/api/admin/providers/:id", providerUpdate],
  ["POST", "/api/admin/providers/:id/test", providerTest],
  ["GET", "/api/admin/packages", packagesList],
  ["PATCH", "/api/admin/packages/:id", packageUpdate],
];
