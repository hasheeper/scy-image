import { vault } from "./vault.js";
import { detectMode, fetchCatalog, fetchQuotaStatus, generate, state as api, DEFAULT_MODEL, FALLBACK_MAX_PIXELS } from "./api.js";
import { history, prefs, makeThumb } from "./store.js";
import { attach as attachHighlight } from "./highlight.js";
import { attachTagAutocomplete } from "./tag-autocomplete.js";
import { convertToNaiPrompt } from "./prompt-converter.js";
import { quotaPolicy, recordSuccessfulImage } from "./quota-policy.js";
import { toast } from "./toast.js";
import { takePendingTags } from "./tag-handoff.js";
import { readImageParams } from "./image-meta.js";

const $ = (id) => document.getElementById(id);
const body = document.body;

/* Ratio cards. `box` is a scale model of the real output shape, so the
   glyph itself communicates the aspect rather than a text label alone. */
const RATIOS = [
  { tag: "2:3", w: 832, h: 1216, box: [13, 19] },
  { tag: "1:1", w: 1024, h: 1024, box: [17, 17] },
  { tag: "3:2", w: 1216, h: 832, box: [19, 13] },
  { tag: "自定义", custom: true, box: [17, 13] }
];

const SNAP = 64;
const DIM_MIN = 64;
const DIM_MAX = 2048;
const BATCH_MAX = 24;
const UINT32_RANGE = 4_294_967_296;
const GENERATION_LOCK = "scylla-image-generation-v1";
const QUOTA_TTL = 60_000;
const BATCH_HINT = "严格逐张请求；失败或取消时停止剩余队列。";

const DEFAULTS = {
  sampler: "k_euler_ancestral",
  steps: 25, scale: 5, cfg: 10,
  batchCount: 1, optimize: false, serverCache: false, localCache: true
};

/* True when the size matches no preset, or the user picked the custom card. */
let customMode = false;

/* Set when we navigate away deliberately, so the unload guard stays quiet. */
let suppressUnloadGuard = false;

/* Weight-highlight mirrors; call after setting a textarea's value in code. */
let refreshPromptHL = () => {};
let refreshNegativeHL = () => {};
const refreshHighlights = () => { refreshPromptHL(); refreshNegativeHL(); };

let catalog = { models: [], samplers: [], defaults: {} };
let controller = null;
let ticker = null;
let current = null;
let jobActive = false;
let cancelRequested = false;
let quotaPreflightActive = false;
let quotaStatus = null;
let quotaFetchedAt = 0;
let quotaRequest = null;
let quotaResetTimer = null;
let quotaLoading = false;
let batchRestricted = false;
let requestedBatchCount = DEFAULTS.batchCount;
const urls = new Map();

const setState = (next) => { body.dataset.state = next; };

/* ── Fit ───────────────────────────────────────────────────── */
/* Publish the stage's usable box as pixel values. CSS cannot express "fit
   inside my parent" here: the parent is content-sized, so a percentage
   max-height against it resolves to `none` and the image escapes its box.
   
   Measured on .stage, NOT .viewport. In 1:1 mode the viewport scrolls, so
   reading its clientWidth would couple the measurement to scrollbar
   visibility — that feedback loop (measure -> resize -> measure) was what
   locked up the main thread and killed the tab. .stage never scrolls. */
let fitW = 0;
let fitH = 0;

function measureFit() {
  const vp = $("viewport");
  if (!vp) return;

  // Read the real padding: it differs between desktop and mobile breakpoints,
  // and a hardcoded value made the image compute too small on phones.
  const cs = getComputedStyle(vp);
  const w = Math.floor(vp.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
  const h = Math.floor(vp.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom));
  if (w <= 0 || h <= 0) return;
  if (w === fitW && h === fitH) return; // idempotent: breaks any resize loop

  fitW = w;
  fitH = h;
  body.style.setProperty("--fit-w", `${w}px`);
  body.style.setProperty("--fit-h", `${h}px`);
  sizeSkeleton();
}

/* Shape of the request that is actually in flight. While it runs, the form is
   still editable, so reading the inputs would let the placeholder morph into a
   size the pending image will never have. Null when nothing is running. */
let pendingShape = null;

const pendingLabel = () => {
  if (!pendingShape) return "";
  const { width, height, index, total, composing } = pendingShape;
  if (composing) return "正在合成对比图";
  const which = total > 1 ? `生成中 · 第 ${index}/${total} 张` : "生成中";
  return `${which} · ${width}×${height}`;
};

/* Skeleton mirrors the pending image's shape, letterboxed into the same box. */
function sizeSkeleton() {
  if (!fitW || !fitH) return;
  const aw = pendingShape?.width || Number($("width").value) || 1;
  const ah = pendingShape?.height || Number($("height").value) || 1;
  const scale = Math.min(fitW / aw, fitH / ah, 1);
  const sk = $("skeleton");
  sk.style.setProperty("--sk-w", `${Math.round(aw * scale)}px`);
  sk.style.setProperty("--sk-h", `${Math.round(ah * scale)}px`);
}

/* ── gate ──────────────────────────────────────────────────── */
function showGate(view) {
  const gate = $("gate");
  gate.hidden = false;
  for (const s of gate.querySelectorAll(".gate-view")) s.hidden = s.dataset.view !== view;
  requestAnimationFrame(() => { body.dataset.gate = "open"; });
  const focus = { setup: "setupKey", unlock: "unlockPass", proxy: "proxyEnter" }[view];
  setTimeout(() => $(focus)?.focus(), 300);
}

function hideGate() {
  body.dataset.gate = "closed";
  setTimeout(() => { $("gate").hidden = true; }, 320);
}

/* ── catalog ───────────────────────────────────────────────── */
const activeModel = () => catalog.models.find((m) => m.id === $("model").value) || null;
const maxPixels = () => activeModel()?.maxPixels || FALLBACK_MAX_PIXELS;

function renderCatalog() {
  const saved = prefs.load();

  const modelSel = $("model");
  modelSel.innerHTML = "";
  for (const m of catalog.models) {
    const o = document.createElement("option");
    o.value = m.id;
    o.textContent = m.name;
    modelSel.append(o);
  }
  const want = saved.model && catalog.models.some((m) => m.id === saved.model)
    ? saved.model
    : catalog.models.some((m) => m.id === DEFAULT_MODEL) ? DEFAULT_MODEL : catalog.models[0]?.id;
  if (want) modelSel.value = want;

  const sampSel = $("sampler");
  sampSel.innerHTML = "";
  for (const id of catalog.samplers) {
    const o = document.createElement("option");
    o.value = id;
    o.textContent = id.replace(/^k_/, "").replace(/_/g, " ");
    sampSel.append(o);
  }
  sampSel.value = catalog.samplers.includes(saved.sampler) ? saved.sampler
    : catalog.samplers.includes(DEFAULTS.sampler) ? DEFAULTS.sampler : catalog.samplers[0];

  syncModelHint();
}

function syncModelHint() {
  // Model detail lives on the select's own tooltip; the pixel budget is shown
  // inline by validateSize() instead of a separate line of prose.
  const m = activeModel();
  $("model").title = m ? [m.description, `上限 ${(m.maxPixels / 1e6).toFixed(2)}M 像素`].filter(Boolean).join(" · ") : "";
  validateSize();
}

