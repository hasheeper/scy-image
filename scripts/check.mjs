import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
const scripts = readdirSync("docs/js").filter(f => f.endsWith(".js")).map(f => `docs/js/${f}`);
for (const file of ["server.mjs", ...scripts]) {
  if (spawnSync(process.execPath, ["--check", file], { stdio: "inherit" }).status !== 0) process.exit(1);
}
const tests = readdirSync("tests").filter(f => f.endsWith(".test.mjs")).map(f => `tests/${f}`);
process.exit(spawnSync(process.execPath, ["--test", ...tests], { stdio: "inherit" }).status ?? 1);
