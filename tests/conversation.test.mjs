import { test } from "node:test";
import assert from "node:assert/strict";
import { newConversation, contextSnapshot, beginTurn, beginVersion, completeVersion, selectSource, attachUpload, retainImage, forgetImage, reorderRefs } from "../docs/js/conversation-store.js";
test("three turns, branching and retries preserve exact text/image context", () => {
  const c = newConversation({ model: "gpt-image-2@local", options: {} });
  const run = prompt => {
    c.prompt = prompt;
    const snap = contextSnapshot(c), { turn, version } = beginTurn(c, snap, prompt, c.settings);
    completeVersion(c, turn, version, [{ type: "image", assetId: turn.id }], { cost: 0 }, c.selectionRevision);
    return turn;
  };
  const first = run("猫\n坐在窗前"), second = run("改成蓝色");
  assert.deepEqual(second.snapshot.imageIds, [first.id]);
  assert.match(second.snapshot.text, /猫\n坐在窗前/);
  selectSource(c, first, first.id); c.attachments = ["reference"];
  const third = run("增加参考图里的花瓶");
  assert.deepEqual(third.snapshot.turnIds, [first.id]);
  assert.deepEqual(third.snapshot.imageIds, [first.id, "reference"]);
  assert.ok(!third.snapshot.text.includes("改成蓝色"));
  const version = beginVersion(third); version.status = "error";
  assert.equal(c.turns.length, 3);
  assert.equal(third.versions.length, 2);
  assert.throws(() => completeVersion(c, first, { status: "pending" }, [{ type: "text", text: "No image" }], {}, 0), /没有图片/);
});
test("the user's original keeps riding along after the model answers", () => {
  const c = newConversation({ model: "gpt-image-2@local", options: {} });
  attachUpload(c, "original");
  const run = (prompt, assetId) => {
    c.prompt = prompt;
    const { turn, version } = beginTurn(c, contextSnapshot(c), prompt, c.settings);
    completeVersion(c, turn, version, [{ type: "image", assetId }], { cost: 0 }, c.selectionRevision);
    return turn;
  };
  const first = run("把衬衫改成红色", "result1");
  assert.deepEqual(first.snapshot.imageIds, ["original"]);
  // Sending still empties the composer strip, but the image stays in context.
  assert.deepEqual(c.attachments, []);
  const second = run("背景换成夜景", "result2");
  assert.deepEqual(second.snapshot.imageIds, ["result1", "original"]);
  assert.equal(second.snapshot.base, "result1");
  assert.deepEqual(second.snapshot.refs, ["original"]);
  c.prompt = "再加点雨";
  assert.deepEqual(contextSnapshot(c).imageIds, ["result2", "original"]);
  // Removing it must stick: the next completed turn may not resurrect it.
  forgetImage(c, "original");
  assert.deepEqual(contextSnapshot(c).imageIds, ["result2"]);
  run("第四轮", "result3");
  c.prompt = "第五轮";
  assert.deepEqual(contextSnapshot(c).imageIds, ["result3"]);
});
test("a model's image ceiling trims context instead of failing the send", () => {
  const c = newConversation();
  c.mainId = "base";
  for (const ref of ["ref1", "ref2", "ref3"]) retainImage(c, ref);
  c.prompt = "改色";
  const full = contextSnapshot(c);
  assert.deepEqual(full.imageIds, ["base", "ref1", "ref2", "ref3"]);
  assert.deepEqual(full.dropped, []);
  const single = contextSnapshot(c, c.prompt, 1);
  assert.deepEqual(single.imageIds, ["base"]);
  assert.deepEqual(single.refs, []);
  assert.deepEqual(single.dropped, ["ref1", "ref2", "ref3"]);
  const triple = contextSnapshot(c, c.prompt, 3);
  assert.deepEqual(triple.imageIds, ["base", "ref1", "ref2"]);
  assert.deepEqual(triple.dropped, ["ref3"]);
  // Reordering decides who survives the cut, which is the point of the control.
  reorderRefs(c, ["ref3", "ref1", "ref2"]);
  assert.deepEqual(contextSnapshot(c, c.prompt, 2).imageIds, ["base", "ref3"]);
  // Pinning outranks plain retention regardless of insertion order.
  c.pinnedIds = ["ref2"];
  assert.deepEqual(contextSnapshot(c, c.prompt, 2).imageIds, ["base", "ref2"]);
});
test("completion does not override a source selected during generation", () => {
  const c = newConversation(); c.prompt = "hello"; c.attachments = ["original"];
  const { turn, version } = beginTurn(c, contextSnapshot(c), c.prompt, {});
  assert.deepEqual(c.attachments, []);
  c.selectionRevision++; c.mainId = "manual"; c.attachments.push("new-reference");
  completeVersion(c, turn, version, [{ type: "image", assetId: "result" }], {}, 0);
  assert.equal(c.mainId, "manual");
  assert.deepEqual(c.attachments, ["new-reference"]);
});
test("sending consumes uploads; failure and cancellation do not return them", () => {
  const c = newConversation(); c.prompt = "edit";
  c.attachments = ["uploaded", "pinned"]; c.pinnedIds = ["pinned"];
  const { turn, version } = beginTurn(c, contextSnapshot(c), c.prompt, {});
  assert.deepEqual(turn.snapshot.imageIds, ["pinned", "uploaded"]);
  assert.deepEqual(c.attachments, []);
  version.status = "error";
  assert.equal(completeVersion(c, turn, version, [{ type: "image", assetId: "unused" }], {}, 0), false);
  assert.deepEqual(c.attachments, []);
  const cancelled = beginVersion(turn); cancelled.status = "cancelled";
  assert.deepEqual(contextSnapshot(c).imageIds, ["pinned"]);
  const retry = beginVersion(turn);
  completeVersion(c, turn, retry, [{ type: "image", assetId: "result" }], { cost: 0 }, 0);
  assert.deepEqual(c.attachments, []);
  assert.deepEqual(contextSnapshot(c).imageIds, ["result", "pinned"]);
});
