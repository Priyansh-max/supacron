import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { cleanupLocalSetupFiles, createLocalSetupWorkspace } from "../src/local-cleanup.js";

test("createLocalSetupWorkspace creates an isolated temp directory", async () => {
  const workspace = await createLocalSetupWorkspace();

  try {
    assert.equal(path.dirname(workspace), os.tmpdir());
    assert.match(path.basename(workspace), /^supacron-setup-/);
    assert.equal((await fs.stat(workspace)).isDirectory(), true);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("cleanupLocalSetupFiles removes the complete setup workspace", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "supacron-cleanup-"));
  const nested = path.join(workspace, "supabase", ".temp");
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(nested, "linked-project.json"), "{}\n");

  const result = await cleanupLocalSetupFiles({ workspaceDir: workspace });

  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.removed, [workspace]);
  assert.equal(await exists(workspace), false);
});

async function exists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}