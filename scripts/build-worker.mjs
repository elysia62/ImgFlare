#!/usr/bin/env bun
/**
 * Build the Worker bundle: Rust -> Wasm -> JavaScript -> `build/worker/`.
 *
 * Why this exists instead of `worker-build`
 * -----------------------------------------
 * `worker-build` is a Rust binary. Cloudflare's build image ships Node, Bun,
 * Python, Ruby and Go but **no Rust toolchain**, so `cargo install worker-build`
 * has to compile ~200 crates from scratch on every build (measured: 3m38s).
 * That is the only reason a bare `bun run build` could not stand alone.
 *
 * Everything `worker-build` actually does for this project is four steps, all
 * of which have cheap alternatives:
 *
 *   1. `cargo build --release --target wasm32-unknown-unknown`
 *   2. `wasm-bindgen --target bundler`        <- prebuilt binaries on GitHub Releases
 *   3. wrap the result in the Worker shim     <- a static template, inlined below
 *   4. bundle with esbuild                    <- already a devDependency
 *
 * So this script does them directly. The only thing that still needs a Rust
 * toolchain is `cargo` itself, which is installed by the build command in
 * README. Everything else is downloaded prebuilt or is already present.
 *
 * Output:
 *   build/worker/index_bg.wasm  the compiled Wasm
 *   build/worker/shim.mjs       the Worker entry point, bundled
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const STAGING = `${ROOT}/build/.staging`;
const OUT_DIR = `${ROOT}/build/worker`;
const TOOLS = `${ROOT}/build/.tools`;

const log = (msg) => console.log(`[build:worker] ${msg}`);

function fail(msg, hint) {
  console.error(`\n[build:worker] ${msg}`);
  if (hint) console.error(`[build:worker] ${hint}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Toolchain checks
// ---------------------------------------------------------------------------

/**
 * Ask rustc directly rather than shelling out to `rustup`: distro-packaged Rust
 * (Arch, Fedora, Debian) has no `rustup` at all and still ships the target.
 */
function requireRustTarget() {
  const r = spawnSync("rustc", ["--print", "target-libdir", "--target", "wasm32-unknown-unknown"], {
    encoding: "utf8",
  });
  const dir = (r.stdout ?? "").trim();
  if (r.status !== 0 || !dir || !existsSync(dir)) {
    fail(
      "Rust target wasm32-unknown-unknown is missing.",
      "Install it with `rustup target add wasm32-unknown-unknown` (the build command in README does this).",
    );
  }
}

/** The `wasm-bindgen` version pinned by Cargo.lock, so CLI and crate agree. */
function pinnedWasmBindgenVersion() {
  const lock = readFileSync(`${ROOT}/Cargo.lock`, "utf8");
  for (const block of lock.split("[[package]]")) {
    if (/^name = "wasm-bindgen"$/m.test(block)) {
      return block.match(/^version = "([^"]+)"/m)?.[1] ?? null;
    }
  }
  return null;
}

/** Map the running platform to wasm-bindgen's release-asset suffix. */
function wasmBindgenTarget() {
  const key = `${process.platform}-${process.arch}`;
  const table = {
    "linux-x64": "x86_64-unknown-linux-musl",
    "linux-arm64": "aarch64-unknown-linux-musl",
    "darwin-x64": "x86_64-apple-darwin",
    "darwin-arm64": "aarch64-apple-darwin",
    "win32-x64": "x86_64-pc-windows-msvc",
  };
  return table[key] ?? null;
}

/**
 * Fetch a prebuilt `wasm-bindgen` matching Cargo.lock.
 *
 * Cached under `build/.tools/` so repeat builds skip the download. Builds from
 * a clean checkout pay ~10 MB once, which is far cheaper than compiling the CLI.
 */