function renderRatios() {
  const host = $("ratios");
  host.innerHTML = "";
  for (const r of RATIOS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ratio";
    btn.setAttribute("role", "radio");
    btn.dataset.w = r.w;
    btn.dataset.h = r.h;
    btn.title = `${r.w} × ${r.h}`;

    const box = document.createElement("span");
    box.className = "ratio-box";
    const i = document.createElement("i");
    i.style.width = `${r.box[0]}px`;
    i.style.height = `${r.box[1]}px`;
    box.append(i);

    const tag = document.createElement("b");
    tag.textContent = r.tag;

    btn.append(box, tag);

    if (r.custom) {
      btn.dataset.custom = "1";
      btn.title = "自由填写宽高";
      btn.addEventListener("click", () => {
        customMode = true;
        syncRatioSelection();
        $("width").focus();
        $("width").select();
      });
    } else {
      btn.dataset.w = r.w;
      btn.dataset.h = r.h;
      btn.title = `${r.w} × ${r.h}`;
      btn.addEventListener("click", () => {
        customMode = false;
        $("width").value = r.w;
        $("height").value = r.h;
        validateSize();
        sizeSkeleton();
        persist();
      });
    }
    host.append(btn);
  }
}

function syncRatioSelection() {
  const w = Number($("width").value);
  const h = Number($("height").value);
  const preset = RATIOS.some((r) => !r.custom && r.w === w && r.h === h);

  for (const btn of $("ratios").children) {
    const isCustom = btn.dataset.custom === "1";
    const on = isCustom
      ? (customMode || !preset)
      : (!customMode && Number(btn.dataset.w) === w && Number(btn.dataset.h) === h);
    btn.setAttribute("aria-checked", String(on));
  }
  $("sizeFields").hidden = !(customMode || !preset);
}

/* Round to the nearest multiple of 64 within range. The upstream rejects
   off-grid dimensions, so snapping is corrective rather than cosmetic. */
function snap(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const rounded = Math.round(n / SNAP) * SNAP;
  return Math.min(DIM_MAX, Math.max(DIM_MIN, rounded));
}

/* Snap on commit (blur / Enter), not while typing — snapping mid-keystroke
   fights the user. */
function snapField(id) {
  const el = $(id);
  const next = snap(el.value);
  if (next === null) return;
  if (Number(el.value) !== next) {
    el.value = next;
    toast(`已对齐到 64 的倍数：${next}`, "ok");
  }
  validateSize();
  sizeSkeleton();
  persist();
}

/* Over-budget requests come back as a 512x256 "Generation Failed" card
   with HTTP 200, so block them before they are sent. */
function validateSize() {
  const w = Number($("width").value) || 0;
  const h = Number($("height").value) || 0;
  const px = w * h;
  const cap = maxPixels();

  $("pixelMeta").textContent = px ? `${w}×${h} · ${(px / 1e6).toFixed(2)}M` : "";
  syncRatioSelection();

  let problem = "";
  if (w < DIM_MIN || h < DIM_MIN) problem = `宽高至少 ${DIM_MIN}`;
  else if (px > cap) {
    const side = Math.floor(Math.sqrt(cap) / SNAP) * SNAP;
    problem = `超出模型上限 ${(cap / 1e6).toFixed(2)}M 像素（约 ${side}×${side}）`;
  } else if (w % SNAP || h % SNAP) problem = "离开输入框后会自动对齐到 64 的倍数";

  const warn = $("pixelWarn");
  warn.textContent = problem;
  warn.hidden = !problem;

  const fatal = w < DIM_MIN || h < DIM_MIN || px > cap;
  $("pixelWarn").classList.toggle("warn", fatal);
  $("goBtn").disabled = fatal || body.dataset.state === "busy";
  return !fatal;
}

function syncAdvBadge() {
  let n = 0;
  if ($("sampler").value !== DEFAULTS.sampler) n += 1;
  if (Number($("steps").value) !== DEFAULTS.steps) n += 1;
  if (Number($("scale").value) !== DEFAULTS.scale) n += 1;
  if (Number($("cfg").value) !== DEFAULTS.cfg) n += 1;
  if ($("seed").value.trim() !== "") n += 1;
  if (batchCount() !== DEFAULTS.batchCount) n += 1;
  if ($("optimize").checked !== DEFAULTS.optimize) n += 1;
  if ($("serverCache").checked !== DEFAULTS.serverCache) n += 1;
  if ($("localCache").checked !== DEFAULTS.localCache) n += 1;

  const badge = $("advBadge");
  badge.hidden = n === 0;
  badge.textContent = String(n);
}

function syncRangeLabels() {
  $("stepsVal").textContent = $("steps").value;
  $("scaleVal").textContent = $("scale").value;
  $("cfgVal").textContent = $("cfg").value;
}

function syncPromptCount() {
  $("promptCount").textContent = String($("prompt").value.length);
}

function normalizedBatchCount(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.min(BATCH_MAX, Math.max(1, n)) : DEFAULTS.batchCount;
}

function batchCount() {
  return batchRestricted ? 1 : normalizedBatchCount($("batchCount").value);
}

function setRequestedBatchCount(value) {
  requestedBatchCount = normalizedBatchCount(value);
  $("batchCount").value = String(batchRestricted ? 1 : requestedBatchCount);
}

function commitBatchCount() {
  if (!batchRestricted) requestedBatchCount = normalizedBatchCount($("batchCount").value);
  $("batchCount").value = String(batchRestricted ? 1 : requestedBatchCount);
  syncAdvBadge();
  syncGenerateLabel();
  persist();
  return batchCount();
}

function syncGenerateLabel() {
  if (!jobActive) $("goLabel").textContent = `生成 ×${batchCount()}`;
}

function quotaValue(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return Number.isInteger(number) ? String(number) : String(Number(number.toFixed(1)));
}

function syncQuotaControls({ announce = false } = {}) {
  const policy = quotaPolicy(quotaStatus);
  const wasRestricted = batchRestricted;
  if (!wasRestricted && policy.serialDisabled) {
    requestedBatchCount = normalizedBatchCount($("batchCount").value);
  }
  batchRestricted = policy.serialDisabled;

  const input = $("batchCount");
  input.disabled = batchRestricted;
  input.value = String(batchRestricted ? 1 : requestedBatchCount);
  $("batchRange").textContent = policy.serialUnavailable
    ? (quotaLoading ? "校验中" : "额度未知")
    : batchRestricted ? "仅单张" : "1–24 张";
  $("batchHint").textContent = policy.serialUnavailable
    ? quotaLoading
      ? "正在读取临时 Key 全局日额度，串行暂不可用。"
      : "临时 Key 全局日额度暂不可用，为避免超额，串行已关闭。"
    : batchRestricted
      ? `临时 Key 全局日额度剩余 ${quotaValue(policy.tempRemaining)}，低于 300，仅允许单张生成。`
      : BATCH_HINT;
  $("batchHint").classList.toggle("warn", batchRestricted);

  const warning = $("quotaWarning");
  warning.hidden = !policy.warning;
  $("quotaWarningText").textContent = policy.warning
    ? `额度提醒：图片已用 ${quotaValue(policy.imageUsed)}；临时 Key 全局日额度仅剩 ${quotaValue(policy.tempRemaining)}，串行批量已关闭。`
    : "";

  syncAdvBadge();
  syncGenerateLabel();
  if (announce && !wasRestricted && batchRestricted) {
    toast(policy.serialUnavailable
      ? "全局额度暂不可用，串行批量已关闭"
      : "临时 Key 全局日额度低于 300，串行批量已关闭");
  }
}

function scheduleQuotaResetRefresh() {
  clearTimeout(quotaResetTimer);
  quotaResetTimer = null;
  const resetSeconds = Number(quotaStatus?.temporary?.resetSeconds);
  if (!batchRestricted || !Number.isFinite(resetSeconds) || resetSeconds <= 0) return;
  quotaResetTimer = setTimeout(() => {
    quotaResetTimer = null;
    void refreshQuota({ force: true, announce: true });
  }, Math.min(2_147_000_000, (resetSeconds + 2) * 1000));
}

