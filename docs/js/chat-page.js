import { vault } from "./vault.js";
import { detectMode, state as transport } from "./transport.js";
import { fetchMediaCatalog, fetchMediaQuota, quotaForModel, estimateImage, runImage, quoteLabel } from "./media-api.js";
import { chatModels, normalizeOptions, resolveModel, buildChatPayload } from "./model-catalog.js";
import { newConversation, contextSnapshot, beginTurn, beginVersion, completeVersion, selectSource } from "./conversation-store.js";
import { AssetStore } from "./image-attachments.js";
import { withGenerationLock } from "./generation-lock.js";

const $ = id => document.getElementById(id);
const assets = new AssetStore();
const conversations = [];
let current, catalog, models = [], media = null, ready = false, busy = null, uploading = 0;
let quote = null, quoteSequence = 0, quoteTimer, quoteController, toastTimer;
const nodes = new Map();
function collectAssets() { if (!busy && !uploading) assets.collect(conversations); }
const labels = { quality: "质量", size: "画幅", aspect_ratio: "比例", image_size: "分辨率", output_format: "格式" };
const valueLabels = { auto: "自动", low: "草稿", medium: "标准", high: "高质量", xhigh: "超高", max: "最高",
  "1024x1024": "方形 · 1024²", "1536x1024": "横向 · 1536×1024", "1024x1536": "竖向 · 1024×1536" };
