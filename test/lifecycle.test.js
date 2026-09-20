import test from "node:test";
import assert from "node:assert/strict";

import { repair, status, uninstall } from "../src/lifecycle.js";
import { SupabaseAuthRequiredError } from "../src/supabase/client.js";

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


test("repair performs a verified heartbeat secret handover without exposing the secret", async () => {
  const output = createOutput();
  const calls = [];
  const clearSecret = Buffer.alloc(32, "r").toString("hex");

  const report = await repair(["--project-ref", "abcdefghijklmnopqrst", "--approve-redeploy"], {
    out: output,
    randomBytes: (length) => Buffer.alloc(length, "r"),
    readInstallManifest: async () => MANIFEST,
    createLocalSetupWorkspace: async () => "C:\\Temp\\supacron-repair",
    cleanupLocalSetupFiles: async ({ workspaceDir }) => calls.push(["cleanup", workspaceDir]),
    listSupabaseProjects: async () => calls.push(["list-projects"]),
    linkSupabaseProject: async ({ projectRef }) => calls.push(["link", projectRef]),
    verifyDbStructure: ({ projectRef }) => {
      calls.push(["structure", projectRef]);
      return { ok: true, heartbeatTable: true, pingFunction: true, heartbeatPolicy: true };
    },
    executeSql: async (request) => calls.push(["sql", request]),
    putWorkerSecret: async ({ key, value }) => calls.push(["put", key, value]),
    deleteWorkerSecret: async ({ key }) => calls.push(["delete", key]),
    deployWorker: async (request) => {
      calls.push(["deploy", request.verification, request.declareSecrets]);
      return request.verification
        ? { workersDevUrl: "https://supacron-abcdefghijklmnopqrst.example.workers.dev" }
        : {};
    },
    verifyWorker: async ({ verifySecret }) => {
      calls.push(["verify-worker", verifySecret]);
      return { ok: true, lastPingAt: "2026-09-14T15:02:00.000Z", pingCount: 4 };
    },
    verifyDbHeartbeat: () => ({
      ok: true,
      lastPingAt: "2026-09-14T15:02:00.000Z",
      pingCount: 4,
    }),
  });

  assert.equal(report.ok, true);
  const sqlCall = calls.find((call) => call[0] === "sql");
  assert.equal(sqlCall[1].operation, "Supacron heartbeat secret rotation");
  assert.match(sqlCall[1].sql, /active_secret_hash/);
  assert.match(sqlCall[1].sql, /pending_secret_hash/);
  assert.doesNotMatch(sqlCall[1].sql, new RegExp(clearSecret));
  assert.deepEqual(calls.filter((call) => call[0] === "put").map((call) => call[1]), [
    "SUPACRON_HEARTBEAT_SECRET",
    "SUPACRON_VERIFY_SECRET",
  ]);
  assert.deepEqual(calls.filter((call) => call[0] === "deploy"), [
    ["deploy", true, true],
    ["deploy", false, true],
  ]);
  assert.deepEqual(calls.at(-1), ["cleanup", "C:\\Temp\\supacron-repair"]);
  assert.match(output.text(), /Supacron repair complete/);
  assert.match(output.text(), /rotated and verified/);
  assert.doesNotMatch(output.text(), new RegExp(clearSecret));
});

test("repair refuses to rotate when Supabase heartbeat objects are missing", async () => {
  await assert.rejects(
    () =>
      repair(["--project-ref", "abcdefghijklmnopqrst", "--approve-redeploy"], {
        out: createOutput(),
        readInstallManifest: async () => MANIFEST,
        createLocalSetupWorkspace: async () => "C:\\Temp\\supacron-repair",
        cleanupLocalSetupFiles: async () => {},
        listSupabaseProjects: async () => [],
        linkSupabaseProject: async () => {},
        verifyDbStructure: () => ({
          ok: false,
          heartbeatTable: false,
          pingFunction: false,
          heartbeatPolicy: false,
        }),
      }),
    /heartbeat objects are missing/,
  );
});