async function refreshQuota({ force = false, announce = false } = {}) {
  if (!force && quotaStatus && !quotaPolicy(quotaStatus).serialUnavailable
      && Date.now() - quotaFetchedAt < QUOTA_TTL) return quotaStatus;
  if (quotaRequest) return quotaRequest;

  quotaLoading = true;
  syncQuotaControls();
  quotaRequest = fetchQuotaStatus()
    .then((status) => {
      quotaStatus = status;
      quotaFetchedAt = Date.now();
      quotaLoading = false;
      syncQuotaControls({ announce });
      scheduleQuotaResetRefresh();
      return status;
    })
    .catch(() => {
      quotaLoading = false;
      quotaStatus = {
        ...(quotaStatus || {}),
        temporaryChecked: false
      };
      syncQuotaControls({ announce });
      return quotaStatus;
    })
    .finally(() => { quotaRequest = null; });
  return quotaRequest;
}

function noteSuccessfulImageQuota() {
  if (!quotaStatus) return;
  quotaStatus = recordSuccessfulImage(quotaStatus);
  syncQuotaControls({ announce: true });
}

/* ── prefs ─────────────────────────────────────────────────── */
function persist() {
  prefs.save({
    prompt: $("prompt").value,
    negative: $("negative").value,
    model: $("model").value, sampler: $("sampler").value,
    width: Number($("width").value), height: Number($("height").value),
    steps: Number($("steps").value), scale: Number($("scale").value), cfg: Number($("cfg").value),
    seed: $("seed").value,
    batchCount: requestedBatchCount,
    optimize: $("optimize").checked, serverCache: $("serverCache").checked,
    localCache: $("localCache").checked
  });
}

/* Text fields fire `persist` on every keystroke, so coalesce the writes. */
let persistTimer = null;
function persistSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persist, 400);
}

function restore() {
  const s = prefs.load();
  if (typeof s.prompt === "string") $("prompt").value = s.prompt;
  if (typeof s.negative === "string") $("negative").value = s.negative;
  if (s.width) $("width").value = s.width;
  if (s.height) $("height").value = s.height;
  if (s.steps != null) $("steps").value = s.steps;
  if (s.scale != null) $("scale").value = s.scale;
  if (s.cfg != null) $("cfg").value = s.cfg;
  if (s.seed != null) $("seed").value = s.seed;
  setRequestedBatchCount(s.batchCount ?? requestedBatchCount);
  $("optimize").checked = s.optimize ?? DEFAULTS.optimize;
  $("serverCache").checked = s.serverCache ?? DEFAULTS.serverCache;
  $("localCache").checked = s.localCache ?? DEFAULTS.localCache;
}

/* Median of past durations. Measured spread is wide and driven by upstream
   queue depth, not step count (8 steps once took longer than 16), so a
   determinate progress bar would be fiction. Show a typical time instead. */
function typicalMs(items) {
  const xs = items.map((i) => i.ms).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (xs.length < 3) return null;
  return xs[Math.floor(xs.length / 2)];
}

/* ── gallery ───────────────────────────────────────────────── */
function renderGallery() {
  const items = history.all();
  const tray = $("tray");
  // Keep the current non-history result alive as well. Without this, turning
  // off "加入历史" revoked its object URL as soon as the gallery rerendered.
  const seen = new Set(current?.id ? [current.id] : []);

  tray.innerHTML = "";
  $("histCount").textContent = String(items.length);
  $("clearHist").hidden = items.length === 0;
  $("trayEmpty").hidden = items.length !== 0 || !!pendingShape;

  /* A placeholder for the image still being generated. Without it, browsing
     back to an earlier result during a batch left no sign that anything was
     still running — the rail looked idle and the new image arrived from
     nowhere. It leads the list because history is newest-first. */
  if (pendingShape) {
    const slot = document.createElement("div");
    slot.className = "tile tile-pending";
    slot.setAttribute("role", "status");
    slot.setAttribute("aria-label", pendingLabel());
    slot.dataset.tip = pendingLabel();
    slot.style.aspectRatio = `${pendingShape.width} / ${pendingShape.height}`;
    const glow = document.createElement("div");
    glow.className = "shimmer";
    slot.append(glow);
    tray.append(slot);
  }

  for (const item of items) {
    seen.add(item.id);

    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "tile";
    tile.setAttribute("aria-current", String(current?.id === item.id));
    const when = new Date(item.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    tile.title = `${when}\n${item.params?.prompt?.slice(0, 140) || ""}`;

    const img = document.createElement("img");
    // Use the downscaled thumbnail. Full-size blobs here decode to ~3.9 MB
    // each and previously exhausted renderer memory.
    img.src = item.thumbUrl || urls.get(item.id) || (() => {
      const u = URL.createObjectURL(item.blob);
      urls.set(item.id, u);
      return u;
    })();
    img.alt = "";
    img.decoding = "async";
    // reserve the right box before decode so the rail does not jump
    if (item.size?.width && item.size?.height) {
      tile.style.aspectRatio = `${item.size.width} / ${item.size.height}`;
    }
    tile.append(img);

    const x = document.createElement("span");
    x.className = "tile-x";
    x.textContent = "×";
    x.setAttribute("role", "button");
    x.setAttribute("aria-label", "删除");
    x.addEventListener("click", (event) => {
      event.stopPropagation();
      history.remove(item.id);
      const url = urls.get(item.id);
      if (url) { URL.revokeObjectURL(url); urls.delete(item.id); }
      if (current?.id === item.id) {
        current = null;
        setState("empty");
        for (const id of ["saveBtn", "reuseBtn", "copyBtn"]) $(id).hidden = true;
      }
      renderGallery();
    });
    tile.append(x);

    // Draggable onto the composer to reopen its parameters.
    tile.draggable = true;
    tile.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData("application/x-scylla-history", item.id);
      event.dataTransfer.effectAllowed = "copy";
    });

    tile.addEventListener("click", () => showEntry(item));
    tray.append(tile);
  }

  for (const [id, url] of urls) {
    if (!seen.has(id)) { URL.revokeObjectURL(url); urls.delete(id); }
  }
}

function showEntry(item) {
  const url = urls.get(item.id) || URL.createObjectURL(item.blob);
  urls.set(item.id, url);
  current = { id: item.id, blob: item.blob, params: item.params, size: item.size, url };

  $("image").src = url;

  $("stageTitle").textContent = item.params?.modelName || "结果";
  const bits = [
    item.size ? `${item.size.width}×${item.size.height}` : "",
    item.params?.seed != null ? `seed ${item.params.seed}` : "",
    Number.isFinite(item.ms) ? `${(item.ms / 1000).toFixed(1)}s` : ""
  ].filter(Boolean);
  $("stageSub").textContent = bits.join("  ·  ");
  // Deliberately excludes seed: stageSub above already shows it, and the
  // duplicate was long enough to wrap this strip onto several lines on phones.
  $("printMeta").textContent = [
    item.params?.sampler,
    `${item.params?.steps} steps`,
    `cfg ${item.params?.cfg}`,
    `scale ${item.params?.scale}`
  ].filter(Boolean).join(" · ");

  setState("done");
  $("saveBtn").hidden = false;
  $("reuseBtn").hidden = false;
  $("copyBtn").hidden = !item.params?.prompt;
  renderGallery();
}

