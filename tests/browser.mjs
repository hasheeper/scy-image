/** Optional browser integration tests. All API calls use a local mock: no paid images. */
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createAppServer } from "../server.mjs";
import { mockUpstream, listen, png } from "./fixtures.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const screenshots = await mkdtemp(path.join(tmpdir(), "scylla-chat-qa-"));
console.log(`Screenshots: ${screenshots}`);
const mock = mockUpstream(), upstream = await listen(mock.server);
const app = createAppServer({ upstream, readToken: async () => "test-only-token" });
const origin = await listen(app);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1360, height: 950 } });
const page = await context.newPage(), errors = [];
page.on("pageerror", e => errors.push(e.message));
const screenshot = name => page.screenshot({ path: path.join(screenshots, name + ".png"), animations: name.includes("waiting") ? "allow" : "disabled" });
const waitReady = () => page.waitForFunction(() => !document.getElementById("sendButton").disabled);
const waitImages = count => page.waitForFunction(n => document.querySelectorAll(".chat-print").length === n && document.getElementById("stopButton").hidden, count);
async function send(prompt, count) {
  await page.locator("#chatPrompt").fill(prompt); await waitReady();
  await page.locator("#sendButton").click(); await waitImages(count);
}
try {
  await page.goto(origin + "/chat.html");
  await page.waitForFunction(() => document.querySelectorAll("#chatModel option").length === 4);
  assert.equal((await page.locator("#sendButton").innerText()).trim(), "");
  assert.match(await page.locator("#sendButton use").getAttribute("href"), /#i-send$/);
  assert.ok(await page.getByRole("button", { name: "发送绘图请求", exact: true }).count());
  await screenshot("desktop-empty");
  mock.state.delay = 1400;
  await page.locator("#chatPrompt").fill("画一只窗边的猫\n保留柔和光线"); await waitReady();
  await page.locator("#sendButton").click(); await page.locator(".chat-pending").waitFor();
  assert.equal(await page.locator("#sendButton").isVisible(), false);
  assert.equal(await page.getByRole("button", { name: "停止生成", exact: true }).isVisible(), true);
  assert.equal(await page.locator(".chat-pending .bar").evaluate(n => getComputedStyle(n).height), "3px");
  await screenshot("desktop-waiting"); await waitImages(1);
  assert.equal(mock.state.records[0].path, "/v1/studio/image/generate");
  assert.equal(mock.state.records[0].payload.max_cost, 0);
  mock.state.delay = 60;
  await send("改成蓝色", 2);
  assert.equal(mock.state.records[1].path, "/v1/image/tools/run");
  assert.match(mock.state.records[1].payload.prompt, /画一只窗边的猫\n保留柔和光线/);
  assert.ok(mock.state.records[1].payload.init_image.startsWith("data:image/png;base64,"));
  await page.getByRole("button", { name: "继续编辑这张图", exact: true }).first().click();
  await page.locator("#imageUpload").setInputFiles({ name: "参考.png", mimeType: "image/png", buffer: png(64, 80) });
  await page.waitForFunction(() => document.querySelectorAll(".attachment").length === 2);
  assert.equal((await page.locator("#attachmentList").innerText()).trim(), "");
  assert.equal(await page.locator(".attachment-remove").count(), 2);
  await page.locator(".attachment-preview").last().click();
  assert.equal(await page.locator("#imageDialog").isVisible(), true);
  await page.locator("#closeImage").click();
  await screenshot("desktop-attachments");
  await page.locator(".attachment-remove").last().click();
  assert.equal(await page.locator(".attachment").count(), 1);
  assert.equal(await page.locator("#contextImageCount").innerText(), "1");
  await page.locator("#imageUpload").setInputFiles({ name: "参考.png", mimeType: "image/png", buffer: png(64, 80) });
  await page.waitForFunction(() => document.querySelectorAll(".attachment").length === 2);
  await page.locator("#contextButton").click();
  const pin = page.getByRole("button", { name: "固定参考图", exact: true }).last();
  await pin.click(); assert.equal(await pin.getAttribute("aria-pressed"), "true");
  await pin.click(); assert.equal(await pin.getAttribute("aria-pressed"), "false");
  await page.getByRole("button", { name: "关闭上下文", exact: true }).click();
  await send("加入参考图中的花瓶", 3);
  assert.equal(mock.state.records[2].payload.additional_images.length, 1);
  assert.ok(!mock.state.records[2].payload.prompt.includes("改成蓝色"));
  await screenshot("desktop-result");
  await page.getByRole("button", { name: "重新生成此版本", exact: true }).last().click();
  await page.waitForFunction(() => document.querySelectorAll(".version-select option").length === 2 && document.getElementById("stopButton").hidden);
  assert.equal(await page.locator(".chat-turn").count(), 3);
  assert.equal(mock.state.records.length, 4);
  // Decode failure must not enter usable context.
  mock.state.badImage = true;
  await page.locator("#chatPrompt").fill("解码失败测试"); await waitReady(); await page.locator("#sendButton").click();
  await page.locator(".turn-error").waitFor();
  assert.match(await page.locator(".turn-error").innerText(), /图片加载失败/);
  mock.state.badImage = false;
  // Version retry is a single request and doesn't duplicate the user's turn.
  await page.locator(".turn-error button").click(); await waitImages(4);
  assert.equal(await page.locator(".chat-turn").count(), 4);
  // Capability controls, including 2.5-only quality and Lite's 1K restriction.
  await page.locator("#chatModel").selectOption("gpt-image-2.5-sunburst@local");
  await page.locator("#settingsButton").click();
  await page.locator('#settingsFields select[aria-label="质量"]').selectOption("max");
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  await page.locator("#chatModel").selectOption("gpt-image-2@local");
  assert.equal(await page.locator('#settingsFields select[aria-label="质量"]').inputValue(), "auto");
  await page.locator("#chatModel").selectOption("gemini-3.1-flash-lite-image@local");
  assert.equal(await page.locator('#settingsFields select[aria-label="分辨率"] option').count(), 1);
  await page.locator("#chatModel").selectOption("gpt-image-2@local");
  // Free-to-paid changes are stopped before the generating POST.
  await page.locator("#chatPrompt").fill("费用变化测试"); await waitReady();
  const beforePaid = mock.state.records.length; mock.state.cost = 7;
  await page.locator("#sendButton").click();
  await page.waitForFunction(() => [...document.querySelectorAll(".turn-error")].some(n => n.textContent.includes("报价已上涨")));
  assert.equal(mock.state.records.length, beforePaid); mock.state.cost = 0;
  // Shared origin lock: another page owns the generation slot.
  const lockPage = await context.newPage(); await lockPage.goto(origin + "/chat.html");
  await lockPage.evaluate(() => {
    window.lockHeld = false;
    navigator.locks.request("scylla-image-generation-v1", async () => { window.lockHeld = true; await new Promise(resolve => { window.releaseLock = resolve; }); });
  });
  await lockPage.waitForFunction(() => window.lockHeld);
  await page.locator("#chatPrompt").fill("并发锁测试"); await waitReady(); await page.locator("#sendButton").click();
  await page.waitForFunction(() => document.getElementById("chatToast").textContent.includes("另一个页面"));
  assert.equal(mock.state.records.length, beforePaid);
  await lockPage.evaluate(() => window.releaseLock()); await lockPage.close();
  // Responsive layout, waiting indicator and bottom composer.
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await page.waitForFunction(() => document.getElementById("chatApp").getBoundingClientRect().height <= innerHeight + 1);
    await page.locator("#chatSidebar").waitFor({ state: "hidden" });
    const metrics = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
      bottom: document.getElementById("chatForm").getBoundingClientRect().bottom,
      imageArea: document.getElementById("chatScroll").clientHeight }));
    assert.ok(metrics.scroll <= width, JSON.stringify(metrics));
    assert.ok(metrics.bottom <= 845 && metrics.imageArea > 200, JSON.stringify(metrics));
    await page.locator("#latestButton").evaluate(n => n.click());
    await screenshot(`mobile-${width}`);
    await page.locator("#menuButton").click();
    assert.equal(await page.locator(".chat-workspace").evaluate(n => n.inert), true);
    await page.locator("#closeSidebar").click();
    await page.locator("#chatSidebar").waitFor({ state: "hidden" });
  }
  await page.setViewportSize({ width: 390, height: 430 });
  await page.locator("#chatPrompt").focus();
  assert.ok((await page.locator("#chatForm").boundingBox()).y >= 0);
  await screenshot("mobile-keyboard-sized-viewport");
  await page.setViewportSize({ width: 390, height: 844 });
  mock.state.delay = 1400;
  await page.locator("#chatPrompt").fill("取消测试"); await waitReady(); await page.locator("#sendButton").click();
  await page.locator(".chat-pending").waitFor(); await screenshot("mobile-waiting");
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await page.locator(".chat-pending .sheen").evaluate(n => getComputedStyle(n, "::before").animationName), "none");
  await page.locator("#stopButton").click();
  await page.waitForFunction(() => document.getElementById("stopButton").hidden);
  assert.equal(await page.locator(".chat-pending").count(), 0);
  // Existing NAI page remains functional with shared assets and the new routes.
  const nai = await context.newPage(); nai.on("pageerror", e => errors.push(e.message));
  await nai.goto(origin + "/"); await nai.waitForFunction(() => document.getElementById("ptLeft").textContent === "248");
  await nai.screenshot({ path: path.join(screenshots, "nai-current.png") });
  await nai.locator("#model").selectOption("nai-diffusion-4-5-full@local");
  await nai.waitForFunction(() => document.getElementById("ptLeft").textContent === "1999");
  const repriced = nai.waitForResponse(r => r.url().endsWith("/studio/image/estimate") && r.request().postDataJSON()?.width === 1024);
  await nai.locator('#ratios button[data-w="1024"][data-h="1024"]').click();
  assert.equal((await repriced).status(), 200);
  await nai.locator("#advanced > summary").click();
  await nai.locator("label").filter({ has: nai.locator("#serverCache") }).click();
  assert.equal(await nai.locator("#serverCache").isChecked(), true);
  const naiCount = mock.state.records.length; mock.state.delay = 40;
  await nai.locator("#goBtn").click();
  await nai.waitForFunction(() => document.body.dataset.state === "done" && !document.getElementById("goBtn").disabled);
  assert.equal(mock.state.records.length, naiCount + 1);
  const naiRequest = mock.state.records.at(-1);
  assert.equal(naiRequest.path, "/v1/studio/image/generate");
  assert.equal(naiRequest.payload.cache, true);
  assert.equal(naiRequest.payload.image_options, undefined);
  assert.equal(naiRequest.payload.max_cost, 0);
  // A history entry with the legacy model ID must still be reusable.
  await nai.evaluate(async () => {
    const { history } = await import("./js/store.js");
    history.all()[0].params.model = "nai-diffusion-4-5-full";
  });
  await nai.locator("#model").selectOption("nai-diffusion-5-full@local");
  await nai.locator("#reuseBtn").click();
  assert.equal(await nai.locator("#model").inputValue(), "nai-diffusion-4-5-full@local");
  await nai.waitForFunction(() => document.getElementById("ptLeft").textContent === "1999");
  const before = await context.newPage();
  await before.route("**/styles.css", route => route.fulfill({ contentType: "text/css", body: execFileSync("git", ["show", "HEAD:docs/styles.css"], { encoding: "utf8" }) }));
  await before.goto(origin + "/"); await before.waitForFunction(() => document.body.dataset.state === "empty");
  await before.screenshot({ path: path.join(screenshots, "nai-style-baseline.png") });
  // Direct static subpath mode: only intercepted requests, no real upstream I/O.
  const direct = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const dp = await direct.newPage(); dp.on("pageerror", e => errors.push(e.message));
  await dp.addInitScript(() => sessionStorage.setItem("scy.session.token", "test-direct-token"));
  await dp.route(origin + "/repo/**", async route => {
    const relative = new URL(route.request().url()).pathname.slice("/repo/".length);
    try {
      const type = relative.endsWith(".js") ? "text/javascript" : relative.endsWith(".css") ? "text/css" : relative.endsWith(".html") ? "text/html" : relative.endsWith(".svg") ? "image/svg+xml" : "application/octet-stream";
      await route.fulfill({ body: await readFile(path.resolve("docs", relative)), contentType: type });
    } catch { await route.fulfill({ status: 404, body: "not found" }); }
  });
  await dp.route("https://proxy.scylla.love/**", async route => {
    const request = route.request(), url = new URL(request.url());
    assert.equal(request.headers().authorization, "Bearer test-direct-token");
    const response = await fetch(upstream + url.pathname, { method: request.method(), body: request.postData() });
    await route.fulfill({ status: response.status, body: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get("content-type") });
  });
  mock.state.delay = 40; mock.state.jsonImage = true;
  await dp.goto(origin + "/repo/chat.html");
  await dp.locator("#chatPrompt").fill("静态子路径直连测试");
  await dp.waitForFunction(() => !document.getElementById("sendButton").disabled);
  await dp.locator("#sendButton").click();
  await dp.locator(".chat-print").waitFor();
  assert.deepEqual(errors, []);
  console.log(`Browser checks passed. Screenshots: ${screenshots}`);
} finally {
  await browser.close();
  await Promise.all([new Promise(r => app.close(r)), new Promise(r => mock.server.close(r))]);
}
