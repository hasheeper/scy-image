import {
  CATEGORIES, danbooruTagUrl, formatCount, loadCategoryFilter,
  promptTag, saveCategoryFilter, searchTagPage
} from "./tag-api.js";
import { toast } from "./toast.js";
import { queueTags } from "./tag-handoff.js";

const CART_KEY = "scylla:tag-cart-v1";
const input = document.getElementById("tagSearch");
const form = document.getElementById("tagSearchForm");
const submit = document.getElementById("tagSearchButton");
const results = document.getElementById("tagResults");
const status = document.getElementById("tagStatus");
const count = document.getElementById("tagResultCount");
const region = document.querySelector(".tags-results");
const filterButtons = [...document.querySelectorAll(".tag-filter")];
const cartPanel = document.getElementById("tagCart");
const cartList = document.getElementById("tagCartList");
const cartEmpty = document.getElementById("tagCartEmpty");
const cartCount = document.getElementById("tagCartCount");
const cartFabCount = document.getElementById("tagCartFabCount");
const cartPrompt = document.getElementById("tagCartPrompt");
const cartPreview = document.getElementById("tagCartPreview");
const cartCopy = document.getElementById("tagCartCopy");
const cartClear = document.getElementById("tagCartClear");
const cartApply = document.getElementById("tagCartApply");
const cartOpen = document.getElementById("tagCartOpen");
const cartClose = document.getElementById("tagCartClose");
const cartBackdrop = document.getElementById("tagCartBackdrop");
const mobileCart = matchMedia("(max-width: 860px)");
const pagination = document.getElementById("tagPagination");
const prevPage = document.getElementById("tagPrevPage");
const nextPage = document.getElementById("tagNextPage");
const pageLabel = document.getElementById("tagPageLabel");

let timer = null;
let request = null;
let runId = 0;
let composing = false;
let activeCategories = loadCategoryFilter();
let cart = loadCart();
let currentPage = 1;
let hasNextPage = false;

function makeIcon(symbol) {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("class", "ico");
  icon.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#${symbol}`);
  icon.append(use);
  return icon;
}

async function copyText(value, message) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    /* Clipboard API needs a secure context and permission; the textarea
       route still works when it is unavailable. */
    const helper = document.createElement("textarea");
    helper.value = value;
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    document.body.append(helper);
    helper.select();
    const copied = document.execCommand("copy");
    helper.remove();
    if (!copied) {
      toast("复制失败，请手动选取组合预览里的文本");
      return;
    }
  }
  toast(message, "ok");
}

function loadCart() {
  try {
    const stored = JSON.parse(localStorage.getItem(CART_KEY));
    if (!Array.isArray(stored)) return [];
    const seen = new Set();
    return stored.filter((item) => {
      if (!item || typeof item.name !== "string" || !item.name || seen.has(item.name)) return false;
      seen.add(item.name);
      return true;
    }).slice(0, 100).map((item) => ({
      name: item.name,
      cnName: String(item.cnName || ""),
      category: Number(item.category) || 0,
      weight: clampWeight(item.weight)
    }));
  } catch { return []; }
}

function saveCart() {
  try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch { /* optional local preference */ }
}

function clampWeight(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.min(5, Math.max(0.1, Math.round(number * 10) / 10));
}

function weightedTag(item) {
  const tag = promptTag(item.name);
  return item.weight === 1 ? tag : `${item.weight}::${tag}::`;
}

function combinedPrompt() {
  return cart.map(weightedTag).join(", ");
}

function setCartOpen(open) {
  const wasOpen = document.body.dataset.tagCart === "open";
  document.body.dataset.tagCart = open ? "open" : "closed";
  cartOpen.setAttribute("aria-expanded", String(open));
  cartPanel.inert = mobileCart.matches && !open;
  if (mobileCart.matches && open) requestAnimationFrame(() => cartClose.focus());
  if (mobileCart.matches && !open && wasOpen && cartPanel.contains(document.activeElement)) cartOpen.focus();
}

