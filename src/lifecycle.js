import crypto from "node:crypto";

import { parseArgs } from "./args.js";
import { createPromptSession } from "./prompts.js";
import { login as cloudflareLogin } from "./cloudflare/client.js";
import { deleteManifest, readManifest } from "./lib/manifest.js";
import { cleanupLocalSetupFiles, createLocalSetupWorkspace } from "./local-cleanup.js";
import {
  createSecretRotationSql,
  createUninstallSql,
  heartbeatSecretHash,
} from "./supabase/migration.js";
import {
  SupabaseAuthRequiredError,
  listProjects as listSupabaseProjects,
  login as supabaseLogin,
} from "./supabase/client.js";
import { executeProjectSql, linkProject as linkSupabaseProject } from "./supabase/query.js";
import { verifyHeartbeat, verifyStructure, verifyUninstalled } from "./supabase/verify.js";
import {
  deleteWorker,
  deleteWorkerSecret,
  deployWorker,
  putWorkerSecret,
  verifyDeployedWorker,
} from "./cloudflare/deploy.js";

export async function status(args = [], dependencies = {}) {
  const parsed = parseArgs(args);
  const projectRef = parsed.values["project-ref"];
  if (!projectRef) {
    throw new Error("status requires --project-ref <ref>.");
  }

  const out = dependencies.out || process.stdout;
  const manifest = await (dependencies.readInstallManifest || readManifest)(projectRef);
  if (!manifest) {
    throw new Error(`No Supacron installation manifest found for project ${projectRef}.`);
  }

  const verifyDbStructure = dependencies.verifyDbStructure || verifyStructure;
  const verifyDbHeartbeat = dependencies.verifyDbHeartbeat || verifyHeartbeat;
  const executeSql = dependencies.executeSql;

  const structure = await runCheck(() =>
    verifyDbStructure({
      projectRef,
      execute: executeSql,
    }),
  );
  const heartbeat = await runCheck(() =>
    verifyDbHeartbeat({
      projectRef,
      execute: executeSql,
    }),
  );

  const report = {
    ok: structure.ok === true && heartbeat.ok === true,
    manifest,
    structure,
    heartbeat,
  };
  writeStatusReport(out, report);
  return report;
}

export async function repair(args = [], dependencies = {}) {
  const parsed = parseArgs(args);
  const projectRef = parsed.values["project-ref"];
  if (!projectRef) {
    throw new Error("repair requires --project-ref <ref>.");
  }

  const out = dependencies.out || process.stdout;
  const manifest = await (dependencies.readInstallManifest || readManifest)(projectRef);
  if (!manifest) {
    throw new Error(`No Supacron installation manifest found for project ${projectRef}.`);
  }

  let setupWorkspace;
  try {
    setupWorkspace = await (dependencies.createLocalSetupWorkspace || createLocalSetupWorkspace)();
    const executeSql = dependencies.executeSql || ((request) =>
      executeProjectSql({ ...request, cwd: setupWorkspace }));
    const linkProject = dependencies.linkSupabaseProject || ((request) =>
      linkSupabaseProject({ ...request, cwd: setupWorkspace }));

    await linkSupabaseWithLoginRecovery({ projectRef, linkProject, dependencies, out });

    const verifyDbStructure = dependencies.verifyDbStructure || verifyStructure;
    const structure = await verifyDbStructure({ projectRef, execute: executeSql });
    if (structure.ok !== true) {
      throw new Error(
        "Repair stopped: Supabase heartbeat objects are missing. Rerun `supacron init` to recreate them.",
      );
    }

    const rl = dependencies.rl || await createPromptSession();
    const shouldCloseRl = !dependencies.rl;
    try {
      writeRepairPlan(out, manifest);
      await requireRepairApproval({ rl, out, parsed });
    } finally {
      if (shouldCloseRl) {
        rl.close();
      }
    }

    const heartbeatSecret = randomHex(32, dependencies.randomBytes);
    const verifySecret = randomHex(32, dependencies.randomBytes);
    const rotationSql = createSecretRotationSql({
      secretHash: heartbeatSecretHash(heartbeatSecret),
    });

    write(out, "Preparing a safe heartbeat secret handover in Supabase...");
    await executeSql({
      projectRef,
      sql: rotationSql,
      operation: "Supacron heartbeat secret rotation",
    });
    write(out, "Supabase will accept the current secret until the new Worker heartbeat succeeds.");

    const worker = await rotateWorkerSecretWithLoginRecovery({
      manifest,
      heartbeatSecret,
      verifySecret,
      dependencies,
      out,
    });

    const heartbeat = await (dependencies.verifyDbHeartbeat || verifyHeartbeat)({
      projectRef,
      execute: executeSql,
    });
    if (!heartbeat.ok) {
      throw new Error("Repair verification failed: Supabase did not show the new Worker heartbeat.");
    }

    const report = {
      ok: true,
      manifest,
      structure,
      heartbeat,
      worker,
    };
    writeRepairReport(out, report);
    return report;
  } finally {
    if (setupWorkspace) {
      await (dependencies.cleanupLocalSetupFiles || cleanupLocalSetupFiles)({
        workspaceDir: setupWorkspace,
      });
    }
  }
}