/* ── generate ──────────────────────────────────────────────── */
function collect() {
  const model = activeModel();
  const raw = $("seed").value.trim();
  const seed = raw === ""
    ? randomSeed()
    : Math.min(4_294_967_295, Math.max(0, Math.floor(Number(raw))));

  return {
    prompt: $("prompt").value.trim(),
    negative_prompt: $("negative").value.trim(),
    model: model?.id,
    modelName: model?.name,
    width: Number($("width").value),
    height: Number($("height").value),
    steps: Number($("steps").value),
    sampler: $("sampler").value,
    scale: Number($("scale").value),
    cfg: Number($("cfg").value),
    seed,
    randomSeed: raw === "",
    batchCount: batchCount(),
    localHistory: $("localCache").checked,
    optimize: $("optimize").checked,
    cache: $("serverCache").checked,
    transform_prompt: false
  };
}

function randomSeed() {
  if (globalThis.crypto?.getRandomValues) {
    return crypto.getRandomValues(new Uint32Array(1))[0];
  }
  return Math.floor(Math.random() * UINT32_RANGE);
}

function paramsForBatchItem(base, index, total) {
  return {
    ...base,
    seed: base.randomSeed ? randomSeed() : (base.seed + index) % UINT32_RANGE,
    batchIndex: index + 1,
    batchTotal: total
  };
}

function comparisonColumns(total) {
  if (total <= 2) return total;
  if (total === 3) return 3;
  if (total <= 4) return 2;
  if (total <= 9) return 3;
  if (total <= 16) return 4;
  return 5;
}

async function drawBlobContained(ctx, blob, x, y, width, height) {
  let source = null;
  let release = () => {};

  if (typeof createImageBitmap === "function") {
    try {
      source = await createImageBitmap(blob);
      release = () => source.close?.();
    } catch {
      source = null;
    }
  }

  if (!source) {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.src = url;
    try {
      if (image.decode) await image.decode();
      else await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error("图片解码失败"));
      });
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
    source = image;
    release = () => URL.revokeObjectURL(url);
  }

  try {
    const scale = Math.min(width / source.width, height / source.height);
    const drawWidth = Math.max(1, Math.round(source.width * scale));
    const drawHeight = Math.max(1, Math.round(source.height * scale));
    const drawX = x + Math.round((width - drawWidth) / 2);
    const drawY = y + Math.round((height - drawHeight) / 2);
    ctx.drawImage(source, drawX, drawY, drawWidth, drawHeight);
  } finally {
    release();
  }
}

function canvasBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("浏览器未能编码对比图"));
    }, "image/png");
  });
}

async function makeComparison(records, base) {
  const total = records.length;
  const columns = comparisonColumns(total);
  const rows = Math.ceil(total / columns);
  const padding = 24;
  const gap = 12;
  const headerHeight = 76;
  const cellWidth = Math.min(
    480,
    Math.floor((2048 - padding * 2 - gap * (columns - 1)) / columns)
  );
  const cellHeight = Math.max(1, Math.round(cellWidth * base.height / base.width));
  const width = padding * 2 + columns * cellWidth + (columns - 1) * gap;
  const height = padding * 2 + headerHeight + rows * cellHeight + (rows - 1) * gap;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("当前浏览器不支持 Canvas 合成");

  ctx.fillStyle = "#0a0a0c";
  ctx.fillRect(0, 0, width, height);
  ctx.textBaseline = "top";
  ctx.fillStyle = "#f2f1f4";
  ctx.font = '600 25px ui-sans-serif, -apple-system, "PingFang SC", sans-serif';
  ctx.fillText(`串行批量 · ${total} 张对比`, padding, padding);
  ctx.fillStyle = "#8e8d98";
  ctx.font = '14px ui-monospace, "SFMono-Regular", Menlo, monospace';
  ctx.fillText(
    `${base.modelName || base.model} · ${base.width}×${base.height} · ${base.steps} steps · ${base.sampler}`,
    padding,
    padding + 38,
    width - padding * 2
  );

  for (let index = 0; index < total; index += 1) {
    if (cancelRequested) throw new DOMException("已取消", "AbortError");
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = padding + column * (cellWidth + gap);
    const y = padding + headerHeight + row * (cellHeight + gap);
    ctx.fillStyle = "#16161b";
    ctx.fillRect(x, y, cellWidth, cellHeight);
    await drawBlobContained(ctx, records[index].blob, x, y, cellWidth, cellHeight);

    const labelHeight = Math.min(36, Math.max(28, Math.round(cellHeight * 0.08)));
    ctx.fillStyle = "rgba(7, 7, 9, 0.78)";
    ctx.fillRect(x, y + cellHeight - labelHeight, cellWidth, labelHeight);
    ctx.fillStyle = "#f2f1f4";
    ctx.font = '600 14px ui-monospace, "SFMono-Regular", Menlo, monospace';
    ctx.textBaseline = "middle";
    ctx.fillText(
      `#${index + 1}  ·  seed ${records[index].params.seed}`,
      x + 11,
      y + cellHeight - labelHeight / 2,
      cellWidth - 22
    );
    ctx.textBaseline = "top";
  }

  return { blob: await canvasBlob(canvas), size: { width, height } };
}

async function addComparison(records, base) {
  const { blob, size } = await makeComparison(records, base);
  const params = {
    ...base,
    modelName: `串行对比 · ${records.length} 张`,
    seed: null,
    seedStart: base.randomSeed ? null : base.seed,
    randomSeed: false,
    isComparison: true,
    comparisonTotal: records.length,
    batchTotal: records.length
  };
  const thumb = await makeThumb(blob);
  return history.add({
    blob,
    params,
    size,
    ms: records.reduce((sum, item) => sum + (Number(item.ms) || 0), 0),
    thumbUrl: thumb ? URL.createObjectURL(thumb) : null
  });
}

function startTimer() {
  const t0 = performance.now();
  $("timer").textContent = "0.0s";
  ticker = setInterval(() => {
    $("timer").textContent = `${((performance.now() - t0) / 1000).toFixed(1)}s`;
  }, 100);
}

function setBusy(on) {
  $("goBtn").disabled = on;
  if (on) $("goLabel").textContent = `准备 ×${batchCount()}`;
  else syncGenerateLabel();
  $("cancelBtn").hidden = !on;
  $("form").setAttribute("aria-busy", String(on));
  if (on) for (const id of ["saveBtn", "reuseBtn", "copyBtn"]) $(id).hidden = true;
}