function syncCartMode() {
  if (mobileCart.matches) {
    cartPanel.setAttribute("role", "dialog");
    cartPanel.setAttribute("aria-modal", "true");
  } else {
    cartPanel.removeAttribute("role");
    cartPanel.removeAttribute("aria-modal");
  }
  cartPanel.inert = mobileCart.matches && document.body.dataset.tagCart !== "open";
}

function syncAddButtons() {
  const selected = new Set(cart.map((item) => item.name));
  document.querySelectorAll(".tag-add").forEach((button) => {
    const on = selected.has(button.dataset.tag);
    button.setAttribute("aria-pressed", String(on));
    button.setAttribute("aria-label", `${on ? "移出" : "加入"} Prompt 组合：${promptTag(button.dataset.tag)}`);
  });
}

function adjustWeight(index, amount) {
  const item = cart[index];
  if (!item) return;
  item.weight = clampWeight(item.weight + amount);
  saveCart();
  renderCart();
}

function removeCartItem(index) {
  cart.splice(index, 1);
  saveCart();
  renderCart();
}

function renderCart() {
  cartList.replaceChildren();
  cart.forEach((item, index) => {
    const row = document.createElement("article");
    row.className = "tag-cart-item";

    const names = document.createElement("div");
    names.className = "tag-cart-item-names";
    const english = document.createElement("strong");
    english.textContent = item.name;
    const chinese = document.createElement("span");
    chinese.textContent = item.cnName || "暂无中文翻译";
    names.append(english, chinese);

    const controls = document.createElement("div");
    controls.className = "tag-weight";
    const label = document.createElement("span");
    label.textContent = "权重";
    const minus = document.createElement("button");
    minus.type = "button";
    minus.className = "ibtn ibtn-xs tag-weight-step";
    minus.setAttribute("aria-label", `降低 ${item.name} 的权重`);
    minus.append(makeIcon("i-minus"));
    minus.addEventListener("click", () => adjustWeight(index, -0.1));
    const weight = document.createElement("input");
    weight.type = "number";
    weight.min = "0.1";
    weight.max = "5";
    weight.step = "0.1";
    weight.value = String(item.weight);
    weight.setAttribute("aria-label", `${item.name} 权重`);
    weight.addEventListener("change", () => {
      item.weight = clampWeight(weight.value);
      saveCart();
      renderCart();
    });
    const plus = document.createElement("button");
    plus.type = "button";
    plus.className = "ibtn ibtn-xs tag-weight-step";
    plus.setAttribute("aria-label", `提高 ${item.name} 的权重`);
    plus.append(makeIcon("i-plus"));
    plus.addEventListener("click", () => adjustWeight(index, 0.1));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ibtn ibtn-xs tag-cart-remove";
    remove.setAttribute("aria-label", `移除 ${item.name}`);
    remove.dataset.tip = "移除";
    remove.append(makeIcon("i-close"));
    remove.addEventListener("click", () => removeCartItem(index));
    controls.append(label, minus, weight, plus, remove);
    row.append(names, controls);
    cartList.append(row);
  });

  const prompt = combinedPrompt();
  const empty = cart.length === 0;
  cartEmpty.hidden = !empty;
  cartPreview.hidden = empty;
  cartPrompt.textContent = prompt;
  cartCount.textContent = String(cart.length);
  cartFabCount.textContent = String(cart.length);
  cartCopy.disabled = empty;
  cartClear.disabled = empty;
  cartApply.disabled = empty;
  syncAddButtons();
}

function toggleCart(item) {
  const index = cart.findIndex((entry) => entry.name === item.name);
  if (index >= 0) {
    cart.splice(index, 1);
    toast(`已移出：${promptTag(item.name)}`, "ok");
  } else {
    cart.push({ name: item.name, cnName: item.cnName, category: item.category, weight: 1 });
    toast(`已加入：${promptTag(item.name)}`, "ok");
  }
  saveCart();
  renderCart();
}

