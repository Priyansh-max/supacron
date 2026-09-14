import fs from "node:fs";
import path from "node:path";

export function writeFile(filePath, content) {
  const absolute = path.resolve(process.cwd(), filePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
  return filePath;
}

export function projectRefFromUrl(url) {
  try {
    return new URL(url).hostname.split(".")[0] || "project";
  } catch {
    return "project";
  }
}

export function safeName(value) {
  return value.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "project";
}

export function getRuntimeValue(envName, argValue, configValue) {
  const value = argValue || process.env[envName] || configValue;
  if (!value) {
    throw new Error(`${envName} is required. Pass it as an option or environment variable.`);
  }

  return value;
}

export async function callHeartbeat({ supabaseUrl, supabaseAnonKey, secret, source }) {
  const response = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/rpc/supacron_ping`, {
    method: "POST",
    headers: {
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${supabaseAnonKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      p_secret: secret,
      p_source: source
    })
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase heartbeat failed: ${response.status} ${text}`);
  }

  return text ? JSON.parse(text) : { ok: true };
}
