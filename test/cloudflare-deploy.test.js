import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { WRANGLER_PACKAGE } from "../src/constants.js";
import {
  deleteWorkerSecret,
  deleteWorker,
  deployWorker,
  parseWorkersDevUrl,
  putWorkerSecret,
  verifyDeployedWorker
} from "../src/cloudflare/deploy.js";

const ACCOUNT_ID = "a".repeat(32);
const WORKER_NAME = "supacron-abcdefghijklmnopqrst";

test("deployWorker uses an account-scoped temporary workspace and cleans it", () => {
  let directory;
  let args;

  const result = deployWorker({
    accountId: ACCOUNT_ID,
    workerName: WORKER_NAME,
    schedule: "0 0,12 * * *",
    verification: true,
    declareSecrets: false,
    run(_packageSpec, _binary, receivedArgs, options) {
      args = receivedArgs;
      directory = options.cwd;
      const configPath = receivedArgs[receivedArgs.indexOf("--config") + 1];
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      const source = fs.readFileSync(`${directory}/src/index.js`, "utf8");

      assert.equal(config.account_id, ACCOUNT_ID);
      assert.equal(config.workers_dev, true);
      assert.equal("secrets" in config, false);
      assert.match(source, /__supacron\/verify/);
      return {
        stdout: `Deployed ${WORKER_NAME}\nhttps://${WORKER_NAME}.example.workers.dev`,
        stderr: "",
        exitCode: 0
      };
    }
  });

  assert.ok(args.includes("--strict"));
  assert.equal(result.workersDevUrl, `https://${WORKER_NAME}.example.workers.dev`);
  assert.equal(fs.existsSync(directory), false);
});

test("deployWorker cleans its workspace after Wrangler fails", () => {
  let directory;
  assert.throws(
    () => deployWorker({
      accountId: ACCOUNT_ID,
      workerName: WORKER_NAME,
      schedule: "0 0,12 * * *",
      run(_packageSpec, _binary, _args, options) {
        directory = options.cwd;
        throw new Error("deploy failed");
      }
    }),
    /deploy failed/
  );
  assert.equal(fs.existsSync(directory), false);
});

test("putWorkerSecret sends values through stdin and never arguments", () => {
  const value = "a".repeat(64);
  let call;
  putWorkerSecret({
    accountId: ACCOUNT_ID,
    workerName: WORKER_NAME,
    key: "SUPACRON_HEARTBEAT_SECRET",
    value,
    run(packageSpec, binary, args, options) {
      call = { packageSpec, binary, args, options };
      return { stdout: "", stderr: "", exitCode: 0 };
    }
  });

  assert.deepEqual(call.args, [
    "secret", "put", "SUPACRON_HEARTBEAT_SECRET", "--name", WORKER_NAME
  ]);
  assert.equal(call.args.includes(value), false);
  assert.equal(call.options.input, `${value}\n`);
  assert.deepEqual(call.options.secrets, [value]);
  assert.equal(call.options.env.CLOUDFLARE_ACCOUNT_ID, ACCOUNT_ID);
});

test("putWorkerSecret accepts only binding-specific secret value shapes", () => {
  const accepted = [];
  const run = (_packageSpec, _binary, args, options) => {
    accepted.push([args[2], options.input]);
    return { stdout: "", stderr: "", exitCode: 0 };
  };

  putWorkerSecret({
    accountId: ACCOUNT_ID,
    workerName: WORKER_NAME,
    key: "SUPABASE_URL",
    value: "https://abcdefghijklmnopqrst.supabase.co",
    run
  });
  putWorkerSecret({
    accountId: ACCOUNT_ID,
    workerName: WORKER_NAME,
    key: "SUPABASE_PUBLISHABLE_KEY",
    value: `sb_publishable_${"p".repeat(30)}`,
    run
  });
  putWorkerSecret({
    accountId: ACCOUNT_ID,
    workerName: WORKER_NAME,
    key: "SUPACRON_VERIFY_SECRET",
    value: "b".repeat(64),
    run
  });

  assert.deepEqual(accepted, [
    ["SUPABASE_URL", "https://abcdefghijklmnopqrst.supabase.co\n"],
    ["SUPABASE_PUBLISHABLE_KEY", `sb_publishable_${"p".repeat(30)}\n`],
    ["SUPACRON_VERIFY_SECRET", `${"b".repeat(64)}\n`]
  ]);
});