async function runBatch(base) {
  const total = base.batchCount;
  const typical = typicalMs(history.all());
  let completed = 0;
  let quotaStopped = false;
  const completedRecords = [];
  startTimer();
  try {
    for (let index = 0; index < total; index += 1) {
      if (cancelRequested) throw new DOMException("已取消", "AbortError");
      /* Claim the next slot before the quota check, not after: that check is a
         network round trip, and until the placeholder advances it still names
         the image that just finished. */
      pendingShape = { ...pendingShape, index: index + 1, total };
      renderGallery();
      if (index > 0) {
        if (!batchRestricted) await refreshQuota({ force: true, announce: true });
        if (batchRestricted) {
          quotaStopped = true;
          break;
        }
      }

      const params = paramsForBatchItem(base, index, total);
      controller = new AbortController();
      setState("busy");
      $("goLabel").textContent = `剩余 ×${total - index}`;
      $("stageTitle").textContent = total > 1 ? `串行生成 · 剩余 ×${total - index}` : "生成中";
      $("stageSub").textContent = completed ? `已完成 ${completed}/${total}` : "";
      $("busyNote").textContent = [
        `${params.width}×${params.height}`,
        total > 1 ? `第 ${index + 1} 张` : params.modelName,
        typical ? `通常约 ${(typical / 1000).toFixed(0)}s/张` : ""
      ].filter(Boolean).join(" · ");

      const { blob, size, ms } = await generate(params, { signal: controller.signal });
      controller = null;

      // Decode first so the picture never appears half-painted.
      const probe = new Image();
      const tmp = URL.createObjectURL(blob);
      probe.src = tmp;
      if (probe.decode) await probe.decode().catch(() => {});
      URL.revokeObjectURL(tmp);

      let record;
      if (base.localHistory) {
        const thumb = await makeThumb(blob);
        record = history.add({
          blob, params, size, ms,
          thumbUrl: thumb ? URL.createObjectURL(thumb) : null
        });
      } else {
        record = { id: `live-${Date.now()}`, createdAt: Date.now(), blob, params, size, ms };
      }
      completed += 1;
      completedRecords.push(record);
      showEntry(record);
      noteSuccessfulImageQuota();
      if (batchRestricted && completed < total) {
        quotaStopped = true;
        break;
      }
    }

    if (quotaStopped) {
      $("stageTitle").textContent = "额度保护已停止串行";
      $("stageSub").textContent = `已完成 ${completed}/${total}`;
      $("busyNote").textContent = "临时 Key 全局日额度低于 300，未再提交后续请求";
      setState("done");
      return;
    }

    if (total > 1) {
      $("goLabel").textContent = "合成对比图…";
      $("stageTitle").textContent = "正在整理批次";
      $("stageSub").textContent = `已完成 ${completed}/${total}`;
      $("busyNote").textContent = "图片已全部生成 · 正在本地合成对比图";
      // Every image is done; the remaining work is local compositing, so the
      // rail should say that rather than keep counting requests.
      pendingShape = { ...pendingShape, composing: true };
      setState("busy");
      renderGallery();
      try {
        const comparison = await addComparison(completedRecords, base);
        showEntry(comparison);
        toast(`串行批量完成：${completed} 张，已生成对比图`, "ok");
      } catch (error) {
        if (error.name === "AbortError") throw error;
        showEntry(completedRecords.at(-1));
        toast(`图片已完成，但对比图生成失败：${error.message || "未知错误"}`);
      }
    }
  } catch (error) {
    if (error.name === "AbortError") {
      setState(current ? "done" : "empty");
      toast(total > 1 ? `已取消：完成 ${completed}/${total} 张` : "已取消", "ok");
    } else {
      const prefix = total > 1 ? `第 ${completed + 1}/${total} 张失败，队列已停止。` : "";
      $("errBody").textContent = `${prefix}${error.message || "未知错误"}`;
      setState("error");
      $("stageTitle").textContent = total > 1 ? "批量中止" : "失败";
      $("stageSub").textContent = total > 1 ? `已完成 ${completed}/${total}` : "";
    }
  } finally {
    clearInterval(ticker);
    ticker = null;
    controller = null;
  }
}

/* Web Locks serializes every tab on this origin. The local proxy has its own
   process-level guard as well; direct mode cannot coordinate other devices or
   origins, so the upstream still remains the final authority there. */
async function withGenerationLock(task) {
  if (!navigator.locks?.request) {
    await task();
    return true;
  }

  let acquired = false;
  let callbackStarted = false;
  try {
    await navigator.locks.request(
      GENERATION_LOCK,
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        callbackStarted = true;
        if (!lock) return;
        acquired = true;
        await task();
      }
    );
  } catch (error) {
    // Older Web Locks implementations may reject unsupported options. Only
    // fall back when the task itself never started, otherwise it could run twice.
    if (callbackStarted) throw error;
    await task();
    acquired = true;
  }
  return acquired;
}

async function run() {
  if (jobActive || quotaPreflightActive) { toast("已有生成任务，请先等待或取消"); return; }
  quotaPreflightActive = true;
  $("goBtn").disabled = true;
  $("goLabel").textContent = "检查额度…";
  try {
    await refreshQuota({ force: true, announce: true });
  } finally {
    quotaPreflightActive = false;
    syncGenerateLabel();
  }
  if (jobActive) return;
  if (!validateSize()) return;

  commitBatchCount();
  const params = collect();
  if (!params.model) { toast("模型列表未就绪"); return; }
  if (params.batchCount > 1 && !params.localHistory) {
    toast("串行批量需要开启「加入历史」，否则前面的结果无法保留");
    return;
  }

  // Freeze the shape before the first request; the form stays editable.
  pendingShape = { width: params.width, height: params.height, index: 1, total: params.batchCount };
  sizeSkeleton();
  renderGallery();
  jobActive = true;
  cancelRequested = false;
  setBusy(true);
  setState("busy");
  $("stageTitle").textContent = "准备生成";
  $("stageSub").textContent = "";
  $("busyNote").textContent = params.batchCount > 1 ? `等待串行锁 · 共 ${params.batchCount} 张` : "等待生成锁";

  try {
    const acquired = await withGenerationLock(() => runBatch(params));
    if (!acquired) {
      setState(current ? "done" : "empty");
      toast("另一个标签页正在生成；为避免并发，本次未提交");
    }
  } catch (error) {
    setState("error");
    $("stageTitle").textContent = "失败";
    $("stageSub").textContent = "";
    $("errBody").textContent = error.message || "生成锁异常";
  } finally {
    jobActive = false;
    cancelRequested = false;
    setBusy(false);
    controller = null;
    pendingShape = null;
    renderGallery();
    sizeSkeleton();
    validateSize();
  }
}

/* ── wiring ────────────────────────────────────────────────── */
$("form").addEventListener("submit", (e) => { e.preventDefault(); run(); });
$("cancelBtn").addEventListener("click", () => {
  cancelRequested = true;
  controller?.abort();
});
$("retryBtn").addEventListener("click", () => run());

$("model").addEventListener("change", () => { syncModelHint(); persist(); });
$("sampler").addEventListener("change", () => { syncAdvBadge(); persist(); });
$("prompt").addEventListener("input", () => { syncPromptCount(); persistSoon(); });
$("negative").addEventListener("input", persistSoon);
document.querySelectorAll("[data-convert-prompt]").forEach((button) => {
  const textarea = $(button.dataset.convertPrompt);
  const settle = (label) => {
    button.dataset.state = "done";
    const restore = () => {
      delete button.dataset.state;
      textarea.removeEventListener("input", restore);
    };
    textarea.addEventListener("input", restore, { once: true });
    toast(label, "ok");
  };

  button.addEventListener("click", () => {
    const before = textarea.value;
    if (!before.trim()) {
      toast("没有可清洗内容");
      return;
    }
    const converted = convertToNaiPrompt(before);
    if (converted === before) {
      settle("格式已经是 NAI 写法");
      return;
    }
    textarea.setRangeText(converted, 0, before.length, "end");
    textarea.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertReplacementText",
      data: converted
    }));
    settle("格式已清洗");
  });
});




for (const id of ["width", "height"]) {
  $(id).addEventListener("input", () => {
    customMode = true;
    validateSize();
    sizeSkeleton();
    persist();
  });
  $(id).addEventListener("change", () => snapField(id));
  $(id).addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); snapField(id); }
  });
}
for (const id of ["steps", "scale", "cfg"]) {
  $(id).addEventListener("input", () => { syncRangeLabels(); syncAdvBadge(); persist(); });
}
for (const id of ["optimize", "serverCache", "localCache"]) {
  $(id).addEventListener("change", () => { syncAdvBadge(); persist(); });
}
$("seed").addEventListener("input", () => { syncAdvBadge(); persistSoon(); });
$("batchCount").addEventListener("input", () => {
  if (!batchRestricted) requestedBatchCount = normalizedBatchCount($("batchCount").value);
  syncAdvBadge(); syncGenerateLabel(); persistSoon();
});
$("batchCount").addEventListener("change", commitBatchCount);
$("batchCount").addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); commitBatchCount(); }
});

