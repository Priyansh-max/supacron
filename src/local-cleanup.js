import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function createLocalSetupWorkspace({ fsImpl = fs, osImpl = os, pathImpl = path } = {}) {
  const workspace = await fsImpl.mkdtemp(pathImpl.join(osImpl.tmpdir(), "supacron-setup-"));
  try {
    await fsImpl.chmod(workspace, 0o700);
  } catch {
    // Best effort on platforms/filesystems that ignore chmod.
  }
  return workspace;
}

export async function cleanupLocalSetupFiles({ workspaceDir, fsImpl = fs } = {}) {
  const removed = [];
  const skipped = [];

  if (!workspaceDir) {
    return { removed, skipped };
  }

  try {
    await fsImpl.rm(workspaceDir, { recursive: true, force: true });
    removed.push(workspaceDir);
  } catch (error) {
    skipped.push({ path: workspaceDir, reason: error.message });
  }

  return { removed, skipped };
}