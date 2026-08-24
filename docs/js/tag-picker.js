/**
 * In-page tag picker.
 *
 * The dictionary used to live only on its own tab, so using it meant leaving
 * the composer, collecting tags, coming back, and confirming an insert. This
 * panel removes the trip: a click writes straight into the prompt, and clicking
 * a chosen tag again takes it back out.
 *
 * The full page at tags.html stays for browsing and for weight tuning; this is
 * the fast path for "I need one more word right now".
 */

import { CATEGORIES, formatCount, hasHan, promptTag, loadCategoryFilter, searchTags } from "./tag-api.js";
import { toast } from "./toast.js";

const DEBOUNCE = 280;

/**
 * @param {object} options
 * @param {() => HTMLTextAreaElement} options.target  field receiving the tags
 * @param {() => void} options.onChange   called after the field is written to
 */
export function createTagPicker({ target, onChange }) {
  const root = document.getElementById("pickerSheet");
  const field = document.getElementById("pickerSearch");
  const list = document.getElementById("pickerResults");
  const status = document.getElementById("pickerStatus");
  const chosen = document.getElementById("pickerChosen");
  const chosenWrap = document.getElementById("pickerChosenWrap");
  const openers = document.querySelectorAll("[data-open-picker]");

  let timer = null;
  let request = null;
  let token = 0;
  let composing = false;
  let items = [];
  let active = -1;
  let lastFocus = null;

  /* Which tags this session added, so a second click can remove them and the
     result rows can show their state. Tags already typed by hand are not
     listed: removing text the picker never wrote would be overreach. */
  const added = new Map();

  const isOpen = () => document.body.dataset.picker === "open";

  /* Compare on the prompt form so "blue_hair" and "blue hair" are one tag. */
  const key = (name) => promptTag(name).toLocaleLowerCase();

  /* Segments with their exact source offsets. Splitting into strings and
     rejoining with ", " looked simpler but rewrote the whole field: it
     collapsed the author's newlines into commas and dropped empty runs. Edits
     here are splices, so untouched text stays byte-for-byte. */
  function segments(text) {
    const out = [];
    let at = 0;
    for (const chunk of text.split(",")) {
      const lead = chunk.length - chunk.trimStart().length;
      const body = chunk.trim();
      if (body) out.push({ body, start: at + lead, end: at + lead + body.length });
      at += chunk.length + 1;
    }
    return out;
  }

  function insert(name) {
    const el = target();
    const tag = promptTag(name);
    const text = el.value;
    const trimmedEnd = text.replace(/[\s,]+$/, "");
    el.value = trimmedEnd ? `${trimmedEnd}, ${tag}` : tag;
    added.set(key(name), tag);
    commit(el, tag);
  }

  function remove(name) {
    const el = target();
    const want = key(name);
    const text = el.value;
    const hit = segments(text).find((seg) => key(seg.body) === want);
    if (!hit) { added.delete(want); commit(el, ""); return; }

    /* Take one adjacent separator with it, preferring the one before, so the
       remaining text does not end up with ", ," or a leading comma. */
    let from = hit.start;
    let to = hit.end;
    const before = text.slice(0, from);
    const sepBefore = before.match(/,[ \t]*$/);
    if (sepBefore) from -= sepBefore[0].length;
    else {
      const sepAfter = text.slice(to).match(/^[ \t]*,[ \t]*/);
      if (sepAfter) to += sepAfter[0].length;
    }
    el.value = text.slice(0, from) + text.slice(to);
    added.delete(want);
    commit(el, "");
  }

  /* Dispatching input drives the highlight mirror, the counter and persistence,
     and the listener installed below repaints the rows — so no explicit
     renderChosen/syncRows call is needed here. */
  function commit(el, data) {
    el.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: data ? "insertText" : "deleteContentBackward",
      data: data || null
    }));
    onChange?.();
  }

  /* A tag counts as present if it is in the field at all, however it got
     there — otherwise typing a word by hand then clicking it would duplicate. */
  function inField(name) {
    const want = key(name);
    return segments(target().value).some((seg) => key(seg.body) === want);
  }

  function toggle(name) {
    if (inField(name)) {
      remove(name);
      toast(`已移除：${promptTag(name)}`, "ok");
    } else {
      insert(name);
      toast(`已插入：${promptTag(name)}`, "ok");
    }
  }

  function renderChosen() {
    chosen.replaceChildren();
    const live = [...added.entries()].filter(([, tag]) => inField(tag));
    for (const [, tag] of live) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "picker-chip";
      chip.dataset.tip = "移除";
      chip.setAttribute("aria-label", `移除 ${tag}`);
      chip.append(document.createTextNode(tag));
      const x = document.createElement("i");
      x.setAttribute("aria-hidden", "true");
      chip.append(x);
      chip.addEventListener("click", () => toggle(tag));
      chosen.append(chip);
    }
    chosenWrap.hidden = live.length === 0;
  }

  function syncRows() {
    for (const row of list.querySelectorAll(".picker-row")) {
      row.setAttribute("aria-pressed", String(inField(row.dataset.tag)));
    }
  }

  function say(message, kind = "") {
    status.className = `picker-status ${kind}`.trim();
    status.textContent = message;
    status.hidden = !message;
  }

  function renderResults(found) {
    items = found;
    active = found.length ? 0 : -1;
    list.replaceChildren();
    if (!found.length) { say("没有匹配的 Tag"); return; }
    say("");

    found.forEach((item, index) => {
      const category = CATEGORIES[item.category] || CATEGORIES[0];
      const row = document.createElement("button");
      row.type = "button";
      row.className = "picker-row";
      row.dataset.tag = item.name;
      row.setAttribute("aria-pressed", String(inField(item.name)));

      const names = document.createElement("span");
      names.className = "picker-names";
      const en = document.createElement("strong");
      en.textContent = promptTag(item.name);
      const cn = document.createElement("span");
      cn.textContent = item.cnName || "";
      names.append(en, cn);

      const meta = document.createElement("span");
      meta.className = "picker-meta";
      const dot = document.createElement("i");
      dot.className = `tag-category-dot ${category.className}`;
      const text = document.createElement("span");
      text.textContent = `${category.label} · ${formatCount(item.count)}`;
      meta.append(dot, text);

      row.append(names, meta);
      row.addEventListener("click", () => { active = index; syncActive(); toggle(item.name); });
      list.append(row);
    });
    syncActive();
  }

  function syncActive() {
    const rows = [...list.querySelectorAll(".picker-row")];
    rows.forEach((row, index) => {
      row.classList.toggle("on", index === active);
      if (index === active) row.scrollIntoView({ block: "nearest" });
    });
  }

  async function search() {
    const query = field.value.trim();
    const minimum = hasHan(query) ? 1 : 2;
    if (query.length < minimum) {
      list.replaceChildren();
      items = [];
      say(query ? "再多输入一个字" : "输入中文或英文开始搜索");
      return;
    }
    request?.abort();
    request = new AbortController();
    const mine = ++token;
    say("正在查词典…", "load");
    try {
      const found = await searchTags(query, {
        limit: 30, broad: true, signal: request.signal, categories: loadCategoryFilter()
      });
      if (mine !== token) return;
      renderResults(found);
    } catch (error) {
      if (error.name === "AbortError") return;
      say(error.message || "查询失败", "err");
    }
  }

  function schedule() {
    clearTimeout(timer);
    if (composing) return;
    timer = setTimeout(search, DEBOUNCE);
  }

  function open() {
    lastFocus = document.activeElement;
    root.hidden = false;
    requestAnimationFrame(() => { document.body.dataset.picker = "open"; });
    renderChosen();
    if (!items.length) say("输入中文或英文开始搜索");
    setTimeout(() => field.focus(), 300);
  }

  function close() {
    clearTimeout(timer);
    request?.abort();
    document.body.dataset.picker = "closed";
    setTimeout(() => { root.hidden = true; }, 320);
    lastFocus?.focus?.();
    lastFocus = null;
  }

  field.addEventListener("input", schedule);
  field.addEventListener("compositionstart", () => { composing = true; });
  field.addEventListener("compositionend", () => { composing = false; schedule(); });
  field.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      active = Math.min(items.length - 1, active + 1);
      syncActive();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      active = Math.max(0, active - 1);
      syncActive();
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (items[active]) toggle(items[active].name);
    }
  });

  document.getElementById("pickerClose").addEventListener("click", close);
  root.addEventListener("click", (event) => { if (event.target === root) close(); });
  for (const opener of openers) opener.addEventListener("click", open);

  /* The prompt can also change from outside the picker — typing, 清洗格式,
     参数导入, 复用参数. Without this the rows keep showing a stale state and a
     click takes the wrong branch. */
  target().addEventListener("input", () => {
    if (!isOpen()) return;
    renderChosen();
    syncRows();
  });

  return { open, close, isOpen };
}
