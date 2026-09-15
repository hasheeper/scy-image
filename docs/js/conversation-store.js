const id = () => crypto.randomUUID();
export function newConversation(settings = {}) {
  return { id: id(), title: "新对话", turns: [], headId: null, mainId: null,
    pinnedIds: [], attachments: [], keepIds: [], prompt: "", contextTurns: 0, selectionRevision: 0,
    settings: structuredClone(settings) };
}
/* keepIds is the set the user wants to keep travelling with the conversation,
   whatever its provenance — an upload, or a result they promoted and then
   replaced. Membership is a decision, not a fact about the image, so it lives
   here while `origin` (upload vs result) stays on the asset itself. */
export function retainImage(conversation, assetId) {
  if (!assetId) return;
  if (!conversation.keepIds.includes(assetId)) conversation.keepIds.push(assetId);
}
export function attachUpload(conversation, assetId) {
  retainImage(conversation, assetId);
  if (!conversation.attachments.includes(assetId)) conversation.attachments.push(assetId);
}
export function forgetImage(conversation, assetId) {
  if (conversation.mainId === assetId) conversation.mainId = null;
  conversation.pinnedIds = conversation.pinnedIds.filter(x => x !== assetId);
  conversation.attachments = conversation.attachments.filter(x => x !== assetId);
  // Dropping it from keepIds is what makes a removal stick: otherwise the next
  // completed turn would helpfully "restore" the image the user just cut.
  conversation.keepIds = conversation.keepIds.filter(x => x !== assetId);
}
export function reorderRefs(conversation, order) {
  const known = new Set(order);
  conversation.keepIds = [...order, ...conversation.keepIds.filter(x => !known.has(x))];
  conversation.selectionRevision += 1;
}
export function ancestry(conversation, headId = conversation.headId) {
  const byId = new Map(conversation.turns.map(t => [t.id, t]));
  const chain = [], seen = new Set();
  while (headId) {
    if (seen.has(headId)) throw new Error("会话分支无效");
    seen.add(headId);
    const turn = byId.get(headId);
    if (!turn) break;
    chain.unshift(turn); headId = turn.parentId;
  }
  return chain;
}
/* Slot 0 is not just "the first image": the request sends it as init_image, the
   picture being edited, while the rest ride along as additional_images. Keeping
   base and refs separate lets the UI say which is which instead of implying it
   through array order. `limit` mirrors the model's ceiling so the panel can show
   what would be dropped rather than failing at send time. */
export function contextSnapshot(conversation, prompt = conversation.prompt, limit = Infinity) {
  let turns = ancestry(conversation).filter(t => t.versions[t.selectedVersion]?.status === "done");
  if (conversation.contextTurns > 0) turns = turns.slice(-conversation.contextTurns);
  const base = conversation.mainId || null;
  // The user's own uploads stay in context across turns: a result image should
  // not silently evict the original everything is being edited from.
  const refs = [...new Set([...conversation.pinnedIds, ...conversation.keepIds,
    ...conversation.attachments].filter(assetId => assetId && assetId !== base))];
  const wanted = [...(base ? [base] : []), ...refs];
  const imageIds = wanted.slice(0, Math.max(0, limit));
  const dropped = wanted.slice(imageIds.length);
  const text = turns.length ? ["此前的绘图要求（按顺序）：", ...turns.map((t, i) => `${i + 1}. ${t.prompt}`),
    "", "本轮要求（以本轮修改为准）：", prompt].join("\n") : prompt;
  return { text, imageIds, base: imageIds[0] ?? null, refs: imageIds.slice(1), dropped,
    turnIds: turns.map(t => t.id), parentId: conversation.headId };
}
export function beginTurn(conversation, snapshot, prompt, settings) {
  const turn = { id: id(), parentId: snapshot.parentId, prompt, settings: structuredClone(settings),
    snapshot: structuredClone(snapshot), selectedVersion: 0, versions: [] };
  conversation.turns.push(turn);
  // Sending spends the uploads: from here on the turn's reference strip owns
  // them, so failure or cancellation must not put them back in the composer.
  const sent = new Set(snapshot.imageIds);
  conversation.attachments = conversation.attachments.filter(assetId => !sent.has(assetId));
  if (conversation.turns.length === 1) conversation.title = prompt.replace(/\s+/g, " ").slice(0, 36);
  return { turn, version: beginVersion(turn) };
}
export function beginVersion(turn) {
  if (turn.versions.some(v => v.status === "pending")) throw new Error("该轮仍在生成");
  const version = { id: id(), status: "pending", blocks: [], error: "", quote: null };
  turn.versions.push(version); turn.selectedVersion = turn.versions.length - 1;
  return version;
}
export function completeVersion(conversation, turn, version, blocks, quote, selectionRevision) {
  if (version.status !== "pending") return false;
  if (!blocks.some(b => b.type === "image")) throw new Error("结果没有图片");
  Object.assign(version, { status: "done", blocks, quote });
  if (conversation.selectionRevision === selectionRevision) {
    conversation.headId = turn.id;
    conversation.mainId = blocks.find(b => b.type === "image").assetId;
  }
  return true;
}
export function selectSource(conversation, turn, assetId) {
  conversation.headId = turn.id; conversation.mainId = assetId;
  conversation.selectionRevision += 1;
}
