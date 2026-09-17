import test from "node:test";
import assert from "node:assert/strict";

import { logoutSessions } from "../src/logout.js";

test("logoutSessions signs out of both official CLI sessions", async () => {
  const calls = [];
  let output = "";
  const result = await logoutSessions([], {
    out: { write: (chunk) => { output += chunk; } },
    logoutSupabase: async () => calls.push("supabase"),
    logoutCloudflare: async () => calls.push("cloudflare"),
  });

  assert.deepEqual(calls, ["supabase", "cloudflare"]);
  assert.deepEqual(result, {
    supabase: "logged-out",
    cloudflare: "logged-out",
  });
  assert.match(output, /Supabase CLI signed out/);
  assert.match(output, /Cloudflare Wrangler signed out/);
});

test("logoutSessions treats already signed-out providers as success", async () => {
  const error = new Error("Not logged in");
  error.stderr = "not authenticated";

  const result = await logoutSessions([], {
    out: { write() {} },
    logoutSupabase: async () => { throw error; },
    logoutCloudflare: async () => undefined,
  });

  assert.equal(result.supabase, "logged-out");
  assert.equal(result.cloudflare, "logged-out");
});

test("logoutSessions rejects unexpected options", async () => {
  await assert.rejects(
    () => logoutSessions(["--supabase"], { out: { write() {} } }),
    /does not take options/
  );
});