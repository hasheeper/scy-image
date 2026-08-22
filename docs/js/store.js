/**
 * Session history — in memory only.
 *
 * Deliberately not persisted. A single 832x1216 PNG is ~1.6 MB, so
 * sessionStorage (~5 MB, and string-only) would overflow after two images;
 * IndexedDB would survive reloads, which is exactly what we do not want here.
 * Keeping blobs in a plain array means a refresh drops everything, and the
 * object URLs die with the document.
 */

/* Cap chosen for memory, not aesthetics. A decoded 1216x832 bitmap costs
   w*h*4 = 3.9 MB of GPU/renderer memory, so rendering full-size blobs as
   thumbnails at 40 items reached ~218 MB and got the tab killed. History now
   stores a small JPEG thumbnail for the rail and keeps the full blob only for
   the current image + downloads. */
/* One full 24-image batch can also contribute its generated comparison sheet. */
const MAX_ITEMS = 25;
const THUMB_EDGE = 240;
const LEGACY_DB = "scy-image-studio";

let items = [];

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

    // Drop the tail and release every URL it owns.
    for (const stale of items.splice(MAX_ITEMS)) {
      if (stale.url) URL.revokeObjectURL(stale.url);
      if (stale.thumbUrl) URL.revokeObjectURL(stale.thumbUrl);
    }
    return record;
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
    if (gone?.url) URL.revokeObjectURL(gone.url);
    if (gone?.thumbUrl) URL.revokeObjectURL(gone.thumbUrl);
  },

  clear() {
    for (const item of items) {
      if (item.url) URL.revokeObjectURL(item.url);
      if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
    }
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
