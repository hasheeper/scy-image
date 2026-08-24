/**
 * Read generation parameters back out of an image file.
 *
 * Two dialects are understood:
 *
 *   NovelAI  — a PNG `Comment` text chunk holding JSON, with `Software`
 *              set to NovelAI and the prompt mirrored into `Description`.
 *   WebUI    — the A1111 `parameters` text chunk: prompt, then an optional
 *              "Negative prompt:" block, then a trailing line of
 *              "Key: value, Key: value" pairs.
 *
 * Only fields this app can actually drive are returned. Values that look
 * plausible but mean something different upstream are deliberately dropped
 * rather than guessed at — see the note on `cfg` below.
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const MAX_BYTES = 40 * 1024 * 1024;

const latin1 = new TextDecoder("latin1");
const utf8Loose = new TextDecoder("utf-8");
const utf8Strict = new TextDecoder("utf-8", { fatal: true });

/* PNG tEXt is Latin-1 by spec, but every generator in practice writes UTF-8
   bytes into it, which matters the moment a prompt contains CJK. Try strict
   UTF-8 first and fall back only when the bytes cannot be valid UTF-8. */
function decodeText(bytes) {
  try {
    return utf8Strict.decode(bytes);
  } catch {
    return latin1.decode(bytes);
  }
}

function startsWith(bytes, signature) {
  return signature.every((byte, index) => bytes[index] === byte);
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function splitNul(bytes, from = 0) {
  const at = bytes.indexOf(0, from);
  return at < 0 ? [bytes.subarray(from), bytes.length] : [bytes.subarray(from, at), at + 1];
}

/** Collect every textual chunk in a PNG, keyed by keyword. */
async function readPngText(bytes) {
  const found = new Map();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;

  while (at + 12 <= bytes.length) {
    const length = view.getUint32(at);
    const type = latin1.decode(bytes.subarray(at + 4, at + 8));
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (type === "IEND") break;
    if (length > bytes.length) break;

    try {
      if (type === "tEXt") {
        const [key, next] = splitNul(body);
        found.set(latin1.decode(key), decodeText(body.subarray(next)));
      } else if (type === "zTXt") {
        const [key, next] = splitNul(body);
        found.set(latin1.decode(key), decodeText(await inflate(body.subarray(next + 1))));
      } else if (type === "iTXt") {
        const [key, afterKey] = splitNul(body);
        const compressed = body[afterKey] === 1;
        const [, afterLang] = splitNul(body, afterKey + 2);
        const [, afterTranslated] = splitNul(body, afterLang);
        const payload = body.subarray(afterTranslated);
        found.set(latin1.decode(key), compressed ? utf8Loose.decode(await inflate(payload)) : utf8Loose.decode(payload));
      }
    } catch {
      /* A single malformed chunk should not abandon the rest of the file. */
    }
    at += 12 + length;
  }
  return found;
}

/* JPEG keeps no PNG chunks. NovelAI and most WebUI exports write the same
   payload into an EXIF UserComment, which is enough to find by scanning for
   the JSON or the parameters block rather than walking the full TIFF tree. */
function readJpegText(bytes) {
  const found = new Map();
  const text = latin1.decode(bytes);
  const json = text.match(/\{"prompt":[\s\S]*?\}(?=\u0000|$)/);
  if (json) found.set("Comment", decodeText(bytes.subarray(json.index, json.index + json[0].length)));
  const webui = text.match(/[\s\S]{0,8000}?Steps:\s*\d+[^\u0000]*/);
  if (!json && webui) found.set("parameters", decodeText(bytes.subarray(webui.index, webui.index + webui[0].length)));
  return found;
}

const SAMPLER_ALIASES = {
  "euler a": "k_euler_ancestral",
  "euler ancestral": "k_euler_ancestral",
  euler: "k_euler",
  "dpm++ 2m": "k_dpmpp_2m",
  "dpm++ 2m karras": "k_dpmpp_2m",
  "dpm++ 2s a": "k_dpmpp_2s_ancestral",
  "dpm++ sde": "k_dpmpp_sde",
  "dpm++ sde karras": "k_dpmpp_sde",
  ddim: "ddim_v3",
  plms: "plms"
};

function normalizeSampler(value) {
  const raw = String(value || "").trim();
  if (!raw) return undefined;
  if (/^k_|^ddim|^plms/i.test(raw)) return raw.toLowerCase();
  return SAMPLER_ALIASES[raw.toLowerCase()];
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : undefined;
}

/** NovelAI: JSON in the Comment chunk. */
function fromNovelAI(comment, description) {
  let data;
  try {
    data = JSON.parse(comment);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;

  return {
    dialect: "NovelAI",
    fields: {
      prompt: cleanText(data.prompt) ?? cleanText(description),
      negative_prompt: cleanText(data.uc) ?? cleanText(data.negative_prompt),
      width: finiteNumber(data.width),
      height: finiteNumber(data.height),
      steps: finiteNumber(data.steps),
      sampler: normalizeSampler(data.sampler),
      /* NAI's `scale` is guidance, which is this app's `scale`. Its
         `cfg_rescale` is a 0–1 knob and is NOT the app's 0–30 `cfg`, so it
         is left out instead of being written into the wrong control. */
      scale: finiteNumber(data.scale),
      seed: finiteNumber(data.seed)
    }
  };
}

/** A1111 / WebUI: freeform text in the parameters chunk. */
function fromWebUI(text) {
  const body = String(text || "");
  if (!body.trim()) return null;

  const negativeAt = body.search(/(^|\n)Negative prompt:/);
  const lines = body.split("\n");
  /* The settings line is the last one that reads as "Key: value" pairs. */
  let settingsAt = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/(^|,\s*)(Steps|Sampler|CFG scale|Seed|Size|Model):\s*/.test(lines[i])) { settingsAt = i; break; }
  }
  if (settingsAt < 0 && negativeAt < 0) return null;

  const settingsLine = settingsAt >= 0 ? lines[settingsAt] : "";
  const head = lines.slice(0, settingsAt >= 0 ? settingsAt : lines.length).join("\n");
  const negativeMarker = head.search(/(^|\n)Negative prompt:/);
  const prompt = negativeMarker < 0 ? head : head.slice(0, negativeMarker);
  const negative = negativeMarker < 0
    ? ""
    : head.slice(negativeMarker).replace(/(^|\n)Negative prompt:/, "").trim();

  const settings = new Map();
  for (const pair of settingsLine.split(/,\s*(?=[A-Za-z][\w +/-]*:)/)) {
    const at = pair.indexOf(":");
    if (at > 0) settings.set(pair.slice(0, at).trim().toLowerCase(), pair.slice(at + 1).trim());
  }
  const size = (settings.get("size") || "").match(/(\d+)\s*[x×]\s*(\d+)/);

  return {
    dialect: "WebUI",
    fields: {
      prompt: cleanText(prompt),
      negative_prompt: cleanText(negative),
      width: size ? finiteNumber(size[1]) : undefined,
      height: size ? finiteNumber(size[2]) : undefined,
      steps: finiteNumber(settings.get("steps")),
      sampler: normalizeSampler(settings.get("sampler")),
      /* WebUI's "CFG scale" is guidance, same role as NAI's `scale`. */
      scale: finiteNumber(settings.get("cfg scale")),
      seed: finiteNumber(settings.get("seed"))
    }
  };
}

