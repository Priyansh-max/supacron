import crypto from "node:crypto";
import readline from "node:readline";

import { parseArgs } from "./args.js";
import { DEFAULT_SCHEDULE } from "./constants.js";
import { createPromptSession } from "./prompts.js";
import {
  SupabaseAuthRequiredError,
  listProjects,
  login as supabaseLogin,
  projectDashboardUrl,
  projectSqlEditorUrl,
} from "./supabase/client.js";
import { listPublishableKeys } from "./supabase/keys.js";
import { createInstallationSql, heartbeatSecretHash } from "./supabase/migration.js";
import { executeProjectSql, linkProject as linkSupabaseProject } from "./supabase/query.js";
import { verifyHeartbeat, verifyStructure } from "./supabase/verify.js";
import {
  CloudflareAuthRequiredError,
  cloudflareWorkerUrl,
  listAccounts,
  login as cloudflareLogin,
} from "./cloudflare/client.js";
import {
  deleteWorkerSecret,
  deployWorker,
  putWorkerSecret,
  verifyDeployedWorker,
} from "./cloudflare/deploy.js";
import { createManifest, writeManifest } from "./lib/manifest.js";

const SETUP_MODES = [
  {
    value: "automatic",
    label: "Automatic guided setup (recommended)",
    description: "Supacron applies the shown SQL with the official Supabase CLI after approval.",
  },
  {
    value: "manual",
    label: "Manual SQL fallback",
    description: "Supacron prints SQL for you to run in Supabase, then verifies it.",
  },
];

const SECRET_BINDINGS = [
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPACRON_HEARTBEAT_SECRET",
  "SUPACRON_VERIFY_SECRET",
];

const BANNER = [
  " ____",
  "/ ___| _   _ _ __   __ _  ___ _ __ ___  _ __",
  "\\___ \\| | | | '_ \\ / _` |/ __| '__/ _ \\| '_ \\",
  " ___) | |_| | |_) | (_| | (__| | | (_) | | | |",
  "|____/ \\__,_| .__/ \\__,_|\\___|_|  \\___/|_| |_|",
  "            |_|",
].join("\n");

export async function init(args = [], dependencies = {}) {
  ensureNodeVersion(dependencies.nodeVersion || process.versions.node);

  const parsed = parseArgs(args);
  const out = dependencies.out || process.stdout;
  const rl = dependencies.rl || await createPromptSession();
  const shouldCloseRl = !dependencies.rl;

  try {
    writeBanner(out);

    const projects = await discoverSupabaseProjects(dependencies, out);
    const project = await chooseProject({ projects, parsed, rl, out });

    const heartbeatSecret = randomHex(32, dependencies.randomBytes);
    const installSql = createInstallationSql({
      secretHash: heartbeatSecretHash(heartbeatSecret),
    });

    writeDatabasePlan({ out, project, installSql });

    const setupMode = await chooseSetupMode({ parsed, rl, out });
    await setupDatabase({
      mode: setupMode,
      project,
      installSql,
      parsed,
      rl,
      out,
      executeSql: dependencies.executeSql || executeProjectSql,
      linkProject: dependencies.linkSupabaseProject || linkSupabaseProject,
      verifyDbStructure: dependencies.verifyDbStructure || verifyStructure,
    });

    const publishableKey = await discoverPublishableKey({ project, dependencies, out });
    const accounts = await discoverCloudflareAccounts(dependencies, out);
    const account = await chooseAccount({ accounts, parsed, rl, out });
    const schedule = await chooseSchedule({ parsed, rl, out });
    const workerName = chooseWorkerName({ parsed, project });
    const supabaseUrl = `https://${project.ref}.supabase.co`;
    const verifySecret = randomHex(32, dependencies.randomBytes);

    writeCloudflarePlan({ out, account, workerName, schedule });
    await requireApproval({
      rl,
      out,
      parsed,
      flag: "approve-cloudflare",
      question: "Deploy this Cloudflare Worker and stream secrets through Wrangler now?",
      defaultValue: false,
    });

    const deployment = await deployCloudflareCron({
      account,
      workerName,
      schedule,
      supabaseUrl,
      publishableKey,
      heartbeatSecret,
      verifySecret,
      dependencies,
      out,
    });

    const heartbeatCheck = await (dependencies.verifyDbHeartbeat || verifyHeartbeat)({
      projectRef: project.ref,
      execute: dependencies.executeSql || executeProjectSql,
    });
    if (!heartbeatCheck.ok) {
      throw new Error("Cloudflare verification ran, but Supabase did not show the heartbeat row yet.");
    }

    const now = dependencies.now || new Date().toISOString();
    const dashboardUrl = cloudflareWorkerUrl(account.id, workerName);
    const manifest = createManifest({
      now,
      projectRef: project.ref,
      projectName: project.name,
      region: project.region,
      supabaseDashboardUrl: projectDashboardUrl(project.ref),
      supabaseProjectUrl: supabaseUrl,
      setupMode,
      databaseVerifiedAt: now,
      cloudflareAccountId: account.id,
      cloudflareAccountName: account.name,
      workerName,
      workerUrl: deployment.workersDevUrl,
      schedule,
      cloudflareDashboardUrl: dashboardUrl,
      deployedAt: now,
      verificationStatus: "verified",
      lastCheckedAt: now,
      lastHeartbeatAt: heartbeatCheck.lastPingAt || deployment.lastPingAt || now,
    });
    const manifestFile = await (dependencies.writeInstallManifest || writeManifest)(manifest);

    const report = {
      ok: true,
      mode: setupMode,
      project,
      account,
      workerName,
      schedule,
      supabaseUrl,
      supabaseDashboardUrl: projectDashboardUrl(project.ref),
      sqlEditorUrl: projectSqlEditorUrl(project.ref),
      cloudflareDashboardUrl: dashboardUrl,
      manifestFile,
      heartbeat: heartbeatCheck,
    };
    writeFinalReport({ out, report });
    return report;
  } finally {
    if (shouldCloseRl) {
      rl.close();
    }
  }
}

