import { getDb } from "./db.js";
import {
  clearCookie,
  hashPassword,
  HttpError,
  nowIso,
  parseCookies,
  randomToken,
  setCookie,
  sha256,
  verifyPassword,
} from "./util.js";

const SESSION_DAYS = 30;
const SESSION_SECONDS = SESSION_DAYS * 24 * 60 * 60;

function validEmail(value) {
  const v = String(value ?? "").trim().toLowerCase();
  if (v.length < 3 || v.length > 190) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) return null;
  return v;
}

function validName(value) {
  const v = String(value ?? "").trim().replace(/\s+/g, " ");
  if (v.length < 1 || v.length > 60) return null;
  return v;
}

/* ── sessions ──────────────────────────────────────────────────────────── */

export function createSession(userId, req, res) {
  const token = randomToken(32);
  const db = getDb();
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_SECONDS * 1000);

  // opportunistic cleanup
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now.toISOString());

  db.prepare(
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(
    sha256(token),
    Number(userId),
    now.toISOString(),
    expires.toISOString(),
    null,
    String(req.headers["user-agent"] || "").slice(0, 240) || null
  );

  setCookie(res, "bf_sid", token, { httpOnly: true, maxAge: SESSION_SECONDS });
  return token;
}

export function sessionUser(req) {
  const token = parseCookies(req.headers.cookie).bf_sid;
  if (!token || !/^[a-f0-9]{32,128}$/.test(token)) return null;

  const db = getDb();
  const row = db
    .prepare(
      `SELECT u.id, u.email, u.name, u.role, u.status, u.created_at, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`
    )
    .get(sha256(token));

  if (!row) return null;
  if (row.expires_at <= nowIso()) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
    return null;
  }
  if (row.status !== "active") return null;

  return {
    id: Number(row.id),
    email: row.email,
    name: row.name,
    role: row.role,
    status: row.status,
    created_at: row.created_at,
  };
}

export function destroySession(req, res) {
  const token = parseCookies(req.headers.cookie).bf_sid;
  if (token) getDb().prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
  clearCookie(res, "bf_sid");
}

export function requireUser(req) {
  if (!req.user) throw new HttpError(401, "Sign in to continue");
  return req.user;
}

export function requireAdmin(req) {
  if (!req.user) throw new HttpError(401, "Sign in to continue");
  if (req.user.role !== "admin") throw new HttpError(403, "Admin access only");
  return req.user;
}

/* ── accounts ──────────────────────────────────────────────────────────── */

export async function registerUser({ email, password, name }) {
  const cleanEmail = validEmail(email);
  if (!cleanEmail) throw new HttpError(400, "Enter a valid email address");
  const cleanName = validName(name);
  if (!cleanName) throw new HttpError(400, "Enter your name");
  const pass = String(password ?? "");
  if (pass.length < 8) throw new HttpError(400, "Password must be at least 8 characters");
  if (pass.length > 200) throw new HttpError(400, "Password is too long");

  const db = getDb();
  if (db.prepare("SELECT id FROM users WHERE email = ?").get(cleanEmail)) {
    throw new HttpError(409, "An account with that email already exists");
  }

  const hash = await hashPassword(pass);
  try {
    const info = db
      .prepare(
        "INSERT INTO users (email, password_hash, name, role, status, created_at) VALUES (?, ?, ?, 'user', 'active', ?)"
      )
      .run(cleanEmail, hash, cleanName, nowIso());
    return db.prepare("SELECT id, email, name, role, status, created_at FROM users WHERE id = ?").get(
      Number(info.lastInsertRowid)
    );
  } catch (err) {
    if (/UNIQUE/i.test(String(err.message))) {
      throw new HttpError(409, "An account with that email already exists");
    }
    throw err;
  }
}

export async function authenticate(email, password) {
  const cleanEmail = validEmail(email);
  const pass = String(password ?? "");
  if (!cleanEmail || !pass) return null;

  const user = getDb()
    .prepare("SELECT * FROM users WHERE email = ?")
    .get(cleanEmail);

  // Run a dummy verification so a missing account and a wrong password take similar time.
  if (!user) {
    await verifyPassword(pass, "scrypt$16384$8$1$00000000000000000000000000000000$" + "0".repeat(128));
    return null;
  }
  if (user.status !== "active") return null;

  const ok = await verifyPassword(pass, user.password_hash);
  if (!ok) return null;

  return {
    id: Number(user.id),
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    created_at: user.created_at,
  };
}
