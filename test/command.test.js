import test from "node:test";
import assert from "node:assert/strict";
import { CommandError, redactText, runCommand, runNpx } from "../src/lib/command.js";

test("redactText removes known credential shapes and explicit secrets", () => {
  const input = [
    "SUPABASE_ACCESS_TOKEN=sbp_abcdefghijklmnopqrstuvwxyz",
    "Authorization: Bearer eyJheader.payload.signature",
    "heartbeat=local-heartbeat-secret"
  ].join("\n");
  const output = redactText(input, ["local-heartbeat-secret"]);

  assert.doesNotMatch(output, /abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(output, /eyJheader/);
  assert.doesNotMatch(output, /local-heartbeat-secret/);
  assert.match(output, /\[REDACTED\]/);
});

test("runCommand captures successful output without a shell", () => {
  const result = runCommand(process.execPath, ["-e", "process.stdout.write('ok')"]);

  assert.equal(result.stdout, "ok");
  assert.equal(result.exitCode, 0);
});

test("runCommand errors never echo command arguments or secret output", () => {
  const secret = "never-print-this-secret";

  assert.throws(
    () => runCommand(
      process.execPath,
      ["-e", `process.stderr.write('${secret}'); process.exit(7)`],
      { displayName: "test command", secrets: [secret] }
    ),
    (error) => {
      assert.ok(error instanceof CommandError);
      assert.equal(error.exitCode, 7);
      assert.equal(error.message, "test command failed with exit code 7.");
      assert.equal(error.stderr, "[REDACTED]");
      assert.doesNotMatch(`${error.message}${error.stderr}`, new RegExp(secret));
      return true;
    }
  );
});

test("runNpx rejects unpinned packages before execution", () => {
  assert.throws(
    () => runNpx("wrangler@latest", "wrangler", ["--version"]),
    /Refusing unpinned npm package/
  );
});
