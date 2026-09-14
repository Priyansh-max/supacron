import { parseArgs } from "./args.js";
import { readConfig } from "./config.js";
import { callHeartbeat, getRuntimeValue } from "./utils.js";

export async function ping(args) {
  const parsed = parseArgs(args);
  const config = readConfig();
  const supabaseUrl = getRuntimeValue("SUPABASE_URL", parsed.values.url, config.supabaseUrl);
  const supabaseAnonKey = getRuntimeValue("SUPABASE_ANON_KEY", parsed.values.key);
  const secret = getRuntimeValue("SUPACRON_SECRET", parsed.values.secret);
  const source = parsed.values.source || "supacron-cli";

  const result = await callHeartbeat({
    supabaseUrl,
    supabaseAnonKey,
    secret,
    source
  });

  console.log("Supacron ping succeeded.");
  console.log(JSON.stringify(result, null, 2));
}
