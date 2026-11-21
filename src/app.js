import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureCsrf,
  csrfValid,
  esc,
  HttpError,
  IS_PROD,
  sendHtml,
  sendJson,
} from "./util.js";
import { initDb } from "./db.js";
import { sessionUser } from "./auth.js";
import { balanceOf } from "./wallet.js";
import { storeRoutes } from "./pages.js";
import { adminRoutes } from "./adminApi.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_BODY = 256 * 1024;

const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "object-src 'none'",
].join("; ");

const STATIC = new Map([
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/script.js", ["script.js", "text/javascript; charset=utf-8"]],
  ["/store.css", ["public/store.css", "text/css; charset=utf-8"]],
  ["/store.js", ["public/store.js", "text/javascript; charset=utf-8"]],
  ["/admin.js", ["public/admin.js", "text/javascript; charset=utf-8"]],
]);

/* ── router ────────────────────────────────────────────────────────────── */

function compile(entries) {
  return entries.map(([method, pattern, handler]) => {
    const keys = [];
    const regex = new RegExp(
      "^" +
        pattern.replace(/:[A-Za-z]+/g, (m) => {
          keys.push(m.slice(1));
          return "([^/]+)";
        }) +
        "$"
    );
    return { method, regex, keys, handler };
  });
}

const ROUTES = compile([...storeRoutes, ...adminRoutes]);

function matchRoute(method, pathname) {
  const wanted = method === "HEAD" ? "GET" : method;
  for (const route of ROUTES) {
    if (route.method !== wanted) continue;
    const m = route.regex.exec(pathname);
    if (!m) continue;
    const params = {};
    route.keys.forEach((key, i) => {
      params[key] = decodeURIComponent(m[i + 1]);
    });
    return { handler: route.handler, params };
  }
  return null;
}

/* ── request body ──────────────────────────────────────────────────────── */

function readBody(req) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    return Promise.resolve({});
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let size = 0;
    const chunks = [];

    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        fail(new HttpError(413, "Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      const type = String(req.headers["content-type"] || "");
      try {
        if (type.includes("application/json")) {
          return resolve(JSON.parse(raw));
        }
        if (type.includes("application/x-www-form-urlencoded")) {
          return resolve(Object.fromEntries(new URLSearchParams(raw)));
        }
        return resolve({});
      } catch {
        return reject(new HttpError(400, "Malformed request body"));
      }
    });

    req.on("error", (err) => fail(err));
  });
}

/* ── responses ─────────────────────────────────────────────────────────── */

function setSecurityHeaders(res) {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "strict-origin-when-cross-origin");
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("content-security-policy", CSP);
  if (IS_PROD) {
    res.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
  }
}

function brandMark(size = 30) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true">
    <rect width="32" height="32" rx="9" fill="#d2ff57"/>
    <path d="M10 22 22 10M22 10h-8M22 10v8" stroke="#0a0a0b" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  </svg>`;
}

function errorPage(status, message) {
  const title =
    status === 404
      ? "Nothing here."
      : status === 403
        ? "No access."
        : status === 401
          ? "Sign in first."
          : "Something went wrong.";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — BariFollow</title>
<meta name="theme-color" content="#0a0a0b">
<link rel="stylesheet" href="/store.css">
</head>
<body class="store-body">
<header class="topbar"><div class="shell topbar__in">
  <a class="brand" href="/">${brandMark()}<span class="brand__word">Bari<span>Follow</span></span></a>
</div></header>
<main class="shell page">
  <section class="errorpage">
    <p class="mono errorpage__code">${status}</p>
    <h1>${esc(title)}</h1>
    <p>${esc(message)}</p>
    <div class="hero-actions">
      <a class="btn btn--lime" href="/store">Back to store</a>
      <a class="btn btn--ghost" href="/">Home</a>
    </div>
  </section>
</main>
</body>
</html>`;
}

/* ── static ────────────────────────────────────────────────────────────── */

