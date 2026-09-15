import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { executeProjectSql } from "../src/supabase/query.js";

test("executeProjectSql passes SQL through a restricted temporary file", () => {
  const sql = "select 'sensitive query text';";
  let sqlPath;
  let captured;

  const result = executeProjectSql({
    projectRef: "abcdefghijklmnopqrst",
    sql,
    run(packageSpec, binary, args, options) {
      sqlPath = args[args.indexOf("--file") + 1];
      captured = { packageSpec, binary, args, options };
      assert.equal(fs.readFileSync(sqlPath, "utf8"), sql);
      assert.equal(fs.statSync(sqlPath).isFile(), true);
      return { stdout: "[]", stderr: "", exitCode: 0 };
    }
  });

  assert.equal(result.stdout, "[]");
  assert.equal(captured.binary, "supabase");
  assert.deepEqual(captured.args.slice(0, 5), [
    "db", "query", "--linked", "--project-ref", "abcdefghijklmnopqrst"
  ]);
  assert.equal(captured.args.includes(sql), false);
  assert.equal(captured.args.includes("--output"), true);
  assert.equal(captured.args.includes("--output-format"), false);
  assert.equal(fs.existsSync(sqlPath), false);
});

test("executeProjectSql cleans temporary SQL after provider failure", () => {
  let sqlPath;

  assert.throws(
    () => executeProjectSql({
      projectRef: "abcdefghijklmnopqrst",
      sql: "select 1;",
      run(_packageSpec, _binary, args) {
        sqlPath = args[args.indexOf("--file") + 1];
        throw new Error("provider failed");
      }
    }),
    /provider failed/
  );

  assert.equal(fs.existsSync(sqlPath), false);
});

test("executeProjectSql rejects invalid targets and empty SQL", () => {
  assert.throws(
    () => executeProjectSql({ projectRef: "../../escape", sql: "select 1" }),
    /Invalid Supabase project reference/
  );
  assert.throws(
    () => executeProjectSql({ projectRef: "abcdefghijklmnopqrst", sql: "  " }),
    /SQL must be a non-empty string/
  );
});
