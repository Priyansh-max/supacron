import { parseArgs } from "./args.js";
import { readConfig } from "./config.js";
import { callHeartbeat, getRuntimeValue } from "./utils.js";

export async function doctor(args) {
  const parsed = parseArgs(args);
  const config = readConfig();
  const checks = [];

  const supabaseUrl = resolveCheck(checks, "SUPABASE_URL", parsed.values.url, config.supabaseUrl);
  const supabaseAnonKey = resolveCheck(checks, "SUPABASE_ANON_KEY", parsed.values.key);
  const secret = resolveCheck(checks, "SUPACRON_SECRET", parsed.values.secret);

  if (checks.some((check) => !check.ok)) {
    printChecks(checks);
    throw new Error("Doctor failed before network check. Missing required values.");
  }

  try {
    const result = await callHeartbeat({
      supabaseUrl,
      supabaseAnonKey,
      secret,
      source: "supacron-doctor"
    });
    checks.push({ name: "Heartbeat RPC", ok: true, detail: `ping_count=${result.ping_count ?? "unknown"}` });
  } catch (error) {
    checks.push({ name: "Heartbeat RPC", ok: false, detail: error.message });
  }

  printChecks(checks);

  if (checks.some((check) => !check.ok)) {
    throw new Error("Doctor found a problem.");
  }
}

function resolveCheck(checks, name, argValue, configValue) {
  try {
    const value = getRuntimeValue(name, argValue, configValue);
    checks.push({ name, ok: true, detail: "found" });
    return value;
  } catch {
    checks.push({ name, ok: false, detail: "missing" });
    return "";
  }
}

function printChecks(checks) {
  for (const check of checks) {
    const marker = check.ok ? "OK" : "FAIL";
    console.log(`${marker} ${check.name}: ${check.detail}`);
  }
}
