# Supacron

Supacron sets up a tiny Supabase heartbeat and a free cron provider so inactive Supabase projects keep receiving database activity.

It does not require a backend. The default path is:

```txt
free cron provider -> Supabase REST RPC -> one heartbeat row update
```

## Install

```bash
npx supacron setup
```

To let Supacron set provider secrets and deploy where possible:

```bash
npx supacron setup --install
```

## What It Generates

Supacron creates:

- A Supabase SQL migration for `public.supacron_ping`.
- A private `supacron.heartbeat` table.
- Provider config for Cloudflare Workers Cron, GitHub Actions, or Vercel Cron.
- `.supacron/config.json` with non-secret setup metadata.

Secrets are not stored in `.supacron/config.json`.

## Providers

### Cloudflare Workers Cron

Best default for a standalone free cron.

```bash
npx supacron setup --cron cloudflare
```

For the closest end-to-end setup:

```bash
npx supacron setup --cron cloudflare --install
```

Generated files:

```txt
supacron-cloudflare/src/index.js
supacron-cloudflare/wrangler.jsonc
```

### GitHub Actions

Best for the simplest repo-based setup.

```bash
npx supacron setup --cron github
```

Generated file:

```txt
.github/workflows/supacron.yml
```

Note: GitHub may disable scheduled workflows in inactive public repositories.

With GitHub CLI installed and authenticated, Supacron can set repository secrets:

```bash
npx supacron setup --cron github --install
```

### Vercel Cron

Best when the app is already deployed on Vercel.

```bash
npx supacron setup --cron vercel
```

Generated files:

```txt
api/supacron.js
vercel.json
```

Vercel Cron calls a path in the Vercel app, so Supacron creates a small API route.

With Vercel CLI installed and authenticated, Supacron can add production env vars and deploy:

```bash
npx supacron setup --cron vercel --install
```

## Commands

```bash
npx supacron setup
npx supacron ping
npx supacron doctor
```

`ping` and `doctor` read:

```txt
SUPABASE_URL
SUPABASE_ANON_KEY
SUPACRON_SECRET
```

from CLI args or environment variables.
