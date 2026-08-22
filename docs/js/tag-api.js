/**
 * Danbooru tag lookup.
 *
 * Primary source: tagsuggest.zeabur.app — Chinese/English translations and
 * Danbooru counts, maintained from the ffdkj translation table.
 * Fallback: Danbooru's official autocomplete endpoint for English queries.
 */

const TRANSLATED_API = "https://tagsuggest.zeabur.app/api";
const DANBOORU_AUTOCOMPLETE = "https://danbooru.donmai.us/autocomplete.json";
const CACHE_LIMIT = 120;
const cache = new Map();
const pageCache = new Map();

export const CATEGORY_FILTER_KEY = "scylla:tag-categories";
export const DEFAULT_CATEGORY_IDS = [0, 3, 4];

export const CATEGORIES = {
  0: { label: "通用", className: "general" },
  1: { label: "画师", className: "artist" },
  3: { label: "作品", className: "copyright" },
  4: { label: "角色", className: "character" },
  5: { label: "元数据", className: "meta" }
};

const KNOWN_CATEGORY_IDS = new Set(Object.keys(CATEGORIES).map(Number));

export const hasHan = (text) => /[\u3400-\u9fff\uf900-\ufaff]/.test(text);
export const promptTag = (name) => String(name || "").replaceAll("_", " ");
export const danbooruTagUrl = (name) => {
  const url = new URL("https://danbooru.donmai.us/posts");
  url.searchParams.set("tags", String(name || ""));
  return url.href;
};

export function loadCategoryFilter() {
  try {
    const stored = JSON.parse(localStorage.getItem(CATEGORY_FILTER_KEY));
    const valid = Array.isArray(stored)
      ? [...new Set(stored.map(Number).filter((id) => KNOWN_CATEGORY_IDS.has(id)))]
      : [];
    if (valid.length) return valid;
  } catch { /* use defaults when storage is unavailable or malformed */ }
  return [...DEFAULT_CATEGORY_IDS];
}

export function saveCategoryFilter(categoryIds) {
  const valid = [...new Set(categoryIds.map(Number).filter((id) => KNOWN_CATEGORY_IDS.has(id)))];
  if (!valid.length) return loadCategoryFilter();
  try { localStorage.setItem(CATEGORY_FILTER_KEY, JSON.stringify(valid)); } catch { /* optional preference */ }
  return valid;
}

export function formatCount(value) {
  const count = Number(value) || 0;
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 0 : 1)}m`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(count >= 100_000 ? 0 : 1)}k`;
  return String(count);
}

function remember(key, value) {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return value;
}

async function resilientFetch(url, options) {
  try {
    return await fetch(url, options);
  } catch (error) {
    if (error.name === "AbortError" || options.signal?.aborted) throw error;
    return fetch(url, options);
  }
}

async function translatedSearch(query, { limit, broad, signal, offset = 0 }) {
  const path = broad ? "/tags" : "/tags/suggest";
  const url = new URL(`${TRANSLATED_API}${path}`);
  const requestQuery = hasHan(query) ? query : query.replace(/\s+/g, "_");
  url.searchParams.set("q", requestQuery);
  if (broad) {
    url.searchParams.set("limit", String(Math.min(200, limit)));
    url.searchParams.set("offset", String(Math.max(0, offset)));
  }

  const response = await resilientFetch(url, { signal, headers: { Accept: "application/json" } });
  if (response.status === 429) throw new Error("Tag 词典请求过于频繁，请稍后再试");
  if (!response.ok) throw new Error(`中文 Tag 词典暂不可用 (${response.status})`);
  const data = await response.json();
  return (Array.isArray(data?.results) ? data.results : []).slice(0, limit).map((item) => ({
    name: String(item.name || ""),
    cnName: String(item.cn_name || ""),
    count: Number(item.count) || 0,
    category: Number(item.category) || 0,
    source: "translated"
  })).filter((item) => item.name);
}

async function officialSearch(query, { limit, signal, offset = 0 }) {
  const url = new URL(DANBOORU_AUTOCOMPLETE);
  url.searchParams.set("search[query]", query);
  url.searchParams.set("search[type]", "tag_query");
  url.searchParams.set("limit", String(limit + offset));
  const response = await resilientFetch(url, { signal, headers: { Accept: "application/json" } });
  if (response.status === 429) throw new Error("Danbooru 请求过于频繁，请稍后再试");
  if (!response.ok) throw new Error(`Danbooru 暂不可用 (${response.status})`);
  const data = await response.json();
  return (Array.isArray(data) ? data : []).slice(offset, offset + limit).map((item) => ({
    name: String(item.value || item.tag?.name || ""),
    cnName: "",
    count: Number(item.post_count ?? item.tag?.post_count) || 0,
    category: Number(item.category ?? item.tag?.category) || 0,
    source: "danbooru"
  })).filter((item) => item.name);
}