async function resolveWasmBindgen() {
  if (process.env.WASM_BINDGEN_BIN) return process.env.WASM_BINDGEN_BIN;

  const version = pinnedWasmBindgenVersion();
  if (!version) fail("could not read wasm-bindgen version from Cargo.lock");

  // An explicitly installed CLI wins, so a developer can point at their own.
  for (const candidate of [`${process.env.CARGO_HOME ?? `${process.env.HOME}/.cargo`}/bin/wasm-bindgen`]) {
    if (existsSync(candidate)) {
      const got = spawnSync(candidate, ["--version"], { encoding: "utf8" }).stdout?.match(/(\d+\.\d+\.\d+)/)?.[1];
      if (got === version) return candidate;
      log(`ignoring ${candidate}: version ${got} != Cargo.lock's ${version}`);
    }
  }

  const target = wasmBindgenTarget();
  if (!target) fail(`unsupported platform ${process.platform}-${process.arch} for wasm-bindgen`);

  const bin = `${TOOLS}/wasm-bindgen-${version}/wasm-bindgen`;
  if (existsSync(bin)) return bin;

  const asset = `wasm-bindgen-${version}-${target}.tar.gz`;
  const url = `https://github.com/wasm-bindgen/wasm-bindgen/releases/download/${version}/${asset}`;
  log(`downloading wasm-bindgen ${version}…`);

  mkdirSync(`${TOOLS}/wasm-bindgen-${version}`, { recursive: true });
  const tarPath = `${TOOLS}/${asset}`;

  const res = await fetch(url);
  if (!res.ok) fail(`failed to download ${url} (HTTP ${res.status})`);
  writeFileSync(tarPath, Buffer.from(await res.arrayBuffer()));

  // `tar` is present on Linux and macOS runners; Windows is not a supported
  // target for this project's CI anyway.
  const untar = spawnSync("tar", ["xzf", tarPath, "-C", `${TOOLS}/wasm-bindgen-${version}`, "--strip-components=1"], {
    encoding: "utf8",
  });
  if (untar.status !== 0) fail(`failed to extract ${asset}: ${untar.stderr}`);

  rmSync(tarPath, { force: true });
  if (!existsSync(bin)) fail(`wasm-bindgen binary missing after extracting ${asset}`);
  chmodSync(bin, 0o755);
  return bin;
}

// ---------------------------------------------------------------------------
// The Worker shim
// ---------------------------------------------------------------------------

/**
 * Wrapper that turns the wasm-bindgen output into a Worker module.
 *
 * Why the Wasm is instantiated by hand
 * ------------------------------------
 * `wasm-bindgen --target bundler` emits:
 *
 *     import * as wasm from "./index_bg.wasm";
 *     __wbg_set_wasm(wasm);
 *     wasm.__wbindgen_start();
 *
 * That assumes a bundler which turns a `.wasm` import into the *instantiated
 * exports*. workerd does not: importing a `.wasm` module yields a
 * `WebAssembly.Module`, so `wasm.__wbindgen_start` is undefined and the Worker
 * fails to start with `__wbindgen_start is not a function`.
 *
 * `worker-build` works around this by instantiating explicitly, and so do we:
 * call the `__wbg_set_wasm` hook with `new WebAssembly.Instance(module, imports)`
 * before anything touches the exports.
 *
 * The only import module the Wasm declares is `./index_bg.js`, so that is what
 * the import object provides. esbuild inlines `index_bg.js` and the snippet it
 * depends on into this file, which is why a single bundled module is enough.
 */
function shimSource() {
  return `import { WorkerEntrypoint } from "cloudflare:workers";
import wasmModule from "./index_bg.wasm";
import * as bindings from "./index_bg.js";

Error.stackTraceLimit = 100;

// Instantiate by hand and wire the result into the bindings.
// __wbindgen_start is an export of the *instance*, not of index_bg.js, so it
// must be called on instance.exports. wasm-bindgen's own index.js does the
// same thing; it just relies on a bundler to have resolved the .wasm import.
const instance = new WebAssembly.Instance(wasmModule, { "./index_bg.js": bindings });
bindings.__wbg_set_wasm(instance.exports);
instance.exports.__wbindgen_start();

class Entrypoint extends WorkerEntrypoint {
  fetch(request) {
    return bindings.fetch(request, this.env, this.ctx);
  }

  scheduled(event, env, ctx) {
    return bindings.scheduled(event, env, ctx);
  }
}

export default Entrypoint;
`;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", ...opts });
  if (r.error) fail(`failed to run ${cmd}: ${r.error.message}`);
  if (r.status !== 0) fail(`${cmd} ${args.join(" ")} exited with ${r.status}`);
}

