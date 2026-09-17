const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
};

export function supportsColor(out = process.stdout, env = process.env) {
  return Boolean(
    out?.isTTY &&
    env.NO_COLOR == null &&
    env.NODE_DISABLE_COLORS == null &&
    env.TERM !== "dumb"
  );
}

export function color(out, name, value) {
  if (!supportsColor(out) || !ANSI[name]) {
    return String(value);
  }
  return `${ANSI[name]}${value}${ANSI.reset}`;
}

export function strong(out, value) {
  return color(out, "bold", value);
}

export function muted(out, value) {
  return color(out, "dim", value);
}

export function write(out, line = "") {
  out.write(`${line}\n`);
}

export function section(out, title) {
  write(out, "");
  write(out, color(out, "blue", strong(out, title)));
}

export function status(out, state, message) {
  const states = {
    info: ["..", "cyan"],
    success: ["ok", "green"],
    warn: ["!!", "yellow"],
    error: ["xx", "red"],
  };
  const [label, tone] = states[state] || states.info;
  write(out, `  ${color(out, tone, `[${label}]`)} ${message}`);
}

export function keyValue(out, key, value) {
  write(out, `  ${muted(out, `${key.padEnd(12)} `)}${value}`);
}

export function bullet(out, value) {
  write(out, `  ${color(out, "cyan", "-")} ${value}`);
}

export function command(out, value) {
  return color(out, "cyan", value);
}

export function choiceLine(out, choice, active, width = 0) {
  const detailText = choice.description ? ` - ${choice.description}` : "";
  const visibleText = `${choice.label}${detailText}`;
  const label = active ? color(out, "green", strong(out, choice.label)) : choice.label;
  const detail = choice.description ? muted(out, detailText) : "";
  const padding = active && width > visibleText.length ? " ".repeat(width - visibleText.length) : "";
  const marker = active ? ` ${color(out, "green", "<")}` : "";
  return `  ${label}${detail}${padding}${marker}`;
}

export async function renderBannerIntro(out, banner, options = {}) {
  if (supportsMotion(out, options.env)) {
    await renderSupacronPulse(out, options.sleep || sleep);
  }
  renderBanner(out, banner);
}

export function renderBanner(out, banner) {
  const lines = banner.split("\n");
  const width = Math.max(...lines.map((line) => line.length), 58);
  const rule = `+${"-".repeat(width + 2)}+`;

  write(out, "");
  write(out, color(out, "blue", rule));
  for (const line of lines) {
    write(out, color(out, "cyan", `| ${line.padEnd(width)} |`));
  }
  write(out, color(out, "blue", rule));
  write(out, `  ${color(out, "green", strong(out, "Private cron, visible proof."))}`);
  write(out, `  ${muted(out, "Cloudflare runs the timer. Supabase stores the heartbeat. You keep the keys.")}`);
}

function supportsMotion(out = process.stdout, env = process.env) {
  return Boolean(
    out?.isTTY
      && env.CI !== "true"
      && env.NO_COLOR == null
      && env.NODE_DISABLE_COLORS == null
      && env.SUPACRON_NO_ANIMATION == null
      && env.TERM !== "dumb"
  );
}

async function renderSupacronPulse(out, wait) {
  const frames = [
    "      .      ",
    "     /S\\     ",
    "    - S -    ",
    "     \\S/     ",
    "      '      ",
    "     \\S/     ",
    "    - S -    ",
    "     /S\\     ",
  ];

  write(out, "");
  for (let loop = 0; loop < 2; loop += 1) {
    for (const frame of frames) {
      out.write(`\r\x1b[2K${color(out, "cyan", frame)} ${muted(out, "warming up Supacron")}`);
      await wait(55);
    }
  }
  out.write("\r\x1b[2K");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}