export function ensureNodeVersion(version) {
  const major = Number.parseInt(String(version).split(".")[0], 10);
  if (!Number.isSafeInteger(major) || major < 20) {
    throw new Error("Supacron requires Node.js 20 or newer.");
  }
}

export async function discoverSupabaseProjects(dependencies, out) {
  const getProjects = dependencies.listSupabaseProjects || listProjects;
  try {
    return requireNonEmptyProjects(await getProjects());
  } catch (error) {
    if (!(error instanceof SupabaseAuthRequiredError)) {
      throw error;
    }

    write(out, "");
    write(out, "Supabase login required. Opening the official Supabase CLI browser flow.");
    await (dependencies.loginSupabase || supabaseLogin)();
    return requireNonEmptyProjects(await getProjects());
  }
}

export async function discoverCloudflareAccounts(dependencies, out) {
  const getAccounts = dependencies.listCloudflareAccounts || listAccounts;
  try {
    return requireNonEmptyAccounts(await getAccounts());
  } catch (error) {
    if (!(error instanceof CloudflareAuthRequiredError)) {
      throw error;
    }

    write(out, "");
    write(out, "Cloudflare login required. Opening Wrangler device login with narrow Worker scopes.");
    await (dependencies.loginCloudflare || cloudflareLogin)();
    return requireNonEmptyAccounts(await getAccounts());
  }
}

export async function setupDatabase({
  mode,
  project,
  installSql,
  parsed,
  rl,
  out,
  executeSql,
  linkProject,
  verifyDbStructure,
}) {
  if (mode === "manual") {
    write(out, "");
    write(out, "Manual Supabase SQL");
    write(out, "Open the SQL editor link below, run this SQL, then come back here.");
    write(out, projectSqlEditorUrl(project.ref));
    write(out, "");
    write(out, installSql);
    await requireApproval({
      rl,
      out,
      parsed,
      flag: "confirm-manual-sql",
      question: "I have run the SQL successfully in Supabase.",
      defaultValue: false,
    });
    write(out, "Linking Supabase project for CLI SQL access...");
    linkProject({ projectRef: project.ref });
    write(out, "Supabase project linked.");
  } else if (mode === "automatic") {
    await requireApproval({
      rl,
      out,
      parsed,
      flag: "approve-sql",
      question: "Run the shown SQL using the official Supabase CLI now?",
      defaultValue: false,
    });
    write(out, "Linking Supabase project for CLI SQL access...");
    linkProject({ projectRef: project.ref });
    write(out, "Supabase project linked.");
    executeSql({
      projectRef: project.ref,
      sql: installSql,
      operation: "Supacron database setup",
    });
  } else {
    throw new Error(`Unsupported setup mode: ${mode}`);
  }

  const structure = verifyDbStructure({
    projectRef: project.ref,
    execute: executeSql,
  });
  if (!structure.ok) {
    throw new Error("Supabase verification failed: expected table, RPC, or RLS policy was missing.");
  }
  write(out, "Supabase verification passed.");
  return structure;
}

