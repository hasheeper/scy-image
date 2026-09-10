import http from "node:http";
import { deflateSync } from "node:zlib";
const fields = values => Object.fromEntries(Object.entries(values).map(([key, options]) => [key, { options, default: options[0] }]));
const gptFields = fields({ quality: ["auto", "low", "medium", "high"], size: ["auto", "1024x1024", "1536x1024", "1024x1536"], output_format: ["png", "jpeg", "webp"] });
const base = { operations: ["generate", "edit"], max_resolution: 4194304, tools: ["image-edit"] };
export const rawCatalog = { studio_features: { version: 2, max_cost: true, max_context_images: 15 }, valid_samplers: ["k_euler_ancestral"], models: {
  "nai-diffusion-5-full@local": { ...base, name: "NAI Diffusion V5 Full", provider: "novelai", editor_family: "novelai", quota_group: "novelai-v5" },
  "nai-diffusion-4-5-full@local": { ...base, name: "NAI Diffusion V4.5 Full", provider: "novelai", editor_family: "novelai", quota_group: "novelai-v4.5" },
  "gpt-image-2@local": { ...base, name: "GPT Image 2", provider: "openai", editor_family: "gpt", quota_group: "openai", image_capabilities: { fields: gptFields } },
  "gpt-image-2.5-sunburst@local": { ...base, name: "GPT Image 2.5 Sunburst", provider: "openai", editor_family: "gpt", quota_group: "openai", image_capabilities: { fields: { ...gptFields, quality: { options: ["auto", "low", "medium", "high", "xhigh", "max"], default: "auto" } } } },
  "gemini-3.1-flash-image@local": { ...base, name: "Nano Banana 2", provider: "gemini", editor_family: "gemini", quota_group: "gemini", image_capabilities: { fields: fields({ aspect_ratio: ["1:1", "16:9", "9:16"], image_size: ["1K", "2K", "4K"] }) } },
  "gemini-3.1-flash-lite-image@local": { ...base, name: "Nano Banana 2 Lite", provider: "gemini", editor_family: "gemini", quota_group: "gemini", image_capabilities: { fields: fields({ aspect_ratio: ["1:1", "16:9"], image_size: ["1K", "2K", "4K"] }) } }
} };
export const mediaQuota = { period: "weekly", date: "2026-09-10", resets_at: "2026-09-14T00:00:00Z", credits: { remaining: 5000 }, images: {
  "novelai-v5": { used: 2, remaining: 248, limit: 250 }, "novelai-v4.5": { used: 1, remaining: 1999, limit: 2000 },
  openai: { used: 0, remaining: 500, limit: 500 }, gemini: { used: 0, remaining: 250, limit: 250 }
} };
export function png(width = 384, height = 512) {
  const crc = buffer => { let c = 0xffffffff; for (const byte of buffer) { c ^= byte; for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const name = Buffer.from(type), length = Buffer.alloc(4), sum = Buffer.alloc(4); length.writeUInt32BE(data.length); sum.writeUInt32BE(crc(Buffer.concat([name, data]))); return Buffer.concat([length, name, data, sum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const n = y * (width * 3 + 1) + 1 + x * 3;
    pixels[n] = 65 + Math.round(x / width * 65); pixels[n + 1] = 85 + Math.round(y / height * 75); pixels[n + 2] = 165;
  }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}
export const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
export function mockUpstream() {
  const state = { records: [], cost: 0, delay: 40, failure: false, badImage: false, jsonImage: false, estimates: 0, media: structuredClone(mediaQuota) };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const json = (value, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (url.pathname === "/v1/image/models") return json(rawCatalog);
    if (url.pathname === "/v1/media/quota") return json(state.media);
    if (url.pathname === "/v1/token_stats_data") return json({ temp_limits: { is_temp: true, limited: true, rpd: 1000, rpd_remaining: 539, rpd_units: 10000, rpd_remaining_units: 4610 } });
    let text = ""; for await (const chunk of req) text += chunk;
    const payload = JSON.parse(text || "{}");
    if (url.pathname.endsWith("/estimate")) { state.estimates++; return json({ cost: state.cost, mode: state.cost ? "paid" : "free", images: 1, quota: state.media }); }
    state.records.push({ path: url.pathname, payload });
    await new Promise(resolve => setTimeout(resolve, state.delay));
    if (state.failure) return json({ error: { message: "模拟上游失败" } }, 503);
    if (state.jsonImage) return json({ data: [{ b64_json: png().toString("base64") }] });
    res.writeHead(200, { "Content-Type": "image/png" }); res.end(state.badImage ? Buffer.from("broken image") : png());
  });
  return { server, state };
}
