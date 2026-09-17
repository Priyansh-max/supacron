import test from "node:test";
import assert from "node:assert/strict";

import { buildIssueBody, createIssueUrl } from "../src/issue.js";

test("createIssueUrl opens GitHub issues with a prefilled sanitized body", () => {
  const url = new URL(createIssueUrl({
    command: "init",
    args: ["--project-ref", "abcdefghijklmnopqrst"],
    error: new Error("Cloudflare account discovery failed with exit code 1."),
    details: "stderr: {\"loggedIn\":false}\nSUPABASE_ACCESS_TOKEN=sbp_super_secret",
    platform: "win32",
    nodeVersion: "v22.0.0",
    packageVersion: "0.1.1",
  }));

  assert.equal(url.origin + url.pathname, "https://github.com/Priyansh-max/supacron/issues/new");
  assert.match(url.searchParams.get("title"), /Cloudflare account discovery failed/);

  const body = url.searchParams.get("body");
  assert.match(body, /supacron init --project-ref abcdefghijklmnopqrst/);
  assert.match(body, /Cloudflare account discovery failed with exit code 1/);
  assert.match(body, /"loggedIn":false/);
  assert.match(body, /Supacron: 0.1.1/);
  assert.match(body, /Node: v22.0.0/);
  assert.match(body, /Platform: win32/);
  assert.doesNotMatch(body, /sbp_super_secret/);
  assert.match(body, /\[REDACTED\]/);
});

test("buildIssueBody trims very long provider output", () => {
  const body = buildIssueBody({
    command: "test",
    details: "x".repeat(8_000),
  });

  assert.ok(body.length < 8_000);
  assert.match(body, /Issue body trimmed/);
});