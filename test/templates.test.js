import test from "node:test";
import assert from "node:assert/strict";
import {
  cloudflareWorker,
  githubWorkflow,
  migrationSql,
  vercelJson,
  vercelRoute
} from "../src/templates.js";

test("migration creates public RPC and private heartbeat schema", () => {
  const sql = migrationSql({ secret: "abc'123" });

  assert.match(sql, /create schema if not exists supacron/);
  assert.match(sql, /create or replace function public\.supacron_ping/);
  assert.match(sql, /grant execute on function public\.supacron_ping\(text, text\) to anon, authenticated/);
  assert.match(sql, /'abc''123'/);
});

test("github workflow calls Supabase RPC using secrets", () => {
  const workflow = githubWorkflow({ schedule: "0 6 * * *" });

  assert.match(workflow, /cron: "0 6 \* \* \*"/);
  assert.match(workflow, /secrets\.SUPABASE_URL/);
  assert.match(workflow, /rest\/v1\/rpc\/supacron_ping/);
});

test("cloudflare worker has scheduled handler", () => {
  const worker = cloudflareWorker();

  assert.match(worker, /async scheduled/);
  assert.match(worker, /cloudflare-cron/);
  assert.match(worker, /CRON_SECRET/);
});

test("vercel generator creates cron config and API route", () => {
  const config = JSON.parse(vercelJson({ schedule: "0 6 * * *" }));
  const route = vercelRoute();

  assert.equal(config.crons[0].path, "/api/supacron");
  assert.equal(config.crons[0].schedule, "0 6 * * *");
  assert.match(route, /process\.env\.CRON_SECRET/);
  assert.match(route, /vercel-cron/);
});
