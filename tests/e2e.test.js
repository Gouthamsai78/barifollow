import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/* Environment must be set before importing the app (env is read at createServer). */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "barifollow-test-"));
process.env.NODE_ENV = "test";
process.env.PORT = "0";
process.env.APP_SECRET = "test-secret-please-change-0123456789";
process.env.DATABASE_PATH = path.join(TMP, "test.db");
process.env.ADMIN_EMAIL = "admin@test.local";
process.env.ADMIN_PASSWORD = "admin-test-pass";
process.env.ADMIN_NAME = "Test Admin";
process.env.SEED_MOCK = "1";
process.env.MOCK_COMPLETE_SECONDS = "0";
process.env.AUTO_SYNC = "0";
process.env.UPI_ID = "barifollow@test";
process.env.UPI_NAME = "BariFollow Test";
process.env.SUPPORT_WHATSAPP = "917877311536";

const { createServer } = await import("../src/app.js");

const server = createServer();
await new Promise((resolve) => server.listen(0, resolve));
const base = `http://127.0.0.1:${server.address().port}`;

function makeClient(label) {
  const jar = new Map();

  async function request(method, urlPath, options = {}) {
    const { form, json, csrf = true, headers = {} } = options;
    const h = { ...headers };
    let body;

    if (form) {
      const params = new URLSearchParams(form);
      if (csrf && jar.get("bf_csrf") && !params.has("_csrf")) {
        params.set("_csrf", jar.get("bf_csrf"));
      }
      h["content-type"] = "application/x-www-form-urlencoded";
      body = params.toString();
    } else if (json !== undefined) {
      h["content-type"] = "application/json";
      if (csrf) h["x-csrf-token"] = jar.get("bf_csrf") || "";
      body = JSON.stringify(json);
    }

    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    if (cookie) h.cookie = cookie;

    const res = await fetch(base + urlPath, {
      method,
      headers: h,
      body,
      redirect: "manual",
    });

    for (const setCookie of res.headers.getSetCookie()) {
      const pair = setCookie.split(";")[0];
      const i = pair.indexOf("=");
      if (i < 0) continue;
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (!value) jar.delete(name);
      else jar.set(name, decodeURIComponent(value));
    }

    const text = await res.text();
    return {
      label,
      status: res.status,
      location: res.headers.get("location"),
      text,
      json() {
        return JSON.parse(text);
      },
    };
  }

  return {
    request,
    jar,
    get csrf() {
      return jar.get("bf_csrf") || "";
    },
  };
}

