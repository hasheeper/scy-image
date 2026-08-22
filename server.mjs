/**
 * Optional local dev server.
 *
 * Serves public/ and, when config/api-key.txt is filled in, proxies the API so
 * the token never reaches the browser. The site also runs as a pure static
 * bundle (GitHub Pages) where the browser talks to the upstream directly —
 * this file is a convenience for local use, not a requirement.
 */

import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "docs");
const KEY_FILE = path.join(ROOT, "config", "api-key.txt");
const UPSTREAM = "https://proxy.scylla.love";
const PORT = Number.parseInt(process.env.PORT || "3215", 10);
const HOST = "127.0.0.1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon"
};

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data));
}

async function readToken() {
  const raw = (await readFile(KEY_FILE, "utf8")).trim();
  const token = raw.includes("=") ? raw.slice(raw.indexOf("=") + 1).trim() : raw;
  if (!token || token === "YOUR_TOKEN") throw new Error("请在 config/api-key.txt 填写 API Token");
  return token;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      text += chunk;
      if (text.length > 1_000_000) {
        reject(new Error("请求内容过大"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try { resolve(JSON.parse(text || "{}")); }
      catch { reject(new Error("请求 JSON 无效")); }
    });
    req.on("error", reject);
  });
}

function clamp(value, fallback, min, max, integer = false) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const v = Math.min(max, Math.max(min, n));
  return integer ? Math.round(v) : v;
}

/* NAI only. The upstream's Imagen models returned the "Generation Failed"
   placeholder for every parameter shape tested, so they are not offered. */
function buildPayload(input) {
  const prompt = String(input.prompt || "").trim();
  if (!prompt) throw new Error("Prompt 不能为空");

  const model = String(input.model || "").trim();
  if (!/^nai-[a-zA-Z0-9._-]{2,80}$/.test(model)) throw new Error("仅支持 NAI 模型");

  const width = clamp(input.width, 832, 64, 2048, true);
  const height = clamp(input.height, 1216, 64, 2048, true);
  if (width * height > 1_048_576) throw new Error("分辨率超出模型上限（约 1.05M 像素）");

  return {
    prompt,
    model,
    width,
    height,
    steps: clamp(input.steps, 25, 1, 50, true),
    sampler: String(input.sampler || "k_euler_ancestral"),
    scale: clamp(input.scale, 5, 0, 20),
    cfg: clamp(input.cfg, 10, 0, 30),
    seed: clamp(input.seed, -1, -1, 4_294_967_295, true),
    negative_prompt: String(input.negative_prompt || ""),
    cache: input.cache === true,          // default: do not cache upstream
    optimize: input.optimize === true,    // default: full-quality PNG
    transform_prompt: false               // no prompt rewriting
  };
}

async function proxyGenerate(req, res) {
  try {
    const [token, input] = await Promise.all([readToken(), readBody(req)]);
    const payload = buildPayload(input);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 240_000);

    let upstream;
    try {
      upstream = await fetch(`${UPSTREAM}/v1/image/generate`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "image/png, image/jpeg, application/json"
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }

    const type = upstream.headers.get("content-type") || "application/octet-stream";
    const data = Buffer.from(await upstream.arrayBuffer());

    if (!type.startsWith("image/")) {
      return json(res, upstream.ok ? 502 : upstream.status, {
        error: "上游没有返回图片",
        detail: data.toString("utf8").slice(0, 1000)
      });
    }

    res.writeHead(upstream.status, {
      "Content-Type": type,
      "Content-Length": data.length,
      "Cache-Control": "no-store"
    });
    res.end(data);
  } catch (error) {
    const message = error?.name === "AbortError" ? "生成超时，请稍后重试" : error.message;
    json(res, 400, { error: message || "生成失败" });
  }
}

async function proxyModels(res) {
  try {
    const token = await readToken();
    const upstream = await fetch(`${UPSTREAM}/v1/image/models`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    });
    res.end(text);
  } catch (error) {
    json(res, 400, { error: error.message });
  }
}

async function serveStatic(urlPath, res) {
  const requested = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const filePath = path.resolve(PUBLIC_DIR, requested);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    return json(res, 403, { error: "Forbidden" });
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache"
    });
    res.end(data);
  } catch {
    json(res, 404, { error: "Not found" });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

  // The `proxy` flag is what the client uses to pick its transport mode.
  if (req.method === "GET" && url.pathname === "/api/status") {
    let configured = false;
    try { await readToken(); configured = true; } catch { /* not configured */ }
    return json(res, 200, { proxy: true, configured });
  }

  if (req.method === "GET" && url.pathname === "/api/image/models") return proxyModels(res);
  if (req.method === "POST" && url.pathname === "/api/image/generate") return proxyGenerate(req, res);
  if (req.method === "GET") return serveStatic(url.pathname, res);

  json(res, 405, { error: "Method not allowed" });
});

server.listen(PORT, HOST, () => {
  console.log(`Scylla Image  →  http://${HOST}:${PORT}`);
  console.log(`Key 文件      →  ${KEY_FILE}`);
});
