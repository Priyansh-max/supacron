import fs from "node:fs";
import path from "node:path";

const CONFIG_PATH = path.join(process.cwd(), ".supacron", "config.json");

export function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return {};
  }

  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  return JSON.parse(raw);
}

export function writeConfig(config) {
  const dir = path.dirname(CONFIG_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

export function configPath() {
  return CONFIG_PATH;
}
