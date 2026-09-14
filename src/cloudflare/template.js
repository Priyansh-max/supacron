const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const CRON = /^[0-9*/?, -]+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const BASE_BINDINGS = [
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPACRON_HEARTBEAT_SECRET"
];

export function createWorkerSource({ verification = false } = {}) {
  const fetchHandler = verification ? `,

  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/__supacron/verify") {
      return new Response("Not Found", { status: 404 });
    }

    const expected = env.SUPACRON_VERIFY_SECRET;
    if (typeof expected !== "string" || expected.length < 32) {
      return Response.json({ ok: false, error: "Verification is unavailable." }, { status: 503 });
    }

    const authorization = request.headers.get("authorization") || "";
    const provided = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!(await secureEqual(provided, expected))) {
      return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
    }

    try {
      return Response.json(await ping(env));
    } catch {
      console.error(JSON.stringify({ event: "supacron.verify", ok: false }));
      return Response.json({ ok: false, error: "Verification failed." }, { status: 502 });
    }
  }` : "";

  return `const REQUEST_TIMEOUT_MS = 10_000;

function requiredString(env, name, validator) {
  const value = env[name];
  if (typeof value !== "string" || !validator(value)) {
    throw new Error(\`Missing or invalid required binding: \${name}\`);
  }
  return value;
}

function safeResult(value) {
  return {
    ok: value?.ok === true,
    last_ping_at: typeof value?.last_ping_at === "string" ? value.last_ping_at : null,
    ping_count: Number.isSafeInteger(value?.ping_count) ? value.ping_count : null,
    source: value?.source === "cloudflare-cron" ? value.source : null
  };
}

async function secureEqual(left, right) {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right))
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let different = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < leftBytes.length; index += 1) {
    different |= leftBytes[index] ^ rightBytes[index];
  }
  return different === 0;
}

async function ping(env) {
  const supabaseUrl = requiredString(env, "SUPABASE_URL", (value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  });
  const publishableKey = requiredString(
    env,
    "SUPABASE_PUBLISHABLE_KEY",
    (value) => value.startsWith("sb_publishable_") && value.length >= 35
  );
  const heartbeatSecret = requiredString(
    env,
    "SUPACRON_HEARTBEAT_SECRET",
    (value) => value.length >= 32
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const endpoint = new URL("/rest/v1/rpc/supacron_ping", supabaseUrl);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        apikey: publishableKey,
        Authorization: \`Bearer \${publishableKey}\`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ p_secret: heartbeatSecret }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(\`Supabase heartbeat failed with status \${response.status}.\`);
    }

    const result = safeResult(await response.json());
    if (!result.ok) {
      throw new Error("Supabase heartbeat returned an invalid response.");
    }
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      ping(env)
        .then((result) => {
          console.log(JSON.stringify({
            event: "supacron.heartbeat",
            ok: true,
            last_ping_at: result.last_ping_at,
            ping_count: result.ping_count
          }));
        })
        .catch((error) => {
          console.error(JSON.stringify({
            event: "supacron.heartbeat",
            ok: false,
            error: error.message
          }));
          throw error;
        })
    );
  }${fetchHandler}
};
`;
}

export function createWranglerConfig({
  name,
  schedule,
  declareSecrets = true,
  verification = false,
  compatibilityDate = "2026-09-14"
}) {
  if (!WORKER_NAME.test(name ?? "")) {
    throw new Error("Invalid Cloudflare Worker name.");
  }
  if (!validCron(schedule)) {
    throw new Error("Invalid Cloudflare cron expression.");
  }
  if (!ISO_DATE.test(compatibilityDate)) {
    throw new Error("Invalid Worker compatibility date.");
  }

  const requiredSecrets = verification
    ? [...BASE_BINDINGS, "SUPACRON_VERIFY_SECRET"]
    : BASE_BINDINGS;

  return `${JSON.stringify({
    $schema: "node_modules/wrangler/config-schema.json",
    name,
    main: "src/index.js",
    compatibility_date: compatibilityDate,
    workers_dev: verification,
    observability: { enabled: true },
    secrets: declareSecrets ? { required: requiredSecrets } : undefined,
    triggers: { crons: verification ? [] : [schedule] }
  }, null, 2)}\n`;
}

function validCron(value) {
  return typeof value === "string"
    && value.length <= 100
    && CRON.test(value)
    && value.trim().split(/\s+/).length === 5;
}
