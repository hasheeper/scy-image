import { CATEGORIES, formatCount, promptTag, searchTags } from "./tag-api.js";

const input = document.getElementById("tagSearch");
const form = document.getElementById("tagSearchForm");
const submit = document.getElementById("tagSearchButton");
const results = document.getElementById("tagResults");
const status = document.getElementById("tagStatus");
const count = document.getElementById("tagResultCount");
const region = document.querySelector(".tags-results");
const toast = document.getElementById("tagToast");

let timer = null;
let request = null;
let runId = 0;
let toastTimer = null;
let composing = false;

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2200);
}

async function copyTag(name) {
  const value = promptTag(name);
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const helper = document.createElement("textarea");
    helper.value = value;
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    document.body.append(helper);
    helper.select();
    document.execCommand("copy");
    helper.remove();
  }
  showToast(`已复制：${value}`);
}

function empty(message) {
  results.replaceChildren();
  const note = document.createElement("p");
  note.className = "tags-empty";
  note.textContent = message;
  results.append(note);
}

function render(items) {
  results.replaceChildren();
  if (!items.length) {
    empty("没有找到匹配的 Danbooru Tag");
    return;
  }

  const fragment = document.createDocumentFragment();
  items.forEach((item) => {
    const category = CATEGORIES[item.category] || CATEGORIES[0];
    const card = document.createElement("button");
    card.type = "button";
    card.className = "tag-card";
    card.title = `复制 ${promptTag(item.name)}`;

    const names = document.createElement("span");
    names.className = "tag-card-names";
    const english = document.createElement("strong");
    english.textContent = item.name;
    const chinese = document.createElement("span");
    chinese.textContent = item.cnName || "暂无中文翻译";
    names.append(english, chinese);

    const side = document.createElement("span");
    side.className = "tag-card-side";
    const meta = document.createElement("span");
    meta.className = "tag-card-meta";
    const dot = document.createElement("i");
    dot.className = `tag-category-dot ${category.className}`;
    const metaText = document.createElement("span");
    metaText.textContent = `${category.label} · ${formatCount(item.count)}`;
    meta.append(dot, metaText);
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("class", "ico tag-card-copy");
    icon.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#i-copy");
    icon.append(use);
    side.append(meta, icon);
    card.append(names, side);
    card.addEventListener("click", () => copyTag(item.name));
    fragment.append(card);
  });
  results.append(fragment);
}

async function runSearch({ updateUrl = true } = {}) {
  const query = input.value.trim();
  clearTimeout(timer);
  request?.abort();
  const id = ++runId;

  if (!query) {
    status.textContent = "输入关键词开始搜索";
    count.textContent = "";
    results.replaceChildren();
    if (updateUrl) history.replaceState(null, "", location.pathname);
    return;
  }

  request = new AbortController();
  submit.disabled = true;
  region.setAttribute("aria-busy", "true");
  status.textContent = `正在搜索“${query}”…`;
  count.textContent = "";
  if (updateUrl) {
    const url = new URL(location.href);
    url.searchParams.set("q", query);
    history.replaceState(null, "", url);
  }

  try {
    const items = await searchTags(query, { broad: true, limit: 50, signal: request.signal });
    if (id !== runId) return;
    render(items);
    status.textContent = `“${query}”的匹配结果`;
    count.textContent = `${items.length} 个`;
  } catch (error) {
    if (error.name === "AbortError" || id !== runId) return;
    empty(error.message || "Tag 搜索失败，请稍后再试");
    status.textContent = "搜索失败";
  } finally {
    if (id === runId) {
      submit.disabled = false;
      region.setAttribute("aria-busy", "false");
    }
  }
}

function schedule() {
  clearTimeout(timer);
  if (composing) return;
  const query = input.value.trim();
  if (!query) { runSearch(); return; }
  timer = setTimeout(runSearch, 320);
}

form.addEventListener("submit", (event) => { event.preventDefault(); runSearch(); });
input.addEventListener("input", schedule);
input.addEventListener("compositionstart", () => { composing = true; });
input.addEventListener("compositionend", () => { composing = false; schedule(); });
document.querySelectorAll("[data-query]").forEach((button) => {
  button.addEventListener("click", () => {
    input.value = button.dataset.query;
    input.focus();
    runSearch();
  });
});

const initial = new URLSearchParams(location.search).get("q");
if (initial) {
  input.value = initial;
  runSearch({ updateUrl: false });
}
