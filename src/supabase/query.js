import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { COMMAND_TIMEOUT_MS, SUPABASE_PACKAGE } from "../constants.js";
import { runNpx } from "../lib/command.js";

const PROJECT_REF = /^[a-z0-9]{20}$/;

export function executeProjectSql({
  projectRef,
  sql,
  operation = "Supabase SQL query",
  run = runNpx
}) {
  if (!PROJECT_REF.test(projectRef ?? "")) {
    throw new Error("Invalid Supabase project reference.");
  }
  if (typeof sql !== "string" || sql.trim().length === 0) {
    throw new Error("SQL must be a non-empty string.");
  }

  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "supacron-sql-"));
  const sqlPath = path.join(tempDirectory, "query.sql");

  try {
    fs.chmodSync(tempDirectory, 0o700);
    fs.writeFileSync(sqlPath, sql, { encoding: "utf8", flag: "wx", mode: 0o600 });

    return run(
      SUPABASE_PACKAGE,
      "supabase",
      [
        "db",
        "query",
        "--project-ref",
        projectRef,
        "--file",
        sqlPath,
        "--output-format",
        "json",
        "--agent",
        "no"
      ],
      {
        displayName: operation,
        timeoutMs: Math.max(COMMAND_TIMEOUT_MS, 120_000)
      }
    );
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
}
