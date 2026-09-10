import { vault } from "./vault.js";
export const UPSTREAM = "https://proxy.scylla.love";
export const API_BASE = new URL("../api/", import.meta.url);
export const state = { mode: "direct" };
export async function detectMode() {
  try {
    const res = await fetch(new URL("status", API_BASE), { cache: "no-store", signal: AbortSignal.timeout(1500) });
    const data = res.ok ? await res.json() : null;
    if (data?.proxy) { state.mode = "proxy"; return { mode: "proxy", configured: !!data.configured }; }
  } catch { /* Static deployment has no proxy. */ }
  state.mode = "direct";
  return { mode: "direct", configured: vault.isUnlocked() };
}
export function endpoint(path) {
  return state.mode === "proxy" ? new URL(path.replace(/^\//, ""), API_BASE).href : `${UPSTREAM}/v1${path}`;
}
export async function request(path, { body, signal, method, ...options } = {}) {
  const headers = { Accept: "application/json, image/png, image/jpeg, image/webp" };
  if (state.mode === "direct") {
    if (!vault.token()) throw new Error("请先解锁 API Key");
    headers.Authorization = `Bearer ${vault.token()}`;
  }
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(endpoint(path), { ...options, method: method || (body === undefined ? "GET" : "POST"),
    headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store", signal });
}
export function errorMessage(data, fallback = "请求失败") {
  const value = data?.error?.message || data?.detail || data?.error || data?.message;
  return typeof value === "string" ? value.slice(0, 1000) : fallback;
}
export async function readJson(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(errorMessage(data, `请求失败 (${res.status})`));
  return data;
}
