import crypto from "node:crypto";

const SHA256_HEX = /^[a-f0-9]{64}$/;

export function heartbeatSecretHash(secret) {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error("Heartbeat secret must contain at least 32 characters.");
  }

  return crypto.createHash("sha256").update(secret, "utf8").digest("hex");
}

export function createInstallationSql({ secretHash }) {
  if (!SHA256_HEX.test(secretHash)) {
    throw new Error("Secret hash must be a lowercase SHA-256 hex digest.");
  }

  return `begin;

do $supacron_preflight$
begin
  if pg_catalog.to_regnamespace('supacron') is not null
     and pg_catalog.to_regclass('supacron.heartbeat') is null then
    raise exception 'Supacron schema already exists but supacron.heartbeat is missing. Resolve this schema collision before setup.';
  end if;
end;
$supacron_preflight$;

create extension if not exists pgcrypto with schema extensions;

create schema if not exists supacron;

create table if not exists supacron.heartbeat (
  id boolean primary key default true check (id),
  installed_at timestamptz not null default pg_catalog.now(),
  last_ping_at timestamptz,
  ping_count bigint not null default 0 check (ping_count >= 0),
  last_source text
);

insert into supacron.heartbeat (id) values (true)
on conflict (id) do nothing;

alter table supacron.heartbeat enable row level security;

revoke all on schema supacron from public, anon, authenticated;
revoke all on table supacron.heartbeat from public, anon, authenticated;

drop policy if exists supacron_no_direct_access on supacron.heartbeat;
create policy supacron_no_direct_access
on supacron.heartbeat
for all
using (false)
with check (false);

create or replace function public.supacron_ping(p_secret text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $supacron_function$
declare
  heartbeat_row supacron.heartbeat%rowtype;
begin
  if p_secret is null
     or pg_catalog.encode(
       extensions.digest(pg_catalog.convert_to(p_secret, 'UTF8'), 'sha256'),
       'hex'
     ) is distinct from '${secretHash}' then
    raise exception 'invalid supacron secret' using errcode = '28000';
  end if;

  update supacron.heartbeat
  set last_ping_at = pg_catalog.now(),
      ping_count = ping_count + 1,
      last_source = 'cloudflare-cron'
  where id = true
  returning * into heartbeat_row;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'last_ping_at', heartbeat_row.last_ping_at,
    'ping_count', heartbeat_row.ping_count,
    'source', heartbeat_row.last_source
  );
end;
$supacron_function$;

revoke all on function public.supacron_ping(text) from public, anon, authenticated;
grant execute on function public.supacron_ping(text) to anon, authenticated;

commit;
`;
}

export function createUninstallSql() {
  return `begin;

drop function if exists public.supacron_ping(text);
drop table if exists supacron.heartbeat;
drop schema if exists supacron;

commit;
`;
}
