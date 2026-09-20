import test from "node:test";
import assert from "node:assert/strict";

import {
  createHeartbeatVerificationSql,
  createStructureVerificationSql,
  createUninstallVerificationSql,
  parseHeartbeatVerificationJson,
  parseStructureVerificationJson,
  parseUninstallVerificationJson,
  verifyHeartbeat,
  verifyStructure,
  verifyUninstalled,
} from "../src/supabase/verify.js";

test("structure verification SQL checks only Supacron-owned objects", () => {
  const sql = createStructureVerificationSql();

  assert.match(sql, /information_schema\.tables/);
  assert.match(sql, /supacron/);
  assert.match(sql, /heartbeat/);
  assert.match(sql, /supacron_ping/);
  assert.doesNotMatch(sql, /drop|alter|create|insert|update|delete/i);
});

test("parseStructureVerificationJson normalizes Supabase boolean formats", () => {
  assert.deepEqual(
    parseStructureVerificationJson(
      JSON.stringify([
        {
          heartbeat_table_exists: "t",
          ping_function_exists: true,
          heartbeat_policy_exists: 1,
        },
      ]),
    ),
    {
      heartbeatTable: true,
      pingFunction: true,
      heartbeatPolicy: true,
      ok: true,
    },
  );

  assert.equal(
    parseStructureVerificationJson(
      JSON.stringify([
        {
          heartbeat_table_exists: true,
          ping_function_exists: false,
          heartbeat_policy_exists: true,
        },
      ]),
    ).ok,
    false,
  );
});

test("parseStructureVerificationJson accepts current Supabase CLI rows wrapper", () => {
  assert.deepEqual(
    parseStructureVerificationJson(
      JSON.stringify({
        rows: [
          {
            heartbeat_table_exists: true,
            ping_function_exists: true,
            heartbeat_policy_exists: true,
          },
        ],
        warning: "untrusted data warning",
      }),
    ),
    {
      heartbeatTable: true,
      pingFunction: true,
      heartbeatPolicy: true,
      ok: true,
    },
  );
});

test("parseStructureVerificationJson fails closed on malformed data", () => {
  assert.throws(() => parseStructureVerificationJson("{}"), /expected a JSON array or rows array/);
  assert.throws(() => parseStructureVerificationJson("[]"), /exactly one row/);
  assert.throws(
    () =>
      parseStructureVerificationJson(
        JSON.stringify([
          {
            heartbeat_table_exists: "yes",
            ping_function_exists: true,
            heartbeat_policy_exists: true,
          },
        ]),
      ),
    /non-boolean/,
  );
});

test("heartbeat verification SQL reads only the Cloudflare source row", () => {
  const sql = createHeartbeatVerificationSql();

  assert.match(sql, /from supacron\.heartbeat/);
  assert.match(sql, /last_source as source/);
  assert.match(sql, /where last_source = 'cloudflare-cron'/);
  assert.doesNotMatch(sql, /drop|alter|create|insert|update|delete/i);
});

test("parseHeartbeatVerificationJson reports row presence without exposing secrets", () => {
  assert.deepEqual(parseHeartbeatVerificationJson(JSON.stringify({ rows: [] })), {
    ok: false,
    source: "cloudflare-cron",
    lastPingAt: null,
    pingCount: 0,
  });

  assert.deepEqual(
    parseHeartbeatVerificationJson(
      JSON.stringify([
        {
          source: "cloudflare-cron",
          last_ping_at: "2026-09-14T15:12:00.000Z",
          ping_count: "2",
        },
      ]),
    ),
    {
      ok: true,
      source: "cloudflare-cron",
      lastPingAt: "2026-09-14T15:12:00.000Z",
      pingCount: 2,
    },
  );
});

test("parseHeartbeatVerificationJson normalizes Postgres timestamps to ISO", () => {
  assert.deepEqual(
    parseHeartbeatVerificationJson(
      JSON.stringify([
        {
          source: "cloudflare-cron",
          last_ping_at: "2026-09-15 12:34:56.789+00",
          ping_count: "3",
        },
      ]),
    ),
    {
      ok: true,
      source: "cloudflare-cron",
      lastPingAt: "2026-09-15T12:34:56.789Z",
      pingCount: 3,
    },
  );
});

test("parseHeartbeatVerificationJson rejects invalid heartbeat timestamps", () => {
  assert.deepEqual(
    parseHeartbeatVerificationJson(
      JSON.stringify([
        {
          source: "cloudflare-cron",
          last_ping_at: "not a timestamp",
          ping_count: "3",
        },
      ]),
    ),
    {
      ok: false,
      source: "cloudflare-cron",
      lastPingAt: null,
      pingCount: 3,
    },
  );
});

test("uninstall verification checks every Supacron-owned database object", () => {
  const sql = createUninstallVerificationSql();

  assert.match(sql, /pg_namespace/);
  assert.match(sql, /supacron\.heartbeat/);
  assert.match(sql, /public\.supacron_ping\(text\)/);
  assert.match(sql, /pg_policies/);
  assert.doesNotMatch(sql, /drop|alter|create|insert|update|delete/i);
});

test("parseUninstallVerificationJson succeeds only when all objects are absent", () => {
  assert.deepEqual(
    parseUninstallVerificationJson(JSON.stringify([{
      supacron_schema_exists: false,
      heartbeat_table_exists: "f",
      ping_function_exists: 0,
      heartbeat_policy_exists: false,
    }])),
    {
      supacronSchema: false,
      heartbeatTable: false,
      pingFunction: false,
      heartbeatPolicy: false,
      ok: true,
    },
  );

  assert.equal(
    parseUninstallVerificationJson(JSON.stringify([{
      supacron_schema_exists: true,
      heartbeat_table_exists: false,
      ping_function_exists: false,
      heartbeat_policy_exists: false,
    }])).ok,
    false,
  );
});

test("verify helpers execute the expected SQL against the selected project", () => {
  const calls = [];
  const execute = (request) => {
    calls.push(request);
    return {
      stdout: JSON.stringify([
        request.operation.includes("structure")
          ? {
              heartbeat_table_exists: true,
              ping_function_exists: true,
              heartbeat_policy_exists: true,
            }
          : request.operation.includes("uninstall")
            ? {
                supacron_schema_exists: false,
                heartbeat_table_exists: false,
                ping_function_exists: false,
                heartbeat_policy_exists: false,
              }
          : {
              source: "cloudflare-cron",
              last_ping_at: "2026-09-14T15:12:00.000Z",
              ping_count: 1,
            },
      ]),
    };
  };

  assert.equal(verifyStructure({ projectRef: "abcdefghijklmnopqrst", execute }).ok, true);
  assert.equal(verifyHeartbeat({ projectRef: "abcdefghijklmnopqrst", execute }).ok, true);
  assert.equal(verifyUninstalled({ projectRef: "abcdefghijklmnopqrst", execute }).ok, true);
  assert.equal(calls[0].projectRef, "abcdefghijklmnopqrst");
  assert.match(calls[0].sql, /information_schema/);
  assert.match(calls[1].sql, /supacron\.heartbeat/);
  assert.match(calls[2].sql, /pg_namespace/);
});
