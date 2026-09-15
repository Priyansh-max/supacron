import crypto from "node:crypto";
import readline from "node:readline";

import { parseArgs } from "./args.js";
import { DEFAULT_SCHEDULE } from "./constants.js";
import { createPromptSession } from "./prompts.js";
import {
  SupabaseAuthRequiredError,
  listProjects,
  login as supabaseLogin,
  logout as supabaseLogout,
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
  logout as cloudflareLogout,
} from "./cloudflare/client.js";
import {
  deleteWorkerSecret,
  deployWorker,
  putWorkerSecret,
  verifyDeployedWorker,
} from "./cloudflare/deploy.js";
import { cleanupLocalSetupFiles, createLocalSetupWorkspace } from "./local-cleanup.js";
import {
  bullet,
  choiceLine,
  color,
  keyValue,
  muted,
  renderBanner,
  section,
  status,
  strong,
  write,
} from "./ui.js";

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

const SCHEDULE_PRESETS = [
  {
    value: DEFAULT_SCHEDULE,
    label: "Twice daily (recommended)",
    description: DEFAULT_SCHEDULE,
  },
  {
    value: "0 * * * *",
    label: "Hourly",
    description: "0 * * * *",
  },
  {
    value: "*/15 * * * *",
    label: "Every 15 minutes",
    description: "*/15 * * * *",
  },
  {
    value: "custom",
    label: "Custom cron expression",
    description: "Enter your own 5-field cron schedule.",
  },
];

const SESSION_CHOICES = [
  {
    value: "remember",
    label: "Remember me",
    description: "Keep Supabase CLI and Wrangler logged in for future CLI use.",
  },
  {
    value: "logout",
    label: "Logout",
    description: "Logout from both Supabase CLI and Cloudflare Wrangler.",
  },
];

const SECRET_BINDINGS = [
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPACRON_HEARTBEAT_SECRET",
  "SUPACRON_VERIFY_SECRET",
];

const BANNER = [
  "  ___ _   _ ___   _   ___ ___  ___  _  _ ",
  " / __| | | | _ \\ /_\\ / __| _ \\/ _ \\| \\| |",
  " \\__ \\ |_| |  _// _ \\ (__|   / (_) | .` |",
  " |___/\\___/|_| /_/ \\_\\___|_|_\\\\___/|_|\\_|",
].join("\n");

export async function init(args = [], dependencies = {}) {
  ensureNodeVersion(dependencies.nodeVersion || process.versions.node);

  const parsed = parseArgs(args);
  const out = dependencies.out || process.stdout;
  const rl = dependencies.rl || await createPromptSession();
  const shouldCloseRl = !dependencies.rl;
  let setupWorkspace;

  try {
    setupWorkspace = await (dependencies.createLocalSetupWorkspace || createLocalSetupWorkspace)();
    const executeSql = dependencies.executeSql || ((request) => executeProjectSql({ ...request, cwd: setupWorkspace }));
    const linkProject = dependencies.linkSupabaseProject || ((request) => linkSupabaseProject({ ...request, cwd: setupWorkspace }));

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
      executeSql,
      linkProject,
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
      execute: executeSql,
    });
    if (!heartbeatCheck.ok) {
      throw new Error("Cloudflare verification ran, but Supabase did not show the heartbeat row yet.");
    }

    const dashboardUrl = cloudflareWorkerUrl(account.id, workerName);
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
      heartbeat: heartbeatCheck,
    };
    writeFinalReport({ out, report });
    report.postSetup = await runPostSetupFinish({ parsed, rl, out, setupWorkspace, dependencies });
    setupWorkspace = null;
    return report;
  } finally {
    if (setupWorkspace) {
      await cleanupSetupWorkspace({ setupWorkspace, dependencies, out: null });
    }
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
    section(out, "Manual Supabase SQL");
    status(out, "info", "Open the SQL editor link below, run this SQL, then come back here.");
    keyValue(out, "SQL editor", projectSqlEditorUrl(project.ref));
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
    status(out, "info", "Linking Supabase project for CLI SQL access...");
    linkProject({ projectRef: project.ref });
    status(out, "success", "Supabase project linked.");
  } else if (mode === "automatic") {
    await requireApproval({
      rl,
      out,
      parsed,
      flag: "approve-sql",
      question: "Run the shown SQL using the official Supabase CLI now?",
      defaultValue: false,
    });
    status(out, "info", "Linking Supabase project for CLI SQL access...");
    linkProject({ projectRef: project.ref });
    status(out, "success", "Supabase project linked.");
    status(out, "info", "Applying Supabase SQL with the official CLI...");
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
  status(out, "success", "Supabase verification passed.");
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

  section(out, "Cloudflare deployment");
  status(out, "info", "Deploying temporary verification Worker...");
  const bootstrap = deploy({
    accountId: account.id,
    workerName,
    schedule,
    verification: true,
    declareSecrets: false,
  });
  status(out, "success", "Temporary verification Worker deployed.");

  let verificationSecretWritten = false;
  try {
    status(out, "info", "Writing Cloudflare Worker secrets through Wrangler stdin...");
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
    status(out, "success", "Cloudflare Worker secrets written.");

    status(out, "info", "Redeploying verification Worker with required secret bindings...");
    const verificationDeploy = deploy({
      accountId: account.id,
      workerName,
      schedule,
      verification: true,
      declareSecrets: true,
    });
    const workersDevUrl = verificationDeploy.workersDevUrl || bootstrap.workersDevUrl;
    status(out, "success", "Verification Worker redeployed.");

    status(out, "info", "Running one verification heartbeat...");
    const workerCheck = await verifyWorker({
      workersDevUrl,
      verifySecret,
    });
    status(out, "success", "Verification heartbeat passed.");

    status(out, "info", "Removing temporary verification secret...");
    removeSecret({
      accountId: account.id,
      workerName,
      key: "SUPACRON_VERIFY_SECRET",
    });
    verificationSecretWritten = false;
    status(out, "success", "Temporary verification secret removed.");

    status(out, "info", "Deploying final scheduled Worker with no public HTTP route...");
    deploy({
      accountId: account.id,
      workerName,
      schedule,
      verification: false,
      declareSecrets: true,
    });
    status(out, "success", "Final scheduled Worker deployed.");

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
        status(out, "warn", "Temporary verification secret cleanup failed. Remove SUPACRON_VERIFY_SECRET in Cloudflare.");
      }
    }
  }
}

