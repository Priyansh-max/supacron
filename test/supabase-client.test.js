import test from "node:test";
import assert from "node:assert/strict";
import {
  SupabaseAuthRequiredError,
  SupabaseTemporarilyUnavailableError,
  listProjects,
  login,
  logout,
  parseProjectsJson,
  projectDashboardUrl,
  projectSqlEditorUrl
} from "../src/supabase/client.js";
import { CommandError } from "../src/lib/command.js";

test("parseProjectsJson keeps only safe project metadata and sorts names", () => {
  const projects = parseProjectsJson(JSON.stringify([
    {
      id: "bbbbbbbbbbbbbbbbbbbb",
      name: "Zulu\nProject",
      region: "ap-south-1",
      status: "ACTIVE_HEALTHY",
      organization_id: "discard-me",
      database: { host: "discard-me" }
    },
    {
      id: "aaaaaaaaaaaaaaaaaaaa",
      name: "Alpha",
      region: "eu-west-1",
      status: "PAUSED"
    }
  ]));

  assert.deepEqual(projects, [
    {
      ref: "aaaaaaaaaaaaaaaaaaaa",
      name: "Alpha",
      region: "eu-west-1",
      status: "PAUSED"
    },
    {
      ref: "bbbbbbbbbbbbbbbbbbbb",
      name: "Zulu Project",
      region: "ap-south-1",
      status: "ACTIVE_HEALTHY"
    }
  ]);
  assert.equal("database" in projects[0], false);
  assert.equal("organization_id" in projects[0], false);
});

test("parseProjectsJson fails closed on malformed responses", () => {
  assert.throws(() => parseProjectsJson("not json"), /invalid project JSON/);
  assert.throws(() => parseProjectsJson("{}"), /must be an array/);
  assert.throws(
    () => parseProjectsJson('[{"id":"../../escape","name":"bad"}]'),
    /invalid project reference/
  );
});

test("listProjects uses only the safe project-list command", () => {
  const calls = [];
  const projects = listProjects({
    run(packageSpec, binary, args, options) {
      calls.push({ packageSpec, binary, args, options });
      return { stdout: '[{"id":"aaaaaaaaaaaaaaaaaaaa","name":"One"}]' };
    }
  });

  assert.equal(projects.length, 1);
  assert.deepEqual(calls[0].args, [
    "projects", "list", "--output", "json"
  ]);
  assert.equal(calls[0].args.includes("api-keys"), false);
  assert.equal(calls[0].args.includes("--reveal"), false);
});

test("listProjects maps authentication failures without leaking details", () => {
  assert.throws(
    () => listProjects({
      run() {
        throw new CommandError("failed", { stderr: "Access token not provided" });
      }
    }),
    SupabaseAuthRequiredError
  );
});

test("listProjects maps scheduled maintenance without raw provider JSON", () => {
  assert.throws(
    () => listProjects({
      run() {
        throw new CommandError("failed", {
          stderr:
            "Unexpected error retrieving projects: {\"error\":\"Service temporarily unavailable for scheduled maintenance\",\"estimated_completion\":\"Tue, 15 Sep 2026 21:45:00 GMT\"}\nTry rerunning the command with --debug to troubleshoot the error.",
        });
      }
    }),
    (error) => {
      assert.equal(error instanceof SupabaseTemporarilyUnavailableError, true);
      assert.match(error.message, /Service temporarily unavailable for scheduled maintenance/);
      assert.match(error.message, /Retry after Tue, 15 Sep 2026 21:45:00 GMT/);
      assert.match(error.message, /Running Supabase projects are not affected/);
      assert.doesNotMatch(error.message, /estimated_completion/);
      return true;
    }
  );
});
test("login delegates to the official browser flow without a token argument", () => {
  const calls = [];
  login({
    run(packageSpec, binary, args, options) {
      calls.push({ packageSpec, binary, args, options });
      return { stdout: "" };
    }
  });

  assert.deepEqual(calls[0].args, ["login", "--name", "supacron"]);
  assert.equal(calls[0].args.includes("--token"), false);
  assert.equal(calls[0].options.interactive, true);
});

test("logout delegates to the official Supabase CLI", () => {
  const calls = [];
  logout({
    run(packageSpec, binary, args, options) {
      calls.push({ packageSpec, binary, args, options });
      return { stdout: "" };
    }
  });

  assert.deepEqual(calls[0].args, ["logout"]);
  assert.equal(calls[0].options.interactive, true);
});
test("dashboard links validate project references", () => {
  assert.equal(
    projectDashboardUrl("abcdefghijklmnopqrst"),
    "https://supabase.com/dashboard/project/abcdefghijklmnopqrst"
  );
  assert.equal(
    projectSqlEditorUrl("abcdefghijklmnopqrst"),
    "https://supabase.com/dashboard/project/abcdefghijklmnopqrst/sql/new"
  );
  assert.throws(() => projectDashboardUrl("bad/ref"), /Invalid Supabase/);
});