test("repair asks before changing Supabase or Cloudflare", async () => {
  const calls = [];
  await assert.rejects(
    () =>
      repair(["--project-ref", "abcdefghijklmnopqrst"], {
        out: createOutput(),
        rl: createRl(["no"]),
        readInstallManifest: async () => MANIFEST,
        createLocalSetupWorkspace: async () => "C:\\Temp\\supacron-repair",
        cleanupLocalSetupFiles: async () => {},
        listSupabaseProjects: async () => [],
        linkSupabaseProject: async () => {},
        verifyDbStructure: () => ({
          ok: true,
          heartbeatTable: true,
          pingFunction: true,
          heartbeatPolicy: true,
        }),
        executeSql: () => calls.push("sql"),
        deployWorker: () => calls.push("deploy"),
      }),
    /stopped before changing Supabase or Cloudflare/,
  );
  assert.deepEqual(calls, []);
});

test("repair restores scheduled-only mode when live verification fails", async () => {
  const calls = [];

  await assert.rejects(
    () => repair(["--project-ref", "abcdefghijklmnopqrst", "--approve-redeploy"], {
      out: createOutput(),
      randomBytes: (length) => Buffer.alloc(length, "s"),
      readInstallManifest: async () => MANIFEST,
      createLocalSetupWorkspace: async () => "C:\\Temp\\supacron-repair",
      cleanupLocalSetupFiles: async () => {},
      listSupabaseProjects: async () => [],
      linkSupabaseProject: async () => {},
      verifyDbStructure: () => ({
        ok: true,
        heartbeatTable: true,
        pingFunction: true,
        heartbeatPolicy: true,
      }),
      executeSql: async () => {},
      putWorkerSecret: async ({ key }) => calls.push(["put", key]),
      deleteWorkerSecret: async ({ key }) => calls.push(["delete", key]),
      deployWorker: async (request) => {
        calls.push(["deploy", request.verification, request.declareSecrets]);
        return request.verification
          ? { workersDevUrl: "https://supacron-abcdefghijklmnopqrst.example.workers.dev" }
          : {};
      },
      verifyWorker: async () => {
        throw new Error("verification failed");
      },
    }),
    /verification failed/,
  );

  assert.deepEqual(calls.filter((call) => call[0] === "deploy"), [
    ["deploy", true, true],
    ["deploy", false, true],
  ]);
  assert.ok(calls.some((call) =>
    call[0] === "delete" && call[1] === "SUPACRON_VERIFY_SECRET"));
});

test("repair recovers official Supabase and Cloudflare logins", async () => {
  const calls = [];
  let projectListAttempts = 0;
  let secretPutAttempts = 0;

  const report = await repair(["--project-ref", "abcdefghijklmnopqrst", "--approve-redeploy"], {
    out: createOutput(),
    randomBytes: (length) => Buffer.alloc(length, "t"),
    readInstallManifest: async () => MANIFEST,
    createLocalSetupWorkspace: async () => "C:\\Temp\\supacron-repair",
    cleanupLocalSetupFiles: async () => {},
    listSupabaseProjects: async () => {
      projectListAttempts += 1;
      if (projectListAttempts === 1) {
        throw new SupabaseAuthRequiredError();
      }
      return [];
    },
    loginSupabase: async () => calls.push("login-supabase"),
    linkSupabaseProject: async () => {},
    verifyDbStructure: () => ({
      ok: true,
      heartbeatTable: true,
      pingFunction: true,
      heartbeatPolicy: true,
    }),
    executeSql: async () => {},
    putWorkerSecret: async () => {
      secretPutAttempts += 1;
      if (secretPutAttempts === 1) {
        const error = new Error("Cloudflare secret write failed.");
        error.stderr = '{"loggedIn":false}';
        throw error;
      }
    },
    loginCloudflare: async () => calls.push("login-cloudflare"),
    deleteWorkerSecret: async () => {},
    deployWorker: async (request) => request.verification
      ? { workersDevUrl: "https://supacron-abcdefghijklmnopqrst.example.workers.dev" }
      : {},
    verifyWorker: async () => ({
      ok: true,
      lastPingAt: "2026-09-14T15:02:00.000Z",
      pingCount: 4,
    }),
    verifyDbHeartbeat: () => ({
      ok: true,
      lastPingAt: "2026-09-14T15:02:00.000Z",
      pingCount: 4,
    }),
  });

  assert.equal(report.ok, true);
  assert.deepEqual(calls, ["login-supabase", "login-cloudflare"]);
  assert.equal(projectListAttempts, 2);
  assert.equal(secretPutAttempts, 3);
});