export async function deployCloudflareCron({
  account,
  workerName,
  schedule,
  supabaseUrl,
  publishableKey,
  heartbeatSecret,
  verifySecret,
  dependencies,
  out,
}) {
  const deploy = dependencies.deployWorker || deployWorker;
  const putSecret = dependencies.putWorkerSecret || putWorkerSecret;
  const removeSecret = dependencies.deleteWorkerSecret || deleteWorkerSecret;
  const verifyWorker = dependencies.verifyWorker || verifyDeployedWorker;

  write(out, "");
  write(out, "Deploying temporary verification Worker...");
  const bootstrap = deploy({
    accountId: account.id,
    workerName,
    schedule,
    verification: true,
    declareSecrets: false,
  });

  let verificationSecretWritten = false;
  try {
    write(out, "Writing Cloudflare Worker secrets through Wrangler stdin...");
    for (const [key, value] of [
      ["SUPABASE_URL", supabaseUrl],
      ["SUPABASE_PUBLISHABLE_KEY", publishableKey],
      ["SUPACRON_HEARTBEAT_SECRET", heartbeatSecret],
      ["SUPACRON_VERIFY_SECRET", verifySecret],
    ]) {
      putSecret({
        accountId: account.id,
        workerName,
        key,
        value,
      });
      if (key === "SUPACRON_VERIFY_SECRET") {
        verificationSecretWritten = true;
      }
    }

    write(out, "Redeploying verification Worker with required secret bindings...");
    const verificationDeploy = deploy({
      accountId: account.id,
      workerName,
      schedule,
      verification: true,
      declareSecrets: true,
    });
    const workersDevUrl = verificationDeploy.workersDevUrl || bootstrap.workersDevUrl;

    write(out, "Running one verification heartbeat...");
    const workerCheck = await verifyWorker({
      workersDevUrl,
      verifySecret,
    });

    write(out, "Removing temporary verification secret...");
    removeSecret({
      accountId: account.id,
      workerName,
      key: "SUPACRON_VERIFY_SECRET",
    });
    verificationSecretWritten = false;

    write(out, "Deploying final scheduled Worker with no public HTTP route...");
    deploy({
      accountId: account.id,
      workerName,
      schedule,
      verification: false,
      declareSecrets: true,
    });

    return {
      workersDevUrl,
      lastPingAt: workerCheck.lastPingAt,
      pingCount: workerCheck.pingCount,
    };
  } finally {
    if (verificationSecretWritten) {
      try {
        removeSecret({
          accountId: account.id,
          workerName,
          key: "SUPACRON_VERIFY_SECRET",
        });
      } catch {
        write(out, "Warning: temporary verification secret cleanup failed. Remove SUPACRON_VERIFY_SECRET in Cloudflare.");
      }
    }
  }
}

async function discoverPublishableKey({ project, dependencies, out }) {
  write(out, "");
  write(out, "Discovering Supabase public API key without revealing secret keys...");
  const keys = await (dependencies.listPublishableKeys || listPublishableKeys)({
    projectRef: project.ref,
  });
  if (keys.length === 0) {
    throw new Error("No Supabase public anon/publishable key was returned. Supacron will not ask for secret/service-role keys.");
  }

  write(out, `Found ${keys.length} public API key(s). The key value is not printed.`);
  return keys[0];
}

async function chooseProject({ projects, parsed, rl, out }) {
  const fromArg = parsed.values["project-ref"];
  if (fromArg) {
    const match = projects.find((project) => project.ref === fromArg);
    if (!match) {
      throw new Error(`Selected Supabase project was not found: ${fromArg}`);
    }
    return match;
  }

  return chooseFromList({
    rl,
    out,
    question: "Select one Supabase project",
    choices: projects.map((project) => ({
      value: project.ref,
      label: `${project.name} (${project.ref}, ${project.region || "unknown"})`,
      item: project,
    })),
  });
}