$("diceBtn").addEventListener("click", () => {
  $("seed").value = randomSeed();
  syncAdvBadge();
});

$("resetAdv").addEventListener("click", () => {
  $("sampler").value = catalog.samplers.includes(DEFAULTS.sampler) ? DEFAULTS.sampler : catalog.samplers[0];
  $("steps").value = DEFAULTS.steps;
  $("scale").value = DEFAULTS.scale;
  $("cfg").value = DEFAULTS.cfg;
  $("seed").value = "";
  setRequestedBatchCount(DEFAULTS.batchCount);
  $("optimize").checked = DEFAULTS.optimize;
  $("serverCache").checked = DEFAULTS.serverCache;
  $("localCache").checked = DEFAULTS.localCache;
  syncRangeLabels(); syncAdvBadge(); syncGenerateLabel(); persist();
});

$("saveBtn").addEventListener("click", () => {
  if (!current) return;
  const ext = current.blob.type.includes("jpeg") ? "jpg" : "png";
  const a = document.createElement("a");
  a.href = current.url;
  a.download = current.params.isComparison
    ? `${current.params.model}-batch-${current.params.comparisonTotal}.${ext}`
    : `${current.params.model}-${current.params.seed}.${ext}`;
  a.click();
});

$("copyBtn").addEventListener("click", async () => {
  if (!current?.params?.prompt) return;
  try {
    await navigator.clipboard.writeText(current.params.prompt);
    toast("描述已复制", "ok");
  } catch {
    toast("浏览器拒绝了剪贴板访问");
  }
});

/* Re-run every derived view after the form is written to programmatically.
   Assigning .value fires no input event, so nothing downstream updates on
   its own — the highlight mirror in particular would keep the old text. */
function syncAfterFormWrite() {
  customMode = !RATIOS.some(
    (r) => !r.custom && r.w === Number($("width").value) && r.h === Number($("height").value)
  );
  refreshHighlights();
  syncRangeLabels();
  syncModelHint();   // -> validateSize() -> syncRatioSelection()
  syncAdvBadge();
  syncGenerateLabel();
  syncPromptCount();
  sizeSkeleton();
  persist();
}

/* Write a subset of generation parameters into the form. Keys absent from
   `fields` are left alone, which is what makes partial imports safe. */
function applyParams(fields) {
  const applied = [];
  const set = (key, id, value) => {
    if (value === undefined) return;
    $(id).value = value;
    applied.push(key);
  };

  set("prompt", "prompt", fields.prompt);
  set("negative_prompt", "negative", fields.negative_prompt);
  if (fields.model !== undefined && catalog.models.some((m) => m.id === fields.model)) {
    set("model", "model", fields.model);
  }
  set("width", "width", fields.width);
  set("height", "height", fields.height);
  set("steps", "steps", fields.steps);
  set("scale", "scale", fields.scale);
  set("cfg", "cfg", fields.cfg);
  if (fields.sampler !== undefined && catalog.samplers.includes(fields.sampler)) {
    set("sampler", "sampler", fields.sampler);
  }
  if (fields.seed !== undefined) set("seed", "seed", fields.seed ?? "");
  if (fields.batchCount !== undefined) {
    setRequestedBatchCount(fields.batchCount);
    applied.push("batchCount");
  }

  syncAfterFormWrite();
  return applied;
}

$("reuseBtn").addEventListener("click", () => {
  if (!current?.params) return;
  const p = current.params;
  applyParams({
    prompt: p.prompt || "",
    negative_prompt: p.negative_prompt || "",
    model: p.model,
    width: p.width,
    height: p.height,
    steps: p.steps,
    scale: p.scale,
    cfg: p.cfg,
    sampler: p.sampler,
    seed: p.isComparison ? (p.seedStart ?? "") : (p.seed ?? ""),
    batchCount: p.batchTotal || p.batchCount || 1
  });
  toast("参数已回填", "ok");
});

$("clearHist").addEventListener("click", () => {
  const n = history.size;
  if (n && !confirm(`清空 ${n} 张图片？此操作无法撤销。`)) return;
  history.clear();
  for (const [, url] of urls) URL.revokeObjectURL(url);
  urls.clear();
  current = null;
  setState("empty");
  for (const id of ["saveBtn", "reuseBtn", "copyBtn"]) $(id).hidden = true;
  renderGallery();
});

/* ── Tag autocomplete toggle ───────────────────────────────── */
/* Detaching rather than muting: with it off no keystroke should reach the
   dictionary service at all, which is the point of the switch. */
let detachAutocomplete = [];

function setTagAutocomplete(on) {
  for (const detach of detachAutocomplete) detach();
  detachAutocomplete = on
    ? ["prompt", "negative"].map((id) => attachTagAutocomplete($(id)))
    : [];
  $("tagSuggest").checked = on;
}

$("tagSuggest").addEventListener("change", (e) => {
  const on = e.target.checked;
  setTagAutocomplete(on);
  prefs.save({ tagSuggest: on });
  toast(on ? "已开启 Tag 自动补全" : "已关闭 Tag 自动补全", "ok");
});

$("histToggle").addEventListener("click", () => {
  const on = body.dataset.hist !== "off";
  body.dataset.hist = on ? "off" : "on";
  $("histToggle").setAttribute("aria-pressed", String(!on));
  $("histToggle").dataset.tip = on ? "显示历史" : "隐藏历史";
  prefs.save({ histOpen: !on });
  setTimeout(measureFit, 400);
});

/* lightbox */
function openZoom() {
  if (!current) return;
  $("lightboxImg").src = current.url;
  $("lightbox").hidden = false;
  requestAnimationFrame(() => { body.dataset.zoom = "on"; });
}
function closeZoom() {
  body.dataset.zoom = "off";
  setTimeout(() => { $("lightbox").hidden = true; }, 240);
}
$("image").addEventListener("click", openZoom);
$("lightboxClose").addEventListener("click", closeZoom);
$("lightbox").addEventListener("click", (e) => { if (e.target !== $("lightboxImg")) closeZoom(); });

/* ── Import parameters from an image ───────────────────────── */
/* Labels and the order rows appear in. Prompt first because it is what the
   reader checks to decide whether this is even the right image. */
const IMPORT_ROWS = [
  { key: "prompt", label: "描述", wide: true },
  { key: "negative_prompt", label: "排除", wide: true },
  { key: "model", label: "模型" },
  { key: "width", label: "宽" },
  { key: "height", label: "高" },
  { key: "steps", label: "步数" },
  { key: "sampler", label: "采样器" },
  { key: "scale", label: "Scale" },
  { key: "cfg", label: "CFG" },
  { key: "seed", label: "Seed" }
];

let importCandidate = null;
let lastImportFocus = null;

function closeImport() {
  body.dataset.import = "closed";
  setTimeout(() => { $("importSheet").hidden = true; }, 320);
  importCandidate = null;
  lastImportFocus?.focus?.();
  lastImportFocus = null;
}

