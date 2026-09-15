/** Pure catalog/parameter rules, shared by the browser and local proxy. */
export const DEFAULT_MODEL = "nai-diffusion-5-full@local";
export const FALLBACK_MAX_PIXELS = 1_048_576;
export const MAX_INPUT_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 46 * 1024 * 1024;
const FIELD_NAMES = ["quality", "size", "aspect_ratio", "image_size", "output_format"];

export function normalizeCatalog(raw) {
  const models = Object.entries(raw?.models || {}).map(([id, meta]) => {
    const fields = {};
    for (const key of FIELD_NAMES) {
      const field = meta.image_capabilities?.fields?.[key];
      if (!Array.isArray(field?.options) || !field.options.length) continue;
      const options = field.options.filter(v => typeof v === "string");
      if (options.length) fields[key] = { ...field, options, default: options.includes(field.default) ? field.default : options[0] };
    }
    // The gateway currently overstates Lite's output resolution.
    if (id.startsWith("gemini-3.1-flash-lite-image") && fields.image_size) {
      fields.image_size = { ...fields.image_size, options: ["1K"], default: "1K" };
    }
    const provider = meta.provider_id || meta.provider;
    if (meta.editor_family === "gpt" && /^gpt-image-2(?:[.@-])/.test(id) && fields.quality) {
      const supported = ["auto", "low", "medium", "high", ...(id.startsWith("gpt-image-2.5-") ? ["xhigh", "max"] : [])];
      fields.quality.options = fields.quality.options.filter(value => supported.includes(value));
      if (!fields.quality.options.includes(fields.quality.default)) fields.quality.default = fields.quality.options[0];
      if (!fields.quality.options.length) delete fields.quality;
    }
    const maxImages = provider === "gemini"
      ? (id.includes("lite-image") ? 1 : id.includes("2.5-flash") ? 3 : 14) : 16;
    return { id, name: meta.name || id, description: meta.description || "", provider,
      family: meta.editor_family, quotaGroup: meta.quota_group,
      maxPixels: Number(meta.max_resolution) || FALLBACK_MAX_PIXELS,
      operations: meta.operations || [], fields, replaces: meta.replaces || [],
      maxImages: Math.min(maxImages, Number(raw.studio_features?.max_context_images) || 15),
      unmetered: meta.unmetered === true };
  });
  return { models, features: raw?.studio_features || {}, defaults: raw?.defaults || {},
    samplers: raw?.valid_samplers?.length ? raw.valid_samplers : ["k_euler_ancestral"] };
}

/* A quota gauge measures one specific pool, so it should be named after that
   pool rather than after "free vs paid". Free images are billed per provider
   (quota_group), while media credits are one cross-provider currency — hence
   the neutral star for credits and a brand mark for each provider. */
const PROVIDER_BADGES = {
  openai: { label: "OpenAI", icon: "openai", pool: "OpenAI 本周免费图片" },
  gemini: { label: "Gemini", icon: "points", pool: "Gemini 本周免费图片" },
  novelai: { label: "NovelAI", icon: "points", pool: "NovelAI 本周免费图片" }
};
export const CREDIT_BADGE = { label: "积分", icon: "points", pool: "媒体积分" };
export function quotaBadge(model, paid = false) {
  if (paid) return CREDIT_BADGE;
  return PROVIDER_BADGES[model?.provider] || { label: "额度", icon: "points", pool: "额度" };
}

export function resolveModel(models, wanted) {
  const exact = models.find(m => m.id === wanted);
  if (exact) return exact;
  const matches = models.filter(m => m.id.replace(/@local$/, "") === wanted || m.replaces.includes(wanted));
  return matches.length === 1 ? matches[0] : null;
}

export function chatModels(catalog) {
  return catalog.models.filter(m => (m.family === "gpt" && /^gpt-image-2(?:[.@-])/.test(m.id)
    || m.provider === "gemini" && m.family === "gemini")
    && m.operations.includes("generate") && m.operations.includes("edit"));
}

export function normalizeOptions(model, values = {}) {
  return Object.fromEntries(Object.entries(model.fields).map(([key, field]) =>
    [key, field.options.includes(values[key]) ? values[key] : field.default]));
}

