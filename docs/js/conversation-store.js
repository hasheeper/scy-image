const id = () => crypto.randomUUID();
export function newConversation(settings = {}) {
  return { id: id(), title: "新对话", turns: [], headId: null, mainId: null,
    pinnedIds: [], attachments: [], prompt: "", contextTurns: 0, selectionRevision: 0,
    settings: structuredClone(settings) };
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
export function contextSnapshot(conversation, prompt = conversation.prompt) {
  let turns = ancestry(conversation).filter(t => t.versions[t.selectedVersion]?.status === "done");
  if (conversation.contextTurns > 0) turns = turns.slice(-conversation.contextTurns);
  const imageIds = [...new Set([conversation.mainId, ...conversation.pinnedIds, ...conversation.attachments].filter(Boolean))];
  const text = turns.length ? ["此前的绘图要求（按顺序）：", ...turns.map((t, i) => `${i + 1}. ${t.prompt}`),
    "", "本轮要求（以本轮修改为准）：", prompt].join("\n") : prompt;
  return { text, imageIds, turnIds: turns.map(t => t.id), parentId: conversation.headId };
}
export function beginTurn(conversation, snapshot, prompt, settings) {
  const turn = { id: id(), parentId: snapshot.parentId, prompt, settings: structuredClone(settings),
    snapshot: structuredClone(snapshot), selectedVersion: 0, versions: [] };
  conversation.turns.push(turn);
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
