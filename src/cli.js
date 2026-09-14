#!/usr/bin/env node

import { doctor } from "./doctor.js";
import { init } from "./init.js";
import { status } from "./lifecycle.js";
import { ping } from "./ping.js";

const command = process.argv[2] ?? "help";
const args = process.argv.slice(3);

try {
  if (command === "init") {
    await init(args);
  } else if (command === "setup") {
    throw new Error("The setup command has been replaced by `supacron init`.");
  } else if (command === "status") {
    await status(args);
  } else if (command === "ping") {
    await ping(args);
  } else if (command === "doctor") {
    await doctor(args);
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
  supacron ping [--url <supabase-url>] [--key <anon-key>] [--secret <secret>]
  supacron doctor [--url <supabase-url>] [--key <anon-key>] [--secret <secret>]

Commands:
  init     Securely set up Supabase heartbeat + Cloudflare Workers Cron.
  status   Verify a saved Supacron installation without local secrets.
  ping     Call the Supabase heartbeat RPC once.
  doctor   Check local config/env and verify the heartbeat RPC.

Init never asks for database passwords, connection strings, service-role keys, Supabase access tokens, or Cloudflare API tokens.
`);
}
