import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  createManifest,
  defaultManifestDir,
  deleteManifest,
  manifestPath,
  readManifest,
  validateManifest,
  writeManifest,
} from "../src/lib/manifest.js";

const PROJECT_REF = "abcdefghijklmnopqrst";
const NOW = "2026-09-14T15:00:00.000Z";

test("defaultManifestDir uses OS-specific config locations", () => {
  assert.equal(
    defaultManifestDir({
      platform: "win32",
      homeDir: "C:\\Users\\buddy",
      env: { LOCALAPPDATA: "C:\\Users\\buddy\\AppData\\Local" },
    }),
    "C:\\Users\\buddy\\AppData\\Local\\supacron",
  );

  assert.equal(
    defaultManifestDir({
      platform: "linux",
      homeDir: "/home/buddy",
      env: { XDG_CONFIG_HOME: "/tmp/config" },
    }),
    path.join("/tmp/config", "supacron"),
  );
});

test("createManifest returns strict non-secret installation state", () => {
  const manifest = createManifest({
    now: NOW,
    projectRef: PROJECT_REF,
    projectName: "Prod",
    region: "ap-south-1",
    organizationId: "org_123",
    supabaseDashboardUrl: "https://supabase.com/dashboard/project/abcdefghijklmnopqrst",
    supabaseProjectUrl: "https://abcdefghijklmnopqrst.supabase.co",
    setupMode: "manual",
    cloudflareAccountId: "cf-account-id",
    cloudflareAccountName: "Personal",
    workerName: "supacron-abcdefghijklmnopqrst",
    workerUrl: "https://supacron.example.workers.dev",
    schedule: "0 0,12 * * *",
    cloudflareDashboardUrl: "https://dash.cloudflare.com/cf-account-id/workers/services/view/supacron",
    deployedAt: NOW,
    databaseVerifiedAt: NOW,
    verificationStatus: "verified",
    lastCheckedAt: NOW,
    lastHeartbeatAt: NOW,
  });

  assert.deepEqual(manifest.security, {
    localSecretStorage: false,
    workerSecretBindings: [
      "SUPABASE_URL",
      "SUPABASE_PUBLISHABLE_KEY",
      "SUPACRON_HEARTBEAT_SECRET",
    ],
  });
  assert.equal(manifest.supabase.projectRef, PROJECT_REF);
  assert.equal(manifest.database.rpc, "public.supacron_ping");
  assert.equal(manifest.cloudflare.schedule, "0 0,12 * * *");
});

test("validateManifest rejects secret-shaped field names and values", () => {
  const manifest = createManifest({
    now: NOW,
    projectRef: PROJECT_REF,
    setupMode: "automatic",
    cloudflareAccountId: "cf-account-id",
    workerName: "supacron-abcdefghijklmnopqrst",
    schedule: "0 0,12 * * *",
  });

  assert.throws(
    () => validateManifest({ ...manifest, supabase: { ...manifest.supabase, serviceRoleKey: "nope" } }),
    /sensitive field/,
  );
  assert.throws(
    () =>
      validateManifest({
        ...manifest,
        cloudflare: { ...manifest.cloudflare, workerUrl: "sb_publishable_bad" },
      }),
    /sensitive value/,
  );
});

test("manifestPath validates project refs before creating filenames", () => {
  assert.equal(
    manifestPath(PROJECT_REF, { rootDir: path.join("tmp", "supacron") }),
    path.join("tmp", "supacron", "installations", `${PROJECT_REF}.json`),
  );
  assert.throws(() => manifestPath("../escape", { rootDir: "tmp" }), /project ref/);
});

test("writeManifest atomically persists chmod-restricted JSON and read/delete roundtrips", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "supacron-manifest-"));
  const manifest = createManifest({
    now: NOW,
    projectRef: PROJECT_REF,
    setupMode: "manual",
    cloudflareAccountId: "cf-account-id",
    workerName: "supacron-abcdefghijklmnopqrst",
    schedule: "0 0,12 * * *",
  });

  const filePath = await writeManifest(manifest, { rootDir });
  assert.equal(filePath, manifestPath(PROJECT_REF, { rootDir }));
  assert.deepEqual(await readManifest(PROJECT_REF, { rootDir }), manifest);

  const stat = await fs.stat(filePath);
  if (process.platform !== "win32") {
    assert.equal(stat.mode & 0o777, 0o600);
  }

  assert.equal(await deleteManifest(PROJECT_REF, { rootDir }), true);
  assert.equal(await readManifest(PROJECT_REF, { rootDir }), null);
  assert.equal(await deleteManifest(PROJECT_REF, { rootDir }), false);
});