test("secret operations reject unknown names, placeholders, malformed values, and injection", () => {
  assert.throws(
    () => putWorkerSecret({
      accountId: ACCOUNT_ID,
      workerName: WORKER_NAME,
      key: "UNKNOWN_SECRET",
      value: "x".repeat(40)
    }),
    /unknown Cloudflare secret/
  );
  assert.throws(
    () => putWorkerSecret({
      accountId: ACCOUNT_ID,
      workerName: WORKER_NAME,
      key: "SUPACRON_VERIFY_SECRET",
      value: `safe-value${"x".repeat(30)}\ninjected`
    }),
    /Invalid value/
  );
  assert.throws(
    () => putWorkerSecret({
      accountId: ACCOUNT_ID,
      workerName: WORKER_NAME,
      key: "SUPACRON_HEARTBEAT_SECRET",
      value: "undefined"
    }),
    /Invalid value/
  );
  assert.throws(
    () => putWorkerSecret({
      accountId: ACCOUNT_ID,
      workerName: WORKER_NAME,
      key: "SUPABASE_URL",
      value: "https://abcdefghijklmnopqrst.supabase.co/path"
    }),
    /Invalid value/
  );
  assert.throws(
    () => putWorkerSecret({
      accountId: ACCOUNT_ID,
      workerName: WORKER_NAME,
      key: "SUPABASE_PUBLISHABLE_KEY",
      value: "sb_secret_not-allowed-here"
    }),
    /Invalid value/
  );
});

test("deleteWorkerSecret deletes only an allowlisted binding", () => {
  let call;
  deleteWorkerSecret({
    accountId: ACCOUNT_ID,
    workerName: WORKER_NAME,
    key: "SUPACRON_VERIFY_SECRET",
    run(_packageSpec, _binary, args, options) {
      call = { args, options };
      return { stdout: "", stderr: "", exitCode: 0 };
    }
  });

  assert.deepEqual(call.args, [
    "secret", "delete", "SUPACRON_VERIFY_SECRET", "--name", WORKER_NAME
  ]);
  assert.equal(call.options.input, "y\n");
});

test("deleteWorker deletes the selected Worker without force and with account scoping", () => {
  const calls = [];
  deleteWorker({
    accountId: ACCOUNT_ID,
    workerName: "supacron-demo",
    run: (...args) => calls.push(args) || { stdout: "", stderr: "" }
  });

  assert.equal(calls[0][0], WRANGLER_PACKAGE);
  assert.equal(calls[0][1], "wrangler");
  assert.deepEqual(calls[0][2], ["delete", "supacron-demo"]);
  assert.equal(calls[0][3].displayName, "Cloudflare Worker delete");
  assert.deepEqual(calls[0][3].env, {
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID
  });
  assert.equal(calls[0][3].input, "y\n");
  assert.equal(calls[0][2].includes("--force"), false);
});

test("parseWorkersDevUrl accepts only the expected Worker hostname", () => {
  assert.equal(
    parseWorkersDevUrl(
      `Visit https://${WORKER_NAME}.example.workers.dev`,
      WORKER_NAME
    ),
    `https://${WORKER_NAME}.example.workers.dev`
  );
  assert.throws(
    () => parseWorkersDevUrl("https://other.example.workers.dev", WORKER_NAME),
    /expected verification URL/
  );
});

test("verifyDeployedWorker sends its secret only in the authorization header", async () => {
  const verifySecret = "v".repeat(48);
  let call;
  const result = await verifyDeployedWorker({
    workersDevUrl: `https://${WORKER_NAME}.example.workers.dev`,
    verifySecret,
    async fetchImpl(url, options) {
      call = { url: String(url), options };
      return Response.json({
        ok: true,
        last_ping_at: "2026-09-14T12:00:00Z",
        ping_count: 3,
        ignored: "discard"
      });
    }
  });

  assert.equal(call.url, `https://${WORKER_NAME}.example.workers.dev/__supacron/verify`);
  assert.equal(call.options.headers.Authorization, `Bearer ${verifySecret}`);
  assert.deepEqual(result, {
    ok: true,
    lastPingAt: "2026-09-14T12:00:00Z",
    pingCount: 3
  });
});

test("verifyDeployedWorker does not expose response bodies in failures", async () => {
  await assert.rejects(
    verifyDeployedWorker({
      workersDevUrl: `https://${WORKER_NAME}.example.workers.dev`,
      verifySecret: "v".repeat(48),
      fetchImpl: async () => new Response("provider-secret-body", { status: 500 })
    }),
    (error) => {
      assert.equal(error.message, "Cloudflare verification failed with status 500.");
      assert.doesNotMatch(error.message, /provider-secret-body/);
      return true;
    }
  );
});
