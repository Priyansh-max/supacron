#!/usr/bin/env node

import { init } from "./init.js";
import { repair, status, uninstall } from "./lifecycle.js";

const command = process.argv[2] ?? "help";
const args = process.argv.slice(3);

try {
  if (command === "setup" || command === "init") {
    await init(args);
  } else if (command === "status") {
    await status(args);
  } else if (command === "repair") {
    await repair(args);
  } else if (command === "uninstall") {
    await uninstall(args);
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
  process.exitCode = 1;
}

function printHelp() {
  console.log(`supacron

Usage:
  supacron setup
  supacron setup --mode automatic|manual
  supacron setup --project-ref <ref> --account-id <id>
  supacron setup --cleanup keep|temp|all --logout none|supabase|cloudflare|all
  supacron status --project-ref <ref>
  supacron uninstall --project-ref <ref>
  supacron repair --project-ref <ref>

Commands:
  setup    End-to-end guided Supabase heartbeat + Cloudflare Workers Cron installer.
  init     Alias for setup.
  status   Verify a saved Supacron installation without local secrets.
  uninstall Remove the Worker, Supabase objects, and local manifest after approval.
  repair   Redeploy the scheduled Worker config from the saved manifest.

Setup never asks for database passwords, connection strings, service-role keys, Supabase access tokens, or Cloudflare API tokens.
After setup, Supacron can remove local helper files and logout official CLI sessions on request.
`);
}
