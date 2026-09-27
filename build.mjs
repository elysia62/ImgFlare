// ---------------------------------------------------------------------------
// Build script — no bundler config files, no framework.
//
//   bun build.mjs               -> build the web frontend into ./dist
//   bun build.mjs --userscript  -> build the Tampermonkey userscript
//   bun build.mjs --watch       -> rebuild on change
//
// Bun-only. Uses `Bun.file`, `Bun.write` and `Bun.Glob` directly rather than
// the `node:fs` compatibility shims, so the script reads like the runtime it
// targets. There is no Node fallback: this project is Bun-first.
//
// Produces:
//   dist/index.html, dist/login.html, dist/styles.css, dist/main.js
//   userscript/image-uploader.user.js
// ---------------------------------------------------------------------------

import { build, context } from "esbuild";

if (typeof Bun === "undefined") {
  throw new Error("This build script requires Bun (https://bun.sh). Run: bun build.mjs");
}

const root = import.meta.dir; // Bun-specific; no need for fileURLToPath
const isWatch = process.argv.includes("--watch");
const isUserscript = process.argv.includes("--userscript");

/**
 * esbuild plugin that lets a bundle import a `.css` / `.html` file as a raw
 * string. Used by the userscript to inline its stylesheet.
 */
const rawTextPlugin = {
  name: "raw-text",
  setup(pluginBuild) {
    pluginBuild.onLoad({ filter: /\.(css|html)$/ }, async (args) => {
      const contents = await Bun.file(args.path).text();
      return { contents, loader: "text" };
    });
  },
};

// ---------------------------------------------------------------------------
// Web frontend
// ---------------------------------------------------------------------------
const FRONTEND_STATIC = ["index.html", "login.html", "styles.css"];

async function buildFrontend() {
  const dist = `${root}/dist`;
  await Bun.$`rm -rf ${dist}`.quiet();
  await Bun.$`mkdir -p ${dist}`.quiet();

  const options = {
    entryPoints: [`${root}/frontend/src/main.ts`],
    bundle: true,
    format: "esm",
    target: "es2022",
    outfile: `${dist}/main.js`,
    minify: !isWatch,
    sourcemap: isWatch ? "inline" : false,
    logLevel: "info",
  };

  // Copy the static shells verbatim. They are plain HTML/CSS with no build
  // step; the Worker injects the Turnstile site key at serve time.
  await Promise.all(
    FRONTEND_STATIC.map(async (file) => {
      const src = Bun.file(`${root}/frontend/${file}`);
      if (!(await src.exists())) throw new Error(`missing frontend/${file}`);
      await Bun.write(`${dist}/${file}`, src);
    }),
  );

  if (isWatch) {
    const ctx = await context(options);
    await ctx.watch();
    console.log(`[build] watching frontend… (bun ${Bun.version})`);
    return;
  }

  await build(options);
  await verifyLocalReferences(dist);
  console.log(`[build] frontend -> dist/ (bun ${Bun.version})`);
}

/**
 * Fail the build if any page references a local *static* asset that does not
 * exist.
 *
 * This exists because of a real bug: the HTML requested `/main.js` while the
 * bundler emitted `app.js`. Everything "built" fine, `tsc` was happy, the
 * deploy succeeded — and the page simply never ran its JavaScript, because the
 * browser 404'd the bundle. A silent, total loss of interactivity is the worst
 * possible failure mode, so we check it explicitly.
 *
 * Skipped on purpose:
 *   - absolute URLs (the Turnstile CDN), so the build needs no network;
 *   - `/api/...` paths, which are Worker routes, not files in dist/.
 */
async function verifyLocalReferences(dist) {
  const pages = FRONTEND_STATIC.filter((f) => f.endsWith(".html"));
  const missing = [];

  for (const page of pages) {
    const html = await Bun.file(`${dist}/${page}`).text();

    // Match src="..." and href="..." that start with a single "/".
    const refs = [...html.matchAll(/(?:src|href)="(\/[^"]*)"/g)].map((m) => m[1]);

    for (const ref of refs) {
      const clean = ref.split("?")[0].split("#")[0];
      if (clean.startsWith("/api/")) continue; // served by the Worker, not a file
      if (!(await Bun.file(`${dist}${clean}`).exists())) {
        missing.push(`${page} -> ${ref}`);
      }
    }
  }

  if (missing.length) {
    throw new Error(
      "broken local asset reference(s) in the built HTML:\n  " +
        missing.join("\n  ") +
        "\nThe bundle output name and the <script src> must agree.",
    );
  }
}

/**
 * Pull `ORIGIN` out of `wrangler.toml` and return its host.
 *
 * Falls back to `localhost` when the value is still the shipped placeholder or
 * the file cannot be parsed — the userscript stays installable either way.
 */
async function readOriginHost() {
  try {
    const text = await Bun.file(`${root}/wrangler.toml`).text();
    const m = text.match(/^\s*ORIGIN\s*=\s*"([^"]+)"/m);
    if (!m) return null;
    const host = new URL(m[1]).hostname;
    if (!host || host.includes("YOUR-")) return null;
    return host;
  } catch {
    return null;
  }
}

/**
 * The `@connect` directive(s) to emit.
 *
 * Tampermonkey only allows requests to hosts listed here, so the deployed host
 * must appear. `localhost` is added on top of it so the same build also works
 * against `wrangler dev`.
 */
function connectDirectives(host) {
  const lines = [`// @connect      ${host ?? "localhost"}`];
  if (host && host !== "localhost") lines.push("// @connect      localhost");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tampermonkey userscript
// ---------------------------------------------------------------------------
async function buildUserscript() {
  const dir = `${root}/userscript`;
  const outfile = `${dir}/image-uploader.user.js`;

  // `@connect` must name the user's own host, or Tampermonkey blocks every
  // request. Read it out of `wrangler.toml` so the header stays in sync with
  // whatever they deployed, instead of shipping a placeholder that silently
  // breaks the script.
  const originHost = await readOriginHost();
  const header = (await Bun.file(`${dir}/metadata.txt`).text()).replace(
    /^\/\/ @connect\s+YOUR-WORKER-HOST\s*$/m,
    connectDirectives(originHost),
  );

  await build({
    entryPoints: [`${dir}/image-uploader.user.ts`],
    bundle: true,
    format: "iife",
    target: "es2020",
    outfile,
    banner: { js: header },
    // The userscript stays readable on purpose: users are expected to inspect
    // what they are about to install into their browser.
    minify: false,
    legalComments: "none",
    logLevel: "info",
  });

  const size = Bun.file(outfile).size;
  console.log(`[build] userscript -> userscript/image-uploader.user.js (${size} bytes)`);
}

// ---------------------------------------------------------------------------
if (isUserscript) {
  await buildUserscript();
} else {
  // `Bun.file()` describes files, not directories, so use a stat-style check.
  const installed = await Bun.file(`${root}/node_modules/esbuild/package.json`).exists();
  if (!installed) {
    console.warn("[build] dependencies not installed — run `bun install` first.");
  }
  await buildFrontend();
  if (isWatch) {
    // Keep the process alive so esbuild's watcher can keep running.
    await new Promise(() => {});
  }
}