async function runPostSetupFinish({ parsed, rl, out, setupWorkspace, dependencies }) {
  section(out, "Finish");
  const cleanup = await cleanupSetupWorkspace({ setupWorkspace, dependencies, out });

  const sessionMode = await chooseSessionMode({ parsed, rl, out });
  const session = await applyCliSession({ sessionMode, dependencies, out });

  return {
    cleanup,
    sessionMode,
    session,
  };
}

async function cleanupSetupWorkspace({ setupWorkspace, dependencies, out }) {
  const cleanupFiles = dependencies.cleanupLocalSetupFiles || cleanupLocalSetupFiles;
  const result = await cleanupFiles({ workspaceDir: setupWorkspace });

  if (out) {
    if (result.removed.length === 0) {
      status(out, "success", "Temporary setup workspace already clean.");
    } else {
      status(out, "success", "Removed temporary setup workspace.");
    }

    for (const skipped of result.skipped) {
      status(out, "warn", `Could not remove ${skipped.path}: ${skipped.reason}`);
    }
  }

  return result;
}

async function chooseSessionMode({ parsed, rl, out }) {
  const value = parsed.values.session ?? legacySessionValue(parsed);
  if (value) {
    const match = SESSION_CHOICES.find((choice) => choice.value === value);
    if (!match) {
      throw new Error(`Invalid session option: ${value}`);
    }
    status(out, "success", `CLI session: ${match.label}`);
    return match.value;
  }

  return chooseFromList({
    rl,
    out,
    question: "CLI session",
    choices: SESSION_CHOICES.map((choice) => ({
      value: choice.value,
      label: choice.label,
      description: choice.description,
      item: choice.value,
    })),
  });
}

function legacySessionValue(parsed) {
  const logoutValue = parsed.values.logout;
  if (logoutValue === "all") {
    return "logout";
  }
  if (logoutValue === "none") {
    return "remember";
  }
  if (parsed.flags.has("logout")) {
    return "logout";
  }
  return null;
}

async function applyCliSession({ sessionMode, dependencies, out }) {
  const result = { supabase: "kept", cloudflare: "kept" };
  if (sessionMode === "remember") {
    status(out, "success", "Remembered official CLI login sessions.");
    return result;
  }

  result.supabase = await runOptionalLogout({
    label: "Supabase CLI",
    logout: dependencies.logoutSupabase || supabaseLogout,
    out,
  });
  result.cloudflare = await runOptionalLogout({
    label: "Cloudflare Wrangler",
    logout: dependencies.logoutCloudflare || cloudflareLogout,
    out,
  });
  return result;
}

async function runOptionalLogout({ label, logout, out }) {
  try {
    status(out, "info", `Logging out ${label} with the official CLI...`);
    await logout();
    status(out, "success", `${label} logged out.`);
    return "logged-out";
  } catch (error) {
    status(out, "warn", `${label} logout failed: ${error.message}`);
    return "failed";
  }
}

