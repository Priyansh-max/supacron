# How to Prevent Supabase Projects From Pausing Due to Inactivity

Supabase free projects can pause when they do not get enough activity. For low-traffic side projects, demos, prototypes, and client apps, the safest keep-alive pattern is a scheduled job that creates real database activity and leaves visible proof.

Supacron automates that setup:

```txt
Cloudflare Cron Trigger -> scheduled Worker -> protected Supabase RPC -> heartbeat row
```

Run:

```bash
npx supacron init
```

Then verify the live heartbeat:

```bash
npx supacron test
```

## Why Supabase Projects Pause

Supabase may pause free projects that do not have enough activity over time. For small projects, this can be annoying because the app may still exist, the frontend may still load, and you may occasionally call APIs, but the database might not receive consistent activity.

The practical fix is to make the keep-alive touch Postgres directly.

## The Manual Solution

A manual Supabase keep-alive cron job usually needs:

1. A scheduled cron provider.
2. A secure endpoint or worker.
3. A Supabase function or query that updates a tiny heartbeat row.
4. Secret handling so the endpoint cannot be called by anyone.
5. Verification so you know the cron actually ran.

That is simple in theory, but repetitive if you have multiple Supabase projects.

## The Supacron Solution

Supacron packages the Cloudflare Cron plus Supabase heartbeat workflow into a guided CLI.

It creates:

- a Supabase `supacron` schema
- a `supacron.heartbeat` table
- a protected `public.supacron_ping(text)` RPC
- a scheduled Cloudflare Worker
- a Cloudflare Cron Trigger
- Worker secrets for the Supabase URL, public Supabase key, and heartbeat secret
- a local non-secret receipt for future verification

The final Worker has no public HTTP handler. During setup and `npx supacron test`, Supacron temporarily enables a secret-protected test route, calls it once, removes the temporary access, and restores the Worker to scheduled-only mode.

## Manual Cron vs Supacron

| Option | What it does well | What you still handle |
| --- | --- | --- |
| GitHub Actions cron | Easy if your project already lives on GitHub | workflow secrets, scheduling, verification |
| Vercel Cron | Good for Vercel-hosted apps | project coupling and endpoint safety |
| Manual Cloudflare Worker | flexible and reliable | SQL, secrets, deployment, verification |
| Supacron | guided setup with live proof | Cloudflare-only v1 |

## FAQ

### How do I prevent a Supabase project from pausing?

Create scheduled database activity. Supacron does this with a Cloudflare Cron Trigger, scheduled Worker, protected Supabase RPC, and heartbeat row.

### How do I keep a Supabase free project alive?

Run `npx supacron init`, choose a heartbeat frequency, and let Supacron deploy the Cloudflare Worker and Supabase heartbeat objects.

### Can I use Cloudflare Cron to keep Supabase active?

Yes. Supacron uses Cloudflare Cron Triggers to run a scheduled Worker that calls Supabase on a recurring schedule.

### Why not just ping my app URL?

A URL ping may prove that a route is reachable, but it may not prove that the Supabase database received activity. Supacron updates a heartbeat row in Postgres so the activity is visible.

### Does Supacron need dangerous credentials?

No. Supacron does not ask for service-role keys, database passwords, connection strings, Supabase access tokens, or Cloudflare API tokens.

### Does Supacron guarantee my Supabase project will never pause?

No tool can guarantee provider-side policy or billing behavior. Supacron helps by creating real scheduled database activity and visible proof that the heartbeat ran.

## Install Command

```bash
npx supacron init
```

GitHub: <https://github.com/Priyansh-max/supacron>
