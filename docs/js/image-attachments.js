import { MAX_INPUT_BYTES, MAX_TOTAL_BYTES } from "./model-catalog.js";
import { decodeImage } from "./media-api.js";
export class AssetStore {
  constructor() { this.assets = new Map(); }
  get(id) { const asset = this.assets.get(id); if (!asset) throw new Error("引用的图片已失效"); return asset; }
  async add(blob, name = "图片", size, origin = size ? "result" : "upload") {
    if (!["image/png", "image/jpeg", "image/webp"].includes(blob.type)) throw new Error("仅支持 PNG、JPEG、WebP");
    if (!blob.size || blob.size > (size ? MAX_TOTAL_BYTES : MAX_INPUT_BYTES)) throw new Error(size ? "结果图片超过 32MB" : "单张图片需在 8MB 以内");
    const dimensions = size || await decodeImage(blob);
    if (dimensions.width * dimensions.height > 40_000_000) throw new Error("图片像素过大（最多 4000 万像素）");
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    const id = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, "0")).join("");
    // Provenance travels with the asset: the panel has to label an image
    // honestly, and position in an array is not evidence of where it came from.
    if (!this.assets.has(id)) this.assets.set(id, { id, blob, url: URL.createObjectURL(blob), name, origin, ...dimensions });
    return this.get(id);
  }
  async encode(ids) {
    const assets = ids.map(id => this.get(id));
    if (assets.some(a => a.blob.size > MAX_INPUT_BYTES)) throw new Error("参考图超过 8MB，请缩小后重新上传");
    if (assets.reduce((n, a) => n + a.blob.size, 0) > MAX_TOTAL_BYTES) throw new Error("本轮图片总大小不得超过 32MB");
    return Promise.all(assets.map(a => new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("读取图片失败")); reader.readAsDataURL(a.blob);
    })));
  }
  collect(conversations) {
    const used = new Set();
    for (const c of conversations) {
      [c.mainId, ...c.pinnedIds, ...c.attachments, ...(c.keepIds || [])].filter(Boolean).forEach(id => used.add(id));
      for (const t of c.turns) {
        t.snapshot.imageIds.forEach(id => used.add(id));
        t.versions.flatMap(v => v.blocks).filter(b => b.type === "image").forEach(b => used.add(b.assetId));
      }
    }
    for (const [id, a] of this.assets) if (!used.has(id)) { URL.revokeObjectURL(a.url); this.assets.delete(id); }
  }
  clear() { for (const a of this.assets.values()) URL.revokeObjectURL(a.url); this.assets.clear(); }
}
