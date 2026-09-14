# Supacron

Supacron installs a small Supabase heartbeat and runs it from Cloudflare Workers Cron. It is built for one job: keep a selected Supabase project receiving narrow database activity without adding a backend, dashboard, hosted service, or account system.

```txt
Cloudflare Cron Trigger -> scheduled Worker -> Supabase REST RPC -> one heartbeat row update
```

Supacron uses your own Supabase and Cloudflare accounts through the official CLIs. It does not ask for database passwords, connection strings, service-role keys, Supabase access tokens, or Cloudflare API tokens.

## Install

```bash
npx supacron init
```

`init` guides you through:

- Supabase browser login through the official CLI.
- Project selection.
- SQL setup in observe, manual, or automatic mode.
- Database structure verification.
- Cloudflare browser login through Wrangler.
- Worker Cron deployment.
- One temporary verification endpoint.
- Final scheduled-only Worker deployment.
- A local non-secret installation manifest.

## Requirements

- Node.js 20 or newer.
- A Supabase account with access to the target project.
- A Cloudflare account that can deploy Workers.
- The official provider CLIs available through `npx` during setup.

Supacron pins the Wrangler package it invokes and runs provider commands without a shell.

## Setup Modes

### Manual SQL

```bash
npx supacron init --mode manual
```

Recommended. Supacron prints the exact SQL for you to run in Supabase SQL Editor, then verifies the installed objects. Supacron never receives a database-write credential in this mode.

### Automatic SQL

```bash
npx supacron init --mode automatic
```

Supacron shows the same SQL and asks again before applying it. If the required scoped provider authorization is not available, use manual mode.

### Observe Only

```bash
npx supacron init --mode observe
```

Lists and inspects what Supacron can see, but does not change Supabase or Cloudflare.

## What It Creates

In Supabase:

- Schema `supacron`.
- Table `supacron.heartbeat`.
- Function `public.supacron_ping(text)`.

In Cloudflare:

- One Worker named for the selected Supabase project.
- One Cron Trigger.
- Worker secret bindings for the Supabase URL, publishable key, and heartbeat secret.
- A temporary verification secret that is removed before the final deployment finishes.

Locally:

- A platform config manifest with project reference, Worker name, schedule, timestamps, checksums, and dashboard links.
- No local secrets.

## Security Boundary

Supacron never stores clear heartbeat secrets locally. It generates the heartbeat secret in memory, stores only a SHA-256 digest in Supabase SQL, and streams the clear value to Wrangler over stdin so Cloudflare stores it as a Worker secret.

The final Worker has no public HTTP handler. During installation, Supacron briefly deploys a secret-protected verification endpoint, calls it once, deletes its temporary secret, then deploys the final scheduled-only Worker.

The local manifest is validated as non-secret data. Fields or values that look like tokens, passwords, service-role keys, connection strings, or publishable keys are rejected.

## Commands

```bash
npx supacron init
npx supacron status --project-ref <ref>
npx supacron repair --project-ref <ref>
npx supacron uninstall --project-ref <ref>
```

`status` verifies the saved installation without local secrets.

`repair` redeploys the final scheduled Worker config from the manifest. It does not recreate database objects because Supacron does not keep the heartbeat secret locally.

`uninstall` shows the exact Worker and Supabase objects first, deletes only the selected Worker, runs scoped SQL for Supacron-owned database objects, and removes the local manifest after approval.

## Package Contents

`npm pack --dry-run` includes only:

- `LICENSE`
- `README.md`
- `package.json`
- `src/**`

Tests and architecture docs stay in the repository, not the published tarball.
