import os from "node:os";
import { readFileSync } from "node:fs";

import { redactText } from "./lib/command.js";

const ISSUE_URL = "https://github.com/Priyansh-max/supacron/issues/new";
const MAX_BODY_LENGTH = 7_500;

export function createIssueUrl({
  command = "",
  args = [],
  error,
  details = "",
  platform = process.platform,
  nodeVersion = process.version,
  packageVersion = readPackageVersion(),
} = {}) {
  const message = cleanErrorText(error?.message || "Unknown Supacron error.");
  const body = buildIssueBody({
    command,
    args,
    message,
    details: cleanErrorText(details),
    platform,
    nodeVersion,
    packageVersion,
  });
  const title = `CLI failure: ${firstLine(message).slice(0, 90)}`;
  const params = new URLSearchParams({ title, body });
  return `${ISSUE_URL}?${params.toString()}`;
}

export function formatIssueLink(url, { stream = process.stderr, env = process.env, label = "Open prefilled GitHub issue" } = {}) {
  if (supportsTerminalHyperlink(stream, env)) {
    return `\u001b]8;;${url}\u001b\\${label}\u001b]8;;\u001b\\`;
  }
  return url;
}

export function buildIssueBody({
  command = "",
  args = [],
  message = "Unknown Supacron error.",
  details = "",
  platform = process.platform,
  nodeVersion = process.version,
  packageVersion = readPackageVersion(),
} = {}) {
  const commandText = cleanErrorText(["supacron", command, ...args].filter(Boolean).join(" "));
  const errorText = [message, details].filter(Boolean).join("\n\n").trim();
  const body = [
    "## What happened",
    "",
    "Supacron failed while running this command:",
    "",
    "```text",
    commandText || "supacron",
    "```",
    "",
    "## Error",
    "",
    "```text",
    errorText || "Unknown Supacron error.",
    "```",
    "",
    "## Environment",
    "",
    `- Supacron: ${packageVersion}`,
    `- Node: ${nodeVersion}`,
    `- Platform: ${platform} ${os.release()}`,
    "",
    "## Notes",
    "",
    "Add anything unusual about your Supabase project, Cloudflare account, terminal, or network here.",
  ].join("\n");

  if (body.length <= MAX_BODY_LENGTH) {
    return body;
  }

  return `${body.slice(0, MAX_BODY_LENGTH)}\n\n[Issue body trimmed by Supacron because the error output was very long.]`;
}

function supportsTerminalHyperlink(stream, env) {
  return Boolean(
    stream?.isTTY
      && env.NO_COLOR == null
      && (
        env.WT_SESSION
        || env.TERM_PROGRAM
        || env.VTE_VERSION
        || env.DOMTERM
        || env.TERM?.includes("xterm")
      )
  );
}

function cleanErrorText(value) {
  return redactText(String(value ?? ""))
    .replace(/\u001b\[[0-9;]*m/g, "")
    .trim();
}

function firstLine(value) {
  return String(value).split(/\r?\n/)[0] || "Unknown Supacron error.";
}

function readPackageVersion() {
  try {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof packageJson.version === "string" ? packageJson.version : "unknown";
  } catch {
    return "unknown";
  }
}