import crypto from "node:crypto";

import { parseArgs } from "./args.js";
import { cloudflareWorkerUrl } from "./cloudflare/client.js";
import {
  deleteWorkerSecret,
  deployWorker,
  putWorkerSecret,
  verifyDeployedWorker,
} from "./cloudflare/deploy.js";
import { cleanupLocalSetupFiles, createLocalSetupWorkspace } from "./local-cleanup.js";
import { listManifests, readManifest } from "./lib/manifest.js";
import { linkProject as linkSupabaseProject, executeProjectSql } from "./supabase/query.js";
import { projectDashboardUrl, projectSqlEditorUrl } from "./supabase/client.js";
import { verifyHeartbeat, verifyStructure } from "./supabase/verify.js";
import { keyValue, section, status } from "./ui.js";

export async function testInstallation(args = [], dependencies = {}) {
  const parsed = parseArgs(args);
  const out = dependencies.out || process.stdout;
  const manifest = await resolveManifest({ parsed, dependencies });
  const projectRef = manifest.supabase.projectRef;
  let setupWorkspace;

  section(out, "Supacron test");
  keyValue(out, "Supabase", `${manifest.supabase.name || projectRef} (${projectRef})`);
  keyValue(out, "Worker", manifest.cloudflare.workerName);
  keyValue(out, "Schedule", manifest.cloudflare.schedule);

  try {
    setupWorkspace = await (dependencies.createLocalSetupWorkspace || createLocalSetupWorkspace)();
    const executeSql = dependencies.executeSql || ((request) =>
      executeProjectSql({ ...request, cwd: setupWorkspace }));
    const linkProject = dependencies.linkSupabaseProject || ((request) =>
      linkSupabaseProject({ ...request, cwd: setupWorkspace }));

    status(out, "info", "Linking Supabase project in a temporary workspace...");
    await linkProject({ projectRef });
    status(out, "success", "Supabase project linked for this test.");

    status(out, "info", "Checking Supabase heartbeat objects...");
    const structure = await (dependencies.verifyDbStructure || verifyStructure)({
      projectRef,
      execute: executeSql,
    });
    if (!structure.ok) {
      throw new Error("Supacron test failed: expected Supabase table, RPC, or RLS policy was missing.");
    }
    status(out, "success", "Supabase objects are present.");

    const proof = await runLiveWorkerProof({
      manifest,
      projectRef,
      executeSql,
      dependencies,
      out,
    });

    const report = {
      ok: true,
      manifest,
      structure,
      heartbeat: proof.heartbeat,
      worker: proof.worker,
      cleanup: null,
    };
    writeProofReport({ out, report });
    report.cleanup = await cleanupWorkspace({ setupWorkspace, dependencies, out });
    setupWorkspace = null;
    return report;
  } finally {
    if (setupWorkspace) {
      await cleanupWorkspace({ setupWorkspace, dependencies, out: null });
    }
  }
}

async function runLiveWorkerProof({ manifest, projectRef, executeSql, dependencies, out }) {
  const verifySecret = randomHex(32, dependencies.randomBytes);
  const accountId = manifest.cloudflare.accountId;
  const workerName = manifest.cloudflare.workerName;
  const schedule = manifest.cloudflare.schedule;
  const putSecret = dependencies.putWorkerSecret || putWorkerSecret;
  const removeSecret = dependencies.deleteWorkerSecret || deleteWorkerSecret;
  const deploy = dependencies.deployWorker || deployWorker;
  const verifyWorker = dependencies.verifyWorker || verifyDeployedWorker;
  const verifyDbHeartbeat = dependencies.verifyDbHeartbeat || verifyHeartbeat;
  let verificationSecretWritten = false;
  let verificationRouteDeployed = false;
  let caughtError = null;
  let result = null;

  try {
    status(out, "info", "Adding temporary Worker verification secret...");
    await putSecret({
      accountId,
      workerName,
      key: "SUPACRON_VERIFY_SECRET",
      value: verifySecret,
    });
    verificationSecretWritten = true;
    status(out, "success", "Temporary verification secret added.");

    status(out, "info", "Deploying temporary live verification route...");
    const verificationDeploy = await deploy({
      accountId,
      workerName,
      schedule,
      verification: true,
      declareSecrets: true,
    });
    verificationRouteDeployed = true;
    status(out, "success", "Temporary live verification route deployed.");

    status(out, "info", "Running a live heartbeat through the deployed Worker...");
    const worker = await verifyWorker({
      workersDevUrl: verificationDeploy.workersDevUrl || manifest.cloudflare.workerUrl,
      verifySecret,
    });
    status(out, "success", "Live Worker heartbeat passed.");

    status(out, "info", "Verifying the heartbeat row in Supabase...");
    const heartbeat = await verifyDbHeartbeat({
      projectRef,
      execute: executeSql,
    });
    if (!heartbeat.ok) {
      throw new Error("Supacron test failed: Worker ran, but Supabase did not show the heartbeat row yet.");
    }
    status(out, "success", "Supabase heartbeat proof found.");
    result = { worker, heartbeat };
  } catch (error) {
    caughtError = error;
  }

  const cleanupError = await cleanupWorkerProof({
    accountId,
    workerName,
    schedule,
    verificationSecretWritten,
    verificationRouteDeployed,
    removeSecret,
    deploy,
    out,
  });

  if (caughtError) {
    if (cleanupError) {
      status(out, "warn", `Cleanup also needs attention: ${cleanupError.message}`);
    }
    throw caughtError;
  }

  if (cleanupError) {
    throw cleanupError;
  }

  return result;
}

