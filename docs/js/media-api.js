import { request, readJson, errorMessage } from "./transport.js";
import { normalizeCatalog } from "./model-catalog.js";
let cachedCatalog;
export async function fetchMediaCatalog({ force = false } = {}) {
  if (cachedCatalog && !force) return cachedCatalog;
  const raw = await readJson(await request("/image/models", { signal: AbortSignal.timeout(15_000) }));
  const catalog = normalizeCatalog(raw);
  if (catalog.features.version < 2 || catalog.features.max_cost !== true) throw new Error("上游尚未支持报价保护，请更新后重试");
  cachedCatalog = catalog;
  return catalog;
}
export async function fetchMediaQuota() {
  return readJson(await request("/media/quota", { signal: AbortSignal.timeout(10_000) }));
}
export function quotaForModel(media, model) {
  return media?.images?.[model?.quotaGroup] || null;
}
export function quoteLabel(quote, count = 1) {
  if (!quote) return "费用未知";
  if (quote.cost > 0) return `${Number((quote.cost * count).toFixed(2))} 积分`;
  return quote.mode === "unmetered" ? "不计额度" : `免费 ×${count}`;
}
export async function estimateImage(payload, { signal } = {}) {
  const data = await readJson(await request(payload.tool ? "/image/tools/estimate" : "/studio/image/estimate",
    { body: payload, signal: signal || AbortSignal.timeout(30_000) }));
  if (typeof data.cost !== "number" || !Number.isFinite(data.cost) || data.cost < 0) throw new Error("上游报价无效，未提交生成");
  return data;
}
export async function decodeImage(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image(); img.src = url;
    await img.decode();
    if (!img.naturalWidth || !img.naturalHeight) throw new Error("无效图片");
    return { width: img.naturalWidth, height: img.naturalHeight };
  } catch { throw new Error("图片加载失败，请保留本轮后重试"); }
  finally { URL.revokeObjectURL(url); }
}

/** No automatic POST retries. The quote is always for this exact snapshot. */
async function runImageRequest(payload, { signal, beforeSend, onLoading } = {}) {
  const startedAt = performance.now();
  const quote = await estimateImage(payload, { signal });
  if (beforeSend) await beforeSend(quote);
  else if (quote.cost > 0) throw new Error("本次需要积分，请确认报价后生成");
  signal?.throwIfAborted();
  const response = await request(payload.tool ? "/image/tools/run" : "/studio/image/generate",
    { body: { ...payload, max_cost: quote.cost }, signal });
  const type = response.headers.get("content-type") || "";
  if (!response.ok) throw new Error(errorMessage(await response.json().catch(() => null), `请求失败 (${response.status})`));
  onLoading?.();
  const blocks = [];
  if (type.startsWith("image/")) blocks.push({ type: "image", blob: await response.blob() });
  else {
    const data = await response.json().catch(() => null);
    if (!data || data.error) throw new Error(errorMessage(data, "上游未返回有效图片"));
    // Accept embedded standard image JSON and ordered Gemini parts. Remote URLs
    // are deliberately not fetched with the user's authorization header.
    const parts = data.candidates?.[0]?.content?.parts;
    const entries = parts || data.data || [];
    for (const part of entries) {
      if (part.text) blocks.push({ type: "text", text: String(part.text) });
      const encoded = part.b64_json || part.inlineData?.data || part.inline_data?.data;
      const mime = part.inlineData?.mimeType || part.inline_data?.mime_type || (payload.image_options?.output_format === "jpeg" ? "image/jpeg" : `image/${payload.image_options?.output_format || "png"}`);
      if (encoded && /^image\/(png|jpeg|webp)$/.test(mime)) {
        blocks.push({ type: "image", blob: new Blob([Uint8Array.from(atob(encoded), c => c.charCodeAt(0))], { type: mime }) });
      }
    }
    if (!blocks.some(b => b.type === "image")) {
      const detail = blocks.filter(b => b.type === "text").map(b => b.text).join("\n");
      throw new Error(detail || "上游没有返回图片（异步任务或远程图片链接暂不支持），请勿重复提交");
    }
  }
  for (const block of blocks.filter(b => b.type === "image")) {
    if (!block.blob.size) throw new Error("上游返回空图片");
    block.size = await decodeImage(block.blob);
    if (payload.model.startsWith("nai-") && block.size.width === 512 && block.size.height === 256
      && !(payload.width === 512 && payload.height === 256)) throw new Error("上游返回 Generation Failed 占位图");
  }
  signal?.throwIfAborted();
  return { blocks, quote, ms: performance.now() - startedAt };
}

export async function runImage(payload, options = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(new DOMException("请求超时；上游可能仍在处理，请勿重复提交", "TimeoutError")), 240_000);
  try { return await runImageRequest(payload, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); }
}