function emptyResults(message) {
  results.replaceChildren();
  const note = document.createElement("p");
  note.className = "tags-empty";
  note.textContent = message;
  results.append(note);
}

/* data-tip renders the styled tooltip the rest of the app uses and is
   suppressed on touch; native title= showed an OS box that looked foreign
   here and never appeared on phones at all. */
function actionButton(label, tip, symbol) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ibtn ibtn-xs";
  button.setAttribute("aria-label", label);
  button.dataset.tip = tip;
  button.append(makeIcon(symbol));
  return button;
}

function renderResults(items) {
  results.replaceChildren();
  if (!items.length) {
    emptyResults("没有找到匹配的 Danbooru Tag");
    return;
  }

  const fragment = document.createDocumentFragment();
  items.forEach((item) => {
    const category = CATEGORIES[item.category] || CATEGORIES[0];
    const card = document.createElement("article");
    card.className = "tag-card";

    /* The name block is the toggle, not just a trailing icon: the card
       already lifted on hover, so a tiny hit area was a false affordance.
       It stays a sibling of the icon actions rather than wrapping them —
       nesting buttons inside a button is invalid and breaks keyboard order. */
    const info = document.createElement("button");
    info.type = "button";
    info.className = "tag-card-info tag-add";
    info.dataset.tag = item.name;
    info.setAttribute("aria-pressed", "false");
    info.addEventListener("click", () => toggleCart(item));
    const names = document.createElement("span");
    names.className = "tag-card-names";
    const english = document.createElement("strong");
    english.textContent = item.name;
    const chinese = document.createElement("span");
    chinese.textContent = item.cnName || "暂无中文翻译";
    names.append(english, chinese);
    const meta = document.createElement("span");
    meta.className = "tag-card-meta";
    const dot = document.createElement("i");
    dot.className = `tag-category-dot ${category.className}`;
    const metaText = document.createElement("span");
    metaText.textContent = `${category.label} · ${formatCount(item.count)}`;
    meta.append(dot, metaText);
    info.append(names, meta);

    const actions = document.createElement("div");
    actions.className = "tag-card-actions";
    const copy = actionButton(`复制 ${promptTag(item.name)}`, "复制", "i-copy");
    copy.addEventListener("click", () => copyText(promptTag(item.name), `已复制：${promptTag(item.name)}`));
    const danbooru = document.createElement("a");
    danbooru.className = "ibtn ibtn-xs";
    danbooru.href = danbooruTagUrl(item.name);
    danbooru.target = "_blank";
    danbooru.rel = "noopener noreferrer";
    danbooru.dataset.tip = "Danbooru";
    danbooru.setAttribute("aria-label", `在 Danbooru 打开 ${item.name}（新标签页）`);
    danbooru.append(makeIcon("i-external"));
    actions.append(copy, danbooru);
    card.append(info, actions);
    fragment.append(card);
  });
  results.append(fragment);
  syncAddButtons();
}

function syncPagination(show = true) {
  pagination.hidden = !show;
  prevPage.disabled = currentPage <= 1;
  nextPage.disabled = !hasNextPage;
  pageLabel.textContent = `第 ${currentPage} 页`;
}

