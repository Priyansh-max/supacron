#!/usr/bin/env node

import { init } from "./init.js";
import { repair, status, uninstall } from "./lifecycle.js";

const command = process.argv[2] ?? "help";
const args = process.argv.slice(3);

try {
  if (command === "init") {
    await init(args);
  } else if (command === "setup") {
    throw new Error("The setup command has been replaced by `supacron init`.");
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
  process.exitCode = 1;
}

function printHelp() {
  console.log(`supacron

Usage:
  supacron init
  supacron init --mode manual|automatic|observe
  supacron init --project-ref <ref> --account-id <id>
  supacron status --project-ref <ref>
  supacron uninstall --project-ref <ref>
  supacron repair --project-ref <ref>

Commands:
  init     Securely set up Supabase heartbeat + Cloudflare Workers Cron.
  status   Verify a saved Supacron installation without local secrets.
  uninstall Remove the Worker, Supabase objects, and local manifest after approval.
  repair   Redeploy the scheduled Worker config from the saved manifest.

Init never asks for database passwords, connection strings, service-role keys, Supabase access tokens, or Cloudflare API tokens.
`);
}
