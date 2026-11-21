/* BariFollow — admin dashboard (vanilla, no build step) */

(() => {
  const root = document.getElementById("adminPanel");
  const tabs = document.getElementById("adminTabs");
  const toastEl = document.getElementById("adminToast");
  if (!root || !tabs) return;

  const STATUS = {
    queued: ["Queued", "is-wait"],
    submitted: ["Submitted", "is-live"],
    in_progress: ["In progress", "is-live"],
    completed: ["Completed", "is-done"],
    partial: ["Partial", "is-warn"],
    manual_review: ["Manual review", "is-warn"],
    refunded: ["Refunded", "is-muted"],
    cancelled: ["Cancelled", "is-muted"],
    failed: ["Failed", "is-bad"],
  };

  const nf = new Intl.NumberFormat("en-IN");
  let current = "overview";
  let toastTimer = null;

  const csrf = () =>
    decodeURIComponent(
      (document.cookie.match(/(?:^|;\s*)bf_csrf=([^;]+)/) || [])[1] || ""
    );

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[c]);
  }

  function inr(paise) {
    const n = Number(paise || 0) / 100;
    return "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function pill(status) {
    const [label, cls] = STATUS[status] || [status, "is-muted"];
    return `<span class="pill ${cls}">${esc(label)}</span>`;
  }

  function toast(message, bad = false) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.style.borderColor = bad ? "rgba(255,143,122,.45)" : "rgba(210,255,87,.35)";
    toastEl.style.color = bad ? "#ffc4b8" : "#e6ffb0";
    toastEl.classList.add("is-on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("is-on"), 3400);
  }

  async function api(path, { method = "GET", body } = {}) {
    const headers = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (method !== "GET") headers["x-csrf-token"] = csrf();

    const res = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    let data = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON */
    }

    if (res.status === 401) {
      window.location.href = "/store/login?next=/store/admin";
      throw new Error("Sign in required");
    }
    if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
    return data;
  }

  function setLoading(message = "Loading…") {
    root.innerHTML = `<p class="muted">${esc(message)}</p>`;
  }

  function fail(err) {
    root.innerHTML = `<div class="flash flash--err">${esc(err.message || "Something failed")}</div>
      <button class="mini-btn" data-retry type="button">Try again</button>`;
  }

  /* ── overview ──────────────────────────────────────────────────────────── */

  async function loadOverview() {
    setLoading();
    const d = await api("/api/admin/summary");
    const counts = d.ordersByStatus || {};
    const pending = counts.manual_review || 0;
    const live = (counts.submitted || 0) + (counts.in_progress || 0);
    const completed = counts.completed || 0;

    const recent = (d.recentOrders || [])
      .map(
        (o) => `<tr>
          <td class="cell-id">${esc(o.publicId)}<span class="cell-sub">${esc(fmtDate(o.createdAt))}</span></td>
          <td>${esc(o.userEmail || "—")}</td>
          <td>${esc(o.packageName || "")}<span class="cell-sub mono mono--raw">@${esc(o.username)}</span></td>
          <td class="cell-num">${inr(o.pricePaise)}</td>
          <td>${pill(o.status)}</td>
        </tr>`
      )
      .join("");

    root.innerHTML = `
      <div class="kpis">
        <article class="kpi kpi--lime">
          <span>Revenue</span><strong>${inr(d.revenuePaise)}</strong>
          <p>Paid orders, net of refunds</p>
        </article>
        <article class="kpi">
          <span>Wallet liability</span><strong>${inr(d.walletLiabilityPaise)}</strong>
          <p>Unspent customer balances</p>
        </article>
        <article class="kpi">
          <span>Pending top-ups</span><strong>${nf.format(d.topups?.count || 0)}</strong>
          <p>${inr(d.topups?.amountPaise || 0)} awaiting UTR check</p>
        </article>
        <article class="kpi">
          <span>Orders</span><strong>${nf.format(live)}</strong>
          <p>${nf.format(pending)} manual · ${nf.format(completed)} completed</p>
        </article>
      </div>

      <div class="panel">
        <div class="panel__head">
          <h2 class="panel__title">Recent orders</h2>
          <button class="mini-btn" data-goto="orders" type="button">All orders</button>
        </div>
        <div class="tablewrap">
          <table class="table admin-table">
            <thead><tr><th>Order</th><th>Customer</th><th>Package</th><th>Amount</th><th>Status</th></tr></thead>
            <tbody>${recent || `<tr><td colspan="5" class="empty">No orders yet.</td></tr>`}</tbody>
          </table>
        </div>
      </div>

      <div class="panel">
        <div class="panel__head">
          <h2 class="panel__title">Queue</h2>
          <div class="row-actions">
            <button class="mini-btn" data-goto="topups" type="button">Review top-ups</button>
            <button class="mini-btn" data-goto="providers" type="button">Providers</button>
          </div>
        </div>
        <p class="admin-note">${nf.format(d.users || 0)} customers · ${nf.format(d.activeProviders || 0)}
        active provider${Number(d.activeProviders) === 1 ? "" : "s"}. Top-ups are credited only after
        you match the UTR against the bank/UPI statement.</p>
      </div>`;
  }

  /* ── orders ────────────────────────────────────────────────────────────── */

  async function loadOrders() {
    setLoading();
    const status = document.getElementById("orderFilter")?.value || "";
    const q = document.getElementById("orderSearch")?.value || "";
    const query = new URLSearchParams();
    if (status) query.set("status", status);
    if (q) query.set("q", q);

    const d = await api(`/api/admin/orders?${query.toString()}`);
    const rows = (d.orders || [])
      .map((o) => {
        const actions = [];
        if (o.status === "submitted" || o.status === "in_progress") {
          actions.push(`<button class="mini-btn" data-order-action="sync" data-id="${o.id}" type="button">Sync</button>`);
        }
        if (o.status !== "completed" && !o.refundedAt) {
          actions.push(`<button class="mini-btn mini-btn--lime" data-order-action="complete" data-id="${o.id}" type="button">Complete</button>`);
        }
        if (!o.refundedAt) {
          actions.push(`<button class="mini-btn mini-btn--bad" data-order-action="refund" data-id="${o.id}" type="button">Refund</button>`);
        }
        return `<tr>
          <td class="cell-id">${esc(o.publicId)}<span class="cell-sub">${esc(fmtDate(o.createdAt))}</span></td>
          <td>${esc(o.userEmail || "—")}<span class="cell-sub">${esc(o.userName || "")}</span></td>
          <td>${esc(o.packageName || "")}<span class="cell-sub mono mono--raw">@${esc(o.username)}</span></td>
          <td class="cell-num">${inr(o.pricePaise)}</td>
          <td>${pill(o.status)}${o.providerStatus ? `<span class="cell-sub">${esc(o.providerStatus)}</span>` : ""}</td>
          <td class="cell-num">${o.remains == null ? "—" : esc(o.remains)}</td>
          <td><div class="row-actions">${actions.join("") || "—"}</div></td>
        </tr>`;
      })
      .join("");

    root.innerHTML = `
      <div class="admin-toolbar">
        <select class="input input--sm" id="orderFilter">
          <option value="">All statuses</option>
          ${["queued", "submitted", "in_progress", "completed", "partial", "manual_review", "refunded", "cancelled"]
            .map((s) => `<option value="${s}" ${s === status ? "selected" : ""}>${STATUS[s]?.[0] || s}</option>`)
            .join("")}
        </select>
        <input class="input input--sm" id="orderSearch" placeholder="Search order, username or email" value="${esc(q)}">
        <button class="mini-btn" data-orders-refresh type="button">Refresh</button>
      </div>
      <div class="tablewrap">
        <table class="table admin-table">
          <thead><tr><th>Order</th><th>Customer</th><th>Package</th><th>Amount</th><th>Status</th><th>Remains</th><th>Actions</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="7" class="empty">No orders match.</td></tr>`}</tbody>
        </table>
      </div>`;

    document.getElementById("orderFilter")?.addEventListener("change", () => {
      loadOrders().catch(fail);
    });
    document.getElementById("orderSearch")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        loadOrders().catch(fail);
      }
    });
    root.querySelector("[data-orders-refresh]")?.addEventListener("click", () => {
      loadOrders().catch(fail);
    });
  }

  /* ── top-ups ───────────────────────────────────────────────────────────── */

  async function loadTopups() {
    setLoading();
    const status = document.getElementById("topupFilter")?.value || "";
    const d = await api(`/api/admin/topups${status ? `?status=${encodeURIComponent(status)}` : ""}`);
    const rows = (d.topups || [])
      .map((t) => {
        const actions =
          t.status === "pending"
            ? `<div class="row-actions">
                 <button class="mini-btn mini-btn--lime" data-topup-action="approve" data-id="${t.id}" type="button">Approve</button>
                 <button class="mini-btn mini-btn--bad" data-topup-action="reject" data-id="${t.id}" type="button">Reject</button>
               </div>`
            : "—";
        return `<tr>
          <td class="cell-id">${esc(t.publicId)}<span class="cell-sub">${esc(fmtDate(t.createdAt))}</span></td>
          <td>${esc(t.userEmail || "—")}<span class="cell-sub">${esc(t.userName || "")}</span></td>
          <td class="cell-num">${inr(t.amountPaise)}</td>
          <td class="cell-id">${esc(t.utr)}</td>
          <td>${t.status === "pending" ? `<span class="pill is-warn">Pending</span>` : t.status === "approved" ? `<span class="pill is-done">Approved</span>` : `<span class="pill is-muted">Rejected</span>`}</td>
          <td>${actions}</td>
        </tr>`;
      })
      .join("");

    root.innerHTML = `
      <div class="admin-toolbar">
        <select class="input input--sm" id="topupFilter">
          <option value="">All</option>
          ${["pending", "approved", "rejected"].map((s) => `<option value="${s}" ${s === status ? "selected" : ""}>${s}</option>`).join("")}
        </select>
        <button class="mini-btn" data-topups-refresh type="button">Refresh</button>
      </div>
      <p class="admin-note" style="margin-bottom:14px">Match each UTR against the UPI statement before approving. Approving credits the wallet immediately and cannot be undone from this screen — refund the customer's order instead if it was a mistake.</p>
      <div class="tablewrap">
        <table class="table admin-table">
          <thead><tr><th>Ref</th><th>Customer</th><th>Amount</th><th>UTR</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="6" class="empty">No top-ups.</td></tr>`}</tbody>
        </table>
      </div>`;

    document.getElementById("topupFilter")?.addEventListener("change", () => {
      loadTopups().catch(fail);
    });
    root.querySelector("[data-topups-refresh]")?.addEventListener("click", () => {
      loadTopups().catch(fail);
    });
  }

  /* ── providers ─────────────────────────────────────────────────────────── */

  async function loadProviders() {
    setLoading();
    const d = await api("/api/admin/providers");
    const rows = (d.providers || [])
      .map(
        (p) => `<tr>
          <td class="cell-id">${esc(p.name)}<span class="cell-sub">${esc(p.kind.toUpperCase())} · priority ${p.priority}</span></td>
          <td class="cell-sub" style="max-width:260px;word-break:break-all">${esc(p.apiUrl || "—")}</td>
          <td>${p.hasKey ? `<span class="pill is-done">Key set</span>` : `<span class="pill is-muted">No key</span>`}</td>
          <td>${p.active ? `<span class="pill is-done">Active</span>` : `<span class="pill is-muted">Off</span>`}</td>
          <td>
            <div class="row-actions">
              <button class="mini-btn" data-provider-action="toggle" data-id="${p.id}" data-active="${p.active}" type="button">${p.active ? "Disable" : "Enable"}</button>
              <button class="mini-btn" data-provider-action="test" data-id="${p.id}" type="button">Test</button>
            </div>
          </td>
        </tr>`
      )
      .join("");

    root.innerHTML = `
      <form class="panel provider-form" id="providerForm">
        <label class="field">
          <span class="field__label">Name</span>
          <input class="input input--sm" name="name" placeholder="Panel name" required maxlength="60">
        </label>
        <label class="field">
          <span class="field__label">Type</span>
          <select class="input input--sm" name="kind">
            <option value="smm">SMM panel</option>
            <option value="mock">Mock (dev)</option>
          </select>
        </label>
        <label class="field provider-form__wide">
          <span class="field__label">API URL</span>
          <input class="input input--sm" name="apiUrl" placeholder="https://panel.example/api/v2" autocomplete="off">
        </label>
        <label class="field">
          <span class="field__label">API key</span>
          <input class="input input--sm" name="apiKey" placeholder="stored encrypted" autocomplete="off">
        </label>
        <label class="field">
          <span class="field__label">Priority</span>
          <input class="input input--sm" name="priority" type="number" min="1" max="9999" value="100">
        </label>
        <button class="btn btn--lime btn--sm" type="submit">Add provider</button>
      </form>

      <div class="tablewrap">
        <table class="table admin-table">
          <thead><tr><th>Provider</th><th>Endpoint</th><th>Key</th><th>State</th><th>Actions</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="5" class="empty">No providers yet.</td></tr>`}</tbody>
        </table>
      </div>
      <p class="admin-note" style="margin-top:16px">Lower priority number = tried first. Package-specific mappings override this order. Keys are encrypted at rest with AES-256-GCM using APP_SECRET.</p>`;

    document.getElementById("providerForm")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const data = Object.fromEntries(new FormData(form));
      const button = form.querySelector("button[type=submit]");
      button.disabled = true;
      try {
        await api("/api/admin/providers", {
          method: "POST",
          body: {
            name: data.name,
            kind: data.kind,
            apiUrl: data.apiUrl,
            apiKey: data.apiKey,
            priority: Number(data.priority) || 100,
          },
        });
        toast("Provider added");
        await loadProviders();
      } catch (err) {
        toast(err.message, true);
        button.disabled = false;
      }
    });
  }

  /* ── packages ──────────────────────────────────────────────────────────── */

  async function loadPackages() {
    setLoading();
    const [d, prov] = await Promise.all([
      api("/api/admin/packages"),
      api("/api/admin/providers"),
    ]);
    const providers = prov.providers || [];

    const rows = (d.packages || [])
      .map((p) => {
        const options = [`<option value="">Auto (any active)</option>`]
          .concat(
            providers.map(
              (x) =>
                `<option value="${x.id}" ${Number(p.providerId) === Number(x.id) ? "selected" : ""}>${esc(x.name)}</option>`
            )
          )
          .join("");

        return `<tr>
          <td class="cell-id">${esc(p.name)}<span class="cell-sub">${esc(p.slug)} · ${esc(p.fulfillment)}</span></td>
          <td><input class="input input--xs" data-price type="number" min="1" step="1" value="${(p.pricePaise / 100).toFixed(p.pricePaise % 100 ? 2 : 0)}"></td>
          <td><select class="input input--xs" data-provider>${options}</select></td>
          <td class="cell-service"><input class="input input--xs" data-service value="${esc(p.providerService)}" placeholder="service ID"></td>
          <td><label class="check"><input type="checkbox" data-active ${p.active ? "checked" : ""}> live</label></td>
          <td><button class="mini-btn mini-btn--lime" data-pkg-save data-id="${p.id}" type="button">Save</button></td>
        </tr>`;
      })
      .join("");

    root.innerHTML = `
      <p class="admin-note" style="margin-bottom:16px">Map each auto package to a provider service ID. Orders fail and refund automatically if a package is unmapped or the provider is unreachable.</p>
      <div class="tablewrap">
        <table class="table admin-table pkg-edit">
          <thead><tr><th>Package</th><th>Price (₹)</th><th>Provider</th><th>Service ID</th><th>State</th><th></th></tr></thead>
          <tbody>${rows || `<tr><td colspan="6" class="empty">No packages.</td></tr>`}</tbody>
        </table>
      </div>`;
  }

  /* ── actions (delegated) ───────────────────────────────────────────────── */

  root.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const goto = target.closest("[data-goto]");
    if (goto) {
      selectTab(goto.getAttribute("data-goto"));
      return;
    }

    if (target.closest("[data-retry]")) {
      load().catch(fail);
      return;
    }

    const orderBtn = target.closest("[data-order-action]");
    if (orderBtn) {
      const id = orderBtn.getAttribute("data-id");
      const action = orderBtn.getAttribute("data-order-action");
      try {
        if (action === "sync") {
          await api(`/api/admin/orders/${id}/sync`, { method: "POST", body: {} });
          toast("Order synced");
        } else if (action === "complete") {
          const note = window.prompt("Completion note (optional):", "");
          if (note === null) return;
          await api(`/api/admin/orders/${id}/complete`, { method: "POST", body: { note } });
          toast("Marked completed");
        } else if (action === "refund") {
          const reason = window.prompt("Refund reason (credited to the customer's wallet):", "");
          if (reason === null) return;
          await api(`/api/admin/orders/${id}/refund`, { method: "POST", body: { reason } });
          toast("Order refunded");
        }
        await loadOrders();
      } catch (err) {
        toast(err.message, true);
      }
      return;
    }

    const topupBtn = target.closest("[data-topup-action]");
    if (topupBtn) {
      const id = topupBtn.getAttribute("data-id");
      const action = topupBtn.getAttribute("data-topup-action");
      try {
        if (action === "approve") {
          if (!window.confirm("Approve this UTR and credit the wallet? Only do this after matching the payment.")) return;
          await api(`/api/admin/topups/${id}/approve`, {
            method: "POST",
            body: { note: "UTR verified" },
          });
          toast("Wallet credited");
        } else {
          const note = window.prompt("Rejection note:", "UTR not found");
          if (note === null) return;
          await api(`/api/admin/topups/${id}/reject`, { method: "POST", body: { note } });
          toast("Top-up rejected");
        }
        await loadTopups();
      } catch (err) {
        toast(err.message, true);
      }
      return;
    }

    const provBtn = target.closest("[data-provider-action]");
    if (provBtn) {
      const id = provBtn.getAttribute("data-id");
      const action = provBtn.getAttribute("data-provider-action");
      try {
        if (action === "toggle") {
          const active = provBtn.getAttribute("data-active") === "true";
          await api(`/api/admin/providers/${id}`, {
            method: "PATCH",
            body: { active: !active },
          });
          toast(active ? "Provider disabled" : "Provider enabled");
          await loadProviders();
        } else {
          const result = await api(`/api/admin/providers/${id}/test`, {
            method: "POST",
            body: {},
          });
          const balance =
            result.balance == null
              ? "connected"
              : `balance ${Number(result.balance).toLocaleString("en-IN")} ${result.currency || ""}`;
          toast(`Provider OK — ${balance}`);
        }
      } catch (err) {
        toast(err.message, true);
      }
      return;
    }

    const savePkg = target.closest("[data-pkg-save]");
    if (savePkg) {
      const row = savePkg.closest("tr");
      const id = savePkg.getAttribute("data-id");
      const priceRupees = Number(row.querySelector("[data-price]").value);
      const pricePaise = Math.round(priceRupees * 100);
      if (!Number.isFinite(pricePaise) || pricePaise < 100) {
        toast("Enter a price of at least ₹1", true);
        return;
      }
      const providerValue = row.querySelector("[data-provider]").value;
      try {
        savePkg.disabled = true;
        await api(`/api/admin/packages/${id}`, {
          method: "PATCH",
          body: {
            pricePaise,
            providerId: providerValue ? Number(providerValue) : null,
            providerService: row.querySelector("[data-service]").value,
            active: row.querySelector("[data-active]").checked,
          },
        });
        toast("Package saved");
      } catch (err) {
        toast(err.message, true);
      } finally {
        savePkg.disabled = false;
      }
    }
  });

  /* ── tabs ──────────────────────────────────────────────────────────────── */

  function selectTab(name) {
    current = name;
    for (const tab of tabs.querySelectorAll("[data-tab]")) {
      tab.classList.toggle("is-on", tab.getAttribute("data-tab") === name);
    }
    load().catch(fail);
  }

  tabs.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-tab]");
    if (tab) selectTab(tab.getAttribute("data-tab"));
  });

  async function load() {
    if (current === "overview") return loadOverview();
    if (current === "orders") return loadOrders();
    if (current === "topups") return loadTopups();
    if (current === "providers") return loadProviders();
    if (current === "packages") return loadPackages();
  }

  load().catch(fail);
})();
