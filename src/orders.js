import { getDb, tx, audit } from "./db.js";
import { balanceOf, postTxn } from "./wallet.js";
import { dispatchToProvider, pollProvider } from "./providers.js";
import {
  HttpError,
  normalizeUsername,
  nowIso,
  randomToken,
  truncate,
} from "./util.js";

const PENDING = new Set(["submitted", "in_progress"]);
const TERMINAL = new Set(["completed", "refunded", "cancelled", "partial"]);

/* ── queries ───────────────────────────────────────────────────────────── */

const ORDER_SELECT = `
  SELECT o.*, p.name AS package_name, p.slug AS package_slug, p.fulfillment AS package_fulfillment
  FROM orders o JOIN packages p ON p.id = o.package_id
`;

export function getOrder(id) {
  return getDb().prepare(`${ORDER_SELECT} WHERE o.id = ?`).get(Number(id));
}

export function getOrderByPublicId(publicId) {
  return getDb().prepare(`${ORDER_SELECT} WHERE o.public_id = ?`).get(String(publicId));
}

export function listOrdersForUser(userId, limit = 25) {
  return getDb()
    .prepare(`${ORDER_SELECT} WHERE o.user_id = ? ORDER BY o.id DESC LIMIT ?`)
    .all(Number(userId), Math.min(Number(limit) || 25, 100));
}

