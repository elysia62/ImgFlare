#!/usr/bin/env bun
/**
 * API contract check: keeps the Rust response shape and the TypeScript types
 * in agreement.
 *
 * Why this exists
 * ---------------
 * Rust serialises with serde; TypeScript declares interfaces by hand. Nothing
 * makes the two agree. A field renamed on one side (`created_at` vs
 * `createdAt`) compiles perfectly on both sides and fails only at runtime, as
 * `undefined` in the UI — or worse, as a thrown TypeError like
 * `undefined.startsWith(...)`.
 *
 * This script reads the structs out of the Rust source and the interfaces out
 * of the TypeScript, converts both to a common camelCase form, and reports any
 * client-facing field that exists on one side but not the other.
 *
 * Run:  bun run test/contract.mjs
 */

import path from "node:path";
import process from "node:process";

if (typeof Bun === "undefined") {
  throw new Error("This script requires Bun. Run: bun run test/contract.mjs");
}

const ROOT = path.resolve(import.meta.dir, "..");

// ---------------------------------------------------------------------------
// The pairs that must agree. Left = Rust struct, right = TS interface.
// ---------------------------------------------------------------------------
const PAIRS = [
  { rust: ["src/upload.rs", "FileInfo"], ts: ["FileInfo"], note: "GET /api/files, POST /api/upload" },
  { rust: ["src/files.rs", "ListResponse"], ts: ["FileListResponse"], note: "GET /api/files" },
  { rust: ["src/files.rs", "StatsResponse"], ts: ["StatsResponse"], note: "GET /api/stats" },
  { rust: ["src/tokens.rs", "TokenInfo"], ts: ["ApiToken"], note: "GET /api/tokens" },
  { rust: ["src/tokens.rs", "CreatedToken"], ts: ["CreatedToken"], note: "POST /api/tokens" },
  { rust: ["src/upload.rs", "CheckResponse"], ts: ["DuplicateCheckResult"], note: "POST /api/upload/check" },
];

const toCamel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

/**
 * Extract the fields of a Rust struct.
 * Only structs that derive Serialize are considered; `rename_all` is honoured
 * because it changes the wire format.
 */
async function rustFields(file, structName) {
  const src = await Bun.file(path.join(ROOT, file)).text();

  // Capture the attribute block plus the struct body.
  const re = new RegExp(
    String.raw`(?<attrs>(?:#\[[^\]]*\]\s*)*)pub struct ${structName}\s*\{(?<body>[^}]*)\}`,
    "m",
  );
  const m = src.match(re);
  if (!m) throw new Error(`struct ${structName} not found in ${file}`);

  const camel = /rename_all\s*=\s*"camelCase"/.test(m.groups.attrs);
  const fields = [...m.groups.body.matchAll(/pub\s+(\w+)\s*:/g)].map((x) => x[1]);

  return { fields: new Set(fields.map((f) => (camel ? toCamel(f) : f))), camel };
}

