import { AUTH_TIMEOUT_MS, SUPABASE_PACKAGE } from "../constants.js";
import { CommandError, runNpx } from "../lib/command.js";

const PROJECT_REF = /^[a-z0-9]{20}$/;

export class SupabaseAuthRequiredError extends Error {
  constructor() {
    super("Supabase login is required.");
    this.name = "SupabaseAuthRequiredError";
  }
}

export function parseProjectsJson(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Supabase CLI returned invalid project JSON.");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Supabase CLI project response must be an array.");
  }

  return parsed.map((project) => {
    const ref = project.id ?? project.ref;
    if (!PROJECT_REF.test(ref ?? "")) {
      throw new Error("Supabase CLI returned an invalid project reference.");
    }

    return {
      ref,
      name: cleanLabel(project.name, ref),
      region: cleanLabel(project.region, "unknown"),
      status: cleanLabel(project.status, "unknown")
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

export function listProjects({ run = runNpx } = {}) {
  try {
    const result = run(
      SUPABASE_PACKAGE,
      "supabase",
      ["projects", "list", "--output", "json"],
      { displayName: "Supabase project discovery" }
    );
    return parseProjectsJson(result.stdout);
  } catch (error) {
    if (error instanceof CommandError && isAuthenticationFailure(error.stderr)) {
      throw new SupabaseAuthRequiredError();
    }
    throw error;
  }
}

export function login({ run = runNpx } = {}) {
  return run(
    SUPABASE_PACKAGE,
    "supabase",
    ["login", "--name", "supacron"],
    {
      displayName: "Supabase browser login",
      interactive: true,
      timeoutMs: AUTH_TIMEOUT_MS
    }
  );
}

export function logout({ run = runNpx } = {}) {
  return run(
    SUPABASE_PACKAGE,
    "supabase",
    ["logout"],
    {
      displayName: "Supabase logout",
      interactive: true,
      timeoutMs: AUTH_TIMEOUT_MS
    }
  );
}

export function projectDashboardUrl(projectRef) {
  if (!PROJECT_REF.test(projectRef)) {
    throw new Error("Invalid Supabase project reference.");
  }
  return `https://supabase.com/dashboard/project/${projectRef}`;
}

export function projectSqlEditorUrl(projectRef) {
  return `${projectDashboardUrl(projectRef)}/sql/new`;
}

function cleanLabel(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }

  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return cleaned.slice(0, 100) || fallback;
}

function isAuthenticationFailure(stderr) {
  return /access token|not logged in|login required|unauthorized|401/i.test(stderr);
}
