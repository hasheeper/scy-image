/**
 * Session history — in memory only.
 *
 * Deliberately not persisted. A single 832x1216 PNG is ~1.6 MB, so
 * sessionStorage (~5 MB, and string-only) would overflow after two images;
 * IndexedDB would survive reloads, which is exactly what we do not want here.
 * Keeping blobs in a plain array means a refresh drops everything, and the
 * object URLs die with the document.
 */

/* History uses downscaled rail thumbnails. The full-image retention limit is a
   user preference: 0 means unlimited, while the UI maps its off state to 1. */
const DEFAULT_MAX_ITEMS = 25;
const THUMB_EDGE = 240;
const LEGACY_DB = "scy-image-studio";

let items = [];
let maxItems = DEFAULT_MAX_ITEMS;

function release(record) {
  if (record.url) URL.revokeObjectURL(record.url);
  if (record.thumbUrl) URL.revokeObjectURL(record.thumbUrl);
}

function trim() {
  if (maxItems === 0) return;
  for (const stale of items.splice(maxItems)) release(stale);
}

/** Downscale to a cheap JPEG for the rail. Falls back to the original. */
export async function makeThumb(blob) {
  try {
    if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas === "undefined") {
      return null;
    }
    const src = await createImageBitmap(blob);
    const scale = Math.min(1, THUMB_EDGE / Math.max(src.width, src.height));
    const w = Math.max(1, Math.round(src.width * scale));
    const h = Math.max(1, Math.round(src.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(src, 0, 0, w, h);
    src.close?.();
    return await canvas.convertToBlob({ type: "image/jpeg", quality: 0.72 });
  } catch {
    return null;
  }
}

export const history = {
  add(entry) {
    const record = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      ...entry
    };
    items.unshift(record);
    trim();
    return record;
  },

  setLimit(value) {
    const n = Math.floor(Number(value));
    maxItems = Number.isFinite(n) ? Math.max(0, n) : DEFAULT_MAX_ITEMS;
    trim();
  },

  all() {
    return items.slice();
  },

  get(id) {
    return items.find((item) => item.id === id) || null;
  },

  remove(id) {
    const index = items.findIndex((item) => item.id === id);
    if (index < 0) return;
    const [gone] = items.splice(index, 1);
    if (gone) release(gone);
  },

  clear() {
    for (const item of items) release(item);
    items = [];
  },

  get size() {
    return items.length;
  },

  /** Remove the IndexedDB store written by earlier builds. */
  purgeLegacy() {
    try {
      indexedDB?.deleteDatabase?.(LEGACY_DB);
    } catch {
      /* nothing to clean up */
    }
  }
};

/* Form settings still persist — they are small and users expect them to
   stick. The API key is never included. */
const PREFS = "scy.prefs.v1";

export const prefs = {
  load() {
    try {
      return JSON.parse(localStorage.getItem(PREFS) || "{}");
    } catch {
      return {};
    }
  },
  save(patch) {
    const next = { ...this.load(), ...patch };
    localStorage.setItem(PREFS, JSON.stringify(next));
    return next;
  }
};
