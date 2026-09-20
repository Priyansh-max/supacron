# Supacron Architecture

## Product boundary

Supacron is a local, open-source CLI that installs and manages one narrow
heartbeat for one Supabase project at a time. Version 1 supports Cloudflare
Workers Cron only.

The runtime path is:

```text
Cloudflare Cron Trigger -> scheduled Worker -> Supabase REST RPC -> one row upsert
```

Supacron has no hosted backend, user accounts, dashboard, analytics, billing,
or GitHub integration. Generated deployment files live in a temporary
directory and do not require a user repository or commit.

## CLI contract

The primary command is:

```text
npx supacron init
```

Lifecycle commands are:

```text
npx supacron status
npx supacron repair
```

The guided `init` flow is:

1. Check Node.js and the official Supabase and Wrangler CLIs.
2. Authenticate through the official provider CLIs when required.
3. List accessible Supabase projects and select exactly one.
4. Show the planned Supabase objects and permission requirements.
5. Select observe-only, manual SQL, or automatic SQL application.
6. Verify the schema, table, and RPC.
7. Show the Cloudflare Worker, bindings, schedule, and account changes.
8. Authenticate with Wrangler and deploy without a GitHub repository.
9. Run a one-time end-to-end verification and remove its temporary surface.
10. Print and persist a non-secret installation report.

## Permission modes

### Observe only

Supacron may list projects and inspect Supacron-owned resources. It does not
change the database or Cloudflare account. Database installation is unavailable
in this mode.

### Manual SQL (recommended)

Supacron generates and displays the exact SQL. The user runs it in Supabase SQL
Editor, then confirms completion. Supacron verifies the result through the
narrow heartbeat RPC. Supacron receives no database-write credential.

### Automatic SQL

Supacron displays the same SQL and requests a second confirmation immediately
before mutation. Automatic application is allowed only with a token scoped to
the selected project and database write. Classic account-wide tokens,
service-role keys, database passwords, and connection strings are rejected.
If compatible scoped authorization is unavailable, Supacron falls back to the
manual path.

## Secret boundary

Supacron never requests or stores:

- A Supabase database password or connection string.
- A Supabase service-role or secret API key.
- A classic account-wide Supabase access token.
- A Cloudflare API token.

Provider authentication is performed by the official Supabase and Wrangler
CLIs. Supacron may handle the selected project's URL and publishable key; these
are not secret credentials and are disclosed in the permission summary.

Supacron generates a high-entropy heartbeat secret in memory. The database
migration contains only SHA-256 digests. One digest is active and one may be
pending during a handover. The clear secret is streamed to Wrangler over
standard input and stored as a Cloudflare secret. It is never placed in command
arguments, generated files, the manifest, or logs.

Secret handover is interruption-safe. Supabase accepts the active digest while
the replacement is pending. A successful heartbeat using the pending secret
atomically promotes it and clears the pending digest. A failed provider step
therefore leaves the previously working secret valid instead of stranding the
Worker and database with different values.

## Database ownership

Supacron owns only:

- Schema `supacron`.
- Table `supacron.heartbeat`.
- Function `public.supacron_ping(text)`.

The function is `SECURITY DEFINER`, uses an empty safe search path, references
all objects with schema-qualified names, accepts one secret, and performs one
fixed upsert. Execute is revoked from `PUBLIC` before being granted to `anon`
and `authenticated`. Table and schema access remain revoked.

Supacron never reads, changes, or deletes application tables.

## Cloudflare ownership

Supacron owns one Worker named from the selected project reference and one Cron
Trigger. The final Worker exposes only a scheduled handler. A temporary,
secret-protected verification handler may exist during installation and is
removed by the final deployment.

Required Worker bindings are:

- `SUPABASE_URL`: non-secret.
- `SUPABASE_PUBLISHABLE_KEY`: non-secret but stored as a secret to reduce noise.
- `SUPACRON_HEARTBEAT_SECRET`: secret.
- `SUPACRON_VERIFY_SECRET`: temporary secret, deleted after verification.

Cloudflare secrets are streamed through Wrangler standard input. Logs contain
only project aliases, timestamps, HTTP status classes, and success or failure.

## Verification claims

The final report distinguishes:

- Database migration applied.
- Heartbeat RPC responded successfully.
- Cloudflare Worker deployed.
- Temporary deployed Worker verification succeeded.
- Final scheduled-only Worker deployed.
- Cron Trigger registered.
- First real scheduled execution observed or still pending.

Registration is not reported as proof that a future scheduled invocation ran.

## Local manifest

Supacron stores a non-secret JSON manifest in the user's platform config
directory. It contains the project reference, project alias, Worker name,
schedule, migration checksum, installation state, timestamps, and dashboard
links. It never contains keys, tokens, passwords, connection strings, or
heartbeat secrets.

Writes use collision checks and atomic replacement. Existing installations are
not overwritten without a repair-specific confirmation.

## Failure and rollback

Each phase records its completion. On failure, Supacron reports what succeeded,
what failed, and the exact safe next action. It does not silently delete a
verified database installation. A failed Cloudflare deployment can be retried
with `repair`. Repair generates a fresh secret, prepares the pending digest,
updates Cloudflare, proves a live heartbeat, and restores scheduled-only mode.

Supacron intentionally has no automated uninstall command. Removing an
installation is a manual provider operation so users can review and delete the
Cloudflare Worker and Supabase objects with their own provider permissions.
