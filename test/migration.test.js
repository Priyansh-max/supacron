import test from "node:test";
import assert from "node:assert/strict";
import {
  createInstallationSql,
  createUninstallSql,
  heartbeatSecretHash
} from "../src/supabase/migration.js";

test("migration stores a digest instead of the heartbeat secret", () => {
  const secret = "a-secret-value-that-is-longer-than-32-characters";
  const secretHash = heartbeatSecretHash(secret);
  const sql = createInstallationSql({ secretHash });

  assert.equal(secretHash.length, 64);
  assert.doesNotMatch(sql, new RegExp(secret));
  assert.match(sql, new RegExp(secretHash));
  assert.match(sql, /extensions\.digest/);
});

test("migration repairs Supacron-owned partial installs but rejects schema collisions", () => {
  const sql = createInstallationSql({ secretHash: "a".repeat(64) });

  assert.match(sql, /to_regnamespace\('supacron'\)/);
  assert.match(sql, /to_regclass\('supacron\.heartbeat'\)/);
  assert.match(sql, /Supacron schema already exists but supacron\.heartbeat is missing/);
  assert.match(sql, /create schema if not exists supacron/);
  assert.match(sql, /create table if not exists supacron\.heartbeat/);
  assert.match(sql, /create or replace function public\.supacron_ping/);
});

test("security definer function uses qualified names and narrow grants", () => {
  const sql = createInstallationSql({ secretHash: "b".repeat(64) });

  assert.match(sql, /security definer\nset search_path = ''/);
  assert.match(sql, /update supacron\.heartbeat/);
  assert.match(sql, /pg_catalog\.now\(\)/);
  assert.match(sql, /revoke all on function public\.supacron_ping\(text\) from public, anon, authenticated/);
  assert.match(sql, /grant execute on function public\.supacron_ping\(text\) to anon, authenticated/);
  assert.match(sql, /create policy supacron_no_direct_access/);
  assert.match(sql, /using \(false\)/);
  assert.doesNotMatch(sql, /p_source/);
});

test("migration rejects malformed hashes and short secrets", () => {
  assert.throws(
    () => createInstallationSql({ secretHash: "not-a-hash" }),
    /lowercase SHA-256/
  );
  assert.throws(() => heartbeatSecretHash("short"), /at least 32/);
});

test("uninstall SQL removes only Supacron-owned database objects", () => {
  const sql = createUninstallSql();

  assert.match(sql, /drop function if exists public\.supacron_ping\(text\)/);
  assert.match(sql, /drop table if exists supacron\.heartbeat/);
  assert.match(sql, /drop schema if exists supacron/);
  assert.doesNotMatch(sql, /cascade/i);
});
