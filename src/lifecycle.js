import { parseArgs } from "./args.js";
import { createPromptSession } from "./prompts.js";
import { deleteManifest, readManifest } from "./lib/manifest.js";
import { createUninstallSql } from "./supabase/migration.js";
import { executeProjectSql } from "./supabase/query.js";
import { verifyHeartbeat, verifyStructure } from "./supabase/verify.js";
import { deleteWorker, deployWorker } from "./cloudflare/deploy.js";

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

  const verifyDbStructure = dependencies.verifyDbStructure || verifyStructure;
  const executeSql = dependencies.executeSql;
  const structure = await runCheck(() =>
    verifyDbStructure({
      projectRef,
      execute: executeSql,
    }),
  );

  if (structure.ok !== true) {
    throw new Error(
      "Repair stopped: Supabase objects are missing or unavailable. Rerun `supacron init` to create a fresh heartbeat secret.",
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

  await (dependencies.deployWorker || deployWorker)({
    accountId: manifest.cloudflare.accountId,
    workerName: manifest.cloudflare.workerName,
    schedule: manifest.cloudflare.schedule,
    verification: false,
    declareSecrets: true,
  });

  const report = {
    ok: true,
    manifest,
    structure,
  };
  writeRepairReport(out, report);
  return report;

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

  await (dependencies.deleteWorker || deleteWorker)({
    accountId: manifest.cloudflare.accountId,
    workerName: manifest.cloudflare.workerName,
  });

  await (dependencies.executeSql || executeProjectSql)({
    projectRef,
    sql: uninstallSql,
    operation: "Supacron database uninstall",
  });

  const manifestDeleted = await (dependencies.deleteInstallManifest || deleteManifest)(projectRef);

  const report = {
    ok: true,
    manifest,
    manifestDeleted,
  };
  writeUninstallReport(out, report);
  return report;
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
    write(out, "Redeploy the scheduled Cloudflare Worker from the saved manifest? yes");
    return;
  }

  const answer = await rl.question("Redeploy the scheduled Cloudflare Worker from the saved manifest? (y/N): ");
  if (!["y", "yes"].includes(answer.trim().toLowerCase())) {
    throw new Error("Repair stopped before redeploying Cloudflare.");
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
  write(out, "Supacron will redeploy the final scheduled Worker config only.");
  write(out, "It will not read, print, recreate, or store local secrets.");
}

function writeRepairReport(out, report) {
  write(out, "");
  write(out, "Supacron repair complete");
  write(out, `Worker redeployed: ${report.manifest.cloudflare.workerName}`);
  write(out, `Schedule: ${report.manifest.cloudflare.schedule}`);
  if (report.manifest.cloudflare.dashboardUrl) {
    write(out, `Cloudflare: ${report.manifest.cloudflare.dashboardUrl}`);
  }
  write(out, "Run `supacron status --project-ref <ref>` after the next scheduled tick to confirm fresh heartbeat data.");

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
  write(out, `SQL preview: ${uninstallSql.split(/\r?\n/).length} lines, no CASCADE.`);
}

function writeUninstallReport(out, report) {
  write(out, "");
  write(out, "Supacron uninstall complete");
  write(out, `Worker deleted: ${report.manifest.cloudflare.workerName}`);
  write(out, `Supabase project: ${report.manifest.supabase.projectRef}`);
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