export function listOrders({ status = null, q = null, limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (status) {
    where.push("o.status = ?");
    params.push(String(status));
  }
  if (q) {
    where.push("(o.public_id LIKE ? OR o.username LIKE ? OR u.email LIKE ?)");
    const like = `%${String(q).trim()}%`;
    params.push(like, like, like);
  }
  params.push(Math.min(Math.max(Number(limit) || 100, 1), 250));

  return getDb()
    .prepare(
      `SELECT o.*, p.name AS package_name, p.slug AS package_slug,
              u.email AS user_email, u.name AS user_name
       FROM orders o
       JOIN packages p ON p.id = o.package_id
       JOIN users u ON u.id = o.user_id
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY o.id DESC LIMIT ?`
    )
    .all(...params);
}

export function ordersByStatus() {
  const rows = getDb()
    .prepare("SELECT status, COUNT(*) AS count FROM orders GROUP BY status")
    .all();
  const out = {};
  for (const r of rows) out[r.status] = Number(r.count);
  return out;
}

export function revenuePaise() {
  const row = getDb()
    .prepare("SELECT COALESCE(SUM(price_paise), 0) AS total FROM orders WHERE refunded_at IS NULL")
    .get();
  return Number(row?.total || 0);
}

export function listPackages() {
  return getDb().prepare("SELECT * FROM packages ORDER BY sort_order ASC, id ASC").all();
}

export function listActivePackages() {
  return getDb()
    .prepare("SELECT * FROM packages WHERE active = 1 ORDER BY sort_order ASC, id ASC")
    .all();
}

export function getPackageBySlug(slug) {
  return getDb().prepare("SELECT * FROM packages WHERE slug = ?").get(String(slug));
}

/* ── placing orders ────────────────────────────────────────────────────── */

function uniquePublicId(d) {
  for (let i = 0; i < 6; i += 1) {
    const id = `BF-${Date.now().toString(36).toUpperCase()}${randomToken(2).toUpperCase()}`;
    if (!d.prepare("SELECT 1 FROM orders WHERE public_id = ?").get(id)) return id;
  }
  throw new Error("Could not allocate an order ID");
}

export async function placeOrder(userId, slug, rawUsername) {
  const db = getDb();
  const pkg = getPackageBySlug(slug);
  if (!pkg || !pkg.active) throw new HttpError(404, "That package is not available");

  const username = normalizeUsername(rawUsername);
  if (!username) {
    throw new HttpError(
      400,
      "Enter a valid Instagram username — letters, numbers, dots and underscores only."
    );
  }

  const order = tx((d) => {
    if (balanceOf(userId) < pkg.price_paise) {
      throw new HttpError(402, "Not enough wallet balance for this package");
    }

    const publicId = uniquePublicId(d);
    const now = nowIso();
    const info = d
      .prepare(
        `INSERT INTO orders
           (public_id, user_id, package_id, username, quantity, price_paise, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`
      )
      .run(
        publicId,
        Number(userId),
        Number(pkg.id),
        username,
        Number(pkg.quantity),
        Number(pkg.price_paise),
        now,
        now
      );

    postTxn(
      userId,
      -Number(pkg.price_paise),
      "order",
      "order",
      publicId,
      `${pkg.name} for @${username}`
    );

    return d.prepare("SELECT * FROM orders WHERE id = ?").get(Number(info.lastInsertRowid));
  });

  audit(
    userId,
    "user",
    "order.create",
    order.public_id,
    `${pkg.slug} · @${username} · ${pkg.price_paise} paise`,
    null
  );

  if (pkg.fulfillment === "manual") {
    db.prepare(
      "UPDATE orders SET status = 'manual_review', note = ?, updated_at = ? WHERE id = ?"
    ).run(
      "Manual fulfilment — our team will contact you on WhatsApp to complete the process.",
      nowIso(),
      order.id
    );
    return getOrder(order.id);
  }

  try {
    const result = await dispatchToProvider(order, pkg);
    db.prepare(
      `UPDATE orders SET status = 'submitted', provider_id = ?, provider_order_id = ?,
              provider_status = 'submitted', start_count = ?, last_error = NULL, updated_at = ?
       WHERE id = ?`
    ).run(
      Number(result.provider.id),
      String(result.providerOrderId),
      result.startCount == null ? null : Number(result.startCount),
      nowIso(),
      order.id
    );
    audit(
      userId,
      "user",
      "order.dispatch",
      order.public_id,
      `provider ${result.provider.name} → ${result.providerOrderId}`,
      null
    );
  } catch (err) {
    const message = `Could not start this order: ${truncate(err.message, 240)}`;
    refundAndFail(order.id, message);
    audit(userId, "user", "order.dispatch_failed", order.public_id, truncate(err.message, 400), null);
  }

  return getOrder(order.id);
}

/* ── refunds + completion ──────────────────────────────────────────────── */

function refundInTx(d, order, { note, actorId = null, actorType = "system" }) {
  const fresh = d.prepare("SELECT * FROM orders WHERE id = ?").get(Number(order.id));
  if (!fresh) throw new HttpError(404, "Order not found");
  if (fresh.refunded_at) return false;

  postTxn(
    fresh.user_id,
    Number(fresh.price_paise),
    "refund",
    "order",
    fresh.public_id,
    note || `Refund — ${fresh.public_id}`
  );

  const now = nowIso();
  d.prepare(
    "UPDATE orders SET status = 'refunded', refunded_at = ?, note = ?, updated_at = ? WHERE id = ?"
  ).run(now, truncate(note || "Refunded to wallet", 300), now, Number(fresh.id));

  audit(actorId, actorType, "order.refund", fresh.public_id, note || "refunded", null);
  return true;
}

function refundAndFail(orderId, note) {
  tx((d) => {
    const fresh = d.prepare("SELECT * FROM orders WHERE id = ?").get(Number(orderId));
    if (!fresh || fresh.refunded_at) return;
    refundInTx(d, fresh, { note, actorType: "system" });
    d.prepare("UPDATE orders SET last_error = ? WHERE id = ?").run(
      truncate(note, 300),
      Number(orderId)
    );
  });
}

export function refundOrder(id, adminId, rawReason = "") {
  const reason = truncate(String(rawReason || "").trim(), 200) || "Refunded by admin";
  return tx((d) => {
    const order = d.prepare("SELECT * FROM orders WHERE id = ?").get(Number(id));
    if (!order) throw new HttpError(404, "Order not found");
    if (order.refunded_at) throw new HttpError(409, "This order has already been refunded");

    refundInTx(d, order, { note: reason, actorId: adminId, actorType: "admin" });
    return d.prepare("SELECT * FROM orders WHERE id = ?").get(Number(id));
  });
}

export function completeOrder(id, adminId, rawNote = "") {
  const note = truncate(String(rawNote || "").trim(), 240);
  return tx((d) => {
    const order = d.prepare("SELECT * FROM orders WHERE id = ?").get(Number(id));
    if (!order) throw new HttpError(404, "Order not found");
    if (order.refunded_at) throw new HttpError(409, "Refunded orders cannot be completed");

    const now = nowIso();
    d.prepare(
      "UPDATE orders SET status = 'completed', completed_at = ?, note = COALESCE(?, note), updated_at = ? WHERE id = ?"
    ).run(now, note || null, now, Number(id));

    audit(adminId, "admin", "order.complete", order.public_id, note || "marked completed", null);
    return d.prepare("SELECT * FROM orders WHERE id = ?").get(Number(id));
  });
}

/* ── provider sync ─────────────────────────────────────────────────────── */

export async function syncOrder(id, { actorId = null, actorType = "system" } = {}) {
  const order = getOrder(id);
  if (!order) throw new HttpError(404, "Order not found");
  if (TERMINAL.has(order.status)) return order;
  if (!PENDING.has(order.status)) return order;
  if (!order.provider_order_id) {
    throw new HttpError(409, "This order has not been submitted to a provider yet");
  }

  let remote;
  try {
    remote = await pollProvider(order);
  } catch (err) {
    const now = nowIso();
    getDb()
      .prepare("UPDATE orders SET last_error = ?, last_sync_at = ?, updated_at = ? WHERE id = ?")
      .run(truncate(err.message, 300), now, now, Number(id));
    throw new HttpError(502, `Could not reach the provider: ${truncate(err.message, 160)}`);
  }

  const now = nowIso();
  const mapped = remote.status;

  tx((d) => {
    const fresh = d.prepare("SELECT * FROM orders WHERE id = ?").get(Number(id));
    if (!fresh || TERMINAL.has(fresh.status)) return;

    d.prepare(
      `UPDATE orders SET provider_status = ?, start_count = COALESCE(?, start_count),
              remains = COALESCE(?, remains), last_sync_at = ?, last_error = NULL, updated_at = ?
       WHERE id = ?`
    ).run(
      remote.rawStatus ? truncate(remote.rawStatus, 80) : mapped,
      remote.startCount == null ? null : Number(remote.startCount),
      remote.remains == null ? null : Number(remote.remains),
      now,
      now,
      Number(id)
    );

    if (mapped === "cancelled" || mapped === "refunded") {
      refundInTx(d, fresh, {
        note: `Provider marked the order ${remote.rawStatus || mapped}. Refunded to wallet.`,
        actorId,
        actorType,
      });
      return;
    }

    if (mapped === "completed") {
      d.prepare(
        "UPDATE orders SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?"
      ).run(now, now, Number(id));
      return;
    }

    d.prepare("UPDATE orders SET status = ?, updated_at = ? WHERE id = ?").run(
      mapped,
      now,
      Number(id)
    );
  });

  return getOrder(id);
}

export async function syncPendingOrders(limit = 25) {
  const rows = getDb()
    .prepare(
      `SELECT id FROM orders
       WHERE status IN ('submitted','in_progress') AND provider_order_id IS NOT NULL
       ORDER BY id ASC LIMIT ?`
    )
    .all(Number(limit));

  for (const row of rows) {
    try {
      await syncOrder(row.id, { actorType: "system" });
    } catch (err) {
      console.error(`[sync] order ${row.id}: ${err.message}`);
    }
  }
  return rows.length;
}

export function startSyncLoop() {
  if (process.env.AUTO_SYNC === "0") return null;
  const every = Math.max(Number(process.env.SYNC_INTERVAL_MS) || 120000, 15000);
  const timer = setInterval(() => {
    syncPendingOrders().catch((err) => console.error("[sync]", err.message));
  }, every);
  timer.unref?.();
  return timer;
}

/* ── serialisation ─────────────────────────────────────────────────────── */

export function orderPublic(order) {
  return {
    id: Number(order.id),
    publicId: order.public_id,
    status: order.status,
    username: order.username,
    quantity: Number(order.quantity),
    pricePaise: Number(order.price_paise),
    packageName: order.package_name || null,
    packageSlug: order.package_slug || null,
    providerStatus: order.provider_status || null,
    startCount: order.start_count == null ? null : Number(order.start_count),
    remains: order.remains == null ? null : Number(order.remains),
    lastError: order.last_error || null,
    note: order.note || null,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
    completedAt: order.completed_at || null,
    refundedAt: order.refunded_at || null,
  };
}
