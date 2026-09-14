import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MANIFEST_SCHEMA_VERSION = 1;
const APP_DIR_NAME = "supacron";

const SECRET_FIELD_PATTERN =
  /access.?token|api.?token|authorization|bearer|connection.?string|database.?url|db.?password|jwt|password|private.?key|publishable.?key|refresh.?token|secret.?value|service.?role|token.?value/i;

const SECRET_VALUE_PATTERNS = [
  /^sb_secret_/i,
  /^sb_publishable_/i,
  /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/,
  /^postgres(?:ql)?:\/\//i,
  /^https:\/\/api\.supabase\.com\/v1\/oauth\/token/i,
  /^[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{16,}$/,
];

const SETUP_MODES = new Set(["observe", "manual", "automatic"]);
const VERIFICATION_STATUSES = new Set(["pending", "verified", "failed", "unknown"]);

export function defaultManifestDir({
  env = process.env,
  platform = process.platform,
  homeDir = os.homedir(),
} = {}) {
  if (env.SUPACRON_CONFIG_DIR) {
    return path.resolve(env.SUPACRON_CONFIG_DIR);
  }

  if (platform === "win32") {
    const base = env.LOCALAPPDATA || env.APPDATA || path.join(homeDir, "AppData", "Local");
    return path.join(base, APP_DIR_NAME);
  }

  if (platform === "darwin") {
    return path.join(homeDir, "Library", "Application Support", APP_DIR_NAME);
  }

  const base = env.XDG_CONFIG_HOME || path.join(homeDir, ".config");
  return path.join(base, APP_DIR_NAME);
}

export function manifestPath(projectRef, options = {}) {
  assertProjectRef(projectRef);
  const rootDir = options.rootDir || defaultManifestDir(options);
  return path.join(rootDir, "installations", `${projectRef}.json`);
}

export function createManifest(input) {
  const now = input.now || new Date().toISOString();
  assertIsoTimestamp(now, "now");
  assertProjectRef(input.projectRef);
  assertNonEmpty(input.workerName, "workerName");
  assertNonEmpty(input.cloudflareAccountId, "cloudflareAccountId");
  assertCron(input.schedule);
  assertSetupMode(input.setupMode);

  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    createdAt: now,
    updatedAt: now,
    supabase: {
      projectRef: input.projectRef,
      name: optionalString(input.projectName),
      region: optionalString(input.region),
      organizationId: optionalString(input.organizationId),
      dashboardUrl: optionalUrl(input.supabaseDashboardUrl),
      projectUrl: optionalUrl(input.supabaseProjectUrl),
    },
    database: {
      schema: "supacron",
      table: "heartbeat",
      rpc: "public.supacron_ping",
      setupMode: input.setupMode,
      verifiedAt: optionalIsoTimestamp(input.databaseVerifiedAt, "databaseVerifiedAt"),
    },
    cloudflare: {
      accountId: input.cloudflareAccountId,
      accountName: optionalString(input.cloudflareAccountName),
      workerName: input.workerName,
      workerUrl: optionalUrl(input.workerUrl),
      schedule: input.schedule,
      dashboardUrl: optionalUrl(input.cloudflareDashboardUrl),
      deployedAt: optionalIsoTimestamp(input.deployedAt, "deployedAt"),
    },
    security: {
      localSecretStorage: false,
      workerSecretBindings: [
        "SUPABASE_URL",
        "SUPABASE_PUBLISHABLE_KEY",
        "SUPACRON_HEARTBEAT_SECRET",
      ],
    },
    verification: {
      status: input.verificationStatus || "pending",
      lastCheckedAt: optionalIsoTimestamp(input.lastCheckedAt, "lastCheckedAt"),
      lastHeartbeatAt: optionalIsoTimestamp(input.lastHeartbeatAt, "lastHeartbeatAt"),
    },
  };

  return validateManifest(manifest);
}