async function cleanupWorkerProof({
  accountId,
  workerName,
  schedule,
  verificationSecretWritten,
  verificationRouteDeployed,
  removeSecret,
  deploy,
  out,
}) {
  let cleanupError = null;

  if (verificationSecretWritten) {
    try {
      status(out, "info", "Removing temporary verification secret...");
      await removeSecret({
        accountId,
        workerName,
        key: "SUPACRON_VERIFY_SECRET",
      });
      status(out, "success", "Temporary verification secret removed.");
    } catch (error) {
      cleanupError = error;
      status(out, "warn", "Temporary verification secret cleanup failed. Remove SUPACRON_VERIFY_SECRET in Cloudflare.");
    }
  }

  if (verificationRouteDeployed) {
    try {
      status(out, "info", "Restoring final private scheduled Worker...");
      await deploy({
        accountId,
        workerName,
        schedule,
        verification: false,
        declareSecrets: true,
      });
      status(out, "success", "Final private scheduled Worker restored.");
    } catch (error) {
      cleanupError = error;
      status(out, "warn", "Final Worker restore failed. Run supacron test again or redeploy the Worker from Cloudflare.");
    }
  }

  return cleanupError;
}

async function resolveManifest({ parsed, dependencies }) {
  const projectRef = parsed.values["project-ref"];
  if (projectRef) {
    const manifest = await (dependencies.readInstallManifest || readManifest)(projectRef);
    if (!manifest) {
      throw new Error(`No Supacron installation receipt found for project ${projectRef}. Run supacron init first.`);
    }
    return manifest;
  }

  const manifests = await (dependencies.listInstallManifests || listManifests)();
  if (manifests.length === 1) {
    return manifests[0];
  }

  if (manifests.length === 0) {
    throw new Error("No Supacron installation receipt found. Run supacron init first.");
  }

  throw new Error("Multiple Supacron installation receipts found. Run supacron test --project-ref <ref>.");
}

async function cleanupWorkspace({ setupWorkspace, dependencies, out }) {
  const cleanupFiles = dependencies.cleanupLocalSetupFiles || cleanupLocalSetupFiles;
  const result = await cleanupFiles({ workspaceDir: setupWorkspace });

  if (out) {
    if (result.removed.length === 0) {
      status(out, "success", "Temporary test workspace already clean.");
    } else {
      status(out, "success", "Removed temporary test workspace.");
    }

    for (const skipped of result.skipped) {
      status(out, "warn", `Could not remove ${skipped.path}: ${skipped.reason}`);
    }
  }

  return result;
}

function writeProofReport({ out, report }) {
  const { manifest, heartbeat, worker } = report;
  section(out, "Proof");
  status(out, "success", "A live deployed Worker request wrote a fresh Supabase heartbeat.");
  keyValue(out, "Last ping", heartbeat.lastPingAt || worker.lastPingAt || "verified");
  keyValue(out, "Ping count", Number.isSafeInteger(heartbeat.pingCount) ? heartbeat.pingCount : "verified");
  keyValue(out, "Route", "temporary verification route removed");
  section(out, "Verify in dashboard");
  keyValue(out, "Supabase", manifest.supabase.dashboardUrl || projectDashboardUrl(manifest.supabase.projectRef));
  keyValue(out, "SQL editor", projectSqlEditorUrl(manifest.supabase.projectRef));
  keyValue(out, "Cloudflare", manifest.cloudflare.dashboardUrl || cloudflareWorkerUrl(
    manifest.cloudflare.accountId,
    manifest.cloudflare.workerName,
  ));
}

function randomHex(byteLength, randomBytes = crypto.randomBytes) {
  return randomBytes(byteLength).toString("hex");
}