import { logout as supabaseLogout } from "./supabase/client.js";
import { logout as cloudflareLogout } from "./cloudflare/client.js";
import { section, status } from "./ui.js";

export async function logoutSessions(args = [], dependencies = {}) {
  if (args.length > 0) {
    throw new Error("The logout command does not take options. Run: npx supacron logout");
  }

  const out = dependencies.out || process.stdout;
  section(out, "Logout");

  const result = {
    supabase: await runLogout({
      label: "Supabase CLI",
      logout: dependencies.logoutSupabase || supabaseLogout,
      out,
    }),
    cloudflare: await runLogout({
      label: "Cloudflare Wrangler",
      logout: dependencies.logoutCloudflare || cloudflareLogout,
      out,
    }),
  };

  if (result.supabase === "logged-out" && result.cloudflare === "logged-out") {
    status(out, "success", "Signed out of both official CLI sessions.");
  } else {
    status(out, "warn", "One or more CLI logout steps need attention. You can still run the provider CLI logout commands directly.");
  }

  return result;
}

async function runLogout({ label, logout, out }) {
  try {
    status(out, "info", `Signing out of ${label}...`);
    await logout();
    status(out, "success", `${label} signed out.`);
    return "logged-out";
  } catch (error) {
    if (isAlreadyLoggedOut(error)) {
      status(out, "success", `${label} was already signed out.`);
      return "logged-out";
    }

    status(out, "warn", `${label} logout failed: ${error.message}`);
    return "failed";
  }
}

function isAlreadyLoggedOut(error) {
  const text = `${error?.message || ""}\n${error?.stderr || ""}\n${error?.stdout || ""}`;
  return /not logged in|logged out|no user is logged in|not authenticated|unauthorized/i.test(text);
}