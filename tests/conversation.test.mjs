import { test } from "node:test";
import assert from "node:assert/strict";
import { newConversation, contextSnapshot, beginTurn, beginVersion, completeVersion, selectSource } from "../docs/js/conversation-store.js";
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
test("completion does not override a source selected during generation", () => {
  const c = newConversation(); c.prompt = "hello";
  const { turn, version } = beginTurn(c, contextSnapshot(c), c.prompt, {});
  c.selectionRevision++; c.mainId = "manual";
  completeVersion(c, turn, version, [{ type: "image", assetId: "result" }], {}, 0);
  assert.equal(c.mainId, "manual");
});