test("uninstall deletes Worker, runs scoped SQL, and removes the manifest after approval", async () => {
  const output = createOutput();
  const calls = [];

  const report = await uninstall(["--project-ref", "abcdefghijklmnopqrst", "--approve-uninstall"], {
    out: output,
    readInstallManifest: async () => MANIFEST,
    createLocalSetupWorkspace: async () => calls.push(["workspace"]) && "C:\\Temp\\supacron-uninstall",
    cleanupLocalSetupFiles: async ({ workspaceDir }) => calls.push(["cleanup", workspaceDir]),
    listSupabaseProjects: async () => calls.push(["list-projects"]),
    linkSupabaseProject: async ({ projectRef }) => calls.push(["link", projectRef]),
    deleteWorker: async (request) => calls.push(["delete-worker", request]),
    executeSql: async (request) => calls.push(["sql", request]),
    verifyDbUninstalled: async ({ projectRef }) => {
      calls.push(["verify-uninstalled", projectRef]);
      return {
        ok: true,
        supacronSchema: false,
        heartbeatTable: false,
        pingFunction: false,
        heartbeatPolicy: false,
      };
    },
    deleteInstallManifest: async (projectRef) => {
      calls.push(["manifest", projectRef]);
      return true;
    },
  });

  assert.equal(report.ok, true);
  assert.equal(calls[3][0], "delete-worker");
  assert.deepEqual(calls[3][1], {
    accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    workerName: "supacron-abcdefghijklmnopqrst",
  });
  assert.equal(calls[4][0], "sql");
  assert.equal(calls[4][1].projectRef, "abcdefghijklmnopqrst");
  assert.equal(calls[4][1].operation, "Supacron database uninstall");
  assert.match(calls[4][1].sql, /drop function if exists public\.supacron_ping\(text\)/i);
  assert.match(calls[4][1].sql, /drop table if exists supacron\.heartbeat/i);
  assert.doesNotMatch(calls[4][1].sql, /cascade/i);
  assert.deepEqual(calls[5], ["verify-uninstalled", "abcdefghijklmnopqrst"]);
  assert.deepEqual(calls[6], ["manifest", "abcdefghijklmnopqrst"]);
  assert.deepEqual(calls[7], ["cleanup", "C:\\Temp\\supacron-uninstall"]);
  assert.match(output.text(), /Supacron uninstall complete/);
  assert.match(output.text(), /schema, heartbeat table, RPC, and policy/);
  assert.doesNotMatch(output.text(), /sb_publishable_/);
});

test("uninstall asks before deleting anything", async () => {
  const calls = [];
  await assert.rejects(
    () =>
      uninstall(["--project-ref", "abcdefghijklmnopqrst"], {
        out: createOutput(),
        rl: createRl(["no"]),
        readInstallManifest: async () => MANIFEST,
        deleteWorker: () => calls.push("worker"),
        executeSql: () => calls.push("sql"),
        deleteInstallManifest: () => calls.push("manifest"),
      }),
    /stopped before deleting/,
  );

  assert.deepEqual(calls, []);
});

test("uninstall requires an existing manifest", async () => {
  await assert.rejects(
    () =>
      uninstall(["--project-ref", "abcdefghijklmnopqrst", "--approve-uninstall"], {
        out: createOutput(),
        readInstallManifest: async () => null,
      }),
    /No Supacron installation manifest/,
  );
});

test("uninstall stops before database changes when Worker deletion fails", async () => {
  const calls = [];
  await assert.rejects(
    () =>
      uninstall(["--project-ref", "abcdefghijklmnopqrst", "--approve-uninstall"], {
        out: createOutput(),
        readInstallManifest: async () => MANIFEST,
        createLocalSetupWorkspace: async () => "C:\\Temp\\supacron-uninstall",
        cleanupLocalSetupFiles: async () => calls.push("cleanup"),
        listSupabaseProjects: async () => calls.push("list"),
        linkSupabaseProject: async () => calls.push("link"),
        deleteWorker: async () => {
          calls.push("worker");
          throw new Error("worker delete failed");
        },
        executeSql: () => calls.push("sql"),
        deleteInstallManifest: () => calls.push("manifest"),
      }),
    /worker delete failed/,
  );

  assert.deepEqual(calls, ["list", "link", "worker", "cleanup"]);
});

