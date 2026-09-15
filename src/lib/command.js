import { spawnSync } from "node:child_process";

const PACKAGE_SPEC = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+@[0-9]+\.[0-9]+\.[0-9]+$/i;

export class CommandError extends Error {
  constructor(message, { exitCode = null, stdout = "", stderr = "" } = {}) {
    super(message);
    this.name = "CommandError";
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

export function platformCommand(command) {
  return process.platform === "win32" ? `${command}.cmd` : command;
}

export function redactText(value, secrets = []) {
  let redacted = String(value ?? "");

  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 0) {
      redacted = redacted.replaceAll(secret, "[REDACTED]");
    }
  }

  return redacted
    .replace(/\b(?:sbp|sb_secret)_[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(
      /(SUPABASE_(?:ACCESS_TOKEN|DB_PASSWORD|SECRET_KEY|SERVICE_ROLE_KEY)\s*[=:]\s*)[^\s]+/gi,
      "$1[REDACTED]"
    );
}

export function runCommand(command, args = [], options = {}) {
  const {
    cwd = process.cwd(),
    displayName = command,
    env,
    input,
    interactive = false,
    secrets = [],
    timeoutMs = 60_000,
    rawStdout = false
  } = options;

  if (interactive && input !== undefined) {
    throw new Error("Interactive commands cannot receive piped input.");
  }

  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
    input,
    shell: shouldUseShell(command),
    stdio: interactive ? "inherit" : ["pipe", "pipe", "pipe"],
    timeout: timeoutMs,
    windowsHide: true
  });

  const stdout = redactText(result.stdout, secrets);
  const stderr = redactText(result.stderr, secrets);

  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      throw new CommandError(`${displayName} timed out.`, { stdout, stderr });
    }
    throw new CommandError(`${displayName} could not start: ${result.error.message}`, { stdout, stderr });
  }

  if (result.status !== 0) {
    throw new CommandError(`${displayName} failed with exit code ${result.status}.`, {
      exitCode: result.status,
      stdout,
      stderr
    });
  }

  return { stdout: rawStdout ? result.stdout : stdout, stderr, exitCode: result.status };
}

function shouldUseShell(command) {
  return process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
}

export function runNpx(packageSpec, binary, args = [], options = {}) {
  if (!PACKAGE_SPEC.test(packageSpec)) {
    throw new Error(`Refusing unpinned npm package: ${packageSpec}`);
  }

  return runCommand(
    platformCommand("npx"),
    ["--yes", "--package", packageSpec, "--", binary, ...args],
    options
  );
}