function pruned(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (value === undefined || value === null || value === "") continue;
    out[key] = value;
  }
  return out;
}

/**
 * @param {File|Blob} file
 * @returns {Promise<{dialect:string, fields:object, name:string}>}
 * @throws {Error} with a message meant to be shown to the reader
 */
export async function readImageParams(file) {
  if (!file) throw new Error("没有文件");
  const name = file.name || "图片";
  if (file.size > MAX_BYTES) throw new Error("文件超过 40 MB，未读取");

  const bytes = new Uint8Array(await file.arrayBuffer());
  let chunks;
  if (startsWith(bytes, PNG_SIGNATURE)) chunks = await readPngText(bytes);
  else if (startsWith(bytes, JPEG_SIGNATURE)) chunks = readJpegText(bytes);
  else throw new Error("只支持 PNG 与 JPEG");

  const comment = chunks.get("Comment");
  const parsed = (comment && fromNovelAI(comment, chunks.get("Description")))
    || fromWebUI(chunks.get("parameters") || chunks.get("Parameters") || "")
    || (comment ? fromWebUI(comment) : null);

  const fields = pruned(parsed?.fields);
  if (!parsed || !Object.keys(fields).length) {
    throw new Error(chunks.size ? "图片里没有可识别的生成参数" : "图片没有附带参数信息");
  }
  return { dialect: parsed.dialect, fields, name };
}

export const DIALECTS = { NAI: "NovelAI", WEBUI: "WebUI" };