/** Extract the property names of a TypeScript interface. */
async function tsFields(interfaceName) {
  const glob = new Bun.Glob("frontend/src/**/*.ts");
  for await (const file of glob.scan(ROOT)) {
    const src = await Bun.file(path.join(ROOT, file)).text();
    const re = new RegExp(
      String.raw`(?:export\s+)?interface\s+${interfaceName}\s*(?:extends\s+\w+\s*)?\{(?<body>[^}]*)\}`,
      "m",
    );
    const m = src.match(re);
    if (!m) continue;
    const fields = [...m.groups.body.matchAll(/(?:^|\n)\s*(\w+)\??\s*:/g)].map((x) => x[1]);
    return { fields: new Set(fields), file };
  }
  throw new Error(`interface ${interfaceName} not found under frontend/src`);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
let failures = 0;

console.log("API 契约检查 — Rust 序列化结果 vs TypeScript 类型\n");

for (const { rust, ts, note } of PAIRS) {
  const [rustFile, rustName] = rust;
  const [tsName] = ts;

  const r = await rustFields(rustFile, rustName);
  const t = await tsFields(tsName);

  const missingInTs = [...r.fields].filter((f) => !t.fields.has(f));
  const missingInRust = [...t.fields].filter((f) => !r.fields.has(f));

  const label = `${rustName} ↔ ${tsName}`;
  if (!missingInTs.length && !missingInRust.length) {
    console.log(`  ✓ ${label}`);
    continue;
  }

  failures++;
  console.log(`  ✗ ${label}   (${note})`);
  if (!r.camel && missingInTs.length) {
    console.log(`      Rust 结构体缺少 #[serde(rename_all = "camelCase")]`);
  }
  for (const f of missingInTs) console.log(`      前端读取的 "${f}" 在后端不存在`);
  for (const f of missingInRust) console.log(`      后端返回的 "${f}" 前端未声明`);
}

console.log();
if (failures) {
  console.error(`契约检查失败：${failures} 处不匹配`);
  process.exit(1);
}
console.log("契约检查通过：所有客户端字段一一对应");

// ---------------------------------------------------------------------------
// Static safety invariants
//
// These are grep-level checks for rules that are easy to break by accident and
// expensive to discover in production. They are not a substitute for review —
// they are a tripwire.
// ---------------------------------------------------------------------------
console.log("\n静态安全不变量\n");

const SOURCES = ["frontend/src", "userscript", "src"];

/** Collect files under a directory that match an extension list. */
async function collect(dir, exts) {
  const out = [];
  const glob = new Bun.Glob("**/*");
  for await (const rel of glob.scan(path.join(ROOT, dir))) {
    if (exts.some((e) => rel.endsWith(e))) out.push(path.join(ROOT, dir, rel));
  }
  return out;
}

const INVARIANTS = [
  {
    name: "前端不使用 innerHTML 类 API（XSS 防线）",
    exts: [".ts", ".js"],
    dirs: ["frontend/src", "userscript"],
    // Allow the phrase inside comments; flag real call sites.
    pattern: /\.(innerHTML|outerHTML|insertAdjacentHTML)\s*[=(]/,
  },
  {
    name: "SQL 不使用字符串拼接",
    exts: [".rs"],
    dirs: ["src"],
    // `format!` building a statement would mean an injection hole.
    pattern: /format!\(\s*"(?:\s*)(?:SELECT|INSERT|UPDATE|DELETE)/i,
  },
  {
    // localStorage is allowed for UI preferences (theme, active tab). What must
    // never land there is anything credential-shaped, because it survives
    // logout and is readable by any script on the origin.
    name: "前端不把凭证写进 localStorage",
    exts: [".ts"],
    dirs: ["frontend/src"],
    pattern:
      /localStorage\.(setItem|getItem)\s*\(\s*(?:`[^`]*(?:token|password|secret|session)[^`]*`|['"][^'"]*(?:token|password|secret|session)[^'"]*['"])/i,
  },
];

let violations = 0;

for (const inv of INVARIANTS) {
  const hits = [];
  for (const dir of inv.dirs) {
    for (const file of await collect(dir, inv.exts)) {
      const text = await Bun.file(file).text();
      text.split("\n").forEach((line, i) => {
        const code = line.split("//")[0];
        if (inv.pattern.test(code)) {
          hits.push(`${path.relative(ROOT, file)}:${i + 1}`);
        }
      });
    }
  }

  if (hits.length) {
    violations++;
    console.log(`  ✗ ${inv.name}`);
    for (const h of hits) console.log(`      ${h}`);
  } else {
    console.log(`  ✓ ${inv.name}`);
  }
}

// ---------------------------------------------------------------------------
// Public-file serving rules
//
// The panel and the uploaded files share one origin, so a stored type that a
// browser renders as a document would be a session-stealing XSS. These cases
// pin the exact mapping, because a careless edit here is a silent hole.
// ---------------------------------------------------------------------------
console.log("\n公开文件响应类型");

{
  const src = await Bun.file(path.join(ROOT, "src/public.rs")).text();

  // Pull the `match` arms out of `plan_serving`: "type" => plain(...) / sandboxed(...)
  const arms = new Map();
  // Matches both `"a" => plain("x")` and the braced, multi-pattern form
  // `"a" | "b" => { sandboxed("x") }`.
  const re =
    /^\s*((?:"[^"]+"\s*\|?\s*)+)=>\s*\{?\s*(plain|sandboxed)\(\s*"([^"]*)"/gm;
  for (const m of src.matchAll(re)) {
    const keys = m[1].match(/"([^"]+)"/g) ?? [];
    for (const k of keys) {
      arms.set(k.slice(1, -1), { kind: m[2], out: m[3] });
    }
  }

  const cases = [
    ["image/png", "image/png", false],
    ["image/jpeg", "image/jpeg", false],
    ["image/webp", "image/webp", false],
    ["image/gif", "image/gif", false],
    ["image/avif", "image/avif", false],
    ["image/bmp", "image/bmp", false],
    ["image/x-icon", "image/x-icon", false],
  ];

  let bad = 0;
  for (const [stored, wantType, wantSandbox] of cases) {
    const arm = arms.get(stored);
    if (!arm) {
      console.log(`  ✗ ${stored}：没有对应的处理分支（会落到默认 case）`);
      bad++;
      continue;
    }
    if (arm.out !== wantType) {
      console.log(`  ✗ ${stored}：声明为 ${arm.out}，应为 ${wantType}`);
      bad++;
      continue;
    }
    if (arm.kind === "sandboxed" !== wantSandbox) {
      console.log(`  ✗ ${stored}：sandbox 应为 ${wantSandbox}`);
      bad++;
      continue;
    }
    console.log(`  ✓ ${stored} → ${wantType}${wantSandbox ? " + sandbox" : ""}`);
  }

  // Every branch must be sandboxed unless it is a known-inert type.
  const inert = new Set([
    "image/png", "image/jpeg", "image/webp", "image/gif", "image/avif",
    "image/bmp", "image/x-icon",
  ]);
  for (const [stored, arm] of arms) {
    if (!inert.has(stored) && arm.kind !== "sandboxed") {
      console.log(`  ✗ ${stored} 不是已知惰性类型，却没有 sandbox`);
      bad++;
    }
  }

  if (!src.includes('_ => sandboxed("application/octet-stream")')) {
    console.log("  ✗ 未知类型没有降级为 application/octet-stream + sandbox");
    bad++;
  }

  const utils = await Bun.file(path.join(ROOT, "src/utils.rs")).text();
  for (const banned of ["application/pdf", "application/javascript", "text/html", "image/svg", "application/zip", ".user.js"]) {
    if (utils.includes(banned)) {
      console.log(`  ✗ utils.rs 仍接受非图片：${banned}`);
      bad++;
    }
  }
  if (bad) violations++;
  else console.log("  ✓ 图片类型按原样返回，其它类型都 sandbox");
}

console.log();
if (violations) {
  console.error(`静态检查失败：${violations} 项违规`);
  process.exit(1);
}
console.log("静态检查通过");
