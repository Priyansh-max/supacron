import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WRANGLER_PACKAGE } from "../constants.js";
import { runNpx } from "../lib/command.js";
import { createWorkerSource, createWranglerConfig } from "./template.js";

const ACCOUNT_ID = /^[a-f0-9]{32}$/;
const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SECRET_KEYS = new Set([
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPACRON_HEARTBEAT_SECRET",
  "SUPACRON_VERIFY_SECRET"
]);

export function deployWorker({
  accountId,
  workerName,
  schedule,
  verification = false,
  declareSecrets = true,
  run = runNpx
}) {
  validateTarget(accountId, workerName);
  const workspace = createWorkspace({
    accountId,
    workerName,
    schedule,
    verification,
    declareSecrets
  });

  try {
    const result = run(
      WRANGLER_PACKAGE,
      "wrangler",
      ["deploy", "--config", workspace.configPath, "--strict"],
      {
        cwd: workspace.directory,
        displayName: verification
          ? "Cloudflare verification Worker deploy"
          : "Cloudflare scheduled Worker deploy",
        timeoutMs: 120_000
      }
    );

    return {
      workersDevUrl: verification
        ? parseWorkersDevUrl(`${result.stdout}\n${result.stderr}`, workerName)
        : null
    };
  } finally {
    fs.rmSync(workspace.directory, { recursive: true, force: true });
  }
}

export function putWorkerSecret({
  accountId,
  workerName,
  key,
  value,
  run = runNpx
}) {
  validateTarget(accountId, workerName);
  validateSecret(key, value);

  return run(
    WRANGLER_PACKAGE,
    "wrangler",
    ["secret", "put", key, "--name", workerName],
    {
      displayName: `Cloudflare secret ${key}`,
      env: { CLOUDFLARE_ACCOUNT_ID: accountId },
      input: `${value}\n`,
      secrets: [value],
      timeoutMs: 120_000
    }
  );
}

export function deleteWorkerSecret({
  accountId,
  workerName,
  key,
  run = runNpx
}) {
  validateTarget(accountId, workerName);
  if (!SECRET_KEYS.has(key)) {
    throw new Error("Refusing to delete an unknown Cloudflare secret.");
  }

  return run(
    WRANGLER_PACKAGE,
    "wrangler",
    ["secret", "delete", key, "--name", workerName],
    {
      displayName: `Cloudflare secret removal ${key}`,
      env: { CLOUDFLARE_ACCOUNT_ID: accountId },
      input: "y\n",
      timeoutMs: 120_000
    }
  );
}

export async function verifyDeployedWorker({
  workersDevUrl,
  verifySecret,
  fetchImpl = fetch
}) {
  const endpoint = verificationEndpoint(workersDevUrl);
  if (typeof verifySecret !== "string" || verifySecret.length < 32 || /[\r\n]/.test(verifySecret)) {
    throw new Error("Invalid Cloudflare verification secret.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${verifySecret}` },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`Cloudflare verification failed with status ${response.status}.`);
    }

    const body = await response.json();
    if (body?.ok !== true) {
      throw new Error("Cloudflare verification returned an invalid response.");
    }
    return {
      ok: true,
      lastPingAt: typeof body.last_ping_at === "string" ? body.last_ping_at : null,
      pingCount: Number.isSafeInteger(body.ping_count) ? body.ping_count : null
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function parseWorkersDevUrl(output, workerName) {
  if (!WORKER_NAME.test(workerName ?? "")) {
    throw new Error("Invalid Cloudflare Worker name.");
  }

  const matches = String(output).match(/https:\/\/[a-z0-9.-]+\.workers\.dev\/?/gi) ?? [];
  for (const candidate of matches) {
    const url = new URL(candidate);
    if (url.protocol === "https:"
        && url.hostname.endsWith(".workers.dev")
        && url.hostname.split(".")[0] === workerName) {
      return url.origin;
    }
  }
  throw new Error("Wrangler did not report the expected verification URL.");
}

function createWorkspace({
  accountId,
  workerName,
  schedule,
  verification,
  declareSecrets
}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "supacron-worker-"));
  const sourceDirectory = path.join(directory, "src");
  const sourcePath = path.join(sourceDirectory, "index.js");
  const configPath = path.join(directory, "wrangler.json");

  try {
    fs.chmodSync(directory, 0o700);
    fs.mkdirSync(sourceDirectory, { mode: 0o700 });
    const config = JSON.parse(createWranglerConfig({
      name: workerName,
      schedule,
      verification,
      declareSecrets
    }));
    config.account_id = accountId;

    fs.writeFileSync(sourcePath, createWorkerSource({ verification }), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });

    return { directory, sourcePath, configPath };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function verificationEndpoint(workersDevUrl) {
  let url;
  try {
    url = new URL(workersDevUrl);
  } catch {
    throw new Error("Invalid Cloudflare verification URL.");
  }
  if (url.protocol !== "https:" || !url.hostname.endsWith(".workers.dev")) {
    throw new Error("Invalid Cloudflare verification URL.");
  }
  url.pathname = "/__supacron/verify";
  url.search = "";
  url.hash = "";
  return url;
}

function validateTarget(accountId, workerName) {
  if (!ACCOUNT_ID.test(accountId ?? "")) {
    throw new Error("Invalid Cloudflare account ID.");
  }
  if (!WORKER_NAME.test(workerName ?? "")) {
    throw new Error("Invalid Cloudflare Worker name.");
  }
}

function validateSecret(key, value) {
  if (!SECRET_KEYS.has(key)) {
    throw new Error("Refusing to write an unknown Cloudflare secret.");
  }
  if (typeof value !== "string" || value.length < 8 || /[\r\n]/.test(value)) {
    throw new Error(`Invalid value for Cloudflare secret ${key}.`);
  }
}
