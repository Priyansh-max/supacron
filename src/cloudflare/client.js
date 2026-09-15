import { AUTH_TIMEOUT_MS, WRANGLER_PACKAGE } from "../constants.js";
import { CommandError, runNpx } from "../lib/command.js";

const ACCOUNT_ID = /^[a-f0-9]{32}$/;
const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const LOGIN_SCOPES = ["account:read", "user:read", "workers_scripts:write"];

export class CloudflareAuthRequiredError extends Error {
  constructor() {
    super("Cloudflare login is required.");
    this.name = "CloudflareAuthRequiredError";
  }
}

export function parseAccountsJson(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Wrangler returned invalid account JSON.");
  }

  const candidates = Array.isArray(parsed.accounts)
    ? parsed.accounts
    : parsed.account && typeof parsed.account === "object"
      ? [parsed.account]
      : [];

  return candidates.map((account) => {
    if (!ACCOUNT_ID.test(account.id ?? "")) {
      throw new Error("Wrangler returned an invalid Cloudflare account ID.");
    }
    return {
      id: account.id,
      name: cleanLabel(account.name, "Cloudflare account")
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

export function listAccounts({ run = runNpx } = {}) {
  try {
    const result = run(
      WRANGLER_PACKAGE,
      "wrangler",
      ["whoami", "--json"],
      { displayName: "Cloudflare account discovery" }
    );
    return parseAccountsJson(result.stdout);
  } catch (error) {
    if (error instanceof CommandError && isAuthenticationFailure(error.stderr)) {
      throw new CloudflareAuthRequiredError();
    }
    throw error;
  }
}

export function login({ run = runNpx } = {}) {
  return run(
    WRANGLER_PACKAGE,
    "wrangler",
    [
      "login",
      "--device",
      "--use-keyring",
      "--scopes",
      ...LOGIN_SCOPES
    ],
    {
      displayName: "Cloudflare device login",
      interactive: true,
      timeoutMs: AUTH_TIMEOUT_MS
    }
  );
}

export function logout({ run = runNpx } = {}) {
  return run(
    WRANGLER_PACKAGE,
    "wrangler",
    ["logout"],
    {
      displayName: "Cloudflare logout",
      interactive: true,
      timeoutMs: AUTH_TIMEOUT_MS
    }
  );
}

export function cloudflareWorkerUrl(accountId, workerName) {
  if (!ACCOUNT_ID.test(accountId ?? "")) {
    throw new Error("Invalid Cloudflare account ID.");
  }
  if (!WORKER_NAME.test(workerName ?? "")) {
    throw new Error("Invalid Cloudflare Worker name.");
  }
  return `https://dash.cloudflare.com/${accountId}/workers/services/view/${workerName}`;
}

function cleanLabel(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return cleaned.slice(0, 100) || fallback;
}

function isAuthenticationFailure(stderr) {
  return /not logged in|auth token|expired|CLOUDFLARE_API_TOKEN|unauthorized/i.test(stderr);
}
