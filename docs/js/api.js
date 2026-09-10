/** Shared transport; NAI-specific payloads stay separate from conversational images. */
import { vault } from "./vault.js";
import { request, readJson, state, UPSTREAM, API_BASE } from "./transport.js";
import { fetchMediaCatalog, fetchMediaQuota, runImage, estimateImage } from "./media-api.js";
import { normalizeQuota } from "./quota-normalize.js";
export { detectMode, state } from "./transport.js";
export { DEFAULT_MODEL, FALLBACK_MAX_PIXELS } from "./model-catalog.js";

export async function fetchCatalog(options) {
  const catalog = await fetchMediaCatalog(options);
  const models = catalog.models.filter(m => m.provider === "novelai").sort((a, b) =>
    b.id.localeCompare(a.id, undefined, { numeric: true }));
  return { ...catalog, models };
}
export async function fetchQuotaStatus(model) {
  let media, stats = null, checked = false;
  if (state.mode === "proxy") {
    const data = await readJson(await fetch(new URL("quota", API_BASE), {
      cache: "no-store", signal: AbortSignal.timeout(10_000)
    }));
    return normalizeQuota(data.media, data.stats, data.temporaryChecked, model?.quotaGroup);
  }
  const statsUrl = new URL(`${UPSTREAM}/v1/token_stats_data`);
  statsUrl.searchParams.set("days", "1");
  if (!vault.token()) throw new Error("请先解锁 API Key");
  statsUrl.searchParams.set("api_key", vault.token());
  const results = await Promise.allSettled([
    fetchMediaQuota(),
    fetch(statsUrl, { cache: "no-store", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(8_000) }).then(readJson)
  ]);
  media = results[0].status === "fulfilled" ? results[0].value : null;
  checked = results[1].status === "fulfilled";
  if (checked) stats = results[1].value;
  if (!media && !stats) throw new Error("额度暂不可用");
  return normalizeQuota(media, stats, checked, model?.quotaGroup);
}
const WIRE_KEYS = ["prompt", "negative_prompt", "model", "width", "height", "steps", "sampler", "scale", "cfg", "seed", "optimize"];
function toWire(payload) {
  return { ...Object.fromEntries(WIRE_KEYS.filter(k => payload[k] !== undefined).map(k => [k, payload[k]])),
    cache: payload.cache === true, transform_prompt: false, transform_mode: "off" };
}
export const estimateNAI = (payload, options) => estimateImage(toWire(payload), options);
export async function generate(payload, options = {}) {
  const result = await runImage(toWire(payload), options);
  const image = result.blocks.find(b => b.type === "image");
  return { blob: image.blob, size: image.size, ms: result.ms, quote: result.quote };
}
