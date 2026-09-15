import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { cleanupLocalSetupFiles } from "../src/local-cleanup.js";

test("cleanup removes manifest and safe Supabase link cache", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "supacron-cleanup-"));
  const manifestFile = path.join(root, "manifest.json");
  const tempDir = path.join(root, "supabase", ".temp");
  await fs.mkdir(tempDir, { recursive: true });
  await fs.writeFile(manifestFile, "{}\n");
  await fs.writeFile(path.join(tempDir, "cli-latest"), "2.117.0\n");
  await fs.writeFile(path.join(tempDir, "linked-project.json"), "{}\n");

  try {
    const result = await cleanupLocalSetupFiles({
      manifestFile,
      removeManifest: true,
      cwd: root,
    });

    assert.equal(result.skipped.length, 0);
    assert.equal(await exists(manifestFile), false);
    assert.equal(await exists(tempDir), false);
    assert.equal(await exists(path.join(root, "supabase")), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("cleanup keeps Supabase temp cache when unexpected files exist", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "supacron-cleanup-"));
  const tempDir = path.join(root, "supabase", ".temp");
  await fs.mkdir(tempDir, { recursive: true });
  await fs.writeFile(path.join(tempDir, "linked-project.json"), "{}\n");
  await fs.writeFile(path.join(tempDir, "custom.txt"), "keep\n");

  try {
    const result = await cleanupLocalSetupFiles({ cwd: root });

    assert.deepEqual(result.removed, []);
    assert.equal(result.skipped.length, 1);
    assert.equal(await exists(path.join(tempDir, "custom.txt")), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
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
