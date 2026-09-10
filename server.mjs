/** Optional localhost proxy. Tokens never enter the browser in this mode. */
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeCatalog, validatePayload, MAX_REQUEST_BYTES } from "./docs/js/model-catalog.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "docs");
const KEY_FILE = path.join(ROOT, "config", "api-key.txt");
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml",
  ".woff2": "font/woff2", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon" };
function json(res, status, data) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}
async function readTokenFile() {
  const raw = (await readFile(KEY_FILE, "utf8")).trim();
  const token = raw.includes("=") ? raw.slice(raw.indexOf("=") + 1).trim() : raw;
  if (!token || token === "YOUR_TOKEN") throw new Error("请在 config/api-key.txt 填写 API Key");
  return token;
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [], failed = false;
    req.on("data", chunk => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) { failed = true; chunks = []; reject(Object.assign(new Error("请求内容过大"), { status: 413 })); }
      else chunks.push(chunk);
    });
    req.on("end", () => {
      if (failed) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new Error("请求 JSON 无效")); }
    });
    req.on("error", reject);
    req.on("aborted", () => reject(new Error("请求已断开")));
  });
}
export function createAppServer({ upstream = "https://proxy.scylla.love", readToken = readTokenFile } = {}) {
  let generationActive = false, catalogCache = null, catalogTime = 0;
  const get = async (route, token, signal) => fetch(upstream + "/v1" + route,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal });
  async function catalog(token) {
    if (catalogCache && Date.now() - catalogTime < 60_000) return catalogCache;
    const r = await get("/image/models", token, AbortSignal.timeout(10_000));
    if (!r.ok) throw new Error("读取模型目录失败");
    const data = await r.json();
    if (data.studio_features?.max_cost !== true) throw new Error("上游不支持费用保护");
    catalogCache = normalizeCatalog(data); catalogTime = Date.now();
    return catalogCache;
  }
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    // Reject cross-origin writes to the credential-holding localhost service.
    const host = req.headers.host || "";
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return json(res, 403, { error: "Forbidden host" });
    if (req.method === "POST" && (req.headers.origin && req.headers.origin !== `http://${host}`
      || !req.headers["content-type"]?.startsWith("application/json"))) return json(res, 403, { error: "Forbidden origin or content type" });
    try {
      if (req.method === "GET" && url.pathname === "/api/status") {
        let configured = false;
        try { await readToken(); configured = true; } catch { /* Not configured. */ }
        return json(res, 200, { proxy: true, configured, generationLock: true, generationBusy: generationActive });
      }
      if (req.method === "GET" && url.pathname === "/api/quota") {
        const token = await readToken();
        const statsUrl = new URL(upstream + "/v1/token_stats_data");
        statsUrl.searchParams.set("api_key", token); statsUrl.searchParams.set("days", "1");
        const parse = async r => { if (!r.ok) throw Error("额度暂不可用"); return r.json(); };
        const [media, stats] = await Promise.allSettled([
          get("/media/quota", token, AbortSignal.timeout(8_000)).then(parse),
          fetch(statsUrl, { signal: AbortSignal.timeout(8_000) }).then(parse)
        ]);
        if (media.status !== "fulfilled" && stats.status !== "fulfilled") return json(res, 502, { error: "额度暂不可用" });
        return json(res, 200, { media: media.status === "fulfilled" ? media.value : null,
          stats: stats.status === "fulfilled" ? { temp_limits: stats.value.temp_limits } : null,
          temporaryChecked: stats.status === "fulfilled" });
      }
      if (req.method === "GET" && ["/api/image/models", "/api/media/quota"].includes(url.pathname)) {
        const response = await get(url.pathname.slice(4), await readToken(), AbortSignal.timeout(10_000));
        return json(res, response.status, await response.json());
      }
      const posts = {
        "/api/studio/image/estimate": ["/studio/image/estimate", false, false],
        "/api/studio/image/generate": ["/studio/image/generate", false, true],
        "/api/image/tools/estimate": ["/image/tools/estimate", true, false],
        "/api/image/tools/run": ["/image/tools/run", true, true]
      };
      const route = posts[url.pathname];
      if (req.method === "POST" && route) {
        const [target, edit, execution] = route;
        if (execution && generationActive) { res.setHeader("Retry-After", "2"); return json(res, 429, { error: "已有生成任务正在进行，请等待完成" }); }
        if (execution) generationActive = true;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 240_000);
        req.once("aborted", () => controller.abort());
        res.once("close", () => { if (!res.writableEnded) controller.abort(); });
        try {
          const token = await readToken();
          const input = await readBody(req, edit ? MAX_REQUEST_BYTES : 1_000_000);
          const payload = validatePayload(input, await catalog(token), { edit, execution });
          controller.signal.throwIfAborted();
          const response = await fetch(upstream + "/v1" + target, {
            method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify(payload), signal: controller.signal
          });
          const body = Buffer.from(await response.arrayBuffer());
          if (!res.destroyed) {
            res.writeHead(response.status, { "Content-Type": response.headers.get("content-type") || "application/octet-stream",
              "Content-Length": body.length, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
            res.end(body);
          }
        } finally { clearTimeout(timer); if (execution) generationActive = false; }
        return;
      }
      if (url.pathname.startsWith("/api/")) return json(res, 404, { error: "Unknown API route" });
      if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });
      const requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const file = path.resolve(PUBLIC_DIR, requested);
      if (!file.startsWith(PUBLIC_DIR + path.sep)) return json(res, 403, { error: "Forbidden" });
      try {
        const bytes = await readFile(file);
        res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
        res.end(bytes);
      } catch { json(res, 404, { error: "Not found" }); }
    } catch (error) {
      json(res, error.status || (error.name === "AbortError" ? 504 : 400),
        { error: error.name === "AbortError" ? "请求超时；上游可能仍在处理，请勿立即重复提交" : error.message || "请求失败" });
    }
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number.parseInt(process.env.PORT || "3215", 10);
  createAppServer().listen(port, "127.0.0.1", () => console.log(`Scylla Image → http://127.0.0.1:${port}`));
}
