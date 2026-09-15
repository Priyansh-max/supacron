<div align="center">

<h1>&#9201; Supacron</h1>

<hr />

<h3>Keep a Supabase project warm with one Cloudflare Cron heartbeat.</h3>

<p><em>No backend. No service-role key. No stored local secrets. Your accounts -> official CLIs -> scheduled Worker -> protected Supabase RPC.</em></p>

<br />

<a href="#install"><img alt="Get Started" src="https://img.shields.io/badge/GET_STARTED-64D80D?style=for-the-badge&labelColor=64D80D&color=64D80D" /></a>

<br />
<br />

<img alt="version 0.1.0" src="https://img.shields.io/badge/version-0.1.0-64D80D?style=flat-square&labelColor=111827" />
<img alt="license MIT" src="https://img.shields.io/badge/license-MIT-64D80D?style=flat-square&labelColor=111827" />
<img alt="platform CLI" src="https://img.shields.io/badge/platform-CLI-64D80D?style=flat-square&labelColor=111827" />
<img alt="runtime Node 20+" src="https://img.shields.io/badge/runtime-Node_20+-64D80D?style=flat-square&labelColor=111827" />

<br />
<br />

<img alt="Supabase" src="https://img.shields.io/badge/SUPABASE-3ECF8E?style=for-the-badge&logo=supabase&logoColor=white&labelColor=111827" />
<img alt="Cloudflare" src="https://img.shields.io/badge/CLOUDFLARE-F38020?style=for-the-badge&logo=cloudflare&logoColor=white&labelColor=111827" />
<img alt="Workers" src="https://img.shields.io/badge/WORKERS-F6821F?style=for-the-badge&logo=cloudflareworkers&logoColor=white&labelColor=111827" />
<img alt="Wrangler" src="https://img.shields.io/badge/WRANGLER-222222?style=for-the-badge&logo=cloudflare&logoColor=white&labelColor=111827" />
<img alt="Secret safe" src="https://img.shields.io/badge/SECRET_SAFE-0F172A?style=for-the-badge&logo=shieldsdotio&logoColor=white&labelColor=111827" />

</div>

## Install

```bash
npx supacron setup
```

`setup` walks through the full secure setup and runs the provider CLI commands for you after approval:

- Supabase browser login through the official CLI.
- Project selection.
- Automatic SQL setup by default, with manual fallback available.
- Database structure verification.
- Cloudflare browser login through Wrangler.
- Worker Cron deployment.
- One temporary verification endpoint.
- Final scheduled-only Worker deployment.
- A local non-secret installation manifest.

## Runtime Path

```txt
Cloudflare Cron Trigger -> scheduled Worker -> Supabase REST RPC -> one heartbeat row update
```

Supacron is intentionally narrow. It has no hosted backend, dashboard, account system, billing, analytics, queue, GitHub integration, or Vercel path.

## Requirements

- Node.js 20 or newer.
- A Supabase account with access to the target project.
- A Cloudflare account that can deploy Workers.
- Official provider CLIs available through `npx` during setup. Supacron invokes them internally; you should not have to run Wrangler or Supabase commands by hand during the guided flow.

Supacron pins the provider CLI packages it invokes and runs major setup commands inside the guided installer.

## Setup Modes

### Automatic SQL

```bash
npx supacron setup --mode automatic
```

Recommended and used by default. Supacron shows the SQL, asks again, applies it with the official Supabase CLI, verifies the database objects, then continues into Cloudflare deployment. If the required scoped provider authorization is not available, use manual mode.

### Manual SQL

```bash
npx supacron setup --mode manual
```

Fallback mode. Supacron prints the exact SQL for you to run in Supabase SQL Editor, then verifies the installed objects. Supacron never receives a database-write credential in this mode.

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

Supacron never asks for database passwords, connection strings, service-role keys, Supabase access tokens, or Cloudflare API tokens.

It generates the heartbeat secret in memory, stores only a SHA-256 digest in Supabase SQL, and streams the clear value to Wrangler over stdin so Cloudflare stores it as a Worker secret. The clear heartbeat secret is never written to command arguments, generated files, the local manifest, or logs.

The final Worker has no public HTTP handler. During installation, Supacron briefly deploys a secret-protected verification endpoint, calls it once, deletes its temporary secret, then deploys the final scheduled-only Worker.

The local manifest is validated as non-secret data. Fields or values that look like tokens, passwords, service-role keys, connection strings, or publishable keys are rejected.

## Commands

```bash
npx supacron setup
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
