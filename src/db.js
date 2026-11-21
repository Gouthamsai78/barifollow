import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hashPasswordSync, IS_PROD, nowIso } from "./util.js";

let db = null;

/* ── schema ────────────────────────────────────────────────────────────── */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip         TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS providers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('smm','mock')),
  api_url     TEXT,
  api_key_enc TEXT,
  priority    INTEGER NOT NULL DEFAULT 100,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS packages (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  slug             TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  tagline          TEXT NOT NULL DEFAULT '',
  quantity         INTEGER NOT NULL,
  price_paise      INTEGER NOT NULL,
  cost_paise       INTEGER NOT NULL DEFAULT 0,
  fulfillment      TEXT NOT NULL DEFAULT 'auto' CHECK (fulfillment IN ('auto','manual')),
  provider_id      INTEGER REFERENCES providers(id) ON DELETE SET NULL,
  provider_service TEXT NOT NULL DEFAULT '',
  sort_order       INTEGER NOT NULL DEFAULT 0,
  active           INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS orders (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id         TEXT NOT NULL UNIQUE,
  user_id           INTEGER NOT NULL REFERENCES users(id),
  package_id        INTEGER NOT NULL REFERENCES packages(id),
  username          TEXT NOT NULL,
  quantity          INTEGER NOT NULL,
  price_paise       INTEGER NOT NULL,
  status            TEXT NOT NULL,
  provider_id       INTEGER REFERENCES providers(id),
  provider_order_id TEXT,
  provider_status   TEXT,
  start_count       INTEGER,
  remains           INTEGER,
  last_error        TEXT,
  note              TEXT,
  refunded_at       TEXT,
  completed_at      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  last_sync_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_provider_order
  ON orders(provider_id, provider_order_id) WHERE provider_order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS wallet_txns (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  delta_paise   INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('topup','order','refund','adjustment')),
  ref_type      TEXT,
  ref_id        TEXT,
  memo          TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wallet_user ON wallet_txns(user_id, id DESC);

CREATE TABLE IF NOT EXISTS topups (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id    TEXT NOT NULL UNIQUE,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  amount_paise INTEGER NOT NULL,
  utr          TEXT NOT NULL UNIQUE,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  note         TEXT,
  reviewed_by  INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL,
  reviewed_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_topups_status ON topups(status, id DESC);

CREATE TABLE IF NOT EXISTS audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id   INTEGER,
  actor_type TEXT NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT,
  detail     TEXT,
  ip         TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit(id DESC);
`;

/* ── seed data ─────────────────────────────────────────────────────────── */

const SEED_PACKAGES = [
  {
    slug: "followers-5k",
    name: "5,000 followers",
    tagline: "Starter — for a fresh page.",
    quantity: 5000,
    price: 18000,
    sort: 1,
  },
  {
    slug: "followers-10k",
    name: "10,000 followers",
    tagline: "The one most people pick.",
    quantity: 10000,
    price: 28000,
    sort: 2,
  },
  {
    slug: "followers-20k",
    name: "20,000 followers",
    tagline: "Momentum for an active page.",
    quantity: 20000,
    price: 38000,
    sort: 3,
  },
  {
    slug: "followers-50k",
    name: "50,000 followers",
    tagline: "Creator scale, filled naturally.",
    quantity: 50000,
    price: 58000,
    sort: 4,
  },
  {
    slug: "followers-100k",
    name: "100,000 followers",
    tagline: "Authority numbers.",
    quantity: 100000,
    price: 78000,
    sort: 5,
  },
  {
    slug: "followers-500k",
    name: "500,000 followers",
    tagline: "Maximum reach, lowest ₹ / 1K.",
    quantity: 500000,
    price: 110000,
    sort: 6,
  },
  {
    slug: "blue-tick",
    name: "Blue tick — verification",
    tagline: "Audit, document kit, submission and follow-up. Meta decides the badge.",
    quantity: 1,
    price: 66900,
    sort: 7,
    fulfillment: "manual",
  },
];

function seedPackages(d) {
  const stmt = d.prepare(`
    INSERT INTO packages
      (slug, name, tagline, quantity, price_paise, cost_paise, fulfillment, provider_service, sort_order, active)
    VALUES (?, ?, ?, ?, ?, 0, ?, '', ?, 1)
    ON CONFLICT(slug) DO NOTHING
  `);
  for (const p of SEED_PACKAGES) {
    stmt.run(
      p.slug,
      p.name,
      p.tagline,
      p.quantity,
      p.price,
      p.fulfillment || "auto",
      p.sort
    );
  }
}

function seedAdmin(d) {
  const existing = d.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
  if (existing) return;

  let email = process.env.ADMIN_EMAIL;
  let password = process.env.ADMIN_PASSWORD;
  const name = process.env.ADMIN_NAME || "BariFollow Admin";

  if (!email || !password) {
    if (IS_PROD) {
      throw new Error(
        "No admin account exists. Set ADMIN_EMAIL and ADMIN_PASSWORD (8+ chars) before first production boot."
      );
    }
    email = "admin@barifollow.local";
    password = "admin12345";
    console.warn(
      `[db] Dev admin created: ${email} / ${password} — set ADMIN_EMAIL and ADMIN_PASSWORD in production.`
    );
  }
  if (String(password).length < 8) {
    throw new Error("ADMIN_PASSWORD must be at least 8 characters.");
  }

  d.prepare(
    "INSERT INTO users (email, password_hash, name, role, status, created_at) VALUES (?, ?, ?, 'admin', 'active', ?)"
  ).run(String(email).trim().toLowerCase(), hashPasswordSync(password), name, nowIso());
}

function seedMockProvider(d) {
  const seedMock =
    process.env.SEED_MOCK === "1" ||
    (!IS_PROD && process.env.SEED_MOCK !== "0");
  if (!seedMock) return;

  const existing = d.prepare("SELECT id FROM providers WHERE kind = 'mock' LIMIT 1").get();
  if (existing) return;

  d.prepare(
    "INSERT INTO providers (name, kind, api_url, api_key_enc, priority, active, created_at) VALUES (?, 'mock', NULL, NULL, 900, 1, ?)"
  ).run("Mock panel (dev)", nowIso());
}

/* ── lifecycle ─────────────────────────────────────────────────────────── */

export function initDb() {
  if (db) return db;

  const file =
    process.env.DATABASE_PATH ||
    path.join(process.cwd(), "data", "barifollow.db");

  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }

  db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);

  seedPackages(db);
  seedMockProvider(db);
  seedAdmin(db);

  return db;
}

export function getDb() {
  if (!db) throw new Error("Database not initialised");
  return db;
}

/** Synchronous transaction. Do not nest. */
export function tx(fn) {
  const d = getDb();
  d.exec("BEGIN IMMEDIATE");
  try {
    const out = fn(d);
    d.exec("COMMIT");
    return out;
  } catch (err) {
    try {
      d.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    throw err;
  }
}

export function audit(actorId, actorType, action, target, detail, ip) {
  try {
    getDb()
      .prepare(
        "INSERT INTO audit (actor_id, actor_type, action, target, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        actorId == null ? null : Number(actorId),
        actorType,
        action,
        target == null ? null : String(target).slice(0, 120),
        detail == null ? null : String(detail).slice(0, 500),
        ip == null ? null : String(ip).slice(0, 80),
        nowIso()
      );
  } catch (err) {
    console.error("[audit] failed", err.message);
  }
}
