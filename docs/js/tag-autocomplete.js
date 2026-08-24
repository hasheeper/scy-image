import { CATEGORIES, formatCount, hasHan, promptTag, searchTags } from "./tag-api.js";

let sequence = 0;

const CARET_STYLE_PROPERTIES = [
  "boxSizing", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "fontFamily", "fontSize",
  "fontWeight", "fontStyle", "fontVariant", "lineHeight", "letterSpacing", "wordSpacing",
  "textIndent", "textTransform", "tabSize", "whiteSpace", "overflowWrap", "wordBreak"
];

function caretRect(textarea) {
  const rect = textarea.getBoundingClientRect();
  const style = getComputedStyle(textarea);
  const mirror = document.createElement("div");
  mirror.setAttribute("aria-hidden", "true");
  Object.assign(mirror.style, {
    position: "fixed",
    visibility: "hidden",
    pointerEvents: "none",
    overflow: "hidden",
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: "auto",
    minHeight: "0"
  });
  CARET_STYLE_PROPERTIES.forEach((property) => { mirror.style[property] = style[property]; });
  mirror.textContent = textarea.value.slice(0, textarea.selectionStart ?? textarea.value.length);
  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  mirror.append(marker);
  document.body.append(mirror);
  const markerRect = marker.getBoundingClientRect();
  mirror.remove();
  return markerRect;
}

function visibleViewport() {
  const viewport = window.visualViewport;
  return {
    left: viewport?.offsetLeft || 0,
    top: viewport?.offsetTop || 0,
    width: viewport?.width || window.innerWidth,
    height: viewport?.height || window.innerHeight
  };
}

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

export function attachTagAutocomplete(textarea, { maxResults = 20 } = {}) {
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
  textarea.setAttribute("aria-haspopup", "listbox");

  let timer = null;
  let request = null;
  let results = [];
  let active = -1;
  let composing = false;
  let searchToken = 0;

  const setOpen = (open) => {
    popover.hidden = !open;
    textarea.setAttribute("aria-expanded", String(open));
    if (!open) textarea.removeAttribute("aria-activedescendant");
  };

  const position = () => {
    if (popover.hidden) return;
    const anchor = textarea.closest(".hl-wrap") || textarea;
    const anchorRect = anchor.getBoundingClientRect();
    const caret = caretRect(textarea);
    const viewport = visibleViewport();
    const viewRight = viewport.left + viewport.width;
    const viewBottom = viewport.top + viewport.height;
    const margin = viewport.width <= 680 ? 8 : 10;
    const gap = 6;
    const width = Math.min(420, Math.max(340, anchorRect.width), viewport.width - margin * 2);
    const caretX = Math.min(anchorRect.right - 8, Math.max(anchorRect.left + 8, caret.left));
    const left = Math.min(viewRight - width - margin, Math.max(viewport.left + margin, caretX - 18));
    const caretTop = Math.min(anchorRect.bottom, Math.max(anchorRect.top, caret.top));
    const caretBottom = Math.min(anchorRect.bottom, Math.max(anchorRect.top, caret.bottom));
    const roomBelow = Math.max(0, viewBottom - margin - caretBottom - gap);
    const roomAbove = Math.max(0, caretTop - viewport.top - margin - gap);

    popover.style.width = `${Math.round(width)}px`;
    popover.style.maxHeight = `${Math.floor(Math.max(108, Math.min(360, Math.max(roomBelow, roomAbove))))}px`;
    const desired = Math.min(360, popover.scrollHeight);
    const below = roomBelow >= Math.min(desired, 150) || roomBelow >= roomAbove;
    const available = below ? roomBelow : roomAbove;
    popover.style.maxHeight = `${Math.floor(Math.max(108, Math.min(360, available)))}px`;
    const height = Math.min(popover.scrollHeight, Math.max(108, Math.min(360, available)));
    const top = below
      ? Math.min(viewBottom - margin - height, caretBottom + gap)
      : Math.max(viewport.top + margin, caretTop - gap - height);
    popover.dataset.placement = below ? "bottom" : "top";
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
  };

  const dismiss = () => {
    clearTimeout(timer);
    request?.abort();
    request = null;
    searchToken += 1;
    setOpen(false);
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
    note.setAttribute("role", "status");
    note.append(document.createTextNode(message));
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
    const token = ++searchToken;
    /* Announce the request instead of leaving a blank gap. Results already on
       screen stay put — swapping them for a spinner on every keystroke reads
       as flicker — so only the first lookup shows the pending row. */
    popover.setAttribute("aria-busy", "true");
    if (popover.hidden) renderMessage("正在查词典…", "load");
    try {
      const items = await searchTags(query, { limit: maxResults, broad: true, signal: request.signal });
      if (token !== searchToken || fragmentAtCaret(textarea).query !== query) return;
      render(items);
    } catch (error) {
      if (error.name !== "AbortError") renderMessage(error.message || "Tag 搜索失败", "err");
    } finally {
      if (token === searchToken) popover.removeAttribute("aria-busy");
    }
  };

  const schedule = () => {
    clearTimeout(timer);
    if (composing) return;
    if (document.activeElement !== textarea) { dismiss(); return; }
    const { query } = fragmentAtCaret(textarea);
    const minimum = hasHan(query) ? 1 : 2;
    if (query.length < minimum) { request?.abort(); setOpen(false); return; }
    timer = setTimeout(search, 280);
  };

  const onCompositionStart = () => { composing = true; dismiss(); };
  const onCompositionEnd = () => { composing = false; schedule(); };
  const onKeydown = (event) => {
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
      dismiss();
    }
  };

  const onPointerDown = (event) => {
    if (event.target !== textarea && !popover.contains(event.target)) dismiss();
  };
  const onSelectionChange = () => {
    if (!popover.hidden && document.activeElement === textarea) position();
  };
  const observer = new ResizeObserver(position);
  observer.observe(textarea.closest(".hl-wrap") || textarea);

  textarea.addEventListener("input", schedule);
  textarea.addEventListener("click", schedule);
  textarea.addEventListener("compositionstart", onCompositionStart);
  textarea.addEventListener("compositionend", onCompositionEnd);
  textarea.addEventListener("keydown", onKeydown);
  document.addEventListener("pointerdown", onPointerDown);
  document.addEventListener("selectionchange", onSelectionChange);
  window.addEventListener("resize", position);
  document.addEventListener("scroll", position, true);
  window.visualViewport?.addEventListener("resize", position);
  window.visualViewport?.addEventListener("scroll", position);

  return () => {
    dismiss();
    observer.disconnect();
    /* Clear the guard flag and the ARIA wiring, otherwise a later re-attach
       is refused by the check at the top and the textarea keeps advertising
       a listbox that no longer exists. */
    delete textarea.dataset.tagAutocomplete;
    for (const attribute of ["aria-autocomplete", "aria-controls", "aria-expanded", "aria-haspopup"]) {
      textarea.removeAttribute(attribute);
    }
    textarea.removeEventListener("input", schedule);
    textarea.removeEventListener("click", schedule);
    textarea.removeEventListener("compositionstart", onCompositionStart);
    textarea.removeEventListener("compositionend", onCompositionEnd);
    textarea.removeEventListener("keydown", onKeydown);
    document.removeEventListener("pointerdown", onPointerDown);
    document.removeEventListener("selectionchange", onSelectionChange);
    window.removeEventListener("resize", position);
    document.removeEventListener("scroll", position, true);
    window.visualViewport?.removeEventListener("resize", position);
    window.visualViewport?.removeEventListener("scroll", position);
    popover.remove();
  };
}