async function discoverPublishableKey({ project, dependencies, out }) {
  section(out, "Supabase public key");
  status(out, "info", "Discovering public API key without revealing secret keys...");
  const keys = await (dependencies.listPublishableKeys || listPublishableKeys)({
    projectRef: project.ref,
  });
  if (keys.length === 0) {
    throw new Error("No Supabase public anon/publishable key was returned. Supacron will not ask for secret/service-role keys.");
  }

  status(out, "success", `Found ${keys.length} public API key(s). The key value is not printed.`);
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
    return requireValidSchedule(parsed.values.schedule);
  }

  const selected = await chooseFromList({
    rl,
    out,
    question: "Choose cron schedule",
    choices: SCHEDULE_PRESETS.map((entry) => ({
      value: entry.value,
      label: entry.label,
      description: entry.description,
      item: entry.value,
    })),
  });

  if (selected !== "custom") {
    return selected;
  }

  section(out, "Custom schedule");
  write(out, muted(out, "  Use 5 cron fields, for example: */15 * * * *"));
  while (true) {
    const answer = (await askRaw(rl, "Cron expression: ")).trim();
    try {
      return requireValidSchedule(answer);
    } catch {
      status(out, "warn", "Invalid cron expression. Use exactly 5 fields, for example: 0 0,12 * * *");
    }
  }
}

function requireValidSchedule(value) {
  if (typeof value !== "string" || !validCron(value.trim())) {
    throw new Error("Invalid cron schedule. Choose a preset or provide a 5-field cron expression like 0 0,12 * * *.");
  }
  return value.trim();
}

function validCron(value) {
  return typeof value === "string"
    && value.length <= 100
    && /^[0-9*/?, -]+$/.test(value)
    && value.trim().split(/\s+/).length === 5;
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
    throw new Error(`${question}: invalid selection: ${selected.trim() || "empty"}`);
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
  let renderedLines = 0;
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
      if (renderedLines > 0) {
        readline.moveCursor(output, 0, -renderedLines);
      } else {
        output.write("\n");
      }

      output.write("\x1b[?25l");
      const optionWidth = Math.max(...choices.map((choice) => {
        const detail = choice.description ? ` - ${choice.description}` : "";
        return `${choice.label}${detail}`.length;
      }));
      const lines = [
        color(output, "blue", strong(output, question)),
        ...choices.map((choice, index) => choiceLine(output, choice, index === selectedIndex, optionWidth)),
        muted(output, "Use arrow keys and Enter."),
      ];

      for (const line of lines) {
        readline.cursorTo(output, 0);
        readline.clearLine(output, 0);
        output.write(`${line}\n`);
      }
      renderedLines = lines.length;
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
    status(out, "success", `${question} yes`);
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
  section(out, "Supabase change plan");
  keyValue(out, "Project", `${project.name} (${project.ref})`);
  keyValue(out, "SQL", `${installSql.split(/\r?\n/).length} lines, heartbeat secret stored only as SHA-256 digest`);
  bullet(out, "schema: supacron");
  bullet(out, "table: supacron.heartbeat");
  bullet(out, "RPC: public.supacron_ping(text)");
  bullet(out, "RLS, revokes, and grants for Supacron-owned objects");
  write(out, muted(out, "  No database passwords, connection strings, service-role keys, or Supabase access tokens."));
}

function writeCloudflarePlan({ out, account, workerName, schedule }) {
  section(out, "Cloudflare change plan");
  keyValue(out, "Account", `${account.name} (${account.id})`);
  keyValue(out, "Worker", workerName);
  keyValue(out, "Schedule", schedule);
  bullet(out, "deploy through Wrangler");
  bullet(out, "stream Worker secrets through stdin");
  bullet(out, "run one temporary verification endpoint");
  bullet(out, "remove the verification secret and deploy the final private cron Worker");
  write(out, muted(out, `  Bindings: ${SECRET_BINDINGS.join(", ")}`));
}

function writeFinalReport({ out, report }) {
  section(out, "Setup complete");
  status(out, "success", "Supacron is installed and verified.");
  keyValue(out, "Supabase", `${report.project.name} (${report.project.ref})`);
  keyValue(out, "Cloudflare", `${report.account.name} (${report.account.id})`);
  keyValue(out, "Worker", report.workerName);
  keyValue(out, "Schedule", report.schedule);
  keyValue(out, "Heartbeat", report.heartbeat.lastPingAt || "verified");
  section(out, "Manage later");
  keyValue(out, "Supabase", report.supabaseDashboardUrl);
  keyValue(out, "SQL editor", report.sqlEditorUrl);
  keyValue(out, "Cloudflare", report.cloudflareDashboardUrl);
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
  renderBanner(out, BANNER);
}

async function askRaw(rl, question) {
  return rl.question(question);
}
