import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "./args.js";
import { writeConfig } from "./config.js";
import { installProvider, providerCliStatus } from "./provider-actions.js";
import { ask, choose, confirm, createPromptSession } from "./prompts.js";
import {
  PROVIDERS,
  cloudflareWorker,
  cloudflareWrangler,
  envExample,
  githubWorkflow,
  migrationSql,
  vercelJson,
  vercelRoute
} from "./templates.js";
import { projectRefFromUrl, safeName, writeFile } from "./utils.js";

const DEFAULT_SCHEDULE = "0 6 * * *";

export async function setup(args) {
  const parsed = parseArgs(args);
  const yes = parsed.flags.has("yes");
  const install = parsed.flags.has("install");
  const providerFromArg = parsed.values.cron;

  if (providerFromArg && !PROVIDERS.includes(providerFromArg)) {
    throw new Error(`Unsupported cron provider: ${providerFromArg}`);
  }

  const rl = await createPromptSession();

  try {
    const supabaseUrl = await valueOrAsk(rl, parsed.values.url, "Supabase project URL");
    const supabaseAnonKey = await valueOrAsk(rl, parsed.values.key, "Supabase anon key");
    const provider = providerFromArg || await choose(rl, "Where should the free cron run?", [
      { value: "cloudflare", label: "Cloudflare Workers Cron (recommended)" },
      { value: "github", label: "GitHub Actions" },
      { value: "vercel", label: "Vercel Cron" }
    ]);
    const schedule = parsed.values.schedule || DEFAULT_SCHEDULE;
    const supacronSecret = parsed.values.secret || crypto.randomBytes(24).toString("hex");
    const cronSecret = parsed.values["cron-secret"] || crypto.randomBytes(24).toString("hex");
    const repo = parsed.values.repo;
    const projectRef = projectRefFromUrl(supabaseUrl);
    const migrationPath = path.join("supabase", "migrations", `${timestamp()}_supacron.sql`);

    if (!yes) {
      console.log(`\nSupacron will generate:
- ${migrationPath}
- .supacron/config.json
- .supacron/env.supacron.example
${providerFilesPreview(provider)}
`);
    }

    const created = [];
    created.push(writeFile(migrationPath, migrationSql({ secret: supacronSecret })));
    created.push(writeFile(path.join(".supacron", "env.supacron.example"), envExample({ supabaseUrl })));

    if (provider === "github") {
      created.push(writeFile(path.join(".github", "workflows", "supacron.yml"), githubWorkflow({ schedule })));
    }

    if (provider === "cloudflare") {
      const workerName = `supacron-${safeName(projectRef)}`;
      created.push(writeFile(path.join("supacron-cloudflare", "src", "index.js"), cloudflareWorker()));
      created.push(writeFile(path.join("supacron-cloudflare", "wrangler.jsonc"), cloudflareWrangler({ name: workerName, schedule })));
    }

    if (provider === "vercel") {
      created.push(writeFile(path.join("api", "supacron.js"), vercelRoute()));
      created.push(writeFile("vercel.json", vercelJson({ schedule })));
    }

    writeConfig({
      provider,
      schedule,
      supabaseUrl,
      projectRef,
      createdAt: new Date().toISOString(),
      files: created
    });

    const shouldInstall = install || (!yes && await confirm(rl, providerInstallQuestion(provider), provider === "cloudflare"));
    let installed = false;

    if (shouldInstall) {
      if (!providerCliStatus(provider)) {
        console.log(`\n${providerCliName(provider)} was not found or is not logged in.`);
        console.log("Supacron generated the files and will print manual setup steps instead.");
      } else {
        installProvider({
          provider,
          supabaseUrl,
          supabaseAnonKey,
          supacronSecret,
          cronSecret,
          repo
        });
        installed = true;
      }
    }

    printNextSteps({
      provider,
      schedule,
      supabaseUrl,
      supabaseAnonKey,
      supacronSecret,
      cronSecret,
      created,
      installed
    });
  } finally {
    rl.close();
  }
}

async function valueOrAsk(rl, value, label) {
  if (value) {
    return value;
  }

  const answer = await ask(rl, label);
  if (!answer) {
    throw new Error(`${label} is required`);
  }

  return answer;
}