async function linkSupabaseWithLoginRecovery({ projectRef, linkProject, dependencies, out }) {
  const listProjects = dependencies.listSupabaseProjects || listSupabaseProjects;
  try {
    await listProjects();
  } catch (error) {
    if (!(error instanceof SupabaseAuthRequiredError) && !isAuthFailure(error)) {
      throw error;
    }

    write(out, "Supabase login is needed. Opening the official Supabase CLI login...");
    await (dependencies.loginSupabase || supabaseLogin)();
    await listProjects();
  }

  write(out, "Connecting the Supabase CLI to this project...");
  await linkProject({ projectRef });
}

async function rotateWorkerSecretWithLoginRecovery(request) {
  try {
    return await rotateWorkerSecret(request);
  } catch (error) {
    if (!isAuthFailure(error)) {
      throw error;
    }

    write(request.out, "Cloudflare login is needed. Opening the official Wrangler login...");
    await (request.dependencies.loginCloudflare || cloudflareLogin)();
    return rotateWorkerSecret(request);
  }
}

async function rotateWorkerSecret({
  manifest,
  heartbeatSecret,
  verifySecret,
  dependencies,
  out,
}) {
  const accountId = manifest.cloudflare.accountId;
  const workerName = manifest.cloudflare.workerName;
  const schedule = manifest.cloudflare.schedule;
  const putSecret = dependencies.putWorkerSecret || putWorkerSecret;
  const removeSecret = dependencies.deleteWorkerSecret || deleteWorkerSecret;
  const deploy = dependencies.deployWorker || deployWorker;
  const verifyWorker = dependencies.verifyWorker || verifyDeployedWorker;
  let verificationSecretWritten = false;
  let verificationRouteDeployed = false;
  let finalWorkerDeployed = false;

  try {
    write(out, "Saving the fresh heartbeat secret directly in Cloudflare...");
    await putSecret({
      accountId,
      workerName,
      key: "SUPACRON_HEARTBEAT_SECRET",
      value: heartbeatSecret,
    });
    await putSecret({
      accountId,
      workerName,
      key: "SUPACRON_VERIFY_SECRET",
      value: verifySecret,
    });
    verificationSecretWritten = true;

    const verificationDeploy = await deploy({
      accountId,
      workerName,
      schedule,
      verification: true,
      declareSecrets: true,
    });
    verificationRouteDeployed = true;

    const worker = await verifyWorker({
      workersDevUrl: verificationDeploy.workersDevUrl || manifest.cloudflare.workerUrl,
      verifySecret,
    });

    await removeSecret({
      accountId,
      workerName,
      key: "SUPACRON_VERIFY_SECRET",
    });
    verificationSecretWritten = false;

    await deploy({
      accountId,
      workerName,
      schedule,
      verification: false,
      declareSecrets: true,
    });
    finalWorkerDeployed = true;
    return worker;
  } finally {
    if (verificationSecretWritten) {
      try {
        await removeSecret({
          accountId,
          workerName,
          key: "SUPACRON_VERIFY_SECRET",
        });
      } catch {
        write(out, "Warning: temporary verification secret cleanup needs attention.");
      }
    }

    if (verificationRouteDeployed && !finalWorkerDeployed) {
      try {
        await deploy({
          accountId,
          workerName,
          schedule,
          verification: false,
          declareSecrets: true,
        });
        write(out, "Scheduled-only Worker restored after interrupted repair.");
      } catch {
        write(out, "Warning: scheduled Worker restore failed. Rerun repair after checking Cloudflare.");
      }
    }
  }
}

function isAuthFailure(error) {
  const text = `${error?.message || ""}\n${error?.stderr || ""}\n${error?.stdout || ""}`;
  return /access token not provided|supabase login|not logged in|not authenticated|login required|unauthorized|auth token|expired|loggedIn"?\s*:\s*false/i.test(text);
}

function randomHex(byteLength, randomBytes = crypto.randomBytes) {
  return randomBytes(byteLength).toString("hex");
}

