import { SUPABASE_PACKAGE } from "../constants.js";
import { runNpx } from "../lib/command.js";

const PROJECT_REF = /^[a-z0-9]{20}$/;
const PUBLISHABLE_KEY = /^sb_publishable_[A-Za-z0-9_-]{20,}$/;
const JWT_KEY = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
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

  const matches = {
    publishable: new Set(),
    anon: new Set()
  };
  collectPublicKeys(parsed, matches);
  return [
    ...[...matches.publishable].sort(),
    ...[...matches.anon].sort()
  ];
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
    { displayName: "Supabase public API-key discovery" }
  );

  return parsePublishableKeysJson(result.stdout);
}

function collectPublicKeys(value, matches) {
  if (typeof value === "string") {
    if (PUBLISHABLE_KEY.test(value)) {
      matches.publishable.add(value);
    } else if (isLegacyAnonKey(value)) {
      matches.anon.add(value);
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectPublicKeys(item, matches));
    return;
  }

  if (value && typeof value === "object") {
    Object.values(value).forEach((item) => collectPublicKeys(item, matches));
  }
}

function isLegacyAnonKey(value) {
  if (typeof value !== "string" || value.length > 4096 || !JWT_KEY.test(value)) {
    return false;
  }

  const [, payload] = value.split(".");
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return parsed?.role === "anon";
  } catch {
    return false;
  }
}