async function chooseAccount({ accounts, parsed, rl, out }) {
  const fromArg = parsed.values["account-id"];
  if (fromArg) {
    const match = accounts.find((account) => account.id === fromArg);
    if (!match) {
      throw new Error(`Selected Cloudflare account was not found: ${fromArg}`);
    }
    return match;
  }

  return chooseFromList({
    rl,
    out,
    question: "Select one Cloudflare account",
    choices: accounts.map((account) => ({
      value: account.id,
      label: `${account.name} (${account.id})`,
      item: account,
    })),
  });
}

async function chooseSetupMode({ parsed, rl, out }) {
  const mode = parsed.values.mode;
  if (mode) {
    if (!SETUP_MODES.some((entry) => entry.value === mode)) {
      throw new Error(`Invalid setup mode: ${mode}`);
    }
    return mode;
  }

  return chooseFromList({
    rl,
    out,
    question: "Choose Supabase setup mode",
    choices: SETUP_MODES.map((entry) => ({
      value: entry.value,
      label: entry.label,
      description: entry.description,
      item: entry.value,
    })),
  });
}

async function chooseSchedule({ parsed, rl, out }) {
  if (parsed.values.schedule) {
    return parsed.values.schedule;
  }

  write(out, "");
  write(out, `Cron schedule (${DEFAULT_SCHEDULE} recommended)`);
  const answer = await askRaw(rl, "> ");
  return answer.trim() || DEFAULT_SCHEDULE;
}

function chooseWorkerName({ parsed, project }) {
  const workerName = parsed.values["worker-name"] || `supacron-${project.ref}`;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(workerName)) {
    throw new Error("Cloudflare Worker name must be lowercase letters, numbers, and hyphens.");
  }
  return workerName;
}

async function chooseFromList({ rl, out, question, choices }) {
  if (supportsInteractiveList(out)) {
    return chooseFromInteractiveList({ question, choices });
  }

  write(out, "");
  write(out, question);
  choices.forEach((choice, index) => {
    const detail = choice.description ? ` - ${choice.description}` : "";
    write(out, `  ${index + 1}. ${choice.label}${detail}`);
  });

  const selected = await askRaw(rl, "> ");
  const number = Number.parseInt(selected.trim() || "1", 10);
  const choice = Number.isSafeInteger(number)
    ? choices[number - 1]
    : choices.find((entry) => entry.value === selected.trim());

  if (!choice) {
    throw new Error(`Invalid selection: ${selected.trim()}`);
  }

  return choice.item ?? choice.value;
}

function supportsInteractiveList(out) {
  return out === process.stdout
    && process.stdin.isTTY
    && process.stdout.isTTY
    && process.env.CI !== "true";
}

async function chooseFromInteractiveList({ question, choices }) {
  let selectedIndex = 0;
  let rendered = false;
  const input = process.stdin;
  const output = process.stdout;

  readline.emitKeypressEvents(input);
  if (input.isTTY) {
    input.setRawMode(true);
  }
  input.resume();

  return new Promise((resolve, reject) => {
    function cleanup() {
      input.off("keypress", onKeypress);
      if (input.isTTY) {
        input.setRawMode(false);
      }
      output.write("\x1b[?25h");
    }

    function render() {
      if (rendered) {
        output.write(`\x1b[${choices.length + 2}F`);
      } else {
        output.write("\n");
      }

      output.write("\x1b[?25l");
      output.write(`\x1b[2K${question}\n`);
      for (const [index, choice] of choices.entries()) {
        const marker = index === selectedIndex ? ">" : " ";
        const detail = choice.description ? ` - ${choice.description}` : "";
        output.write(`\x1b[2K${marker} ${choice.label}${detail}\n`);
      }
      output.write("\x1b[2KUse arrow keys and Enter.\n");
      rendered = true;
    }

    function finish(choice) {
      cleanup();
      output.write("\n");
      resolve(choice.item ?? choice.value);
    }

    function onKeypress(_char, key = {}) {
      if (key.ctrl && key.name === "c") {
        cleanup();
        reject(new Error("Setup cancelled."));
        return;
      }
      if (key.name === "up") {
        selectedIndex = (selectedIndex - 1 + choices.length) % choices.length;
        render();
        return;
      }
      if (key.name === "down") {
        selectedIndex = (selectedIndex + 1) % choices.length;
        render();
        return;
      }
      if (key.name === "return" || key.name === "enter" || key.name === "space") {
        finish(choices[selectedIndex]);
      }
    }

    input.on("keypress", onKeypress);
    render();
  });
}