test("uninstall safely resumes when the Worker was already deleted", async () => {
  const calls = [];
  const report = await uninstall(
    ["--project-ref", "abcdefghijklmnopqrst", "--approve-uninstall"],
    {
      out: createOutput(),
      readInstallManifest: async () => MANIFEST,
      createLocalSetupWorkspace: async () => "C:\\Temp\\supacron-uninstall",
      cleanupLocalSetupFiles: async () => calls.push("cleanup"),
      listSupabaseProjects: async () => [],
      linkSupabaseProject: async () => {},
      deleteWorker: async () => {
        const error = new Error("Cloudflare Worker delete failed");
        error.stderr = "workers.api.error.script_not_found [code: 10090]";
        throw error;
      },
      executeSql: async () => calls.push("sql"),
      verifyDbUninstalled: async () => ({
        ok: true,
        supacronSchema: false,
        heartbeatTable: false,
        pingFunction: false,
        heartbeatPolicy: false,
      }),
      deleteInstallManifest: async () => calls.push("manifest") || true,
    },
  );

  assert.equal(report.ok, true);
  assert.deepEqual(report.worker, { deleted: false, alreadyMissing: true });
  assert.deepEqual(calls, ["sql", "manifest", "cleanup"]);
});

test("uninstall keeps the manifest when database cleanup cannot be verified", async () => {
  const calls = [];
  await assert.rejects(
    () => uninstall(
      ["--project-ref", "abcdefghijklmnopqrst", "--approve-uninstall"],
      {
        out: createOutput(),
        readInstallManifest: async () => MANIFEST,
        createLocalSetupWorkspace: async () => "C:\\Temp\\supacron-uninstall",
        cleanupLocalSetupFiles: async () => calls.push("cleanup"),
        listSupabaseProjects: async () => [],
        linkSupabaseProject: async () => {},
        deleteWorker: async () => calls.push("worker"),
        executeSql: async () => calls.push("sql"),
        verifyDbUninstalled: async () => ({
          ok: false,
          supacronSchema: true,
          heartbeatTable: false,
          pingFunction: false,
          heartbeatPolicy: false,
        }),
        deleteInstallManifest: async () => calls.push("manifest"),
      },
    ),
    /local manifest was kept/,
  );

  assert.deepEqual(calls, ["worker", "sql", "cleanup"]);
});

test("uninstall recovers official Supabase and Cloudflare logins", async () => {
  const calls = [];
  let projectListAttempts = 0;
  let workerDeleteAttempts = 0;

  const report = await uninstall(
    ["--project-ref", "abcdefghijklmnopqrst", "--approve-uninstall"],
    {
      out: createOutput(),
      readInstallManifest: async () => MANIFEST,
      createLocalSetupWorkspace: async () => "C:\\Temp\\supacron-uninstall",
      cleanupLocalSetupFiles: async () => {},
      listSupabaseProjects: async () => {
        projectListAttempts += 1;
        if (projectListAttempts === 1) {
          throw new SupabaseAuthRequiredError();
        }
        return [];
      },
      loginSupabase: async () => calls.push("login-supabase"),
      linkSupabaseProject: async () => {},
      deleteWorker: async () => {
        workerDeleteAttempts += 1;
        if (workerDeleteAttempts === 1) {
          const error = new Error("Cloudflare Worker delete failed");
          error.stderr = '{"loggedIn":false}';
          throw error;
        }
      },
      loginCloudflare: async () => calls.push("login-cloudflare"),
      executeSql: async () => {},
      verifyDbUninstalled: async () => ({
        ok: true,
        supacronSchema: false,
        heartbeatTable: false,
        pingFunction: false,
        heartbeatPolicy: false,
      }),
      deleteInstallManifest: async () => true,
    },
  );

  assert.equal(report.ok, true);
  assert.deepEqual(calls, ["login-supabase", "login-cloudflare"]);
  assert.equal(projectListAttempts, 2);
  assert.equal(workerDeleteAttempts, 2);
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
