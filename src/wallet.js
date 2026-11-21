import { getDb, tx, audit } from "./db.js";
import { HttpError, nowIso, randomToken, truncate } from "./util.js";

export const TOPUP_MIN_PAISE = 1000; // ₹10
export const TOPUP_MAX_PAISE = 5000000; // ₹50,000

/* ── balance + ledger ──────────────────────────────────────────────────── */

export function balanceOf(userId) {
  const row = getDb()
    .prepare("SELECT COALESCE(SUM(delta_paise), 0) AS b FROM wallet_txns WHERE user_id = ?")
    .get(Number(userId));
  return Number(row?.b || 0);
}

/** Append a ledger entry. Negative delta is rejected if it would overdraw. */
export function postTxn(userId, delta, kind, refType = null, refId = null, memo = null) {
  const amount = Math.round(Number(delta));
  if (!Number.isFinite(amount) || amount === 0) {
    throw new HttpError(400, "Invalid wallet amount");
  }
  const current = balanceOf(userId);
  const after = current + amount;
  if (after < 0) throw new HttpError(402, "Insufficient wallet balance");

  getDb()
    .prepare(
      `INSERT INTO wallet_txns
         (user_id, delta_paise, balance_after, kind, ref_type, ref_id, memo, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      Number(userId),
      amount,
      after,
      kind,
      refType,
      refId == null ? null : String(refId),
      memo == null ? null : truncate(memo, 200),
      nowIso()
    );
  return after;
}

export function listWalletTxns(userId, limit = 12) {
  return getDb()
    .prepare("SELECT * FROM wallet_txns WHERE user_id = ? ORDER BY id DESC LIMIT ?")
    .all(Number(userId), Number(limit));
}

/* ── UPI top-ups (manual verification) ─────────────────────────────────── */

function genPublicId(prefix) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}${randomToken(2).toUpperCase()}`;
}

export function normalizeUtr(raw) {
  const v = String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^[A-Z0-9]{8,24}$/.test(v)) return null;
  return v;
}

export function createTopup(userId, amountPaise, rawUtr) {
  const amount = Math.round(Number(amountPaise));
  if (!Number.isFinite(amount) || amount < TOPUP_MIN_PAISE || amount > TOPUP_MAX_PAISE) {
    throw new HttpError(400, "Top-up amount must be between ₹10 and ₹50,000");
  }
  const utr = normalizeUtr(rawUtr);
  if (!utr) throw new HttpError(400, "Enter the 8–24 character UTR / reference number from your UPI app");

  const db = getDb();
  const dupe = db.prepare("SELECT id FROM topups WHERE utr = ?").get(utr);
  if (dupe) throw new HttpError(409, "That UTR has already been submitted");

  const publicId = genPublicId("TP");
  try {
    db.prepare(
      `INSERT INTO topups (public_id, user_id, amount_paise, utr, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`
    ).run(publicId, Number(userId), amount, utr, nowIso());
  } catch (err) {
    if (/UNIQUE/i.test(String(err.message))) {
      throw new HttpError(409, "That UTR has already been submitted");
    }
    throw err;
  }

  return db.prepare("SELECT * FROM topups WHERE public_id = ?").get(publicId);
}

export function listTopupsForUser(userId, limit = 12) {
  return getDb()
    .prepare("SELECT * FROM topups WHERE user_id = ? ORDER BY id DESC LIMIT ?")
    .all(Number(userId), Number(limit));
}

export function listTopups({ status = null, limit = 100 } = {}) {
  const db = getDb();
  const cap = Math.min(Math.max(Number(limit) || 100, 1), 250);
  if (status) {
    return db
      .prepare(
        `SELECT t.*, u.email AS user_email, u.name AS user_name
         FROM topups t JOIN users u ON u.id = t.user_id
         WHERE t.status = ? ORDER BY t.id DESC LIMIT ?`
      )
      .all(String(status), cap);
  }
  return db
    .prepare(
      `SELECT t.*, u.email AS user_email, u.name AS user_name
       FROM topups t JOIN users u ON u.id = t.user_id
       ORDER BY t.id DESC LIMIT ?`
    )
    .all(cap);
}

export function getTopup(id) {
  return getDb().prepare("SELECT * FROM topups WHERE id = ?").get(Number(id));
}

export function approveTopup(id, adminId, rawNote = "") {
  const note = truncate(String(rawNote || "").trim(), 200);
  return tx((d) => {
    const t = d.prepare("SELECT * FROM topups WHERE id = ?").get(Number(id));
    if (!t) throw new HttpError(404, "Top-up not found");
    if (t.status !== "pending") throw new HttpError(409, "This top-up has already been reviewed");

    postTxn(
      t.user_id,
      t.amount_paise,
      "topup",
      "topup",
      t.public_id,
      note || "UPI top-up approved"
    );

    d.prepare(
      "UPDATE topups SET status = 'approved', note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?"
    ).run(note || null, Number(adminId), nowIso(), Number(id));

    audit(
      adminId,
      "admin",
      "topup.approve",
      t.public_id,
      `credited ${t.amount_paise} paise to user ${t.user_id}`,
      null
    );
    return d.prepare("SELECT * FROM topups WHERE id = ?").get(Number(id));
  });
}

export function rejectTopup(id, adminId, rawNote = "") {
  const note = truncate(String(rawNote || "").trim(), 200);
  return tx((d) => {
    const t = d.prepare("SELECT * FROM topups WHERE id = ?").get(Number(id));
    if (!t) throw new HttpError(404, "Top-up not found");
    if (t.status !== "pending") throw new HttpError(409, "This top-up has already been reviewed");

    d.prepare(
      "UPDATE topups SET status = 'rejected', note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?"
    ).run(note || null, Number(adminId), nowIso(), Number(id));

    audit(adminId, "admin", "topup.reject", t.public_id, note || "rejected", null);
    return d.prepare("SELECT * FROM topups WHERE id = ?").get(Number(id));
  });
}

export function topupStats() {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(amount_paise), 0) AS amount
       FROM topups WHERE status = 'pending'`
    )
    .get();
  return { count: Number(row?.count || 0), amountPaise: Number(row?.amount || 0) };
}

export function walletLiabilityPaise() {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(b), 0) AS total FROM (
         SELECT SUM(delta_paise) AS b FROM wallet_txns GROUP BY user_id
       ) WHERE b > 0`
    )
    .get();
  return Number(row?.total || 0);
}