function serveStatic(req, res, pathname) {
  if (pathname === "/store/config.js") {
    res.writeHead(200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end('window.BF_STORE_BASE = "/store";\n');
    return true;
  }

  if (pathname === "/robots.txt") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(
      "User-agent: *\nDisallow: /store/admin\nDisallow: /store/account\nDisallow: /store/checkout\nDisallow: /api/\n"
    );
    return true;
  }

  let entry = STATIC.get(pathname);
  if (entry) {
    const [file, type] = entry;
    return sendFile(res, path.join(ROOT, file), type);
  }

  const asset = /^\/assets\/([A-Za-z0-9][A-Za-z0-9._-]*\.(?:jpg|jpeg|png|webp|svg|avif))$/.exec(
    pathname
  );
  if (asset) {
    const type = /\.png$/i.test(asset[1])
      ? "image/png"
      : /\.svg$/i.test(asset[1])
        ? "image/svg+xml"
        : /\.webp$/i.test(asset[1])
          ? "image/webp"
          : /\.avif$/i.test(asset[1])
            ? "image/avif"
            : "image/jpeg";
    return sendFile(res, path.join(ROOT, "assets", asset[1]), type);
  }

  return false;
}

function sendFile(res, absolute, type) {
  let body;
  try {
    body = fs.readFileSync(absolute);
  } catch {
    return false;
  }
  res.writeHead(200, {
    "content-type": type,
    "cache-control": "public, max-age=86400",
    "content-length": body.length,
  });
  res.end(body);
  return true;
}

function landingPage(res) {
  let html;
  try {
    html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  } catch {
    return sendHtml(res, errorPage(500, "The landing page is missing."), 500);
  }
  const tag = '<script src="script.js"></script>';
  if (html.includes(tag)) {
    html = html.replace(
      tag,
      '<script src="/store/config.js"></script>\n<script src="script.js"></script>'
    );
  }
  res.setHeader("cache-control", "no-cache");
  sendHtml(res, html);
}

/* ── server ────────────────────────────────────────────────────────────── */

export function createServer() {
  if (IS_PROD) {
    const secret = String(process.env.APP_SECRET || "");
    if (secret.length < 32) {
      throw new Error(
        "APP_SECRET must be set to a random string of at least 32 characters in production. Generate one with: openssl rand -hex 32"
      );
    }
  }

  initDb();

  return http.createServer(async (req, res) => {
    const started = Date.now();
    setSecurityHeaders(res);

    let pathname = "/";
    let isApi = false;

    try {
      const url = new URL(req.url, "http://localhost");
      pathname = url.pathname;
      if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
      isApi = pathname.startsWith("/api/");

      if (req.method === "GET" || req.method === "HEAD") {
        if (serveStatic(req, res, pathname)) return;
        if (pathname === "/" || pathname === "/index.html") return landingPage(res);
        if (pathname === "/healthz") {
          return sendJson(res, { ok: true, uptime: Math.round(process.uptime()) });
        }
      }

      const route = matchRoute(req.method, pathname);
      if (!route) {
        if (isApi) return sendJson(res, { error: "Not found" }, 404);
        return sendHtml(res, errorPage(404, "That page doesn't exist."), 404);
      }

      const body = await readBody(req);
      const user = sessionUser(req);
      req.user = user;
      const csrf = ensureCsrf(req, res);

      if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !csrfValid(req, body)) {
        throw new HttpError(403, "Invalid or missing CSRF token. Reload the page and try again.");
      }

      const ctx = {
        req,
        res,
        url,
        params: route.params,
        body,
        user,
        csrf,
      };
      if (user) ctx.balance = balanceOf(user.id);

      await route.handler(ctx);
    } catch (err) {
      if (res.writableEnded) return;

      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) {
        console.error(`[http] ${req.method} ${pathname} → ${status}: ${err.stack || err.message}`);
      }

      if (isApi || String(req.headers.accept || "").includes("application/json")) {
        return sendJson(
          res,
          { error: status >= 500 ? "Server error" : err.message },
          status
        );
      }

      const message =
        status >= 500
          ? "Something went wrong on our side. Try again in a moment."
          : err.message;
      return sendHtml(res, errorPage(status, message), status);
    } finally {
      if (process.env.NODE_ENV !== "test" && !isApi && pathname !== "/healthz") {
        const ms = Date.now() - started;
        if (ms > 1500) console.log(`[slow] ${req.method} ${pathname} ${ms}ms`);
      }
    }
  });
}