function friendlyError(primary, fallback) {
  const error = primary || fallback;
  return error instanceof TypeError ? new Error("Tag 服务暂时不可用，请稍后再试") : error;
}

function normalized(text) {
  return String(text || "").toLocaleLowerCase().replaceAll("_", " ").trim();
}

function rankResults(items, query, categoryIds, limit) {
  const allowed = new Set(categoryIds);
  const needle = normalized(query);
  const seen = new Set();

  return items
    .filter((item) => allowed.has(item.category) && !seen.has(item.name) && seen.add(item.name))
    .map((item, index) => {
      const english = normalized(item.name);
      const chinese = normalized(item.cnName);
      let relevance = 0;
      if (english === needle || chinese === needle) relevance = 5;
      else if (english.startsWith(needle) || chinese.startsWith(needle)) relevance = 4;
      else if (english.split(" ").some((word) => word.startsWith(needle))) relevance = 3;
      else if (english.includes(needle) || chinese.includes(needle)) relevance = 2;
      return { item, index, relevance };
    })
    .sort((a, b) => b.item.count - a.item.count || b.relevance - a.relevance || a.index - b.index)
    .slice(0, limit)
    .map(({ item }) => item);
}

export async function searchTags(rawQuery, { limit = 12, broad = false, signal, categories } = {}) {
  const query = String(rawQuery || "").trim();
  if (!query) return [];
  const safeLimit = Math.min(broad ? 100 : 20, Math.max(1, Math.floor(limit)));
  const categoryIds = (categories?.length ? categories : loadCategoryFilter())
    .map(Number).filter((id) => KNOWN_CATEGORY_IDS.has(id));
  const key = `${broad ? "b" : "a"}:${safeLimit}:${categoryIds.sort((a, b) => a - b).join(".")}:${query.toLocaleLowerCase()}`;
  if (cache.has(key)) return cache.get(key).map((item) => ({ ...item }));

  const requestLimit = Math.min(broad ? 200 : 20, Math.max(safeLimit, safeLimit * 3));

  let translatedError = null;
  try {
    const rawResults = await translatedSearch(query, { limit: requestLimit, broad, signal });
    const results = rankResults(rawResults, query, categoryIds, safeLimit);
    if (results.length || hasHan(query)) return remember(key, results).map((item) => ({ ...item }));
  } catch (error) {
    if (error.name === "AbortError") throw error;
    translatedError = error;
    if (hasHan(query)) throw error;
  }

  try {
    const rawResults = await officialSearch(query, { limit: requestLimit, signal });
    const results = rankResults(rawResults, query, categoryIds, safeLimit);
    return remember(key, results).map((item) => ({ ...item }));
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw friendlyError(translatedError, error);
  }
}

export async function searchTagPage(rawQuery, {
  page = 1, pageSize = 25, signal, categories
} = {}) {
  const query = String(rawQuery || "").trim();
  if (!query) return { items: [], hasNext: false };
  const safePage = Math.max(1, Math.floor(page));
  const safeSize = Math.min(100, Math.max(1, Math.floor(pageSize)));
  const offset = (safePage - 1) * safeSize;
  const categoryIds = (categories?.length ? categories : loadCategoryFilter())
    .map(Number).filter((id) => KNOWN_CATEGORY_IDS.has(id));
  const key = `${safePage}:${safeSize}:${categoryIds.slice().sort((a, b) => a - b).join(".")}:${query.toLocaleLowerCase()}`;
  if (pageCache.has(key)) {
    const cached = pageCache.get(key);
    return { items: cached.items.map((item) => ({ ...item })), hasNext: cached.hasNext };
  }

  let translatedError = null;
  try {
    const rawResults = await translatedSearch(query, {
      limit: safeSize + 1,
      broad: true,
      offset,
      signal
    });
    const hasNext = rawResults.length > safeSize;
    const items = rankResults(rawResults.slice(0, safeSize), query, categoryIds, safeSize);
    if (rawResults.length || hasHan(query)) {
      const value = { items, hasNext };
      pageCache.set(key, value);
      if (pageCache.size > CACHE_LIMIT) pageCache.delete(pageCache.keys().next().value);
      return { items: items.map((item) => ({ ...item })), hasNext };
    }
  } catch (error) {
    if (error.name === "AbortError") throw error;
    translatedError = error;
    if (hasHan(query)) throw friendlyError(error);
  }

  try {
    const rawResults = await officialSearch(query, { limit: safeSize + 1, offset, signal });
    const hasNext = rawResults.length > safeSize;
    const items = rankResults(rawResults.slice(0, safeSize), query, categoryIds, safeSize);
    return { items, hasNext };
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw friendlyError(translatedError, error);
  }
}
