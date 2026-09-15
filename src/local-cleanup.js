import fs from "node:fs/promises";
import path from "node:path";

const SAFE_SUPABASE_TEMP_FILES = new Set(["cli-latest", "linked-project.json"]);

export async function cleanupLocalSetupFiles({
  manifestFile,
  removeManifest = false,
  cwd = process.cwd(),
  fsImpl = fs,
} = {}) {
  const removed = [];
  const skipped = [];

  if (removeManifest && manifestFile) {
    try {
      await fsImpl.rm(manifestFile, { force: true });
      removed.push(manifestFile);
    } catch (error) {
      skipped.push({ path: manifestFile, reason: error.message });
    }
  }

  const supabaseDir = path.join(cwd, "supabase");
  const tempDir = path.join(supabaseDir, ".temp");
  try {
    const entries = await fsImpl.readdir(tempDir);
    const safeToRemove = entries.every((entry) => SAFE_SUPABASE_TEMP_FILES.has(entry));
    if (safeToRemove) {
      await fsImpl.rm(tempDir, { recursive: true, force: true });
      removed.push(tempDir);
      await removeDirectoryIfEmpty(fsImpl, supabaseDir, removed);
    } else {
      skipped.push({ path: tempDir, reason: "contains files not created by the Supabase CLI link cache" });
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      skipped.push({ path: tempDir, reason: error.message });
    }
  }

  return { removed, skipped };
}

async function removeDirectoryIfEmpty(fsImpl, directory, removed) {
  try {
    const entries = await fsImpl.readdir(directory);
    if (entries.length === 0) {
      await fsImpl.rmdir(directory);
      removed.push(directory);
    }
  } catch {
    // Leaving a non-empty or already removed project directory is fine.
  }
}
