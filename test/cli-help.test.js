import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("CLI help lists every public command", () => {
  const result = spawnSync(process.execPath, [CLI, "help"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /npx supacron init/);
  assert.match(result.stdout, /npx supacron test/);
  assert.match(result.stdout, /npx supacron status/);
  assert.match(result.stdout, /npx supacron repair/);
  assert.match(result.stdout, /npx supacron uninstall/);
  assert.match(result.stdout, /npx supacron logout/);
  assert.match(result.stdout, /npx supacron help/);
  assert.match(result.stdout, /logout\s+Sign out of both official CLI sessions/);
});