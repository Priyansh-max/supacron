#!/usr/bin/env node

import { init } from "./init.js";
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
  supacron setup --session remember|logout
  supacron test
  supacron test --project-ref <ref>

Commands:
  setup    End-to-end guided Supabase heartbeat + Cloudflare Workers Cron installer.
  init     Alias for setup.
  test     Run a live deployed Worker heartbeat proof, then restore the private scheduled Worker.

Setup never asks for database passwords, connection strings, service-role keys, Supabase access tokens, or Cloudflare API tokens.
After setup, Supacron removes its temporary setup workspace. You can choose whether official CLI sessions stay remembered or get logged out.
`);
}