const savedSettings = () => { try { return JSON.parse(localStorage.getItem("scy.chat.settings.v1")) || {}; } catch { return {}; } };
const selectedModel = (c = current) => models.find(m => m.id === c.settings.model);
function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
}
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", ["parameters", "settings", "model", "frame", "points"].includes(name) ? "ico solid" : "ico"); svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(svg.namespaceURI, "use"); use.setAttribute("href", `./assets/icons.svg#i-${name}`);
  svg.append(use); return svg;
}
function action(label, glyph, handler) {
  const button = el("button", { type: "button", class: "ibtn", "aria-label": label, title: label });
  button.append(icon(glyph));
  if (handler) button.addEventListener("click", handler);
  return button;
}
function toast(text) {
  $("chatToast").textContent = text; $("chatToast").hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $("chatToast").hidden = true; }, 4500);
}
function persistSettings() {
  try { localStorage.setItem("scy.chat.settings.v1", JSON.stringify(current.settings)); } catch { /* Storage may be full. */ }
}
function nearBottom() { const s = $("chatScroll"); return s.scrollHeight - s.scrollTop - s.clientHeight < 100; }
function scrollLatest() { $("chatScroll").scrollTop = $("chatScroll").scrollHeight; $("latestButton").hidden = true; }
function showImage(assetId) { $("fullImage").src = assets.get(assetId).url; $("imageDialog").showModal(); }
function setSidebar(open) {
  document.body.dataset.sidebar = open ? "open" : "closed";
  $("sidebarBackdrop").hidden = !open;
  $("menuButton").setAttribute("aria-expanded", String(open));
  document.querySelector(".chat-workspace").inert = open;
  if (open) $("newConversation").focus(); else $("menuButton").focus();
}
function updateList() {
  $("conversationList").replaceChildren(...conversations.map(c => {
    const button = el("button", { type: "button", class: "conversation-item", "aria-current": String(c === current) }, c.title);
    button.addEventListener("click", () => switchConversation(c)); return button;
  }));
}
function switchConversation(c) {
  if (current) current.scrollTop = $("chatScroll").scrollTop;
  current = c;
  if (models.length && !selectedModel()) current.settings = { model: models[0].id, options: normalizeOptions(models[0]) };
  $("chatPrompt").value = c.prompt;
  updateList(); renderModel(); renderAttachments(); renderMessages(); resizePrompt(); scheduleQuote();
  $("chatScroll").scrollTop = c.scrollTop || 0;
  if (document.body.dataset.sidebar === "open") setSidebar(false);
}
function addConversation() {
  const c = newConversation(current?.settings || savedSettings());
  conversations.unshift(c); switchConversation(c); $("chatPrompt").focus();
}
function optionField(model, key, quick = false) {
  const label = el("label", { class: quick ? "quick-option" : "" });
  const name = el("span", quick ? { class: "sr-only" } : {}, labels[key] || key);
  const select = el("select", { "aria-label": labels[key] || key });
  for (const value of model.fields[key].options) select.append(el("option", { value }, valueLabels[value] || value.toUpperCase()));
  select.value = current.settings.options[key];
  select.addEventListener("change", () => {
    current.settings.options[key] = select.value;
    persistSettings(); renderOptions(); scheduleQuote();
    $("settingsFields").querySelector(`select[aria-label="${labels[key] || key}"]`)?.focus();
  });
  if (quick) label.append(icon(key === "quality" ? "parameters" : "frame"));
  label.append(name, select); return label;
}
function renderOptions() {
  const model = selectedModel(); if (!model) return;
  current.settings.options = normalizeOptions(model, current.settings.options);
  $("quickOptions").replaceChildren(...Object.keys(model.fields).filter(k => ["quality", "size", "aspect_ratio", "image_size"].includes(k)).slice(0, 2).map(k => optionField(model, k, true)));
  $("settingsFields").replaceChildren(...Object.keys(model.fields).map(k => optionField(model, k)));
  $("modelNote").textContent = model.id.includes("lite-image") ? "Lite 仅提供 1K 输出，最多带入 1 张参考图。"
    : `最多带入 ${model.maxImages} 张图片，包含主图。参数以本模型能力为准。`;
}
function renderModel() {
  if (!models.length) return;
  $("chatModel").replaceChildren(...models.map(m => el("option", { value: m.id }, m.name)));
  $("chatModel").value = current.settings.model;
  renderOptions(); renderQuota();
}
function imageIds(c = current) { return contextSnapshot(c).imageIds; }
function changedContext() {
  current.selectionRevision += 1;
  renderAttachments(); scheduleQuote();
  if ($("contextDialog").open) renderContext();
}
function imageRole(id) {
  return [current.mainId === id ? "主图" : "", current.pinnedIds.includes(id) ? "固定参考" : ""].filter(Boolean).join(" · ") || "本轮参考";
}
function removeReference(id) {
  if (current.mainId === id) current.mainId = null;
  current.pinnedIds = current.pinnedIds.filter(x => x !== id);
  current.attachments = current.attachments.filter(x => x !== id);
  changedContext(); collectAssets();
}
function renderAttachments() {
  const ids = imageIds();
  $("attachmentList").replaceChildren(...ids.map(id => {
    const asset = assets.get(id);
    const card = el("div", { class: "attachment" });
    const preview = el("button", { type: "button", class: "attachment-preview", title: `${imageRole(id)} · ${asset.name}`, "aria-label": `查看参考图片：${asset.name}` });
    preview.append(el("img", { src: asset.url, alt: "", width: 96, height: 96 }));
    preview.onclick = () => showImage(id);
    const remove = action("移除参考图片", "close", () => {
      const index = ids.indexOf(id);
      removeReference(id);
      const remaining = $("attachmentList").querySelectorAll(".attachment-remove");
      (remaining[Math.min(index, remaining.length - 1)] || $("uploadButton")).focus();
    });
    remove.classList.add("attachment-remove");
    card.append(preview, remove); return card;
  }));
  const snapshot = contextSnapshot(current);
  $("contextTurnCount").textContent = snapshot.turnIds.length;
  $("contextImageCount").textContent = ids.length;
  $("contextButton").setAttribute("aria-label", `查看上下文：${snapshot.turnIds.length} 轮文字、${ids.length} 张图片`);
  $("contextButton").title = `上下文：${snapshot.turnIds.length} 轮文字、${ids.length} 张图片`;
}
function renderContext() {
  $("contextTurns").value = current.contextTurns;
  const snapshot = contextSnapshot(current);
  const images = el("div", { class: "context-images" });
  images.append(...snapshot.imageIds.map(id => {
    const asset = assets.get(id);
    const row = el("div", { class: "context-image", "data-asset": id });
    const details = el("div", { class: "context-image-details" });
    details.append(el("span", {}, imageRole(id)), el("small", { title: asset.name }, asset.name));
    const controls = el("div", { class: "context-image-actions" });
    const restoreFocus = name => $("contextContent").querySelector(`[data-asset="${id}"] [aria-label="${name}"]`)?.focus();
    const main = action("设为主图", "image", () => {
      if (current.mainId && current.mainId !== id && !current.attachments.includes(current.mainId)) current.attachments.push(current.mainId);
      current.mainId = id; changedContext(); restoreFocus("设为主图");
    });
    main.setAttribute("aria-pressed", String(current.mainId === id));
    const pin = action("固定参考图", "pin", () => {
      if (current.pinnedIds.includes(id)) {
        current.pinnedIds = current.pinnedIds.filter(x => x !== id);
        if (current.mainId !== id && !current.attachments.includes(id)) current.attachments.push(id);
      } else current.pinnedIds.push(id);
      changedContext(); restoreFocus("固定参考图");
    });
    pin.setAttribute("aria-pressed", String(current.pinnedIds.includes(id)));
    controls.append(main, pin);
    row.append(el("img", { src: asset.url, alt: "", width: 44, height: 44 }), details, controls);
    return row;
  }));
  $("contextContent").replaceChildren(el("p", { class: "dialog-note" }, "历史文字＋选中主图＋参考图，直接用于绘图，不调用额外聊天模型。"),
    images, el("div", { class: "context-text" }, snapshot.text || "本轮尚未填写要求"));
}
function previewShape(turn) {
  const options = turn.settings.options;
  const ratioText = options.size?.includes("x") ? options.size.replace("x", ":") : options.aspect_ratio;
  const dims = ratioText?.split(":").map(Number);
  if (dims?.length === 2 && dims.every(n => n > 0)) return dims[0] / dims[1];
  const source = turn.snapshot.imageIds[0] && assets.get(turn.snapshot.imageIds[0]);
  return source ? source.width / source.height : 1;
}
function renderTurn(c, turn) {
  const version = turn.versions[turn.selectedVersion];
  const root = el("article", { class: "chat-turn", "data-turn": turn.id });
  const header = el("div", { class: "turn-header" });
  header.append(el("strong", {}, "你"));
  if (turn.parentId) header.append(el("span", {}, `基于第 ${c.turns.findIndex(t => t.id === turn.parentId) + 1} 轮`));
  if (turn.versions.length > 1) {
    const versions = el("select", { class: "version-select", "aria-label": "查看生成版本" });
    turn.versions.forEach((v, i) => versions.append(el("option", { value: i }, `版本 ${i + 1}${v.status === "pending" ? " · 生成中" : v.status !== "done" ? " · 未完成" : ""}`)));
    versions.value = turn.selectedVersion;
    versions.onchange = () => { turn.selectedVersion = Number(versions.value); c.selectionRevision += 1; renderMessages(); };
    header.append(versions);
  }
  root.append(header, el("div", { class: "turn-prompt" }, turn.prompt));
  if (turn.snapshot.imageIds.length) {
    const refs = el("div", { class: "turn-references" });
    for (const id of turn.snapshot.imageIds) {
      const a = assets.get(id), button = el("button", { type: "button", "aria-label": `查看参考图 ${a.name}` });
      button.append(el("img", { src: a.url, alt: a.name, width: 48, height: 48 }));
      button.onclick = () => showImage(id); refs.append(button);
    }
    root.append(refs);
  }
  const output = el("div", { class: "turn-output", "aria-busy": String(version.status === "pending") });
  if (version.status === "pending") {
    const frame = el("div", { class: "print skeleton chat-pending", "aria-hidden": "true" });
    frame.style.setProperty("--pending-ratio", previewShape(turn));
    frame.style.setProperty("--pending-width", `${560 * Math.min(previewShape(turn), 1)}px`);
    const bar = el("div", { class: "bar" }); bar.append(el("i"));
    frame.append(bar, el("div", { class: "sheen" }));
    output.append(frame, el("p", { class: "turn-phase", "data-phase": version.id }, busy?.phase || "生成中"));
  } else if (version.status !== "done") {
    const failure = el("div", { class: "turn-error" });
    failure.append(el("p", {}, version.error || "已取消；上游可能仍在处理，请勿立即重复提交。"));
    const retry = el("button", { type: "button", class: "btn btn-quiet" }, "重新生成");
    retry.onclick = () => execute(turn); failure.append(retry); output.append(failure);
  } else {
    for (const block of version.blocks) {
      if (block.type === "text") { output.append(el("p", { class: "turn-prompt" }, block.text)); continue; }
      const asset = assets.get(block.assetId);
      const frame = el("figure", { class: "print chat-print" });
      if (!version.painted) { frame.dataset.new = "true"; frame.addEventListener("animationend", () => delete frame.dataset.new, { once: true }); }
      const img = el("img", { src: asset.url, alt: turn.prompt.slice(0, 160), width: asset.width, height: asset.height, decoding: "async", tabindex: "0", role: "button", "aria-label": "查看完整图片" });
      img.onclick = () => showImage(asset.id); img.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); showImage(asset.id); } };
      frame.append(img);
      const resultName = `Scylla-${c.turns.indexOf(turn) + 1}-v${turn.versions.indexOf(version) + 1}`;
      const meta = el("footer", { class: "chat-meta" });
      meta.append(el("strong", { class: "result-name" }, resultName), el("span", { class: "result-model" }, models.find(m => m.id === turn.settings.model)?.name || turn.settings.model));
      const bottom = el("div", { class: "chat-meta-bottom" }), params = el("div", { class: "result-params mono" });
      params.append(el("span", { class: "result-param" }, `${asset.width}×${asset.height}`));
      if (turn.settings.options.quality) params.append(el("span", { class: "result-param" }, valueLabels[turn.settings.options.quality] || turn.settings.options.quality));
      params.append(el("span", { class: "result-param" }, quoteLabel(version.quote)));
      const actions = el("div", { class: "result-actions" });
      const download = el("a", { class: "ibtn", href: asset.url, download: `${resultName}.${asset.blob.type.split("/")[1]}`, "aria-label": "下载图片", title: "下载图片" }); download.append(icon("download"));
      actions.append(download, action("继续编辑这张图", "reuse", () => {
        selectSource(current, turn, asset.id); renderAttachments(); scheduleQuote(); $("chatPrompt").focus(); toast("已选为主图，接着输入修改要求");
      }), action("添加为参考图", "image", () => {
        if (!imageIds().includes(asset.id)) current.attachments.push(asset.id);
        changedContext();
      }), action("重新生成此版本", "retry", () => execute(turn)));
      bottom.append(params, actions); meta.append(bottom);
      const result = el("div", { class: "chat-result" });
      result.style.setProperty("--image-width", `${asset.width}px`);
      result.style.setProperty("--image-ratio", asset.width / asset.height);
      result.append(frame, meta); output.append(result);
    }
    version.painted = true;
  }
  root.append(output); return root;
}
function renderMessages({ follow = false } = {}) {
  const keepBottom = follow || nearBottom();
  const list = $("messageList");
  const wanted = current.turns.map(turn => {
    const v = turn.versions[turn.selectedVersion];
    const signature = `${v.id}:${v.status}:${turn.versions.length}`;
    let entry = nodes.get(turn.id);
    if (!entry || entry.signature !== signature) { entry = { signature, node: renderTurn(current, turn) }; nodes.set(turn.id, entry); }
    return entry.node;
  });
  for (const node of [...list.children]) if (!wanted.includes(node)) node.remove();
  wanted.forEach((node, i) => { if (list.children[i] !== node) list.insertBefore(node, list.children[i] || null); });
  $("chatEmpty").hidden = !!current.turns.length;
  if (keepBottom && current.turns.length) requestAnimationFrame(scrollLatest);
  else if (current.turns.length) $("latestButton").hidden = false;
}
function syncAction() {
  $("chatForm").setAttribute("aria-busy", String(!!busy));
  $("sendButton").disabled = !ready || !!busy || uploading > 0 || !quote;
  $("sendButton").hidden = !!busy;
  $("stopButton").hidden = !busy;
  $("quoteText").textContent = quote ? quoteLabel(quote) : "";
  $("phaseText").textContent = busy ? busy.phase : uploading ? "读取图片中" : quote ? quoteLabel(quote) : "";
}
async function prepare(c, turn) {
  const settings = structuredClone(turn ? turn.settings : c.settings);
  const model = models.find(m => m.id === settings.model);
  if (!model) throw new Error("请选择可用模型");
  const snapshot = turn ? structuredClone(turn.snapshot) : contextSnapshot(c);
  const prompt = turn ? turn.prompt : c.prompt.trim();
  if (!prompt) throw new Error("请填写描述或修改要求");
  if (snapshot.imageIds.length > model.maxImages) throw new Error(`本模型最多带入 ${model.maxImages} 张图片（包含主图）`);
  const images = await assets.encode(snapshot.imageIds);
  const payload = buildChatPayload(model, snapshot.text, settings.options, images);
  return { payload, snapshot, prompt, settings };
}
function scheduleQuote() {
  clearTimeout(quoteTimer); quoteController?.abort();
  const sequence = ++quoteSequence, c = current;
  quote = null; $("composerError").textContent = ""; syncAction(); renderQuota();
  if (!ready || !c.prompt.trim() || uploading || busy) return;
  quoteTimer = setTimeout(async () => {
    quoteController = new AbortController();
    const controller = quoteController;
    try {
      const prepared = await prepare(c);
      controller.signal.throwIfAborted();
      const result = await estimateImage(prepared.payload, { signal: controller.signal });
      if (sequence !== quoteSequence || current !== c) return;
      quote = result;
      if (result.quota) media = result.quota;
      renderQuota(); syncAction();
    } catch (e) {
      if (sequence === quoteSequence && e.name !== "AbortError") { $("composerError").textContent = e.message; syncAction(); }
    }
  }, 650);
}
async function execute(existingTurn) {
  if (!ready || busy || uploading) return;
  const c = current, previewCost = existingTurn ? null : quote?.cost;
  if (!existingTurn && !quote) return;
  const controller = new AbortController();
  busy = { cId: c.id, controller, phase: "校验报价" }; syncAction();
  quoteController?.abort(); clearTimeout(quoteTimer); ++quoteSequence;
  let turn, version;
  const timer = setTimeout(() => controller.abort(new DOMException("请求超时", "TimeoutError")), 240_000);
  try {
    const prepared = await prepare(c, existingTurn);
    controller.signal.throwIfAborted();
    const acquired = await withGenerationLock(async () => {
      if (existingTurn) { turn = existingTurn; version = beginVersion(turn); }
      else {
        ({ turn, version } = beginTurn(c, prepared.snapshot, prepared.prompt, prepared.settings));
        c.prompt = ""; c.attachments = [];
        if (current === c) { $("chatPrompt").value = ""; resizePrompt(); }
      }
      const revision = c.selectionRevision;
      Object.assign(busy, { turnId: turn.id, version, phase: "生成中" });
      if (current === c) { updateList(); renderAttachments(); renderMessages({ follow: !existingTurn }); }
      syncAction();
      const result = await runImage(prepared.payload, { signal: controller.signal,
        beforeSend: latest => {
          if (previewCost !== null && latest.cost > previewCost) throw new Error("报价已上涨，未提交生成；请重新确认本轮费用");
          if (latest.cost > 0 && !confirm(`本轮需要 ${latest.cost} 媒体积分，继续生成？`)) throw new DOMException("已取消", "AbortError");
        }, onLoading: () => {
          if (!busy) return;
          busy.phase = "图片加载中"; syncAction();
          const phase = document.querySelector(`[data-phase="${version.id}"]`); if (phase) phase.textContent = busy.phase;
        }
      });
      const blocks = [];
      for (const block of result.blocks) {
        if (block.type === "text") { blocks.push(block); continue; }
        const asset = await assets.add(block.blob, `Scylla-${c.turns.indexOf(turn) + 1}-v${turn.versions.indexOf(version) + 1}`, block.size);
        blocks.push({ type: "image", assetId: asset.id });
      }
      controller.signal.throwIfAborted();
      completeVersion(c, turn, version, blocks, result.quote, revision);
    });
    if (!acquired) throw new Error("另一个页面正在生成，请等待完成");
  } catch (e) {
    if (version) {
      version.status = e.name === "AbortError" ? "cancelled" : "error";
      version.error = e.name === "AbortError" ? "已取消；上游可能仍在处理或计费。" : e.message;
    } else toast(e.message);
  } finally {
    clearTimeout(timer); busy = null;
    if (current === c) { renderAttachments(); renderMessages(); }
    collectAssets(); syncAction(); scheduleQuote();
    void refreshQuota();
  }
}
async function upload(files) {
  const c = current;
  uploading += 1; syncAction();
  try {
    const model = selectedModel(c); if (!model) throw new Error("请先连接并选择模型");
    if (imageIds(c).length + files.length > model.maxImages) throw new Error(`本模型最多带入 ${model.maxImages} 张图片（包含主图）`);
    const added = [];
    for (const file of files) added.push(await assets.add(file, file.name || "粘贴图片"));
    if (!conversations.includes(c)) return;
    for (const a of added) if (!imageIds(c).includes(a.id)) c.attachments.push(a.id);
    c.selectionRevision += 1;
  } catch (e) { toast(e.message); }
  finally { uploading -= 1; collectAssets(); renderAttachments(); scheduleQuote(); }
}
function renderQuota() {
  const model = selectedModel(), group = quotaForModel(media, model), paid = quote?.cost > 0;
  const remaining = paid ? media?.credits?.remaining : group?.remaining;
  const limit = paid ? null : group?.limit;
  $("quotaKind").textContent = paid ? "CREDITS" : "FREE";
  $("quotaLeft").textContent = Number.isFinite(remaining) ? remaining.toLocaleString("zh-CN", { maximumFractionDigits: 1 }) : "—";
  $("quotaTotal").textContent = Number.isFinite(limit) ? `/${limit}` : "";
  $("quotaFill").style.width = Number.isFinite(remaining) && limit > 0 ? `${Math.min(100, Math.max(0, remaining / limit * 100))}%` : "0%";
  $("quotaButton").setAttribute("aria-label", `${model?.name || "当前模型"}，${paid ? "媒体积分" : "本周免费图片"}剩余 ${remaining ?? "未知"}，查看额度详情`);
  const rows = [["当前模型", model?.name || "—"], ["本周免费图片", `${group?.remaining ?? "—"} / ${group?.limit ?? "—"}`],
    ["媒体积分", media?.credits?.remaining ?? "—"], ["重置时间", media?.resets_at ? new Date(media.resets_at).toLocaleString() : "—"]];
  $("quotaDetails").replaceChildren(...rows.map(([key, value]) => {
    const row = el("div", { class: "quota-row" }); row.append(el("span", {}, key), el("span", {}, value)); return row;
  }), el("p", { class: "dialog-note" }, "媒体额度与临时 Key 日请求额度分开计算，以服务器实际计费为准。"));
}
async function refreshQuota() {
  if (!ready) return;
  $("chatMeters").dataset.loading = "1";
  try { media = await fetchMediaQuota(); } catch { media = null; }
  finally { delete $("chatMeters").dataset.loading; renderQuota(); }
}
function resizePrompt() {
  $("chatPrompt").style.height = "auto";
  $("chatPrompt").style.height = `${$("chatPrompt").scrollHeight}px`;
}
function openKey() {
  const proxy = transport.mode === "proxy", encrypted = vault.mode() === "encrypted";
  $("keyTitle").textContent = proxy ? "本地代理" : encrypted ? "解锁 API Key" : "连接 Scylla";
  $("keyInputField").hidden = proxy || encrypted;
  $("keyModeField").hidden = proxy || encrypted;
  $("keyPassField").hidden = proxy || (!encrypted && $("keyMode").value === "session");
  $("rememberField").hidden = $("keyPassField").hidden;
  $("keyError").textContent = proxy ? "请在 config/api-key.txt 配置 Key 后连接。" : "";
  $("forgetKey").hidden = proxy || !encrypted;
  if (!$("keyDialog").open) $("keyDialog").showModal();
}
async function connect() {
  ready = false; syncAction();
  catalog = await fetchMediaCatalog({ force: true }); models = chatModels(catalog);
  if (!models.length) throw new Error("上游未提供已适配的对话绘图模型");
  const model = resolveModel(models, current.settings.model) || models[0];
  current.settings = { model: model.id, options: normalizeOptions(model, current.settings.options) };
  ready = true; $("keyDialog").close(); renderModel(); renderAttachments(); scheduleQuote(); void refreshQuota();
}
$("chatPrompt").addEventListener("input", () => { current.prompt = $("chatPrompt").value; resizePrompt(); scheduleQuote(); });
$("chatPrompt").addEventListener("keydown", e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.isComposing) { e.preventDefault(); void execute(); } });
$("chatForm").addEventListener("submit", e => { e.preventDefault(); void execute(); });
$("stopButton").onclick = () => busy?.controller.abort();
$("chatModel").onchange = () => {
  const model = models.find(m => m.id === $("chatModel").value);
  const before = current.settings.options;
  current.settings = { model: model.id, options: normalizeOptions(model, before) };
  if (Object.keys(before).some(k => current.settings.options[k] !== before[k])) toast("已按新模型调整可用参数");
  persistSettings(); renderOptions(); scheduleQuote();
};
$("newConversation").onclick = addConversation;
$("deleteConversation").onclick = () => {
  if (busy?.cId === current.id) return toast("请先取消生成再删除对话");
  if (!confirm("删除当前对话及图片？此操作无法撤销。")) return;
  for (const turn of current.turns) nodes.delete(turn.id);
  conversations.splice(conversations.indexOf(current), 1); collectAssets();
  if (conversations.length) switchConversation(conversations[0]); else addConversation();
};
$("uploadButton").onclick = () => $("imageUpload").click();
$("imageUpload").onchange = () => { void upload([...$("imageUpload").files]); $("imageUpload").value = ""; };
document.addEventListener("paste", e => {
  if (document.querySelector("dialog[open]")) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); void upload(files); }
});
document.addEventListener("dragover", e => { if (e.dataTransfer?.types.includes("Files")) e.preventDefault(); });
document.addEventListener("drop", e => {
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault(); if (!document.querySelector("dialog[open]")) void upload([...e.dataTransfer.files]);
});
$("settingsButton").onclick = () => { if (ready) $("settingsDialog").showModal(); else openKey(); };
$("contextButton").onclick = () => { renderContext(); $("contextDialog").showModal(); };
$("contextTurns").onchange = () => {
  const value = Number($("contextTurns").value);
  current.contextTurns = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  changedContext();
};
$("resetContext").onclick = () => {
  current.headId = null; current.mainId = null; current.pinnedIds = []; current.attachments = [];
  changedContext(); collectAssets(); $("contextDialog").close();
};
$("quotaButton").onclick = () => { renderQuota(); $("quotaDialog").showModal(); void refreshQuota(); };
$("menuButton").onclick = () => setSidebar(document.body.dataset.sidebar !== "open");
$("closeSidebar").onclick = $("sidebarBackdrop").onclick = () => setSidebar(false);
$("latestButton").onclick = scrollLatest;
$("chatScroll").onscroll = () => { if (nearBottom()) $("latestButton").hidden = true; };
$("closeImage").onclick = () => $("imageDialog").close();
$("imageDialog").addEventListener("close", () => $("fullImage").removeAttribute("src"));
$("keyButton").onclick = () => {
  if (busy) return toast("请先结束生成");
  if (transport.mode === "direct" && vault.isUnlocked()) {
    if (!confirm("锁定当前 Key？会话图片仍保留。")) return;
    vault.lock(); ready = false; scheduleQuote();
  }
  openKey();
};
$("closeKey").onclick = () => $("keyDialog").close();
$("keyMode").onchange = openKey;
$("forgetKey").onclick = () => {
  if (!confirm("移除此浏览器保存的 Key 并重新填写？")) return;
  vault.forget(); ready = false; $("keyPass").value = ""; openKey();
};
$("keyForm").onsubmit = async e => {
  e.preventDefault(); $("connectButton").disabled = true;
  try {
    if (transport.mode === "direct") {
      if (vault.mode() === "encrypted") await vault.unlock($("keyPass").value, { remember: $("rememberKey").checked });
      else if ($("keyMode").value === "session") vault.saveSession($("keyInput").value);
      else await vault.saveEncrypted($("keyInput").value, $("keyPass").value, { remember: $("rememberKey").checked });
    }
    $("keyInput").value = ""; $("keyPass").value = "";
    await connect();
  } catch (e) { $("keyError").textContent = e.message; }
  finally { $("connectButton").disabled = false; }
};
document.addEventListener("keydown", e => {
  if (document.body.dataset.sidebar !== "open") return;
  if (e.key === "Escape") { e.preventDefault(); setSidebar(false); }
  if (e.key === "Tab") {
    const focusable = [...$("chatSidebar").querySelectorAll("button,a")].filter(n => n.offsetParent);
    const first = focusable[0], last = focusable.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});
matchMedia("(max-width: 860px)").addEventListener("change", e => { if (!e.matches && document.body.dataset.sidebar === "open") setSidebar(false); });
function viewport() {
  const visual = window.visualViewport;
  document.documentElement.style.setProperty("--visible-height", `${visual?.height || innerHeight}px`);
  document.documentElement.style.setProperty("--visible-top", `${visual?.offsetTop || 0}px`);
  resizePrompt();
}
window.visualViewport?.addEventListener("resize", viewport);
window.visualViewport?.addEventListener("scroll", viewport);
window.addEventListener("resize", viewport);
new ResizeObserver(() => document.documentElement.style.setProperty("--composer-height", `${$("chatForm").getBoundingClientRect().height}px`)).observe($("chatForm"));
addEventListener("beforeunload", e => {
  if (busy || conversations.some(c => c.turns.length || c.prompt || c.attachments.length)) { e.preventDefault(); e.returnValue = ""; }
});
addConversation(); viewport();
try {
  await vault.tryResume();
  const mode = await detectMode();
  if (mode.configured) await connect(); else openKey();
} catch (e) { openKey(); $("keyError").textContent = e.message; }
