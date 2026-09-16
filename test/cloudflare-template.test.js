import test from "node:test";
import assert from "node:assert/strict";
import {
  createWorkerSource,
  createWranglerConfig
} from "../src/cloudflare/template.js";

const PUBLISHABLE_KEY = `sb_publishable_${"p".repeat(30)}`;
const ANON_KEY = createJwt({ iss: "supabase", role: "anon", ref: "abcdefghijklmnopqrst" });
const HEARTBEAT_SECRET = "h".repeat(48);
const VERIFY_SECRET = "v".repeat(48);

async function importWorker(options) {
  const source = createWorkerSource(options);
  const url = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  return (await import(url)).default;
}

test("final Worker exposes a scheduled handler and no HTTP handler", async () => {
  const worker = await importWorker({ verification: false });

  assert.equal(typeof worker.scheduled, "function");
  assert.equal("fetch" in worker, false);
});

test("verification Worker fails closed when its secret is missing", async () => {
  const worker = await importWorker({ verification: true });
  const request = new Request("https://worker.example/__supacron/verify", {
    method: "POST",
    headers: { authorization: "Bearer undefined" }
  });
  const response = await worker.fetch(request, {});

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "Verification is unavailable."
  });
});

test("verification Worker rejects wrong methods, paths, and authorization", async () => {
  const worker = await importWorker({ verification: true });
  const env = { SUPACRON_VERIFY_SECRET: VERIFY_SECRET };

  const getResponse = await worker.fetch(
    new Request("https://worker.example/__supacron/verify"),
    env
  );
  const pathResponse = await worker.fetch(
    new Request("https://worker.example/other", { method: "POST" }),
    env
  );
  const authResponse = await worker.fetch(
    new Request("https://worker.example/__supacron/verify", {
      method: "POST",
      headers: { authorization: `Bearer ${"x".repeat(48)}` }
    }),
    env
  );

  assert.equal(getResponse.status, 404);
  assert.equal(pathResponse.status, 404);
  assert.equal(authResponse.status, 401);
});

test("verification Worker performs one narrow heartbeat call", async () => {
  const worker = await importWorker({ verification: true });
  const originalFetch = globalThis.fetch;
  let outbound;
  globalThis.fetch = async (url, options) => {
    outbound = { url: String(url), options };
    return Response.json({
      ok: true,
      last_ping_at: "2026-09-14T12:00:00Z",
      ping_count: 1,
      source: "cloudflare-cron",
      ignored: "not returned"
    });
  };

  try {
    const response = await worker.fetch(
      new Request("https://worker.example/__supacron/verify", {
        method: "POST",
        headers: { authorization: `Bearer ${VERIFY_SECRET}` }
      }),
      {
        SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
        SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE_KEY,
        SUPACRON_HEARTBEAT_SECRET: HEARTBEAT_SECRET,
        SUPACRON_VERIFY_SECRET: VERIFY_SECRET
      }
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      ok: true,
      last_ping_at: "2026-09-14T12:00:00Z",
      ping_count: 1,
      source: "cloudflare-cron"
    });
    assert.equal(
      outbound.url,
      "https://abcdefghijklmnopqrst.supabase.co/rest/v1/rpc/supacron_ping"
    );
    assert.equal(outbound.options.method, "POST");
    assert.equal(outbound.options.headers.apikey, PUBLISHABLE_KEY);
    assert.deepEqual(JSON.parse(outbound.options.body), { p_secret: HEARTBEAT_SECRET });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("verification Worker accepts a legacy Supabase anon key", async () => {
  const worker = await importWorker({ verification: true });
  const originalFetch = globalThis.fetch;
  let outbound;
  globalThis.fetch = async (url, options) => {
    outbound = { url: String(url), options };
    return Response.json({
      ok: true,
      last_ping_at: "2026-09-14T12:00:00Z",
      ping_count: 1,
      source: "cloudflare-cron"
    });
  };

  try {
    const response = await worker.fetch(
      new Request("https://worker.example/__supacron/verify", {
        method: "POST",
        headers: { authorization: `Bearer ${VERIFY_SECRET}` }
      }),
      {
        SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
        SUPABASE_PUBLISHABLE_KEY: ANON_KEY,
        SUPACRON_HEARTBEAT_SECRET: HEARTBEAT_SECRET,
        SUPACRON_VERIFY_SECRET: VERIFY_SECRET
      }
    );

    assert.equal(response.status, 200);
    assert.equal(outbound.options.headers.apikey, ANON_KEY);
    assert.equal(outbound.options.headers.Authorization, `Bearer ${ANON_KEY}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("verification failure returns only a safe failure reason", async () => {
  const worker = await importWorker({ verification: true });
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const logs = [];
  globalThis.fetch = async () => new Response("provider-secret-body", { status: 500 });
  console.error = (message) => logs.push(message);

  try {
    const response = await worker.fetch(
      new Request("https://worker.example/__supacron/verify", {
        method: "POST",
        headers: { authorization: `Bearer ${VERIFY_SECRET}` }
      }),
      {
        SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
        SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE_KEY,
        SUPACRON_HEARTBEAT_SECRET: HEARTBEAT_SECRET,
        SUPACRON_VERIFY_SECRET: VERIFY_SECRET
      }
    );
    const body = await response.json();

    assert.equal(response.status, 502);
    assert.deepEqual(body, {
      ok: false,
      error: "Supabase heartbeat failed with status 500."
    });
    assert.doesNotMatch(JSON.stringify(body), /provider-secret-body/);
    assert.doesNotMatch(logs.join("\n"), /provider-secret-body/);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
});

test("Wrangler config separates verification and final exposure", () => {
  const verification = JSON.parse(createWranglerConfig({
    name: "supacron-abcdefghijklmnopqrst",
    schedule: "0 0,12 * * *",
    verification: true
  }));
  const final = JSON.parse(createWranglerConfig({
    name: "supacron-abcdefghijklmnopqrst",
    schedule: "0 0,12 * * *"
  }));
  const bootstrap = JSON.parse(createWranglerConfig({
    name: "supacron-abcdefghijklmnopqrst",
    schedule: "0 0,12 * * *",
    declareSecrets: false,
    verification: true
  }));

  assert.equal(verification.workers_dev, true);
  assert.deepEqual(verification.triggers.crons, []);
  assert.ok(verification.secrets.required.includes("SUPACRON_VERIFY_SECRET"));
  assert.equal("secrets" in bootstrap, false);
  assert.equal(final.workers_dev, false);
  assert.deepEqual(final.triggers.crons, ["0 0,12 * * *"]);
  assert.equal(final.secrets.required.includes("SUPACRON_VERIFY_SECRET"), false);
});

test("Wrangler config rejects unsafe names and cron values", () => {
  assert.throws(
    () => createWranglerConfig({ name: "../../bad", schedule: "0 0 * * *" }),
    /Invalid Cloudflare Worker name/
  );
  assert.throws(
    () => createWranglerConfig({
      name: "supacron-safe",
      schedule: "0 0 * * *\nmalicious = true"
    }),
    /Invalid Cloudflare cron expression/
  );
});

function createJwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.signature`;
}