function cargoBuild() {
  log("compiling Rust to Wasm…");
  run("cargo", ["build", "--release", "--target", "wasm32-unknown-unknown"]);
}

function runWasmBindgen(bin) {
  log("running wasm-bindgen…");
  rmSync(STAGING, { recursive: true, force: true });
  mkdirSync(STAGING, { recursive: true });

  const wasm = `${ROOT}/target/wasm32-unknown-unknown/release/imgflare.wasm`;
  if (!existsSync(wasm)) fail(`expected ${wasm} to exist after cargo build`);

  // `bundler` rather than `module`: this is what the Worker bundle needs, and it
  // is fully supported by stable rustc (see the note in Cargo.toml about
  // `--no-panic-recovery`).
  run(bin, ["--target", "bundler", "--no-typescript", "--out-name", "index", "--out-dir", STAGING, wasm]);
}

function writeShim() {
  writeFileSync(`${STAGING}/worker-shim.mjs`, shimSource());
}

/** Bundle the shim plus wasm-bindgen output into a single Worker module. */
function bundle() {
  log("bundling with esbuild…");
  const esbuild = `${ROOT}/node_modules/@esbuild/${esbuildPackage()}/bin/esbuild`;
  if (!existsSync(esbuild)) fail(`esbuild binary not found at ${esbuild}`, "Run `bun install` first.");

  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const result = spawnSync(
    esbuild,
    [
      `${STAGING}/worker-shim.mjs`,
      "--bundle",
      "--format=esm",
      "--target=es2022",
      `--outfile=${OUT_DIR}/shim.mjs`,
      // The shim drives the Wasm by hand (see `shimSource`), so the import must
      // survive bundling as a module import rather than being inlined as
      // base64.
      "--external:*.wasm",
      "--external:cloudflare:workers",
    ],
    { cwd: STAGING, encoding: "utf8" },
  );
  if (result.status !== 0) fail(`esbuild failed:\n${result.stderr}`);

  publishWasm();
}

/**
 * Copy the compiled Wasm next to the bundle.
 *
 * The name stays `index_bg.wasm` because that is what the wasm-bindgen output
 * imports; renaming it here would leave the shim pointing at a missing file.
 */
function publishWasm() {
  const generated = `${STAGING}/index_bg.wasm`;
  if (!existsSync(generated)) fail("wasm-bindgen produced no index_bg.wasm");
  writeFileSync(`${OUT_DIR}/index_bg.wasm`, readFileSync(generated));
}

function esbuildPackage() {
  const key = `${process.platform}-${process.arch}`;
  const table = {
    "linux-x64": "linux-x64",
    "linux-arm64": "linux-arm64",
    "darwin-x64": "darwin-x64",
    "darwin-arm64": "darwin-arm64",
    "win32-x64": "win32-x64",
    "win32-arm64": "win32-arm64",
  }[key];
  if (!table) fail(`unsupported platform ${key} for esbuild`);
  return table;
}

// ---------------------------------------------------------------------------

async function main() {
  requireRustTarget();
  const wasmBindgen = await resolveWasmBindgen();

  cargoBuild();
  runWasmBindgen(wasmBindgen);
  writeShim();
  bundle();

  // `worker-shim.mjs` is gone once esbuild inlines it, and the staging tree
  // holds generated JS that nothing ships.
  rmSync(STAGING, { recursive: true, force: true });

  const size = statSync(`${OUT_DIR}/index_bg.wasm`).size;
  const shim = statSync(`${OUT_DIR}/shim.mjs`).size;
  log(`done — index_bg.wasm ${(size / 1024).toFixed(0)} KB, shim.mjs ${(shim / 1024).toFixed(0)} KB`);
  log(`entry point: build/worker/shim.mjs`);
}

await main();
