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

export const CATEGORIES = {
  0: { label: "通用", className: "general" },
  1: { label: "画师", className: "artist" },
  3: { label: "作品", className: "copyright" },
  4: { label: "角色", className: "character" },
  5: { label: "元数据", className: "meta" }
};

export const hasHan = (text) => /[\u3400-\u9fff\uf900-\ufaff]/.test(text);
export const promptTag = (name) => String(name || "").replaceAll("_", " ");

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

async function translatedSearch(query, { limit, broad, signal }) {
  const path = broad ? "/tags" : "/tags/suggest";
  const url = new URL(`${TRANSLATED_API}${path}`);
  const requestQuery = hasHan(query) ? query : query.replace(/\s+/g, "_");
  url.searchParams.set("q", requestQuery);
  if (broad) url.searchParams.set("limit", String(Math.min(200, limit)));

  const response = await fetch(url, { signal, headers: { Accept: "application/json" } });
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

async function officialSearch(query, { limit, signal }) {
  const url = new URL(DANBOORU_AUTOCOMPLETE);
  url.searchParams.set("search[query]", query);
  url.searchParams.set("search[type]", "tag_query");
  url.searchParams.set("limit", String(limit));
  const response = await fetch(url, { signal, headers: { Accept: "application/json" } });
  if (response.status === 429) throw new Error("Danbooru 请求过于频繁，请稍后再试");
  if (!response.ok) throw new Error(`Danbooru 暂不可用 (${response.status})`);
  const data = await response.json();
  return (Array.isArray(data) ? data : []).slice(0, limit).map((item) => ({
    name: String(item.value || item.tag?.name || ""),
    cnName: "",
    count: Number(item.post_count ?? item.tag?.post_count) || 0,
    category: Number(item.category ?? item.tag?.category) || 0,
    source: "danbooru"
  })).filter((item) => item.name);
}

export async function searchTags(rawQuery, { limit = 12, broad = false, signal } = {}) {
  const query = String(rawQuery || "").trim();
  if (!query) return [];
  const safeLimit = Math.min(broad ? 100 : 20, Math.max(1, Math.floor(limit)));
  const key = `${broad ? "b" : "a"}:${safeLimit}:${query.toLocaleLowerCase()}`;
  if (cache.has(key)) return cache.get(key).map((item) => ({ ...item }));

  let translatedError = null;
  try {
    const results = await translatedSearch(query, { limit: safeLimit, broad, signal });
    if (results.length || hasHan(query)) return remember(key, results).map((item) => ({ ...item }));
  } catch (error) {
    if (error.name === "AbortError") throw error;
    translatedError = error;
    if (hasHan(query)) throw error;
  }

  try {
    const results = await officialSearch(query, { limit: safeLimit, signal });
    return remember(key, results).map((item) => ({ ...item }));
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw translatedError || error;
  }
}
