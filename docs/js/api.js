/**
 * Transport layer.
 *
 * Dual mode:
 *   "proxy"  — a local Node server holds the token (config/api-key.txt) and
 *              forwards. Token never enters the browser. Auto-detected.
 *   "direct" — browser talks straight to the upstream with a Bearer header.
 *              Required on GitHub Pages. Verified: upstream echoes any Origin
 *              in access-control-allow-origin and allows the authorization
 *              header, so this works without any relay.
 */

import { vault } from "./vault.js";

const UPSTREAM = "https://proxy.scylla.love";
const CATALOG_CACHE = "scy.catalog.v1";
const CATALOG_TTL = 6 * 60 * 60 * 1000;

export const state = { mode: "direct" };

/**
 * The upstream answers invalid requests with HTTP 200 and a 512x256 PNG whose
 * pixels spell "Generation Failed". Confirmed by decoding the bitmap. Without
 * this guard the UI would present that placeholder as a real result.
 */
const ERROR_IMAGE = { width: 512, height: 256 };

async function decodeSize(blob) {
  if (typeof createImageBitmap !== "function") return null;
  try {
    const bmp = await createImageBitmap(blob);
    const size = { width: bmp.width, height: bmp.height };
    bmp.close?.();
    return size;
  } catch {
    return null;
  }
}

function looksLikeErrorCard(size, requested) {
  if (!size) return false;
  if (size.width !== ERROR_IMAGE.width || size.height !== ERROR_IMAGE.height) return false;
  // A genuine 512x256 render is legitimate; only flag it when that is not
  // what the caller asked for.
  return !(requested?.width === 512 && requested?.height === 256);
}

/* Relative so the app works from a GitHub Pages sub-path
   (user.github.io/repo/) as well as from a domain root. */
const API_BASE = new URL("../api/", import.meta.url);

export async function detectMode() {
  try {
    // Give up quickly: on Pages there is no local server and we do not want
    // this probe to delay first paint.
    const res = await fetch(new URL("status", API_BASE), {
      cache: "no-store",
      signal: AbortSignal.timeout?.(1500)
    });
    if (res.ok) {
      const data = await res.json();
      if (data?.proxy) {
        state.mode = "proxy";
        return { mode: "proxy", configured: Boolean(data.configured) };
      }
    }
  } catch {
    /* no local server — expected on Pages */
  }
  state.mode = "direct";
  return { mode: "direct", configured: vault.isUnlocked() };
}

function authHeaders() {
  if (state.mode === "proxy") return {};
  const token = vault.token();
  if (!token) throw new Error("请先解锁 API Key");
  return { Authorization: `Bearer ${token}` };
}

function endpoint(path) {
  return state.mode === "proxy"
    ? new URL(path.replace(/^\//, ""), API_BASE).href
    : `${UPSTREAM}/v1${path}`;
}

/** Ordered newest-first so the default lands on the best model. */
const MODEL_ORDER = [
  "nai-diffusion-5-full",
  "nai-diffusion-5-curated",
  "nai-diffusion-4-5-full",
  "nai-diffusion-4-5-curated",
  "nai-diffusion-4-full",
  "nai-diffusion-4-curated",
  "nai-diffusion-3"
];

export const DEFAULT_MODEL = "nai-diffusion-5-full";
export const FALLBACK_MAX_PIXELS = 1_048_576;

/**
 * NAI only. The Imagen entries the upstream advertises were tested with
 * aspect_ratio / ratio / width+height / no size at all and every variant came
 * back as the "Generation Failed" placeholder, so they are excluded.
 */
function shapeCatalog(raw) {
  const all = raw?.models || {};
  const models = Object.entries(all)
    .filter(([id, meta]) => meta?.provider === "novelai" || id.startsWith("nai-"))
    .map(([id, meta]) => ({
      id,
      name: meta.name || id,
      description: meta.description || "",
      maxPixels: Number(meta.max_resolution) || FALLBACK_MAX_PIXELS
    }))
    .sort((a, b) => {
      const ia = MODEL_ORDER.indexOf(a.id);
      const ib = MODEL_ORDER.indexOf(b.id);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });

  return {
    models,
    samplers: Array.isArray(raw?.valid_samplers) && raw.valid_samplers.length
      ? raw.valid_samplers
      : ["k_euler_ancestral", "k_euler", "k_dpmpp_2m", "k_dpmpp_sde", "ddim_v3"],
    defaults: raw?.defaults || {}
  };
}

export async function fetchCatalog({ force = false } = {}) {
  if (!force) {
    try {
      const cached = JSON.parse(localStorage.getItem(CATALOG_CACHE) || "null");
      if (cached && Date.now() - cached.at < CATALOG_TTL) return shapeCatalog(cached.data);
    } catch {
      /* ignore corrupt cache */
    }
  }

  const res = await fetch(endpoint("/image/models"), {
    headers: { ...authHeaders(), Accept: "application/json" },
    cache: "no-store"
  });
  if (!res.ok) throw new Error(`获取模型列表失败 (${res.status})`);

  const data = await res.json();
  localStorage.setItem(CATALOG_CACHE, JSON.stringify({ at: Date.now(), data }));
  return shapeCatalog(data);
}

/**
 * @returns {Promise<{blob: Blob, size: {width:number,height:number}|null, ms:number}>}
 */
/* Only these keys are part of the API contract. `collect()` also carries
   UI-only fields (e.g. modelName) for the history record, and those must not
   be sent upstream. */
const WIRE_KEYS = [
  "prompt", "negative_prompt", "model", "width", "height",
  "steps", "sampler", "scale", "cfg", "seed",
  "optimize", "cache", "transform_prompt"
];

function toWire(payload) {
  const out = {};
  for (const k of WIRE_KEYS) if (payload[k] !== undefined) out[k] = payload[k];
  return out;
}

export async function generate(payload, { signal } = {}) {
  const startedAt = performance.now();

  const res = await fetch(endpoint("/image/generate"), {
    method: "POST",
    headers: {
      ...authHeaders(),
      "Content-Type": "application/json",
      Accept: "image/png, image/jpeg, application/json"
    },
    body: JSON.stringify(toWire(payload)),
    signal
  });

  const contentType = res.headers.get("content-type") || "";

  if (!contentType.startsWith("image/")) {
    let message = `请求失败 (${res.status})`;
    try {
      const body = await res.json();
      message = body.detail || body.error || message;
    } catch {
      const text = await res.text().catch(() => "");
      if (text) message = text.slice(0, 300);
    }
    if (res.status === 401) message = "API Key 无效或已过期";
    if (res.status === 429 && message === `请求失败 (${res.status})`) {
      message = "生成请求过于频繁或已有任务正在进行，请稍后重试";
    }
    if ([409, 423].includes(res.status) && message === `请求失败 (${res.status})`) {
      message = "上游已有生成任务，当前请求未执行";
    }
    throw new Error(message);
  }

  const blob = await res.blob();
  const size = await decodeSize(blob);

  if (looksLikeErrorCard(size, payload)) {
    throw new Error(
      "上游返回了「Generation Failed」占位图。常见原因：分辨率超出模型上限、该模型不接受当前参数，或上游额度/后端异常。"
    );
  }

  return { blob, size, ms: performance.now() - startedAt };
}
