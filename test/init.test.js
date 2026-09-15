import test from "node:test";
import assert from "node:assert/strict";

import { init, ensureNodeVersion } from "../src/init.js";
import { SupabaseAuthRequiredError } from "../src/supabase/client.js";
import { CloudflareAuthRequiredError } from "../src/cloudflare/client.js";

const PROJECT = {
  ref: "abcdefghijklmnopqrst",
  name: "Production",
  region: "ap-south-1",
};

const ACCOUNT = {
  id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  name: "Personal",
};

test("ensureNodeVersion requires current Wrangler-compatible Node", () => {
  assert.doesNotThrow(() => ensureNodeVersion("20.0.0"));
  assert.doesNotThrow(() => ensureNodeVersion("22.16.0"));
  assert.throws(() => ensureNodeVersion("18.19.0"), /Node\.js 20/);
});

test("init observe mode lists project and makes no changes", async () => {
  const calls = [];
  const output = createOutput();

  const result = await init(["--mode", "observe"], {
    nodeVersion: "22.16.0",
    out: output,
    rl: createRl(["1"]),
    listSupabaseProjects: () => {
      calls.push("list-projects");
      return [PROJECT];
    },
  });

  assert.equal(result.changed, false);
  assert.deepEqual(calls, ["list-projects"]);
  assert.match(output.text(), /Observe-only report/);
  assert.doesNotMatch(output.text(), /sb_publishable_/);
});

