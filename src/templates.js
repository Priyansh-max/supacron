export const PROVIDERS = ["cloudflare"];

export function migrationSql({ secret }) {
  const escapedSecret = sqlString(secret);

  return `create schema if not exists supacron;

create table if not exists supacron.config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

create table if not exists supacron.heartbeat (
  id text primary key,
  last_ping_at timestamptz not null default now(),
  ping_count bigint not null default 0,
  last_source text not null default 'unknown'
);

alter table supacron.config enable row level security;
alter table supacron.heartbeat enable row level security;

revoke all on schema supacron from anon, authenticated;
revoke all on all tables in schema supacron from anon, authenticated;

insert into supacron.config (key, value, updated_at)
values ('heartbeat_secret', ${escapedSecret}, now())
on conflict (key) do update set
  value = excluded.value,
  updated_at = now();

create or replace function public.supacron_ping(
  p_secret text,
  p_source text default 'supacron'
)
returns jsonb
language plpgsql
security definer
set search_path = supacron, public
as $$
declare
  stored_secret text;
  heartbeat_row supacron.heartbeat%rowtype;
begin
  select value into stored_secret
  from supacron.config
  where key = 'heartbeat_secret';

  if stored_secret is null or p_secret is distinct from stored_secret then
    raise exception 'invalid supacron secret' using errcode = '28000';
  end if;

  insert into supacron.heartbeat (id, last_ping_at, ping_count, last_source)
  values ('default', now(), 1, p_source)
  on conflict (id) do update set
    last_ping_at = excluded.last_ping_at,
    ping_count = supacron.heartbeat.ping_count + 1,
    last_source = excluded.last_source
  returning * into heartbeat_row;

  return jsonb_build_object(
    'ok', true,
    'last_ping_at', heartbeat_row.last_ping_at,
    'ping_count', heartbeat_row.ping_count,
    'source', heartbeat_row.last_source
  );
end;
$$;

grant execute on function public.supacron_ping(text, text) to anon, authenticated;
`;
}

export function githubWorkflow({ schedule }) {
  return `name: Supacron

on:
  schedule:
    - cron: "${schedule}"
  workflow_dispatch:

jobs:
  ping:
    runs-on: ubuntu-latest
    steps:
      - name: Ping Supabase
        shell: bash
        run: |
          set -euo pipefail

          curl --fail --show-error --silent \\
            -X POST "$SUPABASE_URL/rest/v1/rpc/supacron_ping" \\
            -H "apikey: $SUPABASE_ANON_KEY" \\
            -H "Authorization: Bearer $SUPABASE_ANON_KEY" \\
            -H "Content-Type: application/json" \\
            -d "{\\"p_secret\\":\\"$SUPACRON_SECRET\\",\\"p_source\\":\\"github-actions\\"}"
        env:
          SUPABASE_URL: \${{ secrets.SUPABASE_URL }}
          SUPABASE_ANON_KEY: \${{ secrets.SUPABASE_ANON_KEY }}
          SUPACRON_SECRET: \${{ secrets.SUPACRON_SECRET }}
`;
}

export function cloudflareWorker() {
  return `async function ping(env, source) {
  const response = await fetch(\`\${env.SUPABASE_URL}/rest/v1/rpc/supacron_ping\`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: \`Bearer \${env.SUPABASE_ANON_KEY}\`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      p_secret: env.SUPACRON_SECRET,
      p_source: source
    })
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(\`Supabase heartbeat failed: \${response.status} \${text}\`);
  }

  return text ? JSON.parse(text) : { ok: true };
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(ping(env, "cloudflare-cron"));
  },

  async fetch(request, env) {
    const auth = request.headers.get("authorization");
    if (auth !== \`Bearer \${env.CRON_SECRET}\`) {
      return new Response("Unauthorized", { status: 401 });
    }

    const result = await ping(env, "cloudflare-manual");
    return Response.json(result);
  }
};
`;
}

export function cloudflareWrangler({ name, schedule }) {
  return `{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "${name}",
  "main": "src/index.js",
  "compatibility_date": "2026-09-04",
  "triggers": {
    "crons": [
      "${schedule}"
    ]
  }
}
`;
}

export function vercelRoute() {
  return `export default async function handler(req, res) {
  const auth = req.headers.authorization;

  if (auth !== \`Bearer \${process.env.CRON_SECRET}\`) {
    return res.status(401).json({ ok: false });
  }

  const response = await fetch(
    \`\${process.env.SUPABASE_URL}/rest/v1/rpc/supacron_ping\`,
    {
      method: "POST",
      headers: {
        apikey: process.env.SUPABASE_ANON_KEY,
        Authorization: \`Bearer \${process.env.SUPABASE_ANON_KEY}\`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        p_secret: process.env.SUPACRON_SECRET,
        p_source: "vercel-cron"
      })
    }
  );

  const text = await response.text();
  if (!response.ok) {
    return res.status(500).json({
      ok: false,
      status: response.status,
      body: text
    });
  }

  return res.status(200).json(text ? JSON.parse(text) : { ok: true });
}
`;
}

export function vercelJson({ schedule }) {
  return `${JSON.stringify({
    crons: [
      {
        path: "/api/supacron",
        schedule
      }
    ]
  }, null, 2)}\n`;
}

export function envExample({ supabaseUrl }) {
  return `SUPABASE_URL=${supabaseUrl}
SUPABASE_ANON_KEY=replace-with-your-anon-key
SUPACRON_SECRET=replace-with-generated-secret
CRON_SECRET=replace-with-generated-cron-secret
`;
}

function sqlString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}
