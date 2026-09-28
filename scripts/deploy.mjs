import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CONFIG_NAMES = [
  "ADMIN_USERNAME",
  "ADMIN_PASSWORD",
  "SESSION_SECRET",
  "TURNSTILE_SITE_KEY",
  "TURNSTILE_SECRET",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
];

export function parseDotenv(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function loadConfig(env, dotenvText) {
  const file = parseDotenv(dotenvText);
  const values = {};
  const missing = [];
  for (const name of CONFIG_NAMES) {
    const value = (env[name] ?? file[name] ?? "").trim();
    if (!value) missing.push(name);
    else if (name === "SESSION_SECRET" && (value.length < 32 || value.startsWith("YOUR_") || value.startsWith("imgflare-session-"))) {
      missing.push(name + "（请生成新的随机密钥，至少 32 字符）");
    } else values[name] = value;
  }
  return { values, missing };
}

function readDevVars() {
  try {
    return readFileSync(".dev.vars", "utf8");
  } catch {
    return "";
  }
}

function run(command, args, env) {
  const result = spawnSync(command, args, { stdio: "inherit", env });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? 1}`);
  }
}

function main() {
  const { values, missing } = loadConfig(process.env, readDevVars());
  if (missing.length > 0) {
    console.error(`缺少或无效配置：${missing.join(", ")}。请填写 Build variables and secrets。`);
    process.exit(1);
  }

  const dir = mkdtempSync(join(tmpdir(), "imgflare-"));
  const file = join(dir, "secrets.json");
  try {
    writeFileSync(file, JSON.stringify(values), { mode: 0o600 });
    const childEnv = { ...process.env };
    for (const name of CONFIG_NAMES) delete childEnv[name];
    run(
      "bunx",
      ["wrangler", "deploy", "--keep-vars", "--secrets-file", file],
      childEnv,
    );
    run(
      "bunx",
      ["wrangler", "d1", "migrations", "apply", "DB", "--remote"],
      childEnv,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try { main(); }
  catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
