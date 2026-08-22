import {
  CATEGORIES, danbooruTagUrl, formatCount, loadCategoryFilter,
  promptTag, saveCategoryFilter, searchTagPage
} from "./tag-api.js";

const CART_KEY = "scylla:tag-cart-v1";
const input = document.getElementById("tagSearch");
const form = document.getElementById("tagSearchForm");
const submit = document.getElementById("tagSearchButton");
const results = document.getElementById("tagResults");
const status = document.getElementById("tagStatus");
const count = document.getElementById("tagResultCount");
const region = document.querySelector(".tags-results");
const toast = document.getElementById("tagToast");
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
const cartOpen = document.getElementById("tagCartOpen");
const cartClose = document.getElementById("tagCartClose");
const cartBackdrop = document.getElementById("tagCartBackdrop");
const mobileCart = matchMedia("(max-width: 900px)");
const pagination = document.getElementById("tagPagination");
const prevPage = document.getElementById("tagPrevPage");
const nextPage = document.getElementById("tagNextPage");
const pageLabel = document.getElementById("tagPageLabel");

let timer = null;
let request = null;
let runId = 0;
let toastTimer = null;
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

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2200);
}

async function copyText(value, message) {
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
  showToast(message);
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
    button.title = on ? "移出组合" : "加入组合";
    button.querySelector("use").setAttribute("href", on ? "#i-check" : "#i-plus");
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
    minus.className = "tag-weight-step";
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
    plus.className = "tag-weight-step";
    plus.setAttribute("aria-label", `提高 ${item.name} 的权重`);
    plus.append(makeIcon("i-plus"));
    plus.addEventListener("click", () => adjustWeight(index, 0.1));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "tag-cart-remove";
    remove.setAttribute("aria-label", `移除 ${item.name}`);
    remove.title = "移除";
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
  syncAddButtons();
}

function toggleCart(item) {
  const index = cart.findIndex((entry) => entry.name === item.name);
  if (index >= 0) {
    cart.splice(index, 1);
    showToast(`已移出：${promptTag(item.name)}`);
  } else {
    cart.push({ name: item.name, cnName: item.cnName, category: item.category, weight: 1 });
    showToast(`已加入：${promptTag(item.name)}`);
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

function actionButton(label, title, symbol) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tag-icon-action";
  button.setAttribute("aria-label", label);
  button.title = title;
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

    const info = document.createElement("div");
    info.className = "tag-card-info";
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
    const add = actionButton(`加入 Prompt 组合：${promptTag(item.name)}`, "加入组合", "i-plus");
    add.classList.add("tag-add");
    add.dataset.tag = item.name;
    add.setAttribute("aria-pressed", "false");
    add.addEventListener("click", () => toggleCart(item));
    const copy = actionButton(`复制 ${promptTag(item.name)}`, "复制 Tag", "i-copy");
    copy.addEventListener("click", () => copyText(promptTag(item.name), `已复制：${promptTag(item.name)}`));
    const danbooru = document.createElement("a");
    danbooru.className = "tag-icon-action";
    danbooru.href = danbooruTagUrl(item.name);
    danbooru.target = "_blank";
    danbooru.rel = "noopener noreferrer";
    danbooru.title = "在 Danbooru 打开";
    danbooru.setAttribute("aria-label", `在 Danbooru 打开 ${item.name}（新标签页）`);
    danbooru.append(makeIcon("i-external"));
    actions.append(add, copy, danbooru);
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
      showToast("至少保留一种类型");
      return;
    }
    activeCategories = saveCategoryFilter(next);
    syncFilters();
    if (input.value.trim()) runSearch({ page: 1 });
  });
});
prevPage.addEventListener("click", () => {
  if (currentPage > 1) runSearch({ page: currentPage - 1 });
});
nextPage.addEventListener("click", () => {
  if (hasNextPage) runSearch({ page: currentPage + 1 });
});
cartOpen.addEventListener("click", () => setCartOpen(true));
cartClose.addEventListener("click", () => setCartOpen(false));
cartBackdrop.addEventListener("click", () => setCartOpen(false));
cartCopy.addEventListener("click", () => copyText(combinedPrompt(), `已复制 ${cart.length} 个 Tag`));
cartClear.addEventListener("click", () => {
  cart = [];
  saveCart();
  renderCart();
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
