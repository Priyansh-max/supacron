import { SUPABASE_PACKAGE } from "../constants.js";
import { runNpx } from "../lib/command.js";

const PROJECT_REF = /^[a-z0-9]{20}$/;
const PUBLISHABLE_KEY = /^sb_publishable_[A-Za-z0-9_-]{20,}$/;
const MAX_RESPONSE_BYTES = 1_000_000;

export function parsePublishableKeysJson(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error("Supabase API-key response was missing or too large.");
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Supabase CLI returned invalid API-key JSON.");
  }

  const matches = new Set();
  collectPublishableKeys(parsed, matches);
  return [...matches].sort();
}

export function listPublishableKeys({ projectRef, run = runNpx }) {
  if (!PROJECT_REF.test(projectRef ?? "")) {
    throw new Error("Invalid Supabase project reference.");
  }

  const result = run(
    SUPABASE_PACKAGE,
    "supabase",
    [
      "projects",
      "api-keys",
      "--project-ref",
      projectRef,
      "--output",
      "json"
    ],
    { displayName: "Supabase publishable-key discovery" }
  );

  return parsePublishableKeysJson(result.stdout);
}

function collectPublishableKeys(value, matches) {
  if (typeof value === "string") {
    if (PUBLISHABLE_KEY.test(value)) {
      matches.add(value);
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectPublishableKeys(item, matches));
    return;
  }

  if (value && typeof value === "object") {
    Object.values(value).forEach((item) => collectPublishableKeys(item, matches));
  }
}