export async function uninstall(args = [], dependencies = {}) {
  const parsed = parseArgs(args);
  const projectRef = parsed.values["project-ref"];
  if (!projectRef) {
    throw new Error("uninstall requires --project-ref <ref>.");
  }

  const out = dependencies.out || process.stdout;
  const manifest = await (dependencies.readInstallManifest || readManifest)(projectRef);
  if (!manifest) {
    throw new Error(`No Supacron installation manifest found for project ${projectRef}.`);
  }

  const uninstallSql = createUninstallSql();
  const rl = dependencies.rl || await createPromptSession();
  const shouldCloseRl = !dependencies.rl;
  try {
    writeUninstallPlan(out, manifest, uninstallSql);
    await requireUninstallApproval({ rl, out, parsed });
  } finally {
    if (shouldCloseRl) {
      rl.close();
    }
  }

  let setupWorkspace;
  try {
    setupWorkspace = await (dependencies.createLocalSetupWorkspace || createLocalSetupWorkspace)();
    const executeSql = dependencies.executeSql || ((request) =>
      executeProjectSql({ ...request, cwd: setupWorkspace }));
    const linkProject = dependencies.linkSupabaseProject || ((request) =>
      linkSupabaseProject({ ...request, cwd: setupWorkspace }));

    await linkSupabaseWithLoginRecovery({ projectRef, linkProject, dependencies, out });

    const worker = await deleteWorkerWithLoginRecovery({ manifest, dependencies, out });

    await executeSql({
      projectRef,
      sql: uninstallSql,
      operation: "Supacron database uninstall",
    });

    const database = await (dependencies.verifyDbUninstalled || verifyUninstalled)({
      projectRef,
      execute: executeSql,
    });
    if (!database.ok) {
      throw new Error(
        "Uninstall verification failed: one or more Supacron database objects still exist. The local manifest was kept so uninstall can be retried.",
      );
    }

    const manifestDeleted = await (dependencies.deleteInstallManifest || deleteManifest)(projectRef);

    const report = {
      ok: true,
      manifest,
      worker,
      database,
      manifestDeleted,
    };
    writeUninstallReport(out, report);
    return report;
  } finally {
    if (setupWorkspace) {
      await (dependencies.cleanupLocalSetupFiles || cleanupLocalSetupFiles)({
        workspaceDir: setupWorkspace,
      });
    }
  }
}

async function deleteWorkerWithLoginRecovery({ manifest, dependencies, out }) {
  const removeWorker = dependencies.deleteWorker || deleteWorker;
  const request = {
    accountId: manifest.cloudflare.accountId,
    workerName: manifest.cloudflare.workerName,
  };

  try {
    await removeWorker(request);
    return { deleted: true, alreadyMissing: false };
  } catch (error) {
    if (isWorkerMissing(error)) {
      write(out, "Cloudflare Worker is already absent; continuing the retry-safe uninstall.");
      return { deleted: false, alreadyMissing: true };
    }
    if (!isAuthFailure(error)) {
      throw error;
    }
  }

  write(out, "Cloudflare login is needed. Opening the official Wrangler login...");
  await (dependencies.loginCloudflare || cloudflareLogin)();
  try {
    await removeWorker(request);
    return { deleted: true, alreadyMissing: false };
  } catch (error) {
    if (isWorkerMissing(error)) {
      write(out, "Cloudflare Worker is already absent; continuing the retry-safe uninstall.");
      return { deleted: false, alreadyMissing: true };
    }
    throw error;
  }
}

function isWorkerMissing(error) {
  const text = `${error?.message || ""}\n${error?.stderr || ""}\n${error?.stdout || ""}`;
  return /workers\.api\.error\.script_not_found|\bcode\s*[:=]?\s*10090\b|could not find (?:a )?(?:worker|script)|(?:worker|script)[^\n]*does not exist/i.test(text);
}

async function requireUninstallApproval({ rl, out, parsed }) {
  if (parsed.flags.has("approve-uninstall")) {
    write(out, "Delete the Worker, Supabase objects, and local manifest? yes");
    return;
  }

  const answer = await rl.question("Delete the Worker, Supabase objects, and local manifest? (y/N): ");
  if (!["y", "yes"].includes(answer.trim().toLowerCase())) {
    throw new Error("Uninstall stopped before deleting anything.");
  }
}

async function requireRepairApproval({ rl, out, parsed }) {
  if (parsed.flags.has("approve-redeploy")) {
    write(out, "Rotate the heartbeat secret and redeploy the scheduled Worker? yes");
    return;
  }

  const answer = await rl.question("Rotate the heartbeat secret and redeploy the scheduled Worker? (y/N): ");
  if (!["y", "yes"].includes(answer.trim().toLowerCase())) {
    throw new Error("Repair stopped before changing Supabase or Cloudflare.");
  }
}

