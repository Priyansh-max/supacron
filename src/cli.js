#!/usr/bin/env node

import { doctor } from "./doctor.js";
import { ping } from "./ping.js";
import { setup } from "./setup.js";

const command = process.argv[2] ?? "help";
const args = process.argv.slice(3);

try {
  if (command === "setup" || command === "init") {
    await setup(args);
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
  supacron setup [--cron cloudflare|github|vercel] [--install] [--yes]
  supacron ping [--url <supabase-url>] [--key <anon-key>] [--secret <secret>]
  supacron doctor [--url <supabase-url>] [--key <anon-key>] [--secret <secret>]

Commands:
  setup    Generate Supabase heartbeat SQL and free cron provider files.
  ping     Call the Supabase heartbeat RPC once.
  doctor   Check local config/env and verify the heartbeat RPC.
`);
}