async function runSearch({ updateUrl = true, page = 1 } = {}) {
  const query = input.value.trim();
  clearTimeout(timer);
  request?.abort();
  const id = ++runId;

  if (!query) {
    currentPage = 1;
    hasNextPage = false;
    status.textContent = "输入关键词开始搜索";
    count.textContent = "";
    results.replaceChildren();
    syncPagination(false);
    if (updateUrl) history.replaceState(null, "", location.pathname);
    return;
  }

  request = new AbortController();
  currentPage = Math.max(1, Math.floor(page));
  submit.disabled = true;
  region.setAttribute("aria-busy", "true");
  status.textContent = `正在搜索“${query}”…`;
  count.textContent = "";
  if (updateUrl) {
    const url = new URL(location.href);
    url.searchParams.set("q", query);
    if (currentPage > 1) url.searchParams.set("page", String(currentPage));
    else url.searchParams.delete("page");
    history.replaceState(null, "", url);
  }

  try {
    const pageResult = await searchTagPage(query, {
      page: currentPage,
      pageSize: 25,
      categories: activeCategories,
      signal: request.signal
    });
    if (id !== runId) return;
    hasNextPage = pageResult.hasNext;
    renderResults(pageResult.items);
    status.textContent = `“${query}”的匹配结果`;
    count.textContent = `${pageResult.items.length} 个 · 第 ${currentPage} 页`;
    syncPagination(currentPage > 1 || hasNextPage);
  } catch (error) {
    if (error.name === "AbortError" || id !== runId) return;
    emptyResults(error.message || "Tag 搜索失败，请稍后再试");
    status.textContent = "搜索失败";
    hasNextPage = false;
    syncPagination(currentPage > 1);
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

function syncFilters() {
  filterButtons.forEach((button) => {
    const on = activeCategories.includes(Number(button.dataset.category));
    button.setAttribute("aria-pressed", String(on));
  });
}

form.addEventListener("submit", (event) => { event.preventDefault(); runSearch(); });
input.addEventListener("input", schedule);
input.addEventListener("compositionstart", () => { composing = true; });
input.addEventListener("compositionend", () => { composing = false; schedule(); });
filterButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const category = Number(button.dataset.category);
    const next = activeCategories.includes(category)
      ? activeCategories.filter((id) => id !== category)
      : [...activeCategories, category];
    if (!next.length) {
      toast("至少保留一种类型");
      return;
    }
    activeCategories = saveCategoryFilter(next);
    syncFilters();
    if (input.value.trim()) runSearch({ page: 1 });
  });
});
/* Paging without this leaves the viewport mid-list while the rows underneath
   are replaced, which reads as nothing having happened. */
function turnPage(page) {
  runSearch({ page });
  region.scrollIntoView({ block: "start", behavior: "smooth" });
}
prevPage.addEventListener("click", () => {
  if (currentPage > 1) turnPage(currentPage - 1);
});
nextPage.addEventListener("click", () => {
  if (hasNextPage) turnPage(currentPage + 1);
});
cartOpen.addEventListener("click", () => setCartOpen(true));
cartClose.addEventListener("click", () => setCartOpen(false));
cartBackdrop.addEventListener("click", () => setCartOpen(false));
cartCopy.addEventListener("click", () => copyText(combinedPrompt(), `已复制 ${cart.length} 个 Tag`));
cartApply.addEventListener("click", () => {
  if (!cart.length) return;
  if (!queueTags(combinedPrompt())) {
    toast("浏览器拒绝写入本地存储，请改用复制");
    return;
  }
  toast(`已交给生成器：${cart.length} 个 Tag，回到生成器标签页确认插入`, "ok");
});
/* The cart is saved to localStorage, so it survives reloads and represents
   real accumulated work — losing it to a stray click is worth one question. */
cartClear.addEventListener("click", () => {
  if (!cart.length) return;
  if (!confirm(`清空组合中的 ${cart.length} 个 Tag？此操作无法撤销。`)) return;
  cart = [];
  saveCart();
  renderCart();
  toast("已清空组合", "ok");
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.body.dataset.tagCart === "open") setCartOpen(false);
});
mobileCart.addEventListener("change", syncCartMode);

syncFilters();
renderCart();
setCartOpen(false);
syncCartMode();

const initial = new URLSearchParams(location.search).get("q");
if (initial) {
  input.value = initial;
  const page = Math.max(1, Number.parseInt(new URLSearchParams(location.search).get("page") || "1", 10) || 1);
  runSearch({ updateUrl: false, page });
}