function openImport(result) {
  importCandidate = result;
  const list = $("importList");
  list.replaceChildren();

  const unusable = [];
  for (const row of IMPORT_ROWS) {
    const value = result.fields[row.key];
    if (value === undefined) continue;

    /* A model or sampler this deployment does not offer cannot be applied.
       Offering the checkbox anyway would tick a box that does nothing. */
    if (row.key === "model" && !catalog.models.some((m) => m.id === value)) {
      unusable.push(`模型 ${value}`);
      continue;
    }
    if (row.key === "sampler" && !catalog.samplers.includes(value)) {
      unusable.push(`采样器 ${value}`);
      continue;
    }

    const label = document.createElement("label");
    label.className = `import-row${row.wide ? " wide" : ""}`;
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = true;
    box.dataset.field = row.key;
    const tick = document.createElement("span");
    tick.className = "box";
    const key = document.createElement("span");
    key.className = "k";
    key.textContent = row.label;
    const shown = document.createElement("span");
    shown.className = "v";
    // An empty string is a real value here: importing it clears the field.
    shown.textContent = String(value) === "" ? "（清空）" : String(value);
    label.append(box, tick, key, shown);
    list.append(label);
  }

  /* Name what will not carry over, so a dropped field does not read as the
     import having silently misfired. */
  const absent = ["model", "cfg"]
    .filter((k) => result.fields[k] === undefined)
    .map((k) => (k === "model" ? "模型" : "CFG"));
  const notes = [];
  if (absent.length) notes.push(`未包含${absent.join("与")}`);
  if (unusable.length) notes.push(`不支持${unusable.join("、")}`);
  const note = $("importSkipped");
  note.hidden = !notes.length;
  note.textContent = notes.length ? `${notes.join("；")}，保持当前设置不变。` : "";

  $("importFrom").textContent = `${result.name} · ${result.dialect} 格式`;
  lastImportFocus = document.activeElement;
  $("importSheet").hidden = false;
  requestAnimationFrame(() => { body.dataset.import = "open"; });
  setTimeout(() => $("importApply").focus(), 300);
}

async function readAndOpen(file) {
  try {
    openImport(await readImageParams(file));
  } catch (error) {
    toast(error.message || "读取失败");
  }
}

$("importApply").addEventListener("click", () => {
  if (!importCandidate) return;
  const wanted = new Set(
    [...$("importList").querySelectorAll("input:checked")].map((el) => el.dataset.field)
  );
  if (!wanted.size) {
    toast("没有勾选任何参数");
    return;
  }
  const fields = {};
  for (const [key, value] of Object.entries(importCandidate.fields)) {
    if (wanted.has(key)) fields[key] = value;
  }
  const applied = applyParams(fields);
  closeImport();
  toast(`已导入 ${applied.length} 项参数`, "ok");
});

$("importCancel").addEventListener("click", closeImport);
$("importSheet").addEventListener("click", (e) => {
  if (e.target === $("importSheet")) closeImport();
});

$("importBtn").addEventListener("click", () => { if (!gateBlocking()) $("importFile").click(); });
$("importFile").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  // Reset first so picking the same file twice still fires a change event.
  e.target.value = "";
  if (file) await readAndOpen(file);
});

/* Drag and drop. dragenter/dragleave fire for every child element crossed,
   so track depth instead of toggling on each event. */
let dragDepth = 0;
/* Ignore drops while the key gate is up: the form behind it is not ready to
   receive values, and stacking a second dialog over the gate reads as broken. */
const gateBlocking = () => !$("gate").hidden;
const hasFiles = (e) => !gateBlocking() && [...(e.dataTransfer?.types || [])].includes("Files");

window.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth += 1;
  body.dataset.drop = "on";
});
window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener("dragleave", (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) body.dataset.drop = "off";
});
window.addEventListener("drop", async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  body.dataset.drop = "off";
  const file = [...(e.dataTransfer.files || [])].find((f) => /^image\/(png|jpeg)$/.test(f.type));
  if (!file) {
    toast("请拖入 PNG 或 JPEG 图片");
    return;
  }
  await readAndOpen(file);
});

/* A dragged history tile carries its record id. Reading pixels back would be
   the worse source: the stored params are exact, whereas re-parsing loses
   whatever the encoder dropped — and JPEG output has no chunks at all. */
const HISTORY_MIME = "application/x-scylla-history";

const hasHistoryDrag = (e) => !gateBlocking() && !!e.dataTransfer?.types?.includes(HISTORY_MIME);

window.addEventListener("dragenter", (e) => {
  if (!hasHistoryDrag(e)) return;
  e.preventDefault();
  dragDepth += 1;
  body.dataset.drop = "on";
});
window.addEventListener("dragover", (e) => {
  if (hasHistoryDrag(e)) e.preventDefault();
});
window.addEventListener("drop", (e) => {
  if (gateBlocking()) return;
  const id = e.dataTransfer?.getData(HISTORY_MIME);
  if (!id) return;
  e.preventDefault();
  dragDepth = 0;
  body.dataset.drop = "off";
  const item = history.get(id);
  if (!item?.params) {
    toast("这张图的参数已不在会话中");
    return;
  }
  const p = item.params;
  openImport({
    name: p.modelName || "历史记录",
    dialect: "本次会话",
    fields: {
      prompt: p.prompt || "",
      negative_prompt: p.negative_prompt || "",
      model: p.model,
      width: p.width,
      height: p.height,
      steps: p.steps,
      sampler: p.sampler,
      scale: p.scale,
      cfg: p.cfg,
      seed: p.isComparison ? (p.seedStart ?? "") : (p.seed ?? "")
    }
  });
});

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    if (!$("goBtn").disabled) run();
  }
  if (e.key === "Escape") {
    if (body.dataset.import === "open") closeImport();
    else if (body.dataset.zoom === "on") closeZoom();
    else if (controller) controller.abort();
  }
});

$("lockButton").addEventListener("click", () => {
  // Session mode has no passphrase, so locking discards the key entirely and
  // the user must paste it again. Say so before doing it.
  const warnings = [];
  if (jobActive) warnings.push("当前生成任务和剩余队列将被取消");
  if (vault.mode() === "session") warnings.push("本模式没有口令，Key 将被清除，需要重新填写");
  if (history.size) warnings.push(`本次的 ${history.size} 张图片将丢失`);
  if (warnings.length && !confirm(`锁定并重载页面：\n\n· ${warnings.join("\n· ")}\n\n继续？`)) return;
  cancelRequested = true;
  controller?.abort();
  suppressUnloadGuard = true;
  vault.lock();
  location.reload();
});

/* Flush any debounced write before the page goes away, so refreshing right
   after typing cannot lose the last few hundred milliseconds. */
/* History lives in memory only, so a reload destroys it. Warn while there is
   something to lose. Browsers ignore custom text and show their own prompt;
   they also require a prior user interaction, so this cannot nag on load. */
addEventListener("beforeunload", (event) => {
  if (suppressUnloadGuard || (!history.size && !jobActive)) return;
  event.preventDefault();
  event.returnValue = "";
});

addEventListener("pagehide", () => { clearTimeout(persistTimer); persist(); });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") { clearTimeout(persistTimer); persist(); }
});

/* ── Splitter ──────────────────────────────────────────────── */
const RAIL_MIN = 292;
const RAIL_MAX = 560;

function setRail(px) {
  const clamped = Math.min(RAIL_MAX, Math.max(RAIL_MIN, Math.round(px)));
  document.documentElement.style.setProperty("--rail", `${clamped}px`);
  prefs.save({ rail: clamped });
  measureFit();
}

$("splitter").addEventListener("pointerdown", (event) => {
  event.preventDefault();
  const startX = event.clientX;
  const startRail = $("form").getBoundingClientRect().width;
  body.dataset.drag = "on";
  $("splitter").setPointerCapture(event.pointerId);

  const move = (e) => setRail(startRail + (e.clientX - startX));
  const up = () => {
    body.dataset.drag = "off";
    $("splitter").removeEventListener("pointermove", move);
    $("splitter").removeEventListener("pointerup", up);
    $("splitter").removeEventListener("pointercancel", up);
  };
  $("splitter").addEventListener("pointermove", move);
  $("splitter").addEventListener("pointerup", up);
  $("splitter").addEventListener("pointercancel", up);
});

