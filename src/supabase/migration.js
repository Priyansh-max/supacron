import crypto from "node:crypto";

const SHA256_HEX = /^[a-f0-9]{64}$/;

export function heartbeatSecretHash(secret) {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error("Heartbeat secret must contain at least 32 characters.");
  }

  return crypto.createHash("sha256").update(secret, "utf8").digest("hex");
}

export function createInstallationSql({ secretHash }) {
  assertSecretHash(secretHash);

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
  last_source text,
  active_secret_hash text,
  pending_secret_hash text
);

insert into supacron.heartbeat (id) values (true)
on conflict (id) do nothing;

${createSecretStateSql(secretHash)}

alter table supacron.heartbeat enable row level security;

revoke all on schema supacron from public, anon, authenticated;
revoke all on table supacron.heartbeat from public, anon, authenticated;

drop policy if exists supacron_no_direct_access on supacron.heartbeat;
create policy supacron_no_direct_access
on supacron.heartbeat
for all
using (false)
with check (false);

${createPingFunctionSql()}

commit;
`;
}

export function createSecretRotationSql({ secretHash }) {
  assertSecretHash(secretHash);

  return `begin;

do $supacron_rotation_preflight$
begin
  if pg_catalog.to_regclass('supacron.heartbeat') is null
     or pg_catalog.to_regprocedure('public.supacron_ping(text)') is null then
    raise exception 'Supacron heartbeat objects are missing. Run supacron init before repair.';
  end if;
end;
$supacron_rotation_preflight$;

create extension if not exists pgcrypto with schema extensions;

${createSecretStateSql(secretHash)}

${createPingFunctionSql()}

commit;
`;
}

function createSecretStateSql(secretHash) {
  return `alter table supacron.heartbeat
  add column if not exists active_secret_hash text;

alter table supacron.heartbeat
  add column if not exists pending_secret_hash text;

do $supacron_secret_prepare$
declare
  legacy_secret_hash text;
begin
  if exists (
    select 1
    from supacron.heartbeat
    where id = true
      and active_secret_hash is null
  ) and pg_catalog.to_regprocedure('public.supacron_ping(text)') is not null then
    select (
      pg_catalog.regexp_match(
        p.prosrc,
        $supacron_hash_pattern$'([a-f0-9]{64})'$supacron_hash_pattern$
      )
    )[1]
    into legacy_secret_hash
    from pg_catalog.pg_proc p
    where p.oid = pg_catalog.to_regprocedure('public.supacron_ping(text)')
    limit 1;
  end if;

  update supacron.heartbeat
  set active_secret_hash = pg_catalog.coalesce(
        active_secret_hash,
        legacy_secret_hash,
        '${secretHash}'
      ),
      pending_secret_hash = case
        when pg_catalog.coalesce(active_secret_hash, legacy_secret_hash, '${secretHash}') = '${secretHash}'
          then null
        else '${secretHash}'
      end
  where id = true;
end;
$supacron_secret_prepare$;

alter table supacron.heartbeat
  alter column active_secret_hash set not null;`;
}

function createPingFunctionSql() {
  return `create or replace function public.supacron_ping(p_secret text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $supacron_function$
declare
  secret_digest text;
  heartbeat_row supacron.heartbeat%rowtype;
begin
  if p_secret is null then
    raise exception 'invalid supacron secret' using errcode = '28000';
  end if;

  secret_digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(p_secret, 'UTF8'), 'sha256'),
    'hex'
  );

  update supacron.heartbeat
  set active_secret_hash = case
        when pending_secret_hash = secret_digest then secret_digest
        else active_secret_hash
      end,
      pending_secret_hash = case
        when pending_secret_hash = secret_digest then null
        else pending_secret_hash
      end,
      last_ping_at = pg_catalog.now(),
      ping_count = ping_count + 1,
      last_source = 'cloudflare-cron'
  where id = true
    and (
      active_secret_hash = secret_digest
      or pending_secret_hash = secret_digest
    )
  returning * into heartbeat_row;

  if not found then
    raise exception 'invalid supacron secret' using errcode = '28000';
  end if;

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
`;
}

function assertSecretHash(secretHash) {
  if (!SHA256_HEX.test(secretHash)) {
    throw new Error("Secret hash must be a lowercase SHA-256 hex digest.");
  }
}

export function createUninstallSql() {
  return `begin;

drop function if exists public.supacron_ping(text);
drop table if exists supacron.heartbeat;
drop schema if exists supacron;

commit;
`;
}
