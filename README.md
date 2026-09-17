<div align="center">

<h1>Supacron</h1>

<h3>Cloudflare Workers Cron -> Supabase heartbeat, installed from your terminal.</h3>

<p><em>Private cron. Visible proof. No service-role keys, database passwords, connection strings, Supabase access tokens, or Cloudflare API tokens.</em></p>

<br />

<a href="#quick-start"><img alt="Get Started" src="https://img.shields.io/badge/GET_STARTED-64D80D?style=for-the-badge&labelColor=64D80D&color=64D80D" /></a>

<br />
<br />

<img alt="version 0.1.0" src="https://img.shields.io/badge/version-0.1.0-64D80D?style=flat-square&labelColor=111827" />
<img alt="license MIT" src="https://img.shields.io/badge/license-MIT-64D80D?style=flat-square&labelColor=111827" />
<img alt="runtime Node 20+" src="https://img.shields.io/badge/runtime-Node_20+-64D80D?style=flat-square&labelColor=111827" />

<br />
<br />

<img alt="Supabase" src="https://img.shields.io/badge/SUPABASE-3ECF8E?style=for-the-badge&logo=supabase&logoColor=white&labelColor=111827" />
<img alt="Cloudflare" src="https://img.shields.io/badge/CLOUDFLARE-F38020?style=for-the-badge&logo=cloudflare&logoColor=white&labelColor=111827" />
<img alt="Workers" src="https://img.shields.io/badge/WORKERS-F6821F?style=for-the-badge&logo=cloudflareworkers&logoColor=white&labelColor=111827" />

</div>

## Quick Start

Run the guided installer:

```bash
npx supacron init
```

After setup, run a live proof check any time:

```bash
npx supacron test
```

`setup` is also supported as an alias:

```bash
npx supacron setup
```

## What Supacron Does

Supacron installs a small scheduled Cloudflare Worker that calls a protected Supabase RPC on a cron schedule. Supabase stores the latest heartbeat timestamp and ping count, so you can verify that the scheduled Worker is actually running.

```txt
Cloudflare Cron Trigger -> scheduled Worker -> Supabase RPC -> supacron.heartbeat
```

Supacron has no hosted backend, dashboard, billing system, analytics, queue, GitHub integration, or Vercel path. Your accounts remain yours.

## Setup Flow

The installer walks through:

- Supabase login through the official Supabase CLI, if needed.
- Supabase project selection.
- A clear Supabase setup plan before SQL is applied.
- Automatic SQL setup by default, with a manual SQL fallback if you want to inspect or run the SQL yourself.
- Supabase object verification.
- Cloudflare login through Wrangler, if needed.
- Cloudflare account selection.
- Cron schedule selection.
- Worker deployment with secrets streamed through Wrangler stdin.
- One temporary live test to prove the heartbeat works.
- Removal of temporary test access.
- Final scheduled-only Worker deployment.
- Cleanup of Supacron's temporary setup workspace.
- A final choice to keep provider CLI sessions remembered or log out.

## What It Creates

In Supabase:

- Schema `supacron`.
- Table `supacron.heartbeat`.
- Function `public.supacron_ping(text)`.
- RLS, revokes, and narrow grants for Supacron-owned objects.

In Cloudflare:

- One Worker named `supacron-<project-ref>` by default.
- One Cron Trigger.
- Worker secret bindings for the Supabase URL, public Supabase key, and heartbeat secret.
- A temporary verification secret during setup/test that is removed before the final scheduled-only Worker is restored.

Locally:

- A temporary Supacron setup workspace under the OS temp directory while setup or test is running.
- A small non-secret installation receipt in the user's app config directory so `npx supacron test` can find the Worker later.
- No stored heartbeat secret, service-role key, database password, connection string, Supabase access token, or Cloudflare API token.

`npm install` may create normal Node project files such as `node_modules`, `package.json`, and `package-lock.json`. Supacron does not delete project-owned npm files.

## Proof Command

Run:

```bash
npx supacron test
```

It verifies the deployed setup by:

- Loading the local non-secret receipt.
- Checking the Supabase heartbeat objects.
- Temporarily enabling live test access on the Worker.
- Sending one live heartbeat through the deployed Worker.
- Checking Supabase for the new heartbeat.
- Removing temporary test access.
- Restoring the Worker to scheduled-only mode.
- Printing Supabase and Cloudflare links so you can verify the result yourself.

If you have multiple Supacron receipts on the same machine, pass the project ref:

```bash
npx supacron test --project-ref <supabase-project-ref>
```

## Rerunning Setup

Rerunning setup for the same Supabase project uses the same default Worker name:

```txt
supacron-<project-ref>
```

That means choosing a new schedule updates the existing Worker instead of creating a second default Worker.

## Setup Modes

Automatic mode is the default:

```bash
npx supacron init --mode automatic
```

Manual SQL fallback prints the full SQL for you to run in Supabase SQL Editor, then Supacron verifies the result:

```bash
npx supacron init --mode manual
```

## Session Choice

At the end, Supacron asks whether to keep the official CLIs logged in on this machine or log out.

You can script that choice:

```bash
npx supacron init --session remember
npx supacron init --session logout
```

CLI sessions are owned by the official provider CLIs and live outside your project folder.

## Requirements

- Node.js 20 or newer.
- A Supabase account with access to the target project.
- A Cloudflare account that can deploy Workers.
- Network access to run the official Supabase CLI and Wrangler through pinned `npx` package specs.

## Security Boundary

Supacron never asks for database passwords, connection strings, service-role keys, Supabase access tokens, or Cloudflare API tokens.

The heartbeat secret is generated locally in memory. Supacron stores only a SHA-256 digest in Supabase SQL and streams the clear value to Wrangler over stdin so Cloudflare stores it as a Worker secret. The clear heartbeat secret is not written to command arguments, generated files, local storage, or logs.

The final Worker has no public HTTP handler. During setup and `test`, Supacron briefly deploys a secret-protected test route, calls it once, removes its temporary secret, and restores the final scheduled-only Worker.

## Package Contents

The published package includes only:

- `LICENSE`
- `README.md`
- `package.json`
- `src/**`

Tests and docs stay in the repository, not the npm tarball.