export function buildChatPayload(model, prompt, options, images = []) {
  if (!prompt.trim()) throw new Error("请填写描述或修改要求");
  if (prompt.length > 24_000) throw new Error("上下文过长，请减少带入轮次或新建对话");
  const operation = images.length ? "edit" : "generate";
  if (!model.operations.includes(operation)) throw new Error("模型不支持本次操作");
  if (images.length > model.maxImages) throw new Error(`本模型最多带入 ${model.maxImages} 张图片（包含主图）`);
  const image_options = normalizeOptions(model, options);
  if (operation === "edit" && model.family === "gemini") {
    // Studio's edit endpoint uses output_size instead of generation's image_size.
    image_options.output_size = image_options.image_size?.toLowerCase() || "original";
    delete image_options.image_size;
  }
  const payload = { model: model.id, prompt, image_options, cache: false,
    transform_prompt: false, transform_mode: "off" };
  if (images.length) Object.assign(payload, { tool: "image-edit", init_image: images[0], additional_images: images.slice(1) });
  return payload;
}

export function validatePayload(input, catalog, { edit = false, execution = false } = {}) {
  const model = catalog.models.find(m => m.id === input.model);
  if (!model) throw new Error("请选择目录中的有效模型");
  if (!model.operations.includes(edit ? "edit" : "generate")) throw new Error("模型不支持本次操作");
  if (typeof input.prompt !== "string" || input.prompt.length > 24_000) throw new Error("描述长度无效");
  const out = { model: model.id, prompt: input.prompt, cache: false, transform_prompt: false, transform_mode: "off" };
  if (execution) {
    if (typeof input.max_cost !== "number" || !Number.isFinite(input.max_cost) || input.max_cost < 0) throw new Error("缺少有效的费用上限，请先获取报价");
    out.max_cost = input.max_cost;
  }
  if (model.provider === "novelai") {
    const w = Number(input.width), h = Number(input.height);
    if (![w, h].every(n => Number.isInteger(n) && n >= 64 && n <= 2048 && n % 64 === 0)
      || w * h > model.maxPixels) throw new Error("分辨率超出模型范围");
    Object.assign(out, { width: w, height: h, cache: input.cache === true });
    for (const [key, min, max] of [["steps",1,50],["scale",0,20],["cfg",0,30],["seed",-1,4294967295]]) {
      const n = Number(input[key]);
      if (!Number.isFinite(n) || n < min || n > max) throw new Error(`参数 ${key} 超出范围`);
      out[key] = n;
    }
    if (!catalog.samplers.includes(input.sampler)) throw new Error("采样器无效");
    Object.assign(out, { sampler: input.sampler, negative_prompt: String(input.negative_prompt || ""), optimize: input.optimize === true });
  } else {
    if (!chatModels(catalog).some(m => m.id === model.id)) throw new Error("该模型尚未适配");
    const opts = input.image_options || {};
    const valid = normalizeOptions(model, opts);
    for (const [key, value] of Object.entries(opts)) {
      if (edit && model.family === "gemini" && key === "output_size") {
        const allowed = ["original", ...(model.fields.image_size?.options || []).map(v => v.toLowerCase())];
        if (!allowed.includes(value)) throw new Error("编辑分辨率无效");
        continue;
      }
      if (!model.fields[key]?.options.includes(value)) throw new Error(`参数 ${key} 不受模型支持`);
    }
    out.image_options = valid;
    if (edit && model.family === "gemini") {
      out.image_options.output_size = opts.output_size || "original";
      delete out.image_options.image_size;
    }
  }
  if (edit) {
    if (input.tool !== "image-edit") throw new Error("仅支持 image-edit");
    if (input.additional_images !== undefined && !Array.isArray(input.additional_images)) throw new Error("参考图格式无效");
    const images = [input.init_image, ...(input.additional_images || [])];
    if (images.length > model.maxImages) throw new Error("参考图超出模型上限");
    let bytes = 0;
    for (const image of images) {
      if (typeof image !== "string" || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image)) throw new Error("仅接受 PNG、JPEG、WebP 图片数据");
      const size = (image.length - image.indexOf(",") - 1) * 0.75;
      if (size > MAX_INPUT_BYTES) throw new Error("单张参考图不超过 8MB");
      bytes += size;
    }
    if (bytes > MAX_TOTAL_BYTES) throw new Error("本轮图片总大小不得超过 32MB");
    Object.assign(out, { tool: "image-edit", init_image: images[0], additional_images: images.slice(1) });
  }
  return out;
}
