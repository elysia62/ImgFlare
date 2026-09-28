import { build, context } from "esbuild";
import { mkdir, rm } from "node:fs/promises";

const root = import.meta.dir;
const isWatch = process.argv.includes("--watch");
const staticFiles = ["index.html", "login.html", "styles.css"];

async function buildFrontend() {
  const dist = `${root}/dist`;
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  await Promise.all(staticFiles.map((file) => Bun.write(`${dist}/${file}`, Bun.file(`${root}/frontend/${file}`))));

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
  if (isWatch) {
    const ctx = await context(options);
    await ctx.watch();
  } else {
    await build(options);
    await verifyLocalReferences(dist);
  }
}

async function verifyLocalReferences(dist) {
  for (const page of staticFiles.filter((file) => file.endsWith(".html"))) {
    const html = await Bun.file(`${dist}/${page}`).text();
    for (const [, ref] of html.matchAll(/(?:src|href)="(\/[^\/][^"]*)"/g)) {
      const path = ref.split(/[?#]/)[0];
      if (path.startsWith("/api/")) continue;
      if (!(await Bun.file(`${dist}${path}`).exists())) {
        throw new Error(`Missing asset: ${page} -> ${ref}`);
      }
    }
  }
}

async function buildUserscript() {
  await build({
    entryPoints: [`${root}/userscript/image-uploader.user.ts`],
    bundle: true,
    format: "iife",
    target: "es2020",
    outfile: `${root}/userscript/image-uploader.user.js`,
    banner: { js: await Bun.file(`${root}/userscript/metadata.txt`).text() },
    minify: false,
    legalComments: "none",
    logLevel: "info",
  });
}

if (process.argv.includes("--userscript")) await buildUserscript();
else await buildFrontend();
