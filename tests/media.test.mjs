import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCatalog, normalizeOptions, resolveModel, buildChatPayload, validatePayload, quotaBadge } from "../docs/js/model-catalog.js";
import { rawCatalog, png, mockUpstream, listen } from "./fixtures.mjs";
import { createAppServer } from "../server.mjs";
const catalog = normalizeCatalog(rawCatalog);
const gpt = catalog.models.find(m => m.id === "gpt-image-2@local");
const gemini = catalog.models.find(m => m.id === "gemini-3.1-flash-image@local");
const image = `data:image/png;base64,${png(2, 2).toString("base64")}`;
test("catalog migration, quality and resolution capability intersection", () => {
  assert.equal(resolveModel(catalog.models, "nai-diffusion-5-full").id, "nai-diffusion-5-full@local");
  assert.equal(normalizeOptions(gpt, { quality: "max" }).quality, "auto");
  assert.equal(normalizeOptions(catalog.models.find(m => m.name.includes("Sunburst")), { quality: "max" }).quality, "max");
  assert.deepEqual(catalog.models.find(m => m.name.includes("Lite")).fields.image_size.options, ["1K"]);
});
test("the quota gauge is named after the pool it measures", () => {
  const nai = catalog.models.find(m => m.id === "nai-diffusion-5-full@local");
  assert.equal(quotaBadge(gpt).label, "OpenAI");
  assert.equal(quotaBadge(gpt).icon, "openai");
  assert.equal(quotaBadge(gemini).label, "Gemini");
  assert.equal(quotaBadge(nai).label, "NovelAI");
  // Credits are one cross-provider currency, so paid work drops the brand mark.
  assert.equal(quotaBadge(gpt, true).label, "积分");
  assert.equal(quotaBadge(gpt, true).icon, "points");
  assert.equal(quotaBadge(null).label, "额度");
});
test("wire payloads keep NAI and GPT/Gemini parameters separate", () => {
  const payload = buildChatPayload(gpt, "edit", { quality: "high", steps: 20 }, [image]);
  assert.equal(payload.tool, "image-edit"); assert.equal(payload.steps, undefined); assert.equal(payload.image_options.steps, undefined);
  assert.deepEqual(validatePayload(payload, catalog, { edit: true }).image_options, payload.image_options);
  const banana = buildChatPayload(gemini, "edit", { image_size: "2K" }, [image]);
  assert.equal(banana.image_options.output_size, "2k"); assert.equal(banana.image_options.image_size, undefined);
  assert.deepEqual(validatePayload(banana, catalog, { edit: true }).image_options, banana.image_options);
  assert.throws(() => validatePayload({ ...payload, max_cost: -1 }, catalog, { edit: true, execution: true }), /费用上限/);
  assert.throws(() => validatePayload({ ...payload, init_image: "https://private.example/image.png" }, catalog, { edit: true }), /图片数据/);
  assert.throws(() => validatePayload({ ...payload, image_options: { quality: "invalid" } }, catalog, { edit: true }), /不受模型支持/);
  const nai = { model: "nai-diffusion-5-full@local", prompt: "", width: 832, height: 1216,
    steps: 28, scale: 5, cfg: 1, seed: 1, sampler: "k_euler_ancestral", cache: true };
  assert.equal(validatePayload(nai, catalog).cache, true);
  assert.equal(validatePayload({ ...nai, cache: false }, catalog).cache, false);
  assert.equal(validatePayload({ ...payload, cache: true }, catalog, { edit: true }).cache, false);
});
test("proxy routes, quota, max_cost, cross-origin writes and shared execution lock", async () => {
  const mock = mockUpstream(), upstream = await listen(mock.server);
  const app = createAppServer({ upstream, readToken: async () => "test-token" }); const origin = await listen(app);
  const post = (path, payload, extra = {}) => fetch(origin + path, { method: "POST", headers: { "Content-Type": "application/json", ...extra }, body: JSON.stringify(payload) });
  try {
    const quota = await (await fetch(origin + "/api/quota")).json();
    assert.equal(quota.media.images["novelai-v5"].remaining, 248);
    assert.equal(quota.stats.temp_limits.rpd_remaining_units, 4610);
    const payload = { ...buildChatPayload(gpt, "hello", {}), max_cost: 0 };
    assert.equal((await post("/api/studio/image/generate", { ...payload, max_cost: undefined })).status, 400);
    assert.equal((await post("/api/studio/image/generate", payload, { Origin: "https://evil.invalid" })).status, 403);
    assert.equal((await post("/api/anything", payload)).status, 404);
    mock.state.delay = 250;
    const first = post("/api/studio/image/generate", payload);
    while (!mock.state.records.length) await new Promise(resolve => setTimeout(resolve, 5));
    const second = await post("/api/image/tools/run", { ...buildChatPayload(gpt, "edit", {}, [image]), max_cost: 0 });
    assert.equal(second.status, 429);
    assert.equal((await first).status, 200);
    assert.equal(mock.state.records.length, 1);
    assert.equal(mock.state.records[0].payload.max_cost, 0);
    assert.equal(mock.state.records[0].payload.transform_prompt, false);
  } finally { await Promise.all([new Promise(r => app.close(r)), new Promise(r => mock.server.close(r))]); }
});
