import test from "node:test";
import assert from "node:assert/strict";
import {
  listPublishableKeys,
  parsePublishableKeysJson
} from "../src/supabase/keys.js";

const KEY_A = `sb_publishable_${"a".repeat(30)}`;
const KEY_B = `sb_publishable_${"b".repeat(30)}`;
const ANON_KEY = createJwt({ iss: "supabase", role: "anon", ref: "abcdefghijklmnopqrst" });
const SERVICE_ROLE_KEY = createJwt({ iss: "supabase", role: "service_role", ref: "abcdefghijklmnopqrst" });

test("parsePublishableKeysJson allowlists only public Supabase keys", () => {
  const result = parsePublishableKeysJson(JSON.stringify({
    keys: [
      { type: "publishable", api_key: KEY_B },
      { name: "anon", api_key: ANON_KEY },
      { type: "secret", api_key: `sb_secret_${"s".repeat(30)}` },
      { name: "service_role", api_key: SERVICE_ROLE_KEY },
      { nested: { value: KEY_A } }
    ]
  }));

  assert.deepEqual(result, [KEY_A, KEY_B, ANON_KEY]);
});

test("parsePublishableKeysJson rejects invalid and oversized responses", () => {
  assert.throws(() => parsePublishableKeysJson("not json"), /invalid API-key JSON/);
  assert.throws(
    () => parsePublishableKeysJson(`"${"x".repeat(1_000_001)}"`),
    /missing or too large/
  );
});

test("listPublishableKeys never requests revealed secret keys", () => {
  const calls = [];
  const keys = listPublishableKeys({
    projectRef: "abcdefghijklmnopqrst",
    run(packageSpec, binary, args, options) {
      calls.push({ packageSpec, binary, args, options });
      return { stdout: JSON.stringify([{ api_key: KEY_A }]) };
    }
  });

  assert.deepEqual(keys, [KEY_A]);
  assert.deepEqual(calls[0].args, [
    "projects",
    "api-keys",
    "--project-ref",
    "abcdefghijklmnopqrst",
    "--output",
    "json"
  ]);
  assert.equal(calls[0].args.includes("--reveal"), false);
  assert.equal(calls[0].options.rawStdout, true);
});

test("listPublishableKeys rejects an invalid project before execution", () => {
  let called = false;
  assert.throws(
    () => listPublishableKeys({
      projectRef: "bad/ref",
      run() {
        called = true;
      }
    }),
    /Invalid Supabase project reference/
  );
  assert.equal(called, false);
});

function createJwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.signature`;
}