export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Manifest must be an object.");
  }

  assertNoSecretMaterial(manifest);

  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error(`Unsupported manifest schema version: ${manifest.schemaVersion}`);
  }

  assertIsoTimestamp(manifest.createdAt, "createdAt");
  assertIsoTimestamp(manifest.updatedAt, "updatedAt");
  assertProjectRef(manifest.supabase?.projectRef);
  assertSetupMode(manifest.database?.setupMode);
  assertCron(manifest.cloudflare?.schedule);
  assertNonEmpty(manifest.cloudflare?.accountId, "cloudflare.accountId");
  assertNonEmpty(manifest.cloudflare?.workerName, "cloudflare.workerName");

  if (!VERIFICATION_STATUSES.has(manifest.verification?.status)) {
    throw new Error(`Invalid verification status: ${manifest.verification?.status}`);
  }

  optionalUrl(manifest.supabase?.dashboardUrl);
  optionalUrl(manifest.supabase?.projectUrl);
  optionalUrl(manifest.cloudflare?.workerUrl);
  optionalUrl(manifest.cloudflare?.dashboardUrl);
  optionalIsoTimestamp(manifest.database?.verifiedAt, "database.verifiedAt");
  optionalIsoTimestamp(manifest.cloudflare?.deployedAt, "cloudflare.deployedAt");
  optionalIsoTimestamp(manifest.verification?.lastCheckedAt, "verification.lastCheckedAt");
  optionalIsoTimestamp(manifest.verification?.lastHeartbeatAt, "verification.lastHeartbeatAt");

  return pruneUndefined(manifest);
}

export async function readManifest(projectRef, options = {}) {
  const filePath = manifestPath(projectRef, options);

  try {
    const raw = await fs.readFile(filePath, "utf8");
    return validateManifest(JSON.parse(raw));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }

    if (error instanceof SyntaxError) {
      throw new Error(`Manifest is not valid JSON: ${filePath}`);
    }

    throw error;
  }
}

export async function writeManifest(manifest, options = {}) {
  const validManifest = validateManifest(manifest);
  const filePath = manifestPath(validManifest.supabase.projectRef, options);
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  const tempName = `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`;
  const tempPath = path.join(dir, tempName);
  const data = `${JSON.stringify(validManifest, null, 2)}\n`;

  await fs.writeFile(tempPath, data, { mode: 0o600, flag: "wx" });
  await fs.rename(tempPath, filePath);

  return filePath;
}

export async function deleteManifest(projectRef, options = {}) {
  const filePath = manifestPath(projectRef, options);

  try {
    await fs.unlink(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

function assertNoSecretMaterial(value, trail = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecretMaterial(entry, [...trail, String(index)]));
    return;
  }

  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (SECRET_FIELD_PATTERN.test(key)) {
        throw new Error(`Manifest cannot store sensitive field: ${[...trail, key].join(".")}`);
      }

      assertNoSecretMaterial(entry, [...trail, key]);
    }

    return;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(trimmed))) {
      throw new Error(`Manifest cannot store sensitive value at: ${trail.join(".")}`);
    }
  }
}

function assertProjectRef(value) {
  if (!/^[a-z0-9]{20}$/.test(value || "")) {
    throw new Error("Supabase project ref must be a 20 character lowercase alphanumeric value.");
  }
}

function assertNonEmpty(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string.`);
  }
}

function assertCron(value) {
  assertNonEmpty(value, "schedule");
  if (value.length > 120 || /[\r\n]/.test(value)) {
    throw new Error("Schedule must be a single cron line.");
  }
}

function assertSetupMode(value) {
  if (!SETUP_MODES.has(value)) {
    throw new Error(`Invalid setup mode: ${value}`);
  }
}

function assertIsoTimestamp(value, label) {
  assertNonEmpty(value, label);
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${label} must be an ISO timestamp.`);
  }
}

function optionalIsoTimestamp(value, label) {
  if (value == null || value === "") {
    return undefined;
  }

  assertIsoTimestamp(value, label);
  return value;
}

function optionalString(value) {
  if (value == null || value === "") {
    return undefined;
  }

  assertNonEmpty(value, "Optional string");
  return value;
}

function optionalUrl(value) {
  if (value == null || value === "") {
    return undefined;
  }

  const parsed = new URL(value);
  if (parsed.protocol !== "https:") {
    throw new Error(`URL must use HTTPS: ${value}`);
  }

  return value;
}

function pruneUndefined(value) {
  if (Array.isArray(value)) {
    return value.map(pruneUndefined);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, pruneUndefined(entry)]),
  );
}