test("BariFollow Phase 1 end-to-end", async (t) => {
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  const user = makeClient("user");
  const admin = makeClient("admin");

  await t.test("registration, session and CSRF cookie", async () => {
    const loginPage = await user.request("GET", "/store/login");
    assert.equal(loginPage.status, 200);
    assert.ok(user.csrf, "csrf cookie should be issued");

    const register = await user.request("POST", "/store/register", {
      form: {
        name: "Test User",
        email: "user@test.local",
        password: "user-test-pass",
      },
    });
    assert.equal(register.status, 303);
    assert.match(register.location, /^\/store\/account/);

    const me = await user.request("GET", "/api/me");
    assert.equal(me.status, 200);
    const body = me.json();
    assert.equal(body.user.email, "user@test.local");
    assert.equal(body.balancePaise, 0);
    assert.equal(body.orders.length, 0);
  });

  await t.test("top-up requires admin approval before wallet credit", async () => {
    const submit = await user.request("POST", "/store/topup", {
      form: { amount: "500", utr: "TESTUTR00001" },
    });
    assert.equal(submit.status, 303);
    assert.match(submit.location, /msg=topup_submitted/);

    let me = (await user.request("GET", "/api/me")).json();
    assert.equal(me.balancePaise, 0, "pending top-up must not credit the wallet");

    const loginPage = await admin.request("GET", "/store/login");
    assert.equal(loginPage.status, 200);

    const login = await admin.request("POST", "/store/login", {
      form: { email: "admin@test.local", password: "admin-test-pass" },
    });
    assert.equal(login.status, 303);
    assert.match(login.location, /^\/store\/account/);

    const pendingRes = await admin.request("GET", "/api/admin/topups?status=pending");
    assert.equal(pendingRes.status, 200);
    const pending = pendingRes.json().topups.find((x) => x.utr === "TESTUTR00001");
    assert.ok(pending, "pending top-up should be listed");
    assert.equal(pending.amountPaise, 50000);

    const approve = await admin.request("POST", `/api/admin/topups/${pending.id}/approve`, {
      method: "POST",
      json: { note: "UTR verified" },
    });
    assert.equal(approve.status, 200);

    me = (await user.request("GET", "/api/me")).json();
    assert.equal(me.balancePaise, 50000);
  });

  await t.test("duplicate UTR is rejected", async () => {
    const dupe = await user.request("POST", "/store/topup", {
      form: { amount: "500", utr: "TESTUTR00001" },
    });
    assert.equal(dupe.status, 303);
    assert.match(dupe.location, /err=duplicate_utr/);

    const pending = (await admin.request("GET", "/api/admin/topups?status=pending")).json();
    assert.equal(pending.topups.length, 0);
  });

  let orderPublicId = null;

  await t.test("checkout debits the wallet and dispatches to the provider", async () => {
    const checkout = await user.request("GET", "/store/checkout?package=followers-5k");
    assert.equal(checkout.status, 200);
    assert.match(checkout.text, /5,000 followers/);

    const place = await user.request("POST", "/store/checkout", {
      form: { package: "followers-5k", username: "@test.user" },
    });
    assert.equal(place.status, 303);
    assert.match(place.location, /^\/store\/orders\/BF-/);
    orderPublicId = place.location.split("?")[0].split("/").pop();

    const me = (await user.request("GET", "/api/me")).json();
    assert.equal(me.balancePaise, 32000, "₹500 − ₹180 = ₹320");
    assert.equal(me.orders[0].publicId, orderPublicId);
    assert.equal(me.orders[0].username, "test.user");
    assert.equal(me.orders[0].status, "submitted");
    assert.equal(me.orders[0].pricePaise, 18000);
  });

  await t.test("manual sync completes a mock order", async () => {
    const sync = await user.request("POST", `/store/orders/${orderPublicId}/sync`, {
      method: "POST",
      form: {},
    });
    assert.equal(sync.status, 303);
    assert.match(sync.location, /msg=status_refreshed/);

    const me = (await user.request("GET", "/api/me")).json();
    assert.equal(me.orders[0].status, "completed");
    assert.equal(me.balancePaise, 32000);
  });

  await t.test("missing CSRF token is refused", async () => {
    const res = await user.request("POST", "/store/topup", {
      form: { amount: "100", utr: "NOCSRF0001" },
      csrf: false,
    });
    assert.equal(res.status, 403);
  });

  await t.test("customer cannot reach admin APIs", async () => {
    const res = await user.request("GET", "/api/admin/summary");
    assert.equal(res.status, 403);
  });

  await t.test("insufficient balance is refused without creating an order", async () => {
    const res = await user.request("POST", "/store/checkout", {
      form: { package: "followers-500k", username: "test.user" },
    });
    assert.equal(res.status, 303);
    assert.match(res.location, /err=insufficient/);

    const me = (await user.request("GET", "/api/me")).json();
    assert.equal(me.balancePaise, 32000);
    assert.equal(me.orders.length, 1, "no order row should be created");
  });

  let mockProviderId = null;

  await t.test("provider failure auto-refunds the order", async () => {
    const providers = (await admin.request("GET", "/api/admin/providers")).json().providers;
    const mock = providers.find((p) => p.kind === "mock");
    assert.ok(mock);
    mockProviderId = mock.id;

    const testCall = await admin.request("POST", `/api/admin/providers/${mock.id}/test`, {
      method: "POST",
      json: {},
    });
    assert.equal(testCall.status, 200);
    assert.equal(testCall.json().ok, true);

    const disable = await admin.request("PATCH", `/api/admin/providers/${mock.id}`, {
      method: "PATCH",
      json: { active: false },
    });
    assert.equal(disable.status, 200);

    const place = await user.request("POST", "/store/checkout", {
      form: { package: "followers-10k", username: "test.user" },
    });
    assert.equal(place.status, 303);
    assert.match(place.location, /^\/store\/orders\//);

    const me = (await user.request("GET", "/api/me")).json();
    const failed = me.orders[0];
    assert.equal(failed.status, "refunded");
    assert.equal(failed.pricePaise, 28000);
    assert.equal(me.balancePaise, 32000, "refund must restore the full price");
    assert.match(failed.note || "", /No active provider/i);

    const enable = await admin.request("PATCH", `/api/admin/providers/${mock.id}`, {
      method: "PATCH",
      json: { active: true },
    });
    assert.equal(enable.status, 200);
  });

  let manualOrderId = null;

  await t.test("manual fulfilment flow and admin completion", async () => {
    const topup = await user.request("POST", "/store/topup", {
      form: { amount: "500", utr: "TESTUTR00002" },
    });
    assert.equal(topup.status, 303);

    const pending = (await admin.request("GET", "/api/admin/topups?status=pending")).json().topups;
    const row = pending.find((x) => x.utr === "TESTUTR00002");
    assert.ok(row);
    await admin.request("POST", `/api/admin/topups/${row.id}/approve`, {
      method: "POST",
      json: { note: "ok" },
    });

    const place = await user.request("POST", "/store/checkout", {
      form: { package: "blue-tick", username: "test.user" },
    });
    assert.equal(place.status, 303);
    const publicId = place.location.split("?")[0].split("/").pop();

    let me = (await user.request("GET", "/api/me")).json();
    const tick = me.orders.find((o) => o.publicId === publicId);
    assert.ok(tick);
    assert.equal(tick.status, "manual_review");
    assert.equal(me.balancePaise, 15100, "₹820 − ₹669");
    manualOrderId = tick.id;

    const complete = await admin.request("POST", `/api/admin/orders/${manualOrderId}/complete`, {
      method: "POST",
      json: { note: "Documents submitted" },
    });
    assert.equal(complete.status, 200);
    assert.equal(complete.json().order.status, "completed");

    me = (await user.request("GET", "/api/me")).json();
    assert.equal(me.orders.find((o) => o.id === manualOrderId).status, "completed");
  });

  await t.test("admin refund credits the wallet exactly once", async () => {
    const refund = await admin.request("POST", `/api/admin/orders/${manualOrderId}/refund`, {
      method: "POST",
      json: { reason: "Test refund" },
    });
    assert.equal(refund.status, 200);
    assert.equal(refund.json().order.status, "refunded");

    const second = await admin.request("POST", `/api/admin/orders/${manualOrderId}/refund`, {
      method: "POST",
      json: { reason: "again" },
    });
    assert.equal(second.status, 409, "double refund must be refused");

    const me = (await user.request("GET", "/api/me")).json();
    assert.equal(me.balancePaise, 82000);
    assert.equal(me.orders.find((o) => o.id === manualOrderId).status, "refunded");
  });

  await t.test("admin can map a package to a provider service", async () => {
    const packages = (await admin.request("GET", "/api/admin/packages")).json().packages;
    const fiveK = packages.find((p) => p.slug === "followers-5k");
    assert.ok(fiveK);
    assert.equal(fiveK.pricePaise, 18000);

    const update = await admin.request("PATCH", `/api/admin/packages/${fiveK.id}`, {
      method: "PATCH",
      json: { providerService: "9999" },
    });
    assert.equal(update.status, 200);

    const after = (await admin.request("GET", "/api/admin/packages")).json().packages;
    assert.equal(after.find((p) => p.slug === "followers-5k").providerService, "9999");
  });

  await t.test("provider creation validates credentials", async () => {
    const bad = await admin.request("POST", "/api/admin/providers", {
      method: "POST",
      json: { name: "Broken panel", kind: "smm" },
    });
    assert.equal(bad.status, 400);

    const good = await admin.request("POST", "/api/admin/providers", {
      method: "POST",
      json: {
        name: "Test panel",
        kind: "smm",
        apiUrl: "https://panel.example/api/v2",
        apiKey: "secret-key",
        priority: 10,
      },
    });
    assert.equal(good.status, 200);
    assert.equal(good.json().provider.hasKey, true);
    assert.equal(good.json().provider.apiKey, undefined, "API key must never be returned");
  });

  await t.test("summary reflects revenue and wallet liability", async () => {
    const summary = (await admin.request("GET", "/api/admin/summary")).json();
    assert.ok(summary.revenuePaise >= 18000);
    assert.equal(summary.users, 2);
    assert.ok(summary.walletLiabilityPaise >= 82000);
    assert.ok(summary.ordersByStatus.completed >= 1);
  });

  await t.test("unknown admin route and bad credentials fail closed", async () => {
    const notFound = await admin.request("GET", "/api/admin/nope");
    assert.equal(notFound.status, 404);

    const fresh = makeClient("wrong");
    await fresh.request("GET", "/store/login");
    const attempt = await fresh.request("POST", "/store/login", {
      form: { email: "admin@test.local", password: "wrong-password" },
    });
    assert.equal(attempt.status, 303);
    assert.match(attempt.location, /err=invalid/);
  });
});
