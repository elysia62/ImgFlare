#!/usr/bin/env bun
/** Check Rust/TypeScript response fields and static safety invariants. */

import path from "node:path";
import process from "node:process";

if (typeof Bun === "undefined") {
  throw new Error("This script requires Bun. Run: bun run tests/contract.mjs");
}

const ROOT = path.resolve(import.meta.dir, "..");

// The pairs that must agree. Left = Rust struct, right = TS interface.

const PAIRS = [
  { rust: ["backend/src/upload.rs", "FileInfo"], ts: ["FileInfo"], note: "GET /api/files, POST /api/upload" },
  { rust: ["backend/src/files.rs", "ListResponse"], ts: ["FileListResponse"], note: "GET /api/files" },
  { rust: ["backend/src/tokens.rs", "TokenInfo"], ts: ["ApiToken"], note: "GET /api/tokens" },
  { rust: ["backend/src/tokens.rs", "CreatedToken"], ts: ["CreatedToken"], note: "POST /api/tokens" },
  { rust: ["backend/src/upload.rs", "CheckResponse"], ts: ["DuplicateCheckResult"], note: "POST /api/upload/check" },
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
  const glob = new Bun.Glob("web/shared/**/*.ts");
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
  throw new Error(`interface ${interfaceName} not found under web/shared`);
}

// Run

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

// Static safety invariants
//
// These are grep-level checks for rules that are easy to break by accident and
// expensive to discover in production. They are not a substitute for review —
// they are a tripwire.

console.log("\n静态安全不变量\n");

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
    dirs: ["web/frontend/src", "web/userscript", "web/shared"],
    // Allow the phrase inside comments; flag real call sites.
    pattern: /\.(innerHTML|outerHTML|insertAdjacentHTML)\s*[=(]/,
  },
  {
    name: "SQL 不使用字符串拼接",
    exts: [".rs"],
    dirs: ["backend/src"],
    // `format!` building a statement would mean an injection hole.
    pattern: /format!\(\s*"(?:\s*)(?:SELECT|INSERT|UPDATE|DELETE)/i,
  },
  {
    // localStorage is allowed for UI preferences (theme, active tab). What must
    // never land there is anything credential-shaped, because it survives
    // logout and is readable by any script on the origin.
    name: "前端不把凭证写进 localStorage",
    exts: [".ts"],
    dirs: ["web/frontend/src", "web/shared"],
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

console.log();
if (violations) {
  console.error(`静态检查失败：${violations} 项违规`);
  process.exit(1);
}
console.log("静态检查通过");
