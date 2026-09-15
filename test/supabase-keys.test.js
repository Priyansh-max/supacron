import test from "node:test";
import assert from "node:assert/strict";
import {
  listPublishableKeys,
  parsePublishableKeysJson
} from "../src/supabase/keys.js";

const KEY_A = `sb_publishable_${"a".repeat(30)}`;
const KEY_B = `sb_publishable_${"b".repeat(30)}`;

test("parsePublishableKeysJson allowlists only publishable keys", () => {
  const result = parsePublishableKeysJson(JSON.stringify({
    keys: [
      { type: "publishable", api_key: KEY_B },
      { type: "secret", api_key: `sb_secret_${"s".repeat(30)}` },
      { name: "service_role", api_key: "eyJheader.payload.signature" },
      { nested: { value: KEY_A } }
    ]
  }));

  assert.deepEqual(result, [KEY_A, KEY_B]);
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
