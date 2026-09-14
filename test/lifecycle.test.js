import test from "node:test";
import assert from "node:assert/strict";

import { repair, status } from "../src/lifecycle.js";

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
    setupMode: "manual",
  },
  cloudflare: {
    accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    workerName: "supacron-abcdefghijklmnopqrst",
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

test("status verifies manifest-backed Supabase state without printing secrets", async () => {
  const output = createOutput();
  const calls = [];

  const report = await status(["--project-ref", "abcdefghijklmnopqrst"], {
    out: output,
    readInstallManifest: async (projectRef) => {
      calls.push(["manifest", projectRef]);
      return MANIFEST;
    },
    verifyDbStructure: ({ projectRef }) => {
      calls.push(["structure", projectRef]);
      return { ok: true, heartbeatTable: true, pingFunction: true, heartbeatPolicy: true };
    },
    verifyDbHeartbeat: ({ projectRef }) => {
      calls.push(["heartbeat", projectRef]);
      return {
        ok: true,
        source: "cloudflare-cron",
        lastPingAt: "2026-09-14T15:01:00.000Z",
        pingCount: 3,
      };
    },
  });

  assert.equal(report.ok, true);
  assert.deepEqual(calls, [
    ["manifest", "abcdefghijklmnopqrst"],
    ["structure", "abcdefghijklmnopqrst"],
    ["heartbeat", "abcdefghijklmnopqrst"],
  ]);
  assert.match(output.text(), /Overall: healthy/);
  assert.match(output.text(), /Ping count: 3/);
  assert.doesNotMatch(output.text(), /sb_publishable_/);
  assert.doesNotMatch(output.text(), /SUPACRON_HEARTBEAT_SECRET=.*[a-z0-9]/i);
});

test("status reports needs attention when verification fails", async () => {
  const output = createOutput();

  const report = await status(["--project-ref", "abcdefghijklmnopqrst"], {
    out: output,
    readInstallManifest: async () => MANIFEST,
    verifyDbStructure: () => {
      throw new Error("not logged in");
    },
    verifyDbHeartbeat: () => ({ ok: false, lastPingAt: null, pingCount: 0 }),
  });

  assert.equal(report.ok, false);
  assert.match(output.text(), /Overall: needs attention/);
  assert.match(output.text(), /Table: missing/);
  assert.match(output.text(), /Row loaded: missing/);
});

test("status requires an existing non-secret manifest", async () => {
  await assert.rejects(() => status([], { out: createOutput() }), /--project-ref/);
  await assert.rejects(
    () =>
      status(["--project-ref", "abcdefghijklmnopqrst"], {
        out: createOutput(),
        readInstallManifest: async () => null,
      }),
    /No Supacron installation manifest/,
  );
});


test("repair redeploys the final Worker config from the saved manifest", async () => {
  const output = createOutput();
  const calls = [];

  const report = await repair(["--project-ref", "abcdefghijklmnopqrst", "--approve-redeploy"], {
    out: output,
    readInstallManifest: async () => MANIFEST,
    verifyDbStructure: ({ projectRef }) => {
      calls.push(["structure", projectRef]);
      return { ok: true, heartbeatTable: true, pingFunction: true, heartbeatPolicy: true };
    },
    deployWorker: (request) => calls.push(["deploy", request]),
  });

  assert.equal(report.ok, true);
  assert.equal(calls[0][0], "structure");
  assert.deepEqual(calls[1], [
    "deploy",
    {
      accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      workerName: "supacron-abcdefghijklmnopqrst",
      schedule: "0 0,12 * * *",
      verification: false,
      declareSecrets: true,
    },
  ]);
  assert.match(output.text(), /Supacron repair complete/);
  assert.doesNotMatch(output.text(), /sb_publishable_/);
});

test("repair refuses to recreate missing Supabase objects without a stored secret", async () => {
  await assert.rejects(
    () =>
      repair(["--project-ref", "abcdefghijklmnopqrst", "--approve-redeploy"], {
        out: createOutput(),
        readInstallManifest: async () => MANIFEST,
        verifyDbStructure: () => ({
          ok: false,
          heartbeatTable: false,
          pingFunction: false,
          heartbeatPolicy: false,
        }),
      }),
    /fresh heartbeat secret/,
  );
});

test("repair asks before redeploying Cloudflare", async () => {
  await assert.rejects(
    () =>
      repair(["--project-ref", "abcdefghijklmnopqrst"], {
        out: createOutput(),
        rl: createRl(["no"]),
        readInstallManifest: async () => MANIFEST,
        verifyDbStructure: () => ({
          ok: true,
          heartbeatTable: true,
          pingFunction: true,
          heartbeatPolicy: true,
        }),
        deployWorker: () => {
          throw new Error("should not deploy");
        },
      }),
    /stopped before redeploying/,
  );
});

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
