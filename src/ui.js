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

export function renderBanner(out, banner) {
  write(out, "");
  for (const line of banner.split("\n")) {
    write(out, color(out, "cyan", line));
  }
  write(out, color(out, "blue", strong(out, "Supacron secure setup")));
  write(out, muted(out, "Cloudflare Workers Cron -> Supabase heartbeat, using only official CLIs."));
}