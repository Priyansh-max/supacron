import { executeProjectSql } from "./query.js";

const STRUCTURE_SQL = `
select
  exists (
    select 1
    from information_schema.tables
    where table_schema = 'supacron'
      and table_name = 'heartbeat'
  ) as heartbeat_table_exists,
  exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'supacron_ping'
  ) as ping_function_exists,
  exists (
    select 1
    from pg_policies
    where schemaname = 'supacron'
      and tablename = 'heartbeat'
  ) as heartbeat_policy_exists;
`;

const HEARTBEAT_SQL = `
select
  last_source as source,
  last_ping_at,
  ping_count
from supacron.heartbeat
where last_source = 'cloudflare-cron'
limit 1;
`;

export function createStructureVerificationSql() {
  return STRUCTURE_SQL.trim();
}

export function createHeartbeatVerificationSql() {
  return HEARTBEAT_SQL.trim();
}

export function parseStructureVerificationJson(raw) {
  const row = firstRow(raw, "Supabase structure verification");
  const result = {
    heartbeatTable: toBoolean(row.heartbeat_table_exists),
    pingFunction: toBoolean(row.ping_function_exists),
    heartbeatPolicy: toBoolean(row.heartbeat_policy_exists),
  };

  return {
    ...result,
    ok: result.heartbeatTable && result.pingFunction && result.heartbeatPolicy,
  };
}

export function parseHeartbeatVerificationJson(raw) {
  const rows = rowsFromJson(raw, "Supabase heartbeat verification");
  if (rows.length === 0) {
    return {
      ok: false,
      source: "cloudflare-cron",
      lastPingAt: null,
      pingCount: 0,
    };
  }

  const row = rows[0];
  const pingCount = Number(row.ping_count);

  return {
    ok:
      row.source === "cloudflare-cron" &&
      typeof row.last_ping_at === "string" &&
      Number.isSafeInteger(pingCount) &&
      pingCount > 0,
    source: row.source === "cloudflare-cron" ? row.source : null,
    lastPingAt: typeof row.last_ping_at === "string" ? row.last_ping_at : null,
    pingCount: Number.isSafeInteger(pingCount) ? pingCount : 0,
  };
}

export function verifyStructure({ projectRef, execute = executeProjectSql }) {
  const result = execute({
    projectRef,
    sql: createStructureVerificationSql(),
    operation: "Supabase structure verification",
  });

  return parseStructureVerificationJson(result.stdout);
}

export function verifyHeartbeat({ projectRef, execute = executeProjectSql }) {
  const result = execute({
    projectRef,
    sql: createHeartbeatVerificationSql(),
    operation: "Supabase heartbeat verification",
  });

  return parseHeartbeatVerificationJson(result.stdout);
}

function firstRow(raw, label) {
  const rows = rowsFromJson(raw, label);
  if (rows.length !== 1) {
    throw new Error(`${label} expected exactly one row.`);
  }

  return rows[0];
}

function rowsFromJson(raw, label) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }

  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (parsed && Array.isArray(parsed.rows)) {
    return parsed.rows;
  }

  throw new Error(`${label} expected a JSON array or rows array.`);
}

function toBoolean(value) {
  if (value === true || value === "t" || value === "true" || value === 1) {
    return true;
  }

  if (value === false || value === "f" || value === "false" || value === 0) {
    return false;
  }

  throw new Error("Supabase verification returned a non-boolean field.");
}
