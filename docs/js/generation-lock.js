const NAME = "scylla-image-generation-v1";
let active = false;
export async function withGenerationLock(task) {
  if (active) return false;
  active = true;
  try {
    if (!navigator.locks?.request) throw new Error("浏览器不支持安全生成锁，请使用新版浏览器和 HTTPS");
    let acquired = false;
    await navigator.locks.request(NAME, { mode: "exclusive", ifAvailable: true }, async lock => {
      if (!lock) return;
      acquired = true;
      await task();
    });
    return acquired;
  } finally { active = false; }
}