function providerFilesPreview(provider) {
  if (provider === "github") {
    return "- .github/workflows/supacron.yml";
  }

  if (provider === "cloudflare") {
    return "- supacron-cloudflare/src/index.js\n- supacron-cloudflare/wrangler.jsonc";
  }

  return "- api/supacron.js\n- vercel.json";
}

function providerInstallQuestion(provider) {
  if (provider === "github") {
    return "Set GitHub Actions secrets now with gh CLI?";
  }

  if (provider === "vercel") {
    return "Set Vercel env vars and deploy now with Vercel CLI?";
  }

  return "Set Cloudflare secrets and deploy now with Wrangler?";
}

function providerCliName(provider) {
  if (provider === "github") {
    return "GitHub CLI";
  }

  if (provider === "vercel") {
    return "Vercel CLI";
  }

  return "Wrangler";
}

function printNextSteps({ provider, schedule, supabaseUrl, supabaseAnonKey, supacronSecret, cronSecret, created, installed }) {
  console.log("\nSupacron files created.\n");
  created.forEach((file) => console.log(`- ${file}`));

  console.log(`\nSchedule: ${schedule}`);
  console.log("\nApply the generated SQL in Supabase first:");
  console.log("1. Open Supabase Dashboard -> SQL Editor.");
  console.log("2. Paste the generated supabase/migrations/*_supacron.sql file.");
  console.log("3. Run it.");

  if (provider === "github") {
    console.log("\nGitHub Actions setup:");
    if (installed) {
      console.log("Repository secrets were set with GitHub CLI.");
      console.log("1. Commit and push .github/workflows/supacron.yml.");
      console.log("2. Run the workflow manually once from GitHub Actions.");
    } else {
      console.log("1. Add these repository secrets:");
      console.log(`   gh secret set SUPABASE_URL --body "${supabaseUrl}"`);
      console.log(`   gh secret set SUPABASE_ANON_KEY --body "${supabaseAnonKey}"`);
      console.log(`   gh secret set SUPACRON_SECRET --body "${supacronSecret}"`);
      console.log("2. Commit and push .github/workflows/supacron.yml.");
      console.log("3. Run the workflow manually once from GitHub Actions.");
    }
    console.log("\nWarning: public repo scheduled workflows may be disabled by GitHub after long repo inactivity.");
  }

  if (provider === "cloudflare") {
    console.log("\nCloudflare setup:");
    if (installed) {
      console.log("Cloudflare secrets were set and the Worker was deployed.");
    } else {
      console.log("1. cd supacron-cloudflare");
      console.log("2. npx wrangler login");
      console.log(`3. npx wrangler secret put SUPABASE_URL        # ${supabaseUrl}`);
      console.log(`4. npx wrangler secret put SUPABASE_ANON_KEY   # ${supabaseAnonKey}`);
      console.log(`5. npx wrangler secret put SUPACRON_SECRET     # ${supacronSecret}`);
      console.log(`6. npx wrangler secret put CRON_SECRET         # ${cronSecret}`);
      console.log("7. npx wrangler deploy");
    }
  }

  if (provider === "vercel") {
    console.log("\nVercel setup:");
    if (installed) {
      console.log("Production env vars were set and the project was deployed.");
    } else {
      console.log("1. Add these production env vars:");
      console.log(`   vercel env add SUPABASE_URL production      # ${supabaseUrl}`);
      console.log(`   vercel env add SUPABASE_ANON_KEY production # ${supabaseAnonKey}`);
      console.log(`   vercel env add SUPACRON_SECRET production   # ${supacronSecret}`);
      console.log(`   vercel env add CRON_SECRET production       # ${cronSecret}`);
      console.log("2. Deploy to production so Vercel registers vercel.json crons.");
      console.log("3. Vercel Hobby cron can run once per day, which matches Supacron's default.");
    }
  }

  console.log("\nAfter SQL is applied, test locally:");
  console.log(`SUPABASE_URL="${supabaseUrl}" SUPABASE_ANON_KEY="${supabaseAnonKey}" SUPACRON_SECRET="${supacronSecret}" npx supacron ping`);
}

function timestamp() {
  const now = new Date();
  const compact = now.toISOString().replaceAll(/[-:]/g, "").replace(/\..+$/, "");
  return compact.replace("T", "");
}
