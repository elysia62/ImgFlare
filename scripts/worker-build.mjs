#!/usr/bin/env bun
/**
 * Reproducible wrapper around `worker-build`. Bun-only.
 *
 * Why this exists
 * ---------------
 * `worker-build` normally downloads three tools on demand:
 *
 *   1. `wasm-bindgen`  (from GitHub Releases)
 *   2. `esbuild`       (from the npm registry)
 *   3. `wasm-opt`      (from GitHub Releases, only if enabled)
 *
 * On locked-down networks (corporate proxies, mainland China, air-gapped CI)
 * all three downloads fail, so a plain `worker-build` can never finish even
 * though the compiled Wasm itself is perfectly fine.
 *
 * `worker-build` honours `WASM_BINDGEN_BIN`, `ESBUILD_BIN` and `WASM_OPT_BIN`
 * as *absolute-path-or-PATH* overrides, so this script:
 *
 *   - locates a `wasm-bindgen` matching the version Cargo.lock pins,
 *   - locates the native `@esbuild/<platform>/bin/esbuild` that bun already
 *     installed (NOT the JS shim in `node_modules/.bin`),
 *   - forwards `--no-panic-recovery` (see below),
 *   - then shells out to `worker-build` with those overrides exported.
 *
 * Why --no-panic-recovery
 * -----------------------
 * Without it, `worker-build` passes `--experimental-reset-state-function` and
 * `--force-enable-abort-handler` to `wasm-bindgen`. Those flags generate
 * `try`/`catch` wrappers requiring a wasm `externref` table and the
 * `exception-handling` feature, neither of which stable `rustc` emits for
 * `wasm32-unknown-unknown`. The result is a hard failure:
 *
 *     error: failed to generate catch wrappers
 *     caused by: externref table required for catch wrappers
 *
 * With `--no-panic-recovery`, `worker-build` targets `bundler` instead of
 * `module`, which stable Rust fully supports and is what a Worker bundle wants
 * anyway. Panics still surface as Worker exceptions.
 */

import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (typeof Bun === "undefined") {
  throw new Error("This script requires Bun (https://bun.sh). Run: bun run build:worker");
}

// `URL.pathname` percent-encodes non-ASCII characters, which breaks `cwd` for
// anyone whose checkout path contains them (e.g. `~/文档/project`). `fileURLToPath`
// decodes back to a real filesystem path.
const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

const log = (msg) => console.log(`[build:worker] ${msg}`);

function which(bin) {
  const r = spawnSync("which", [bin], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

/**
 * Read the exact `wasm-bindgen` version pinned by Cargo.lock so the CLI and
 * the crate agree. A mismatch produces confusing "schema version" errors.
 */
async function pinnedWasmBindgenVersion() {
  const lockFile = Bun.file(`${ROOT}/Cargo.lock`);
  if (!(await lockFile.exists())) return null; // optional on a first build
  const lock = await lockFile.text();
  for (const block of lock.split("[[package]]")) {
    if (/^name = "wasm-bindgen"$/m.test(block)) {
      const m = block.match(/^version = "([^"]+)"/m);
      if (m) return m[1];
    }
  }
  return null;
}

async function resolveWasmBindgen() {
  if (process.env.WASM_BINDGEN_BIN) return process.env.WASM_BINDGEN_BIN;

  const cargoHome = process.env.CARGO_HOME ?? `${process.env.HOME ?? "/root"}/.cargo`;
  const local = `${cargoHome}/bin/wasm-bindgen`;
  const candidate = (await Bun.file(local).exists()) ? local : which("wasm-bindgen");

  if (!candidate) {
    log("wasm-bindgen not found. Install it once with:");
    log("  cargo install wasm-bindgen-cli --version <version> --locked");
    process.exit(1);
  }

  const want = await pinnedWasmBindgenVersion();
  if (want) {
    const r = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    const got = (r.stdout ?? "").match(/(\d+\.\d+\.\d+)/)?.[1];
    if (got && got !== want) {
      log(`WARNING: Cargo.lock pins wasm-bindgen ${want} but the CLI is ${got}.`);
      log(`         Run: cargo install wasm-bindgen-cli --version ${want} --locked --force`);
    }
  }
  return candidate;
}

/** Map the running platform to the `@esbuild/*` package suffix. */
function esbuildTarget() {
  const key = `${process.platform}-${process.arch}`;
  return {
    "darwin-x64": "darwin-x64",
    "darwin-arm64": "darwin-arm64",
    "linux-x64": "linux-x64",
    "linux-arm64": "linux-arm64",
    "win32-x64": "win32-x64",
    "win32-arm64": "win32-arm64",
  }[key] ?? null;
}

/**
 * `worker-build` wants the *native* esbuild binary, not the JS wrapper that
 * lives in `node_modules/.bin`. Bun installs platform packages flat, so the
 * path is deterministic.
 */
async function resolveEsbuildNative() {
  if (process.env.ESBUILD_BIN) return process.env.ESBUILD_BIN;

  const target = esbuildTarget();
  if (!target) return null;

  const binName = process.platform === "win32" ? "esbuild.exe" : "esbuild";
  const bin = `${ROOT}/node_modules/@esbuild/${target}/bin/${binName}`;
  return (await Bun.file(bin).exists()) ? bin : null;
}

/**
 * Is `wasm32-unknown-unknown` available to rustc?
 *
 * Asking rustc directly rather than shelling out to `rustup`: distro-packaged
 * Rust (Arch, Fedora, Debian) has no `rustup` at all and still ships the target,
 * so a `rustup`-only check produces a false negative that blocks the build.
 */
function rustTargetInstalled() {
  const r = spawnSync("rustc", ["--print", "target-libdir", "--target", "wasm32-unknown-unknown"], {
    encoding: "utf8",
  });
  if (r.status !== 0) return false;
  const dir = (r.stdout ?? "").trim();
  if (!dir) return false;
  // The libdir only exists once the target's std is actually installed.
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

async function main() {
  if (!rustTargetInstalled()) {
    log("Rust target wasm32-unknown-unknown is missing. Install it with:");
    log("  rustup target add wasm32-unknown-unknown");
    log("or, with a distro-packaged Rust, install your distro's wasm32 target package.");
    process.exit(1);
  }

  const env = { ...process.env };
  const wasmBindgen = await resolveWasmBindgen();
  const esbuild = await resolveEsbuildNative();

  env.WASM_BINDGEN_BIN = wasmBindgen;
  if (esbuild) env.ESBUILD_BIN = esbuild;
  // wasm-opt stays off: Cargo.toml sets `[package.metadata.wasm-pack.profile.release] wasm-opt = false`,
  // which keeps the whole pipeline free of network downloads.
  if (process.env.WASM_OPT_BIN) env.WASM_OPT_BIN = process.env.WASM_OPT_BIN;

  log(`runtime      : bun ${Bun.version}`);
  log(`wasm-bindgen : ${wasmBindgen}`);
  log(`esbuild      : ${esbuild ?? "(let worker-build resolve it)"}`);

  const args = ["--release", "--no-panic-recovery", ...process.argv.slice(2)];
  log(`running: worker-build ${args.join(" ")}`);

  const r = spawnSync("worker-build", args, { cwd: ROOT, env, stdio: "inherit" });
  if (r.error) {
    if (r.error.code === "ENOENT") {
      log("worker-build is not installed. Install it once with:");
      log("  cargo install worker-build --version 0.8.7 --locked");
    } else {
      log(String(r.error));
    }
    process.exit(1);
  }
  process.exit(r.status ?? 1);
}

await main();
