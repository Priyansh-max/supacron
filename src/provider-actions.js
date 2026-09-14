import { spawnSync } from "node:child_process";
import path from "node:path";

export function providerCliStatus(provider) {
  if (provider === "github") {
    return commandAvailable("gh", ["--version"]);
  }

  if (provider === "vercel") {
    return commandAvailable(platformCommand("vercel"), ["--version"]);
  }

  if (provider === "cloudflare") {
    return commandAvailable(platformCommand("npx"), ["wrangler", "--version"]);
  }

  return false;
}

export function installProvider({ provider, supabaseUrl, supabaseAnonKey, supacronSecret, cronSecret, repo }) {
  if (provider === "github") {
    setGitHubSecret("SUPABASE_URL", supabaseUrl, repo);
    setGitHubSecret("SUPABASE_ANON_KEY", supabaseAnonKey, repo);
    setGitHubSecret("SUPACRON_SECRET", supacronSecret, repo);
    return;
  }

  if (provider === "cloudflare") {
    const cwd = path.join(process.cwd(), "supacron-cloudflare");
    setWranglerSecret("SUPABASE_URL", supabaseUrl, cwd);
    setWranglerSecret("SUPABASE_ANON_KEY", supabaseAnonKey, cwd);
    setWranglerSecret("SUPACRON_SECRET", supacronSecret, cwd);
    setWranglerSecret("CRON_SECRET", cronSecret, cwd);
    runChecked(platformCommand("npx"), ["wrangler", "deploy"], { cwd });
    return;
  }

  if (provider === "vercel") {
    setVercelEnv("SUPABASE_URL", supabaseUrl);
    setVercelEnv("SUPABASE_ANON_KEY", supabaseAnonKey);
    setVercelEnv("SUPACRON_SECRET", supacronSecret);
    setVercelEnv("CRON_SECRET", cronSecret);
    runChecked(platformCommand("vercel"), ["deploy", "--prod"], { cwd: process.cwd() });
  }
}

function setGitHubSecret(name, value, repo) {
  const args = ["secret", "set", name, "--body", value];
  if (repo) {
    args.push("--repo", repo);
  }
  runChecked("gh", args, { cwd: process.cwd() });
}

function setWranglerSecret(name, value, cwd) {
  runChecked(platformCommand("npx"), ["wrangler", "secret", "put", name], {
    cwd,
    input: `${value}\n`
  });
}

function setVercelEnv(name, value) {
  runChecked(platformCommand("vercel"), ["env", "add", name, "production"], {
    cwd: process.cwd(),
    input: `${value}\n`
  });
}

function commandAvailable(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: "ignore",
    shell: false
  });
  return result.status === 0;
}

function runChecked(command, args, options) {
  const result = spawnSync(command, args, {
    ...options,
    encoding: "utf8",
    stdio: options.input ? ["pipe", "inherit", "inherit"] : "inherit",
    shell: false
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function platformCommand(command) {
  return process.platform === "win32" ? `${command}.cmd` : command;
}
