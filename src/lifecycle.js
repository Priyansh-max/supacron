import { parseArgs } from "./args.js";
import { readManifest } from "./lib/manifest.js";
import { verifyHeartbeat, verifyStructure } from "./supabase/verify.js";

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