test("init manual mode fallback prints SQL, verifies, deploys Cloudflare, and writes no secret output", async () => {
  const calls = [];
  const output = createOutput();
  const manifestWrites = [];
  const randomBytes = (length) => Buffer.alloc(length, "a");

  const result = await init(["--mode", "manual", "--approve-cloudflare", "--confirm-manual-sql"], {
    nodeVersion: "22.16.0",
    now: "2026-09-14T15:00:00.000Z",
    out: output,
    rl: createRl(["1", "1", ""]),
    randomBytes,
    listSupabaseProjects: () => [PROJECT],
    verifyDbStructure: ({ projectRef }) => {
      calls.push(["verify-structure", projectRef]);
      return { ok: true, heartbeatTable: true, pingFunction: true, heartbeatPolicy: true };
    },
    listPublishableKeys: () => ["sb_publishable_abcdefghijklmnopqrstuvwxyz"],
    listCloudflareAccounts: () => [ACCOUNT],
    deployWorker: (request) => {
      calls.push(["deploy", request.verification, request.declareSecrets]);
      return request.verification ? { workersDevUrl: "https://supacron-abcdefghijklmnopqrst.example.workers.dev" } : {};
    },
    putWorkerSecret: (request) => calls.push(["secret-put", request.key, request.value]),
    deleteWorkerSecret: (request) => calls.push(["secret-delete", request.key]),
    verifyWorker: async () => ({ ok: true, lastPingAt: "2026-09-14T15:01:00.000Z", pingCount: 1 }),
    verifyDbHeartbeat: () => ({
      ok: true,
      source: "cloudflare-cron",
      lastPingAt: "2026-09-14T15:01:00.000Z",
      pingCount: 1,
    }),
    writeInstallManifest: async (manifest) => {
      manifestWrites.push(manifest);
      return "C:\\Users\\buddy\\AppData\\Local\\supacron\\installations\\abcdefghijklmnopqrst.json";
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "manual");
  assert.equal(result.schedule, "0 0,12 * * *");
  assert.deepEqual(
    calls.filter((call) => call[0] === "deploy"),
    [
      ["deploy", true, false],
      ["deploy", true, true],
      ["deploy", false, true],
    ],
  );
  assert.deepEqual(
    calls.filter((call) => call[0] === "secret-put").map((call) => call[1]),
    [
      "SUPABASE_URL",
      "SUPABASE_PUBLISHABLE_KEY",
      "SUPACRON_HEARTBEAT_SECRET",
      "SUPACRON_VERIFY_SECRET",
    ],
  );
  assert.deepEqual(
    calls.filter((call) => call[0] === "secret-delete"),
    [["secret-delete", "SUPACRON_VERIFY_SECRET"]],
  );
  assert.equal(manifestWrites[0].security.localSecretStorage, false);
  assert.equal(manifestWrites[0].database.setupMode, "manual");
  assert.match(output.text(), /Manual Supabase SQL/);
  assert.match(output.text(), /Supacron setup complete/);
  assert.doesNotMatch(output.text(), /sb_publishable_abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(output.text(), /aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
});

test("init defaults to automatic guided setup and runs shown SQL only after explicit approval", async () => {
  const calls = [];
  const output = createOutput();

  await init(["--approve-sql", "--approve-cloudflare"], {
    nodeVersion: "22.16.0",
    now: "2026-09-14T15:00:00.000Z",
    out: output,
    rl: createRl(["1", "", "1", "*/15 * * * *"]),
    randomBytes: (length) => Buffer.alloc(length, "b"),
    listSupabaseProjects: () => [PROJECT],
    executeSql: (request) => {
      calls.push(["execute-sql", request.operation, request.sql]);
      return { stdout: "[]" };
    },
    verifyDbStructure: () => ({ ok: true, heartbeatTable: true, pingFunction: true, heartbeatPolicy: true }),
    listPublishableKeys: () => ["sb_publishable_abcdefghijklmnopqrstuvwxyz"],
    listCloudflareAccounts: () => [ACCOUNT],
    deployWorker: (request) => {
      calls.push(["deploy", request.verification, request.declareSecrets]);
      return request.verification ? { workersDevUrl: "https://supacron-abcdefghijklmnopqrst.example.workers.dev" } : {};
    },
    putWorkerSecret: () => {},
    deleteWorkerSecret: () => {},
    verifyWorker: async () => ({ ok: true, lastPingAt: "2026-09-14T15:02:00.000Z", pingCount: 1 }),
    verifyDbHeartbeat: () => ({
      ok: true,
      source: "cloudflare-cron",
      lastPingAt: "2026-09-14T15:02:00.000Z",
      pingCount: 1,
    }),
    writeInstallManifest: async () => "manifest.json",
  });

  assert.equal(calls[0][0], "execute-sql");
  assert.equal(calls[0][1], "Supacron database setup");
  assert.match(calls[0][2], /create schema supacron/i);
  assert.doesNotMatch(calls[0][2], /bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/);
  assert.match(output.text(), /Run the shown SQL using the official Supabase CLI now\? yes/);
});

test("init uses official login recovery paths for both providers", async () => {
  const calls = [];
  const output = createOutput();
  let supabaseListCount = 0;
  let cloudflareListCount = 0;

  await init(["--mode", "observe"], {
    nodeVersion: "22.16.0",
    out: output,
    rl: createRl(["1"]),
    listSupabaseProjects: () => {
      supabaseListCount += 1;
      if (supabaseListCount === 1) {
        throw new SupabaseAuthRequiredError();
      }
      return [PROJECT];
    },
    loginSupabase: () => calls.push("supabase-login"),
    listCloudflareAccounts: () => {
      cloudflareListCount += 1;
      if (cloudflareListCount === 1) {
        throw new CloudflareAuthRequiredError();
      }
      return [ACCOUNT];
    },
    loginCloudflare: () => calls.push("cloudflare-login"),
  });

  assert.deepEqual(calls, ["supabase-login"]);
  assert.match(output.text(), /official Supabase CLI browser flow/);
});

test("deployCloudflareCron cleans temporary verification secret on verification failure", async () => {
  const calls = [];

  await assert.rejects(
    () =>
      init(["--mode", "automatic", "--approve-sql", "--approve-cloudflare"], {
        nodeVersion: "22.16.0",
        out: createOutput(),
        rl: createRl(["1", "1", ""]),
        randomBytes: (length) => Buffer.alloc(length, "c"),
        listSupabaseProjects: () => [PROJECT],
        executeSql: () => ({ stdout: "[]" }),
        verifyDbStructure: () => ({ ok: true, heartbeatTable: true, pingFunction: true, heartbeatPolicy: true }),
        listPublishableKeys: () => ["sb_publishable_abcdefghijklmnopqrstuvwxyz"],
        listCloudflareAccounts: () => [ACCOUNT],
        deployWorker: (request) =>
          request.verification
            ? { workersDevUrl: "https://supacron-abcdefghijklmnopqrst.example.workers.dev" }
            : {},
        putWorkerSecret: (request) => calls.push(["put", request.key]),
        deleteWorkerSecret: (request) => calls.push(["delete", request.key]),
        verifyWorker: async () => {
          throw new Error("nope");
        },
      }),
    /nope/,
  );

  assert.deepEqual(calls.at(-1), ["delete", "SUPACRON_VERIFY_SECRET"]);
});

function createOutput() {
  let buffer = "";
  return {
    write(chunk) {
      buffer += chunk;
    },
    text() {
      return buffer;
    },
  };
}

function createRl(answers) {
  return {
    async question() {
      if (answers.length === 0) {
        throw new Error("No test answer queued.");
      }
      return answers.shift();
    },
    close() {},
  };
}
