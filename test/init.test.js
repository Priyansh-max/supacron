import test from "node:test";
import assert from "node:assert/strict";

import { discoverSupabaseProjects, init, ensureNodeVersion } from "../src/init.js";
import { SupabaseAuthRequiredError } from "../src/supabase/client.js";

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

test("init rejects removed observe mode", async () => {
  await assert.rejects(
    () => init(["--mode", "observe", "--project-ref", PROJECT.ref], {
      nodeVersion: "22.16.0",
      out: createOutput(),
      rl: createRl([]),
      listSupabaseProjects: () => [PROJECT],
    }),
    /Invalid setup mode: observe/,
  );
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
    linkSupabaseProject: ({ projectRef }) => calls.push(["link-project", projectRef]),
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
  assert.deepEqual(calls.filter((call) => call[0] === "link-project"), [["link-project", PROJECT.ref]]);
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
  assert.match(output.text(), /Setup complete/);
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
    linkSupabaseProject: ({ projectRef }) => calls.push(["link-project", projectRef]),
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

  assert.deepEqual(calls[0], ["link-project", PROJECT.ref]);
  assert.equal(calls[1][0], "execute-sql");
  assert.equal(calls[1][1], "Supacron database setup");
  assert.match(calls[1][2], /create schema if not exists supacron/i);
  assert.doesNotMatch(calls[1][2], /bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/);
  assert.match(output.text(), /Run the shown SQL using the official Supabase CLI now\? yes/);
});


test("init rejects invalid schedule flags before Cloudflare deployment", async () => {
  let deployed = false;

  await assert.rejects(
    () => init(["--mode", "automatic", "--approve-sql", "--approve-cloudflare", "--schedule", "Y"], {
      nodeVersion: "22.16.0",
      out: createOutput(),
      rl: createRl(["1", "1"]),
      randomBytes: (length) => Buffer.alloc(length, "d"),
      listSupabaseProjects: () => [PROJECT],
      linkSupabaseProject: () => {},
      executeSql: () => ({ stdout: "[]" }),
      verifyDbStructure: () => ({ ok: true, heartbeatTable: true, pingFunction: true, heartbeatPolicy: true }),
      listPublishableKeys: () => ["sb_publishable_abcdefghijklmnopqrstuvwxyz"],
      listCloudflareAccounts: () => [ACCOUNT],
      deployWorker: () => {
        deployed = true;
        return {};
      },
    }),
    /Invalid cron schedule/,
  );

  assert.equal(deployed, false);
});

test("init custom schedule retries invalid cron before showing Cloudflare plan", async () => {
  const deploys = [];
  const output = createOutput();

  const result = await init(["--mode", "automatic", "--approve-sql", "--approve-cloudflare"], {
    nodeVersion: "22.16.0",
    now: "2026-09-14T15:00:00.000Z",
    out: output,
    rl: createRl(["1", "1", "4", "Y", "*/15 * * * *"]),
    randomBytes: (length) => Buffer.alloc(length, "e"),
    listSupabaseProjects: () => [PROJECT],
    linkSupabaseProject: () => {},
    executeSql: () => ({ stdout: "[]" }),
    verifyDbStructure: () => ({ ok: true, heartbeatTable: true, pingFunction: true, heartbeatPolicy: true }),
    listPublishableKeys: () => ["sb_publishable_abcdefghijklmnopqrstuvwxyz"],
    listCloudflareAccounts: () => [ACCOUNT],
    deployWorker: (request) => {
      deploys.push(request.schedule);
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

  assert.equal(result.schedule, "*/15 * * * *");
  assert.deepEqual([...new Set(deploys)], ["*/15 * * * *"]);
  assert.match(output.text(), /Invalid cron expression/);
  assert.match(output.text(), /Schedule\s+\*\/15 \* \* \* \*/);
});
test("discoverSupabaseProjects uses official login recovery", async () => {
  const calls = [];
  const output = createOutput();
  let supabaseListCount = 0;

  const projects = await discoverSupabaseProjects({
    listSupabaseProjects: () => {
      supabaseListCount += 1;
      if (supabaseListCount === 1) {
        throw new SupabaseAuthRequiredError();
      }
      return [PROJECT];
    },
    loginSupabase: () => calls.push("supabase-login"),
  }, output);

  assert.deepEqual(projects, [PROJECT]);
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
        linkSupabaseProject: ({ projectRef }) => calls.push(["link-project", projectRef]),
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
