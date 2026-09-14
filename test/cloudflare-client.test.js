import test from "node:test";
import assert from "node:assert/strict";
import {
  CloudflareAuthRequiredError,
  cloudflareWorkerUrl,
  listAccounts,
  login,
  parseAccountsJson
} from "../src/cloudflare/client.js";
import { CommandError } from "../src/lib/command.js";

const ACCOUNT_A = "a".repeat(32);
const ACCOUNT_B = "b".repeat(32);

test("parseAccountsJson keeps only sanitized account identity", () => {
  const accounts = parseAccountsJson(JSON.stringify({
    accounts: [
      { id: ACCOUNT_B, name: "Zulu\nAccount", extra: "discard" },
      { id: ACCOUNT_A, name: "Alpha" }
    ],
    user: { email: "discard@example.com" }
  }));

  assert.deepEqual(accounts, [
    { id: ACCOUNT_A, name: "Alpha" },
    { id: ACCOUNT_B, name: "Zulu Account" }
  ]);
  assert.equal("email" in accounts[0], false);
});

test("parseAccountsJson rejects malformed identity responses", () => {
  assert.throws(() => parseAccountsJson("not json"), /invalid account JSON/);
  assert.throws(
    () => parseAccountsJson('{"accounts":[{"id":"../../escape"}]}'),
    /invalid Cloudflare account ID/
  );
});

test("listAccounts maps expired authentication to a narrow error", () => {
  assert.throws(
    () => listAccounts({
      run() {
        throw new CommandError("failed", {
          stderr: "Not logged in. Your auth token has expired."
        });
      }
    }),
    CloudflareAuthRequiredError
  );
});

test("login requests only Worker deployment identity scopes", () => {
  const calls = [];
  login({
    run(packageSpec, binary, args, options) {
      calls.push({ packageSpec, binary, args, options });
      return { stdout: "" };
    }
  });

  assert.deepEqual(calls[0].args, [
    "login",
    "--device",
    "--use-keyring",
    "--scopes",
    "account:read",
    "user:read",
    "workers_scripts:write"
  ]);
  assert.equal(calls[0].args.includes("--api-token"), false);
  assert.equal(calls[0].options.interactive, true);
});

test("Cloudflare Worker links validate account and Worker identity", () => {
  assert.equal(
    cloudflareWorkerUrl(ACCOUNT_A, "supacron-abcdefghijklmnopqrst"),
    `https://dash.cloudflare.com/${ACCOUNT_A}/workers/services/view/supacron-abcdefghijklmnopqrst`
  );
  assert.throws(
    () => cloudflareWorkerUrl("bad", "supacron-safe"),
    /Invalid Cloudflare account ID/
  );
  assert.throws(
    () => cloudflareWorkerUrl(ACCOUNT_A, "../../bad"),
    /Invalid Cloudflare Worker name/
  );
});