async function requireApproval({ rl, out, parsed, flag, question, defaultValue }) {
  if (parsed.flags.has(flag)) {
    write(out, `${question} yes`);
    return true;
  }

  const suffix = defaultValue ? "Y/n" : "y/N";
  const answer = await askRaw(rl, `${question} (${suffix}): `);
  const trimmed = answer.trim().toLowerCase();
  const approved = trimmed ? trimmed === "y" || trimmed === "yes" : defaultValue;
  if (!approved) {
    throw new Error("Setup stopped before making this change.");
  }
  return true;
}

function writeDatabasePlan({ out, project, installSql }) {
  write(out, "");
  write(out, "Supabase change plan");
  write(out, `Project: ${project.name} (${project.ref})`);
  write(out, "Supacron will create or replace only these objects after approval:");
  write(out, "  - schema: supacron");
  write(out, "  - table: supacron.heartbeat");
  write(out, "  - RPC: public.supacron_ping(text)");
  write(out, "  - RLS/revokes/grants for the heartbeat table and RPC");
  write(out, "It will not request database passwords, connection strings, service-role keys, or Supabase access tokens.");
  write(out, `SQL preview: ${installSql.split(/\r?\n/).length} lines, heartbeat secret stored only as SHA-256 digest.`);
}

function writeCloudflarePlan({ out, account, workerName, schedule }) {
  write(out, "");
  write(out, "Cloudflare change plan");
  write(out, `Account: ${account.name} (${account.id})`);
  write(out, `Worker: ${workerName}`);
  write(out, `Schedule: ${schedule}`);
  write(out, "Supacron will deploy through Wrangler, stream secrets through stdin, run one temporary verification endpoint,");
  write(out, "remove that verification secret, then deploy the final Worker without a public HTTP handler.");
  write(out, `Secret bindings used: ${SECRET_BINDINGS.join(", ")}`);
}

function writeFinalReport({ out, report }) {
  write(out, "");
  write(out, "Supacron setup complete");
  write(out, `Supabase project: ${report.project.name} (${report.project.ref})`);
  write(out, `Cloudflare account: ${report.account.name} (${report.account.id})`);
  write(out, `Worker: ${report.workerName}`);
  write(out, `Cron schedule: ${report.schedule}`);
  write(out, `Last heartbeat: ${report.heartbeat.lastPingAt || "verified"}`);
  write(out, "");
  write(out, "Verify and manage later:");
  write(out, `Supabase project: ${report.supabaseDashboardUrl}`);
  write(out, `Supabase SQL editor: ${report.sqlEditorUrl}`);
  write(out, `Cloudflare Worker: ${report.cloudflareDashboardUrl}`);
  write(out, `Local manifest: ${report.manifestFile}`);
  write(out, "");
  write(out, "Lifecycle commands:");
  write(out, `supacron status --project-ref ${report.project.ref}`);
  write(out, `supacron repair --project-ref ${report.project.ref}`);
  write(out, `supacron uninstall --project-ref ${report.project.ref}`);
}

function requireNonEmptyProjects(projects) {
  if (!Array.isArray(projects) || projects.length === 0) {
    throw new Error("No Supabase projects were found for this account.");
  }
  return projects;
}

function requireNonEmptyAccounts(accounts) {
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error("No Cloudflare accounts were found for this login.");
  }
  return accounts;
}

function randomHex(byteLength, randomBytes = crypto.randomBytes) {
  return randomBytes(byteLength).toString("hex");
}

function writeBanner(out) {
  write(out, "");
  write(out, BANNER);
  write(out, "Supacron secure setup");
  write(out, "Cloudflare Workers Cron -> Supabase heartbeat, using only official CLIs.");
}

function write(out, line = "") {
  out.write(`${line}\n`);
}

async function askRaw(rl, question) {
  return rl.question(question);
}
