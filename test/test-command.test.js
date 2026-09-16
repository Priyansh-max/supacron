import test from "node:test";
import assert from "node:assert/strict";

import { testInstallation } from "../src/test.js";

const MANIFEST = {
  schemaVersion: 1,
  createdAt: "2026-09-14T15:00:00.000Z",
  updatedAt: "2026-09-14T15:00:00.000Z",
  supabase: {
    projectRef: "abcdefghijklmnopqrst",
    name: "Production",
    dashboardUrl: "https://supabase.com/dashboard/project/abcdefghijklmnopqrst",
  },
  database: {
    schema: "supacron",
    table: "heartbeat",
    rpc: "public.supacron_ping",
    setupMode: "automatic",
  },
  cloudflare: {
    accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    workerName: "supacron-abcdefghijklmnopqrst",
    workerUrl: "https://supacron-abcdefghijklmnopqrst.example.workers.dev",
    schedule: "0 0,12 * * *",
    dashboardUrl:
      "https://dash.cloudflare.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/workers/services/view/supacron-abcdefghijklmnopqrst",
  },
  security: {
    localSecretStorage: false,
    workerSecretBindings: [
      "SUPABASE_URL",
      "SUPABASE_PUBLISHABLE_KEY",
      "SUPACRON_HEARTBEAT_SECRET",
    ],
  },
  verification: {
    status: "verified",
  },
};

test("supacron test runs a live Worker proof from the saved non-secret receipt", async () => {
  const calls = [];
  const output = createOutput();
  const secret = Buffer.alloc(32, "c").toString("hex");

  const report = await testInstallation([], {
    out: output,
    randomBytes: (length) => Buffer.alloc(length, "c"),
    listInstallManifests: async () => [MANIFEST],
    createLocalSetupWorkspace: async () => "C:\\Temp\\supacron-test",
    linkSupabaseProject: async ({ projectRef }) => calls.push(["link", projectRef]),
    verifyDbStructure: ({ projectRef }) => {
      calls.push(["structure", projectRef]);
      return { ok: true, heartbeatTable: true, pingFunction: true, heartbeatPolicy: true };
    },
    putWorkerSecret: ({ key, value }) => calls.push(["put", key, value]),
    deployWorker: (request) => {
      calls.push(["deploy", request.verification, request.declareSecrets]);
      return request.verification
        ? { workersDevUrl: "https://supacron-abcdefghijklmnopqrst.example.workers.dev" }
        : {};
    },
    verifyWorker: async ({ workersDevUrl, verifySecret }) => {
      calls.push(["verify-worker", workersDevUrl, verifySecret]);
      return { ok: true, lastPingAt: "2026-09-14T15:02:00.000Z", pingCount: 2 };
    },
    verifyDbHeartbeat: ({ projectRef }) => {
      calls.push(["heartbeat", projectRef]);
      return {
        ok: true,
        source: "cloudflare-cron",
        lastPingAt: "2026-09-14T15:02:01.000Z",
        pingCount: 2,
      };
    },
    deleteWorkerSecret: ({ key }) => calls.push(["delete", key]),
    cleanupLocalSetupFiles: async ({ workspaceDir }) => {
      calls.push(["cleanup", workspaceDir]);
      return { removed: [workspaceDir], skipped: [] };
    },
  });

  assert.equal(report.ok, true);
  assert.deepEqual(calls.map((call) => call[0]), [
    "link",
    "structure",
    "put",
    "deploy",
    "verify-worker",
    "heartbeat",
    "delete",
    "deploy",
    "cleanup",
  ]);
  assert.deepEqual(calls.find((call) => call[0] === "put"), ["put", "SUPACRON_VERIFY_SECRET", secret]);
  assert.deepEqual(calls.filter((call) => call[0] === "deploy"), [
    ["deploy", true, true],
    ["deploy", false, true],
  ]);
  assert.match(output.text(), /Proof/);
  assert.match(output.text(), /Last ping\s+2026-09-14T15:02:01.000Z/);
  assert.match(output.text(), /temporary test access removed/);
  assert.match(output.text(), /Supabase/);
  assert.match(output.text(), /Cloudflare/);
  assert.doesNotMatch(output.text(), new RegExp(secret));
});

test("supacron test restores the private Worker after proof failure", async () => {
  const calls = [];

  await assert.rejects(
    () =>
      testInstallation(["--project-ref", "abcdefghijklmnopqrst"], {
        out: createOutput(),
        randomBytes: (length) => Buffer.alloc(length, "d"),
        readInstallManifest: async () => MANIFEST,
        createLocalSetupWorkspace: async () => "C:\\Temp\\supacron-test",
        linkSupabaseProject: async () => {},
        verifyDbStructure: () => ({
          ok: true,
          heartbeatTable: true,
          pingFunction: true,
          heartbeatPolicy: true,
        }),
        putWorkerSecret: ({ key }) => calls.push(["put", key]),
        deployWorker: (request) => {
          calls.push(["deploy", request.verification, request.declareSecrets]);
          return request.verification
            ? { workersDevUrl: "https://supacron-abcdefghijklmnopqrst.example.workers.dev" }
            : {};
        },
        verifyWorker: async () => {
          throw new Error("Cloudflare verification failed with status 502.");
        },
        deleteWorkerSecret: ({ key }) => calls.push(["delete", key]),
        cleanupLocalSetupFiles: async () => ({ removed: [], skipped: [] }),
      }),
    /Cloudflare verification failed/,
  );

  assert.deepEqual(calls, [
    ["put", "SUPACRON_VERIFY_SECRET"],
    ["deploy", true, true],
    ["delete", "SUPACRON_VERIFY_SECRET"],
    ["deploy", false, true],
  ]);
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