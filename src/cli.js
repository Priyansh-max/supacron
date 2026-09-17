#!/usr/bin/env node

import { init } from "./init.js";
import { createIssueUrl } from "./issue.js";
import { logoutSessions } from "./logout.js";
import { repair, status, uninstall } from "./lifecycle.js";
import { testInstallation } from "./test.js";

const command = process.argv[2] ?? "help";
const args = process.argv.slice(3);

try {
  if (command === "setup" || command === "init") {
    await init(args);
  } else if (command === "status") {
    await status(args);
  } else if (command === "repair") {
    await repair(args);
  } else if (command === "test") {
    await testInstallation(args);
  } else if (command === "uninstall") {
    await uninstall(args);
  } else if (command === "logout") {
    await logoutSessions(args);
  } else if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
  } else {
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`\n${error.message}`);
  const details = [error.stderr, error.stdout].filter(Boolean).join("\n").trim();
  if (details) {
    console.error(details);
  }
  console.error("\nStill stuck? Open a prefilled GitHub issue:");
  console.error(createIssueUrl({ command, args, error, details }));
  process.exitCode = 1;
}

function printHelp() {
  console.log(`supacron

Usage:
  npx supacron init
  npx supacron test
  npx supacron status
  npx supacron repair
  npx supacron uninstall
  npx supacron logout
  npx supacron help

Setup options:
  npx supacron init --mode automatic|manual
  npx supacron init --project-ref <ref> --account-id <id>
  npx supacron init --session remember|logout

Commands:
  init       End-to-end Supabase heartbeat + Cloudflare Workers Cron setup.
  setup      Alias for init.
  test       Run a live Worker heartbeat proof, then restore scheduled-only mode.
  status     Check the saved Supacron install receipt and Supabase heartbeat objects.
  repair     Redeploy the final private Worker from the saved install receipt.
  uninstall  Remove the Worker, Supacron-owned database objects, and local receipt after approval.
  logout     Sign out of both official CLI sessions: Supabase CLI and Cloudflare Wrangler.
  help       Show this command list.

Supacron never asks for database passwords, connection strings, service-role keys, Supabase access tokens, or Cloudflare API tokens.
`);
}