$("splitter").addEventListener("dblclick", () => setRail(352));

$("splitter").addEventListener("keydown", (event) => {
  const step = event.shiftKey ? 40 : 12;
  const width = $("form").getBoundingClientRect().width;
  if (event.key === "ArrowLeft") { event.preventDefault(); setRail(width - step); }
  if (event.key === "ArrowRight") { event.preventDefault(); setRail(width + step); }
});

/* Observe the viewport itself. It is `overflow:hidden` and its size comes from
   the layout above it, never from its contents, so this cannot feed back into
   itself; measureFit() is also idempotent as a second line of defence.
   `visualViewport` catches mobile URL-bar collapse, which does not always
   fire a window resize. */
const roTargets = [document.querySelector(".stage"), $("viewport")].filter(Boolean);
const ro = new ResizeObserver(measureFit);
for (const el of roTargets) ro.observe(el);
window.addEventListener("resize", measureFit);
window.addEventListener("orientationchange", () => setTimeout(measureFit, 250));
visualViewport?.addEventListener("resize", measureFit);

/* ── gate handlers ─────────────────────────────────────────── */
for (const radio of document.querySelectorAll('input[name="saveMode"]')) {
  radio.addEventListener("change", () => {
    const mode = document.querySelector('input[name="saveMode"]:checked').value;
    $("passFields").hidden = mode !== "encrypted";
  });
}

$("setupSubmit").addEventListener("click", async () => {
  const note = $("setupNote");
  note.className = "note";
  const key = $("setupKey").value.trim();
  if (!key) { note.textContent = "请填写 API Key"; return; }

  const mode = document.querySelector('input[name="saveMode"]:checked').value;
  try {
    if (mode === "encrypted") {
      const p1 = $("setupPass").value;
      if (p1.length < 4) { note.textContent = "口令至少 4 位"; return; }
      if (p1 !== $("setupPass2").value) { note.textContent = "两次口令不一致"; return; }
      await vault.saveEncrypted(key, p1, { remember: $("setupRemember").checked });
    } else {
      vault.saveSession(key);
    }
    $("setupKey").value = $("setupPass").value = $("setupPass2").value = "";
    await enterApp();
  } catch (error) {
    note.textContent = error.message;
  }
});

$("unlockSubmit").addEventListener("click", async () => {
  const note = $("unlockNote");
  note.className = "note";
  try {
    await vault.unlock($("unlockPass").value, { remember: $("unlockRemember").checked });
    $("unlockPass").value = "";
    await enterApp();
  } catch (error) {
    note.textContent = error.message;
  }
});

$("unlockPass").addEventListener("keydown", (e) => { if (e.key === "Enter") $("unlockSubmit").click(); });
$("setupKey").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("setupPass").focus(); } });
$("setupPass2").addEventListener("keydown", (e) => { if (e.key === "Enter") $("setupSubmit").click(); });
$("forgetKey").addEventListener("click", () => { vault.forget(); showGate("setup"); });
$("proxyEnter").addEventListener("click", () => enterApp());

/* ── boot ──────────────────────────────────────────────────── */
async function enterApp() {
  hideGate();
  quotaStatus = null;
  quotaFetchedAt = 0;
  quotaLoading = true;
  clearTimeout(quotaResetTimer);
  quotaResetTimer = null;
  syncQuotaControls();
  const proxied = api.mode === "proxy";
  // With a local backend the browser never holds the key, so there is
  // nothing to lock.
  $("lockButton").hidden = proxied;
  $("lockButton").dataset.tip = vault.mode() === "session" ? "清除 Key" : "锁定（下次需口令）";
  $("modeChip").textContent = proxied ? "本地代理" : "浏览器直连";
  $("modeChip").title = proxied
    ? "Key 由本地服务持有,浏览器不接触明文"
    : "浏览器直接携带 Key 请求上游";

  try {
    catalog = await fetchCatalog();
    if (!catalog.models.length) throw new Error("上游未返回可用的 NAI 模型");
  } catch (error) {
    toast(`模型列表加载失败：${error.message}`);
    catalog = {
      models: [{ id: DEFAULT_MODEL, name: "NAI Diffusion V5 Full", description: "", maxPixels: FALLBACK_MAX_PIXELS }],
      samplers: ["k_euler_ancestral", "k_euler", "k_dpmpp_2m", "k_dpmpp_sde", "ddim_v3"],
      defaults: {}
    };
  }
  renderCatalog();

  restore();
  syncRangeLabels();
  syncAdvBadge();
  syncGenerateLabel();
  syncPromptCount();
  validateSize();
  renderGallery();
  setState("empty");
  measureFit();
  $("prompt").focus();
  void refreshQuota({ force: true });
  applyPendingTags();
}

/* Tags queued from the dictionary tab. Appending is confirmed rather than
   automatic: the prompt box is where the user's own wording lives, and a
   silent rewrite on focus would feel like the page acting behind their back. */
function applyPendingTags() {
  const pending = takePendingTags();
  if (!pending) return;
  const field = $("prompt");
  const count = pending.split(",").filter((part) => part.trim()).length;
  if (!confirm(`Tag 词典有 ${count} 个 Tag 待插入，追加到描述末尾？`)) return;

  const current = field.value.trimEnd().replace(/,+$/, "");
  field.value = current ? `${current}, ${pending}` : pending;
  field.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    inputType: "insertText",
    data: pending
  }));
  field.focus();
  field.setSelectionRange(field.value.length, field.value.length);
  toast(`已插入 ${count} 个 Tag`, "ok");
}

async function boot() {
  // Older builds persisted images in IndexedDB; history is session-only now.
  history.purgeLegacy();

  renderRatios();
  restore();
  refreshPromptHL = attachHighlight($("prompt"));
  refreshNegativeHL = attachHighlight($("negative"));
  setTagAutocomplete(prefs.load().tagSuggest !== false);

  /* The prompt box fills the rail by default; dragging the handle pins it.
     Must run after attach(), which is what creates .hl-wrap. */
  {
    const hero = $("prompt").closest(".fld-hero");
    const wrap = hero.querySelector(".hl-wrap");
    const savedH = prefs.load().promptH;
    if (savedH) {
      wrap.style.height = `${savedH}px`;
      hero.dataset.resized = "1";
    }
    let seen = null;
    new ResizeObserver(() => {
      const h = Math.round(wrap.getBoundingClientRect().height);
      if (seen !== null && Math.abs(h - seen) > 1 && wrap.style.height) {
        hero.dataset.resized = "1";
        prefs.save({ promptH: h });
      }
      seen = h;
    }).observe(wrap);
  }
  const saved = prefs.load();
  if (saved.rail) document.documentElement.style.setProperty("--rail", `${saved.rail}px`);
  body.dataset.hist = saved.histOpen === false ? "off" : "on";
  $("histToggle").setAttribute("aria-pressed", String(saved.histOpen !== false));
  $("histToggle").dataset.tip = saved.histOpen === false ? "显示历史" : "隐藏历史";
  customMode = !RATIOS.some(
    (r) => !r.custom && r.w === Number($("width").value) && r.h === Number($("height").value)
  );
  syncRangeLabels();
  syncRatioSelection();
  measureFit();

  const status = await detectMode();

  if (status.mode === "proxy") {
    if (status.configured) { await enterApp(); return; }
    $("proxyNote").textContent = "后端尚未配置 Key：填写 config/api-key.txt 后重启服务。";
    $("proxyEnter").disabled = true;
    showGate("proxy");
    return;
  }

  if (await vault.tryResume()) { await enterApp(); return; }
  showGate(vault.mode() === "encrypted" ? "unlock" : "setup");
}

boot();
