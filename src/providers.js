import crypto from "node:crypto";
import { getDb } from "./db.js";
import { decryptSecret, randomToken, truncate } from "./util.js";

export class ProviderError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProviderError";
  }
}

const MOCK_COMPLETE_SECONDS = (() => {
  const raw = Number(process.env.MOCK_COMPLETE_SECONDS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 20;
})();

const TERMINAL_RAW = /complete|finished|done/i;
const PARTIAL_RAW = /partial/i;
const CANCEL_RAW = /cancel|refund/i;

/* ── provider records ──────────────────────────────────────────────────── */

export function listProviders({ includeInactive = true } = {}) {
  const where = includeInactive ? "" : "WHERE active = 1";
  return getDb()
    .prepare(`SELECT * FROM providers ${where} ORDER BY active DESC, priority ASC, id ASC`)
    .all();
}

export function getProvider(id) {
  return getDb().prepare("SELECT * FROM providers WHERE id = ?").get(Number(id));
}

/**
 * Explicit package mapping wins; otherwise the highest-priority active provider.
 */
export function selectProvider(pkg) {
  const db = getDb();
  if (pkg.provider_id) {
    const provider = getProvider(pkg.provider_id);
    if (!provider) {
      throw new ProviderError("This package points at a provider that no longer exists.");
    }
    if (!provider.active) {
      throw new ProviderError("The provider mapped to this package is disabled.");
    }
    return provider;
  }
  const provider = db
    .prepare("SELECT * FROM providers WHERE active = 1 ORDER BY priority ASC, id ASC LIMIT 1")
    .get();
  if (!provider) {
    throw new ProviderError(
      "No active provider is configured. Add one in Admin → Providers before taking orders."
    );
  }
  return provider;
}

export function providerPublic(provider) {
  return {
    id: Number(provider.id),
    name: provider.name,
    kind: provider.kind,
    apiUrl: provider.api_url || "",
    hasKey: Boolean(provider.api_key_enc),
    priority: Number(provider.priority),
    active: Boolean(provider.active),
    createdAt: provider.created_at,
  };
}

/* ── adapters ──────────────────────────────────────────────────────────── */

function mockStartCount(providerOrderId) {
  const digest = crypto.createHash("sha256").update(providerOrderId).digest();
  return digest.readUInt32BE(0) % 9000;
}

function mockAdapter() {
  return {
    async add({ quantity }) {
      const qty = Math.max(Number(quantity) || 0, 1);
      const id = `MOCK-${Date.now().toString(36)}-${qty}-${randomToken(2)}`;
      return { providerOrderId: id, startCount: mockStartCount(id) };
    },
    async status(providerOrderId) {
      const parts = String(providerOrderId).split("-");
      const started = parseInt(parts[1], 36);
      const qty = Math.max(parseInt(parts[2], 10) || 1, 1);
      const elapsed = Number.isFinite(started) ? (Date.now() - started) / 1000 : 0;
      const progress =
        MOCK_COMPLETE_SECONDS <= 0 ? 1 : Math.min(Math.max(elapsed / MOCK_COMPLETE_SECONDS, 0), 1);
      const remains = Math.round(qty * (1 - progress));

      return {
        status: progress >= 1 ? "completed" : "in_progress",
        rawStatus: progress >= 1 ? "Completed" : "In progress",
        startCount: mockStartCount(providerOrderId),
        remains,
      };
    },
    async balance() {
      return { balance: 1000, currency: "USD" };
    },
  };
}

async function smmRequest(provider, params) {
  if (!provider.api_url) throw new ProviderError("Provider API URL is missing.");
  const key = decryptSecret(provider.api_key_enc);
  if (!key) throw new ProviderError("Provider API key is missing or could not be decrypted.");

  let url;
  try {
    url = new URL(provider.api_url);
  } catch {
    throw new ProviderError("Provider API URL is invalid.");
  }
  if (!/^https?:$/.test(url.protocol)) {
    throw new ProviderError("Provider API URL must start with http:// or https://");
  }

  const body = new URLSearchParams({ key, ...params });

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body,
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    const reason = err?.name === "TimeoutError" ? "request timed out" : err?.message || "network error";
    throw new ProviderError(`Provider request failed: ${truncate(reason, 160)}`);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new ProviderError(`Provider returned HTTP ${res.status}: ${truncate(text, 160)}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ProviderError(`Provider returned a non-JSON response: ${truncate(text, 120)}`);
  }
  if (data && typeof data === "object" && data.error) {
    throw new ProviderError(String(data.error));
  }
  return data;
}

function smmAdapter(provider) {
  return {
    async add({ service, username, quantity }) {
      const data = await smmRequest(provider, {
        action: "add",
        service: service || "",
        link: `https://www.instagram.com/${encodeURIComponent(username)}/`,
        quantity: String(quantity),
      });
      const id = data?.order ?? data?.order_id ?? data?.id;
      if (id == null || id === "") {
        throw new ProviderError("Provider accepted the request but returned no order ID.");
      }
      return {
        providerOrderId: String(id),
        startCount: Number.isFinite(Number(data.start_count)) ? Number(data.start_count) : null,
      };
    },
    async status(providerOrderId) {
      const data = await smmRequest(provider, {
        action: "status",
        order: String(providerOrderId),
      });
      const rawStatus = String(data?.status ?? "").trim();
      if (!rawStatus) throw new ProviderError("Provider status response did not include a status.");

      return {
        status: normalizeStatus(rawStatus),
        rawStatus,
        startCount: Number.isFinite(Number(data?.start_count)) ? Number(data.start_count) : null,
        remains: Number.isFinite(Number(data?.remains)) ? Number(data.remains) : null,
      };
    },
    async balance() {
      const data = await smmRequest(provider, { action: "balance" });
      const balance = Number(data?.balance);
      return {
        balance: Number.isFinite(balance) ? balance : null,
        currency: data?.currency ? String(data.currency) : "",
      };
    },
  };
}

export function adapterFor(provider) {
  if (!provider) throw new ProviderError("Provider not found.");
  if (provider.kind === "mock") return mockAdapter();
  if (provider.kind === "smm") return smmAdapter(provider);
  throw new ProviderError(`Unknown provider type: ${provider.kind}`);
}

export function normalizeStatus(raw) {
  const value = String(raw ?? "").trim().toLowerCase();
  if (TERMINAL_RAW.test(value)) return "completed";
  if (PARTIAL_RAW.test(value)) return "partial";
  if (CANCEL_RAW.test(value)) return "cancelled";
  if (/progress|processing|pending|active|queue|awaiting|submitted/i.test(value)) {
    return "in_progress";
  }
  return "in_progress";
}

/* ── high-level operations ─────────────────────────────────────────────── */

export async function dispatchToProvider(order, pkg) {
  const provider = selectProvider(pkg);

  if (provider.kind === "smm" && !String(pkg.provider_service || "").trim()) {
    throw new ProviderError(
      "This package has no provider service ID. Map it in Admin → Packages first."
    );
  }

  const adapter = adapterFor(provider);
  const result = await adapter.add({
    service: String(pkg.provider_service || "").trim(),
    username: order.username,
    quantity: order.quantity,
  });

  return { provider, ...result };
}

export async function pollProvider(order) {
  const provider = getProvider(order.provider_id);
  if (!provider) throw new ProviderError("The provider for this order no longer exists.");
  return adapterFor(provider).status(order.provider_order_id);
}

export async function testConnection(provider) {
  const result = await adapterFor(provider).balance();
  return result;
}
