import crypto from "node:crypto";

export const IS_PROD = process.env.NODE_ENV === "production";
export const APP_SECRET =
  process.env.APP_SECRET || "dev-only-insecure-secret-change-me";

export function nowIso() {
  return new Date().toISOString();
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

export function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/* ── money ─────────────────────────────────────────────────────────────── */

const inrFmt = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

export function inr(paise) {
  return "₹" + inrFmt.format(Math.round(Number(paise) || 0) / 100);
}

/** "₹1,099.50" / "1099.5" → 109950 (integer paise). Returns null if invalid. */
export function parseMoney(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    return Math.round(value * 100);
  }
  const clean = String(value ?? "").trim().replace(/[₹,\s]/g, "");
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(clean)) return null;
  return Math.round(Number(clean) * 100);
}

export function rupeesInput(paise) {
  const n = Number(paise) || 0;
  return (n / 100).toFixed(n % 100 === 0 ? 0 : 2);
}

/* ── html / http ───────────────────────────────────────────────────────── */

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function sendHtml(res, body, status = 200) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}

export function sendJson(res, data, status = 200) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(data));
}

export function redirect(res, location, status = 303) {
  res.writeHead(status, { location });
  res.end();
}

export function parseCookies(header = "") {
  const out = {};
  for (const part of String(header).split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[k] = part.slice(i + 1).trim();
    }
  }
  return out;
}

export function setCookie(res, name, value, opts = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path || "/"}`];
  if (opts.maxAge != null) bits.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.httpOnly) bits.push("HttpOnly");
  bits.push("SameSite=Lax");
  if (IS_PROD) bits.push("Secure");
  const existing = res.getHeader("Set-Cookie");
  const list = existing ? (Array.isArray(existing) ? existing : [existing]) : [];
  res.setHeader("Set-Cookie", [...list, bits.join("; ")]);
}

export function clearCookie(res, name) {
  setCookie(res, name, "", { maxAge: 0 });
}

export function ensureCsrf(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  let token = cookies.bf_csrf;
  if (!token || !/^[a-f0-9]{32,64}$/.test(token)) {
    token = randomToken(24);
    setCookie(res, "bf_csrf", token, { maxAge: 60 * 60 * 24 * 30, httpOnly: false });
  }
  return token;
}

export function csrfValid(req, body) {
  const cookie = parseCookies(req.headers.cookie).bf_csrf;
  const sent = body?._csrf || req.headers["x-csrf-token"];
  return Boolean(cookie && sent && safeEqual(cookie, sent));
}

export function clientIp(req) {
  if (process.env.TRUST_PROXY === "1") {
    const fwd = req.headers["x-forwarded-for"];
    if (fwd) return String(fwd).split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

export function safeNext(next) {
  const v = String(next || "");
  if (!v.startsWith("/") || v.startsWith("//") || v.includes("\\")) return null;
  if (v.includes("\n") || v.includes("\r")) return null;
  return v;
}

/* ── rate limits (per-process) ─────────────────────────────────────────── */

const buckets = new Map();

export function rateLimit(key, max, windowMs) {
  const t = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < t) {
    b = { count: 0, reset: t + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  if (buckets.size > 8000) {
    for (const [k, v] of buckets) if (v.reset < t) buckets.delete(k);
  }
  return b.count <= max;
}

/* ── passwords ─────────────────────────────────────────────────────────── */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function scrypt(password, salt, opts) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      String(password),
      salt,
      opts.keylen,
      { N: opts.N, r: opts.r, p: opts.p, maxmem: 96 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key))
    );
  });
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const { N, r, p, keylen } = SCRYPT;
  const hash = await scrypt(password, salt, { N, r, p, keylen });
  return `scrypt$${N}$${r}$${p}$${salt}$${hash.toString("hex")}`;
}

/** Blocking variant for first-boot seeding only. */
export function hashPasswordSync(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const { N, r, p, keylen } = SCRYPT;
  const hash = crypto.scryptSync(String(password), salt, keylen, {
    N,
    r,
    p,
    maxmem: 96 * 1024 * 1024,
  });
  return `scrypt$${N}$${r}$${p}$${salt}$${hash.toString("hex")}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored).split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, N, r, p, salt, hashHex] = parts;
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scrypt(password, salt, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    keylen: expected.length,
  });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/* ── provider secrets (AES-256-GCM at rest) ────────────────────────────── */

const secretKey = crypto.scryptSync(APP_SECRET, "barifollow:providers", 32);

export function encryptSecret(plain) {
  if (!plain) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secretKey, iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${enc.toString("base64")}`;
}

export function decryptSecret(payload) {
  if (!payload) return "";
  try {
    const [ivB64, tagB64, dataB64] = String(payload).split(".");
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      secretKey,
      Buffer.from(ivB64, "base64")
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return "";
  }
}

/* ── misc ──────────────────────────────────────────────────────────────── */

export function normalizeUsername(raw) {
  const v = String(raw ?? "").trim().replace(/^@+/, "");
  if (!/^[A-Za-z0-9._]{1,30}$/.test(v)) return null;
  if (v.startsWith(".") || v.endsWith(".") || v.includes("..")) return null;
  return v;
}

export function truncate(value, n = 320) {
  const s = String(value ?? "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}

export function displayDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
