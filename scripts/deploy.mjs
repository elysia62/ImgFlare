import { spawnSync } from "node:child_process";

function run(command, args, env, capture = false) {
  const result = spawnSync(command, args, {
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
    env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? 1}`);
  }
  return result.stdout;
}

export function deploy({ database, env = process.env, execute = run }) {
  if (!database || database.binding !== "DB" || (!database.database_id && !database.database_name)) {
    throw new Error("请在 wrangler.toml 中配置 DB 的 database_name 或 database_id。");
  }
  // Provision fresh installations before migration, without publishing code.
  // A configured ID is authoritative (including a restored/custom database).
  if (!database.database_id) {
    const databases = JSON.parse(execute("bun", ["x", "wrangler", "d1", "list", "--json"], env, true));
    if (!Array.isArray(databases) || databases.some(db => typeof db.name !== "string")) {
      throw new Error("D1 数据库列表响应无效，已停止部署。");
    }
    if (!databases.some(db => db.name === database.database_name)) {
      execute("bun", ["x", "wrangler", "d1", "create", database.database_name, "--no-update-config"], env);
    }
  }
  execute(
    "bun",
    ["x", "wrangler", "d1", "migrations", "apply", "DB", "--remote"],
    env,
  );
  // Runtime configuration is managed in the dashboard. Wrangler preserves
  // existing secrets; keep-vars also retains dashboard plaintext variables.
  execute("bun", ["x", "wrangler", "deploy", "--keep-vars"], env);
}

async function main() {
  const { unstable_readConfig } = await import("wrangler");
  const config = unstable_readConfig({ config: "wrangler.toml" });
  deploy({ database: config.d1_databases.find(db => db.binding === "DB") });
}

if (import.meta.main) {
  try { await main(); }
  catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