function writeStatusReport(out, report) {
  const { manifest, structure, heartbeat } = report;

  write(out, "");
  write(out, "Supacron status");
  write(out, `Project: ${manifest.supabase.name || manifest.supabase.projectRef} (${manifest.supabase.projectRef})`);
  write(out, `Worker: ${manifest.cloudflare.workerName}`);
  write(out, `Schedule: ${manifest.cloudflare.schedule}`);
  write(out, `Overall: ${report.ok ? "healthy" : "needs attention"}`);
  write(out, "");
  write(out, "Supabase");
  write(out, `  Table: ${statusText(structure.heartbeatTable)}`);
  write(out, `  RPC: ${statusText(structure.pingFunction)}`);
  write(out, `  RLS policy: ${statusText(structure.heartbeatPolicy)}`);
  write(out, "");
  write(out, "Heartbeat");
  write(out, `  Row loaded: ${statusText(heartbeat.ok)}`);
  write(out, `  Last ping: ${heartbeat.lastPingAt || "not seen"}`);
  write(out, `  Ping count: ${Number.isSafeInteger(heartbeat.pingCount) ? heartbeat.pingCount : 0}`);
  write(out, "");
  write(out, "Links");
  if (manifest.supabase.dashboardUrl) {
    write(out, `  Supabase: ${manifest.supabase.dashboardUrl}`);
  }
  if (manifest.cloudflare.dashboardUrl) {
    write(out, `  Cloudflare: ${manifest.cloudflare.dashboardUrl}`);
  }
}

function writeRepairPlan(out, manifest) {
  write(out, "");
  write(out, "Supacron repair plan");
  write(out, `Project: ${manifest.supabase.name || manifest.supabase.projectRef} (${manifest.supabase.projectRef})`);
  write(out, `Cloudflare account: ${manifest.cloudflare.accountId}`);
  write(out, `Worker: ${manifest.cloudflare.workerName}`);
  write(out, `Schedule: ${manifest.cloudflare.schedule}`);
  write(out, "Supacron will generate a fresh heartbeat secret in memory.");
  write(out, "Supabase will accept both digests during handover, then promote the new one after a verified heartbeat.");
  write(out, "Cloudflare will receive the clear secret directly through Wrangler stdin.");
  write(out, "The clear secret will not be printed, written to arguments, or stored locally.");
}

function writeRepairReport(out, report) {
  write(out, "");
  write(out, "Supacron repair complete");
  write(out, `Worker redeployed: ${report.manifest.cloudflare.workerName}`);
  write(out, `Schedule: ${report.manifest.cloudflare.schedule}`);
  write(out, "Heartbeat secret: rotated and verified");
  write(out, `Last ping: ${report.heartbeat.lastPingAt || report.worker.lastPingAt || "verified"}`);
  if (report.manifest.cloudflare.dashboardUrl) {
    write(out, `Cloudflare: ${report.manifest.cloudflare.dashboardUrl}`);
  }
  write(out, "The scheduled Worker is private and active again.");

}
function writeUninstallPlan(out, manifest, uninstallSql) {
  write(out, "");
  write(out, "Supacron uninstall plan");
  write(out, `Project: ${manifest.supabase.name || manifest.supabase.projectRef} (${manifest.supabase.projectRef})`);
  write(out, `Cloudflare Worker: ${manifest.cloudflare.workerName}`);
  write(out, "Supacron will:");
  write(out, "  - delete the Cloudflare Worker with Wrangler");
  write(out, "  - run Supabase uninstall SQL for public.supacron_ping(text), supacron.heartbeat, and schema supacron");
  write(out, "  - delete the local non-secret manifest");
  write(out, "It will not delete other Supabase schemas, tables, policies, secrets, or Cloudflare resources.");
  write(out, "If a provider step fails, the local manifest is kept and uninstall can be safely retried.");
  write(out, `SQL preview: ${uninstallSql.split(/\r?\n/).length} lines, no CASCADE.`);
}

function writeUninstallReport(out, report) {
  write(out, "");
  write(out, "Supacron uninstall complete");
  write(out, `Worker: ${report.worker.alreadyMissing ? "already absent" : "deleted"} (${report.manifest.cloudflare.workerName})`);
  write(out, `Supabase project: ${report.manifest.supabase.projectRef}`);
  write(out, "Supabase objects verified absent: schema, heartbeat table, RPC, and policy");
  write(out, `Local manifest deleted: ${report.manifestDeleted ? "yes" : "already missing"}`);
  if (report.manifest.supabase.dashboardUrl) {
    write(out, `Supabase: ${report.manifest.supabase.dashboardUrl}`);
  }
  if (report.manifest.cloudflare.dashboardUrl) {
    write(out, `Cloudflare: ${report.manifest.cloudflare.dashboardUrl}`);
  }
}

async function runCheck(check) {
  try {
    return await check();
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown verification error.",
    };
  }
}

function statusText(value) {
  return value === true ? "ok" : "missing";
}

function write(out, line = "") {
  out.write(`${line}\n`);
}
