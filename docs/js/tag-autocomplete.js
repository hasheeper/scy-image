import { CATEGORIES, formatCount, hasHan, promptTag, searchTags } from "./tag-api.js";

let sequence = 0;

function fragmentAtCaret(textarea) {
  const caret = textarea.selectionStart ?? textarea.value.length;
  const before = textarea.value.slice(0, caret);
  const separator = Math.max(before.lastIndexOf(","), before.lastIndexOf("\n"));
  const segmentStart = separator + 1;
  const segment = before.slice(segmentStart);
  const leading = segment.match(/^\s*(?:(?:-?\d*\.?\d+)\s*::)?[\[{]*\s*/)?.[0] || "";
  const afterLeading = segment.slice(leading.length);
  const leftTrim = afterLeading.length - afterLeading.trimStart().length;
  const query = afterLeading.trim();
  const start = segmentStart + leading.length + leftTrim;

  let end = Math.max(caret, textarea.selectionEnd ?? caret);
  while (end < textarea.value.length && !/[,\n}\]]/.test(textarea.value[end])) end += 1;
  return { query, start, end };
}

export function insertPromptTag(textarea, name) {
  const { start, end } = fragmentAtCaret(textarea);
  const tag = promptTag(name);
  const suffix = textarea.value.slice(end);
  const next = suffix.trimStart()[0] || "";
  const delimiter = next === "," || next === "\n" || next === "}" || next === "]" ? "" : ", ";
  textarea.setRangeText(`${tag}${delimiter}`, start, end, "end");
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: tag }));
  textarea.focus();
}

export function attachTagAutocomplete(textarea, { maxResults = 10 } = {}) {
  if (!textarea || textarea.dataset.tagAutocomplete === "on") return () => {};
  textarea.dataset.tagAutocomplete = "on";
  const id = `tag-suggest-${++sequence}`;
  const popover = document.createElement("div");
  popover.id = id;
  popover.className = "tag-suggest";
  popover.setAttribute("role", "listbox");
  popover.hidden = true;
  document.body.append(popover);
  textarea.setAttribute("aria-autocomplete", "list");
  textarea.setAttribute("aria-controls", id);
  textarea.setAttribute("aria-expanded", "false");

  let timer = null;
  let request = null;
  let results = [];
  let active = -1;
  let composing = false;

  const setOpen = (open) => {
    popover.hidden = !open;
    textarea.setAttribute("aria-expanded", String(open));
    if (!open) textarea.removeAttribute("aria-activedescendant");
  };

  const position = () => {
    if (popover.hidden) return;
    const anchor = textarea.closest(".hl-wrap") || textarea;
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(rect.width, window.innerWidth - 20);
    const left = Math.min(window.innerWidth - width - 10, Math.max(10, rect.left));
    const roomBelow = window.innerHeight - rect.bottom - 10;
    const estimated = Math.min(330, 54 * Math.max(1, results.length) + 34);
    const top = roomBelow >= Math.min(180, estimated)
      ? rect.bottom + 6
      : Math.max(10, rect.top - estimated - 6);
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
    popover.style.width = `${Math.round(width)}px`;
  };

  const choose = (index) => {
    const item = results[index];
    if (!item) return;
    insertPromptTag(textarea, item.name);
    setOpen(false);
  };

  const syncActive = () => {
    const options = popover.querySelectorAll(".tag-suggest-option");
    options.forEach((option, index) => {
      const on = index === active;
      option.setAttribute("aria-selected", String(on));
      if (on) {
        textarea.setAttribute("aria-activedescendant", option.id);
        option.scrollIntoView({ block: "nearest" });
      }
    });
  };

  const renderMessage = (message, kind = "") => {
    results = [];
    active = -1;
    popover.replaceChildren();
    const note = document.createElement("p");
    note.className = `tag-suggest-note ${kind}`.trim();
    note.textContent = message;
    popover.append(note);
    setOpen(true);
    position();
  };

  const render = (items) => {
    results = items;
    active = items.length ? 0 : -1;
    popover.replaceChildren();
    if (!items.length) {
      renderMessage("没有匹配的 Danbooru Tag");
      return;
    }

    const list = document.createElement("div");
    list.className = "tag-suggest-list";
    items.forEach((item, index) => {
      const category = CATEGORIES[item.category] || CATEGORIES[0];
      const option = document.createElement("button");
      option.type = "button";
      option.id = `${id}-option-${index}`;
      option.className = "tag-suggest-option";
      option.dataset.category = String(item.category);
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(index === active));

      const names = document.createElement("span");
      names.className = "tag-suggest-names";
      const english = document.createElement("strong");
      english.textContent = item.name;
      const chinese = document.createElement("span");
      chinese.textContent = item.cnName || promptTag(item.name);
      names.append(english, chinese);

      const meta = document.createElement("span");
      meta.className = "tag-suggest-meta";
      const dot = document.createElement("i");
      dot.className = `tag-category-dot ${category.className}`;
      const label = document.createElement("span");
      label.textContent = `${category.label} · ${formatCount(item.count)}`;
      meta.append(dot, label);
      option.append(names, meta);
      option.addEventListener("pointerdown", (event) => event.preventDefault());
      option.addEventListener("click", () => choose(index));
      option.addEventListener("mouseenter", () => { active = index; syncActive(); });
      list.append(option);
    });
    popover.append(list);
    setOpen(true);
    syncActive();
    position();
  };

  const search = async () => {
    const { query } = fragmentAtCaret(textarea);
    const minimum = hasHan(query) ? 1 : 2;
    if (query.length < minimum) { setOpen(false); return; }
    request?.abort();
    request = new AbortController();
    try {
      const items = await searchTags(query, { limit: maxResults, signal: request.signal });
      if (fragmentAtCaret(textarea).query !== query) return;
      render(items);
    } catch (error) {
      if (error.name !== "AbortError") renderMessage(error.message || "Tag 搜索失败", "err");
    }
  };

  const schedule = () => {
    clearTimeout(timer);
    if (composing) return;
    const { query } = fragmentAtCaret(textarea);
    const minimum = hasHan(query) ? 1 : 2;
    if (query.length < minimum) { request?.abort(); setOpen(false); return; }
    timer = setTimeout(search, 280);
  };

  textarea.addEventListener("input", schedule);
  textarea.addEventListener("click", schedule);
  textarea.addEventListener("compositionstart", () => { composing = true; setOpen(false); });
  textarea.addEventListener("compositionend", () => { composing = false; schedule(); });
  textarea.addEventListener("keydown", (event) => {
    if (popover.hidden) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      active = Math.min(results.length - 1, active + 1);
      syncActive();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      active = Math.max(0, active - 1);
      syncActive();
    } else if ((event.key === "Enter" || event.key === "Tab") && active >= 0) {
      event.preventDefault();
      choose(active);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    }
  });

  document.addEventListener("pointerdown", (event) => {
    if (event.target !== textarea && !popover.contains(event.target)) setOpen(false);
  });
  window.addEventListener("resize", position);
  document.addEventListener("scroll", position, true);

  return () => {
    clearTimeout(timer);
    request?.abort();
    popover.remove();
  };
}
