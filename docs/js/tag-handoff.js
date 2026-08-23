/**
 * Hand a tag combination from the dictionary page to the generator.
 *
 * The two pages are separate documents (the dictionary opens in its own tab),
 * so the drop-off point is localStorage rather than a direct call. The
 * generator claims the payload exactly once and always asks before writing
 * into the prompt — arriving text that silently rewrites the field the user is
 * composing in would be worse than making them paste it themselves.
 *
 * Stale entries are discarded: a combination queued days ago no longer
 * reflects intent, and applying it on an unrelated visit would be surprising.
 */

const KEY = "scylla:tag-handoff-v1";
const MAX_AGE = 30 * 60 * 1000;

export function queueTags(prompt) {
  const text = String(prompt || "").trim();
  if (!text) return false;
  try {
    localStorage.setItem(KEY, JSON.stringify({ prompt: text, at: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

export function takePendingTags() {
  let raw = null;
  try {
    raw = localStorage.getItem(KEY);
    if (raw) localStorage.removeItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw);
    const prompt = String(payload?.prompt || "").trim();
    const at = Number(payload?.at) || 0;
    if (!prompt || Date.now() - at > MAX_AGE) return null;
    return prompt;
  } catch {
    return null;
  }
}
