#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
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

function requireRustTarget() {
  const ready = () => {
    const r = spawnSync("rustc", ["--print", "target-libdir", "--target", "wasm32-unknown-unknown"], {
      encoding: "utf8",
    });
    const dir = (r.stdout ?? "").trim();
    return r.status === 0 && dir.length > 0 && existsSync(dir);
  };
  if (ready()) return;

  log("installing Rust target wasm32-unknown-unknown…");
  const add = spawnSync("rustup", ["target", "add", "wasm32-unknown-unknown"], { stdio: "inherit" });
  if (add.status === 0 && ready()) return;

  fail(
    "Rust target wasm32-unknown-unknown is missing.",
    "Install Rust with rustup, then run `rustup target add wasm32-unknown-unknown`.",
  );
}

function pinnedWasmBindgenVersion() {
  const lock = readFileSync(`${ROOT}/Cargo.lock`, "utf8");
  for (const block of lock.split("[[package]]")) {
    if (/^name = "wasm-bindgen"$/m.test(block)) {
      return block.match(/^version = "([^"]+)"/m)?.[1] ?? null;
    }
  }
  return null;
}

function wasmBindgenTarget() {
  const key = `${process.platform}-${process.arch}`;
  const table = {
    "linux-x64": "x86_64-unknown-linux-musl",
    "linux-arm64": "aarch64-unknown-linux-musl",
    "darwin-x64": "x86_64-apple-darwin",
    "darwin-arm64": "aarch64-apple-darwin",
  };
  return table[key] ?? null;
}

async function resolveWasmBindgen() {
  if (process.env.WASM_BINDGEN_BIN) return process.env.WASM_BINDGEN_BIN;

  const version = pinnedWasmBindgenVersion();
  if (!version) fail("could not read wasm-bindgen version from Cargo.lock");

  const candidate = `${process.env.CARGO_HOME ?? `${process.env.HOME}/.cargo`}/bin/wasm-bindgen`;
  if (existsSync(candidate)) {
    const got = spawnSync(candidate, ["--version"], { encoding: "utf8" }).stdout?.match(/(\d+\.\d+\.\d+)/)?.[1];
    if (got === version) return candidate;
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

  const untar = spawnSync("tar", ["xzf", tarPath, "-C", `${TOOLS}/wasm-bindgen-${version}`, "--strip-components=1"], {
    encoding: "utf8",
  });
  if (untar.status !== 0) fail(`failed to extract ${asset}: ${untar.stderr}`);

  rmSync(tarPath, { force: true });
  if (!existsSync(bin)) fail(`wasm-bindgen binary missing after extracting ${asset}`);
  chmodSync(bin, 0o755);
  return bin;
}

function shimSource() {
  return `import { WorkerEntrypoint } from "cloudflare:workers";
import wasmModule from "./index_bg.wasm";
import * as bindings from "./index_bg.js";

// Workers imports a WebAssembly.Module; instantiate it before calling Rust.
const instance = new WebAssembly.Instance(wasmModule, { "./index_bg.js": bindings });
bindings.__wbg_set_wasm(instance.exports);
instance.exports.__wbindgen_start();

class Entrypoint extends WorkerEntrypoint {
  fetch(request) {
    return bindings.fetch(request, this.env, this.ctx);
  }

  scheduled(event) {
    return bindings.scheduled(event, this.env, this.ctx);
  }
}

export default Entrypoint;
`;
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit" });
  if (r.error) fail(`failed to run ${cmd}: ${r.error.message}`);
  if (r.status !== 0) fail(`${cmd} ${args.join(" ")} exited with ${r.status}`);
}

function cargoBuild() {
  log("compiling Rust to Wasm…");
  run("cargo", ["build", "--locked", "--release", "--target", "wasm32-unknown-unknown"]);
}

function runWasmBindgen(bin) {
  log("running wasm-bindgen…");
  rmSync(STAGING, { recursive: true, force: true });
  mkdirSync(STAGING, { recursive: true });

  const wasm = `${ROOT}/target/wasm32-unknown-unknown/release/imgflare.wasm`;
  if (!existsSync(wasm)) fail(`expected ${wasm} to exist after cargo build`);

  run(bin, ["--target", "bundler", "--no-typescript", "--out-name", "index", "--out-dir", STAGING, wasm]);
}

function writeShim() {
  writeFileSync(`${STAGING}/worker-shim.mjs`, shimSource());
}

async function bundle() {
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  await build({
    entryPoints: [`${STAGING}/worker-shim.mjs`],
    bundle: true,
    format: "esm",
    target: "es2022",
    outfile: `${OUT_DIR}/shim.mjs`,
    external: ["*.wasm", "cloudflare:workers"],
  });
  publishWasm();
}

function publishWasm() {
  const generated = `${STAGING}/index_bg.wasm`;
  if (!existsSync(generated)) fail("wasm-bindgen produced no index_bg.wasm");
  writeFileSync(`${OUT_DIR}/index_bg.wasm`, readFileSync(generated));
}

async function main() {
  requireRustTarget();
  const wasmBindgen = await resolveWasmBindgen();

  cargoBuild();
  runWasmBindgen(wasmBindgen);
  writeShim();
  await bundle();

  rmSync(STAGING, { recursive: true, force: true });

  const size = statSync(`${OUT_DIR}/index_bg.wasm`).size;
  const shim = statSync(`${OUT_DIR}/shim.mjs`).size;
  log(`done — index_bg.wasm ${(size / 1024).toFixed(0)} KB, shim.mjs ${(shim / 1024).toFixed(0)} KB`);
  log(`entry point: build/worker/shim.mjs`);
}

await main();
