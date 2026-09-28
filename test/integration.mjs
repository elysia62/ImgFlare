// Runs the built Rust/Wasm Worker against local D1. Outbound R2 and Turnstile
// calls are intercepted; no credentials or production resources are used.
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { loadConfig } from '../scripts/deploy.mjs';

// Miniflare is provided by the project's pinned Wrangler dependency.
const requireWrangler = createRequire(import.meta.resolve('wrangler/package.json'));
const { Miniflare, Response, FormData, Log, LogLevel } = requireWrangler('miniflare');
const root = fileURLToPath(new URL('..', import.meta.url));
const state = await mkdtemp(join(tmpdir(), 'imgflare-test-'));
const origin = 'https://imgflare.test';
const objects = new Map();
let rejectBackup = false;
let backupWrites = 0;
const bindings = {
  ADMIN_USERNAME: 'test-admin',
  ADMIN_PASSWORD: randomBytes(24).toString('hex'),
  SESSION_SECRET: randomBytes(32).toString('hex'),
  TURNSTILE_SITE_KEY: 'test-site-key',
  TURNSTILE_SECRET: 'test-turnstile-secret',
  R2_ACCOUNT_ID: '00000000000000000000000000000000',
  R2_ACCESS_KEY_ID: 'test-r2-key',
  R2_SECRET_ACCESS_KEY: 'test-r2-secret',
  R2_BUCKET: 'imgflare-test',
};

const manifest = {
  mainModule: 'shim.mjs',
  modulesRoot: resolve(root, 'build/worker'),
  modules: {
    'shim.mjs': { type: 'esm', contents: await readFile(resolve(root, 'build/worker/shim.mjs'), 'utf8') },
    'index_bg.wasm': { type: 'wasm', contents: await readFile(resolve(root, 'build/worker/index_bg.wasm')) },
  },
};
const outbound = async (request) => {
    const url = new URL(request.url);
    if (url.hostname === 'challenges.cloudflare.com') {
      const form = new URLSearchParams(await request.text());
      return Response.json({ success: form.get('response') === 'valid-test-challenge' });
    }
    assert.equal(url.hostname, bindings.R2_ACCOUNT_ID + '.r2.cloudflarestorage.com');
    assert.match(request.headers.get('authorization'), /^AWS4-HMAC-SHA256 /);
    const key = url.pathname;
    if (request.method === 'PUT') {
      if (rejectBackup && key.endsWith('/back/latest.sql')) return new Response('unavailable', { status: 503 });
      const bytes = Buffer.from(await request.arrayBuffer());
      const digest = createHash('sha256').update(bytes);
      assert.equal(request.headers.get('x-amz-checksum-sha256'), digest.digest('base64'));
      assert.equal(request.headers.get('x-amz-content-sha256'), createHash('sha256').update(bytes).digest('hex'));
      objects.set(key, { bytes, headers: Object.fromEntries(request.headers) });
      if (key.endsWith('/back/latest.sql')) backupWrites++;
      return new Response(null, { headers: { etag: 'test-etag' } });
    }
    if (request.method === 'DELETE') {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    const object = objects.get(key);
    if (!object) return new Response(null, { status: 404 });
    return new Response(request.method === 'HEAD' ? null : object.bytes, {
      headers: { ...object.headers, 'content-length': String(object.bytes.length) },
    });
  };
const runtimeOptions = (values) => ({
  resourcePersistencePath: state,
  telemetry: { enabled: false },
  log: new Log(LogLevel.NONE),
  workers: [{
    config: {
      name: 'imgflare-test',
      compatibilityDate: '2026-09-27',
      compatibilityFlags: ['nodejs_compat'],
      manifest,
      env: {
        ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { type: 'json', value }])),
        DB: { type: 'd1', id: 'source' },
        RESTORE: { type: 'd1', id: 'restore' },
        ASSETS: { type: 'fetcher', handler: async (request) => {
          const name = new URL(request.url).pathname;
          assert.ok(['/index.html', '/login.html'].includes(name));
          return new Response(await readFile(resolve(root, 'dist' + name)), {
            headers: { 'Content-Type': 'text/html' },
          });
        } },
      },
    },
    dev: { outboundService: { type: 'fetcher', handler: outbound } },
  }],
});
const mf = new Miniflare(runtimeOptions(bindings));
const call = (path, init = {}) => mf.dispatchFetch(origin + path, { redirect: 'manual', ...init });
const json = (body) => JSON.stringify(body);
const login = (password = bindings.ADMIN_PASSWORD, challenge = 'valid-test-challenge') => call('/api/login', {
  method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
  body: json({ username: bindings.ADMIN_USERNAME, password, 'cf-turnstile-response': challenge }),
});
const signCookie = (secret, payload) => {
  const body = Buffer.from(json(payload));
  return 'pih_session=' + body.toString('base64url') + '.' + createHmac('sha256', secret).update(body).digest('base64url');
};
const executeScript = async (db, sql) => {
  // Exported values are hex literals, so only actual statements contain ';'.
  const statements = sql.split(';').map((s) => s.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean);
  if (statements.length) await db.batch(statements.map((s) => db.prepare(s)));
};

try {
  const db = await mf.getD1Database('DB');
  const schema = await readFile(resolve(root, 'migrations/init_01.sql'), 'utf8');
  await executeScript(db, schema);
  const exportQuery = await readFile(resolve(root, 'src/backup.sql'), 'utf8');
  assert.deepEqual((await db.prepare(exportQuery).bind(8388608, 20000).all()).results, []);
  assert.deepEqual(loadConfig(bindings, '').missing, []);
  assert.ok(loadConfig({ ...bindings, SESSION_SECRET: '' }, '').missing.includes('SESSION_SECRET'));
  assert.ok(loadConfig({ ...bindings, SESSION_SECRET: 'short' }, '').missing.length);

  const landing = await call('/');
  assert.equal(landing.status, 302);
  assert.equal(landing.headers.get('location'), '/login');
  const loginPage = await call('/login');
  assert.equal(loginPage.status, 200);
  assert.match(await loginPage.text(), /test-site-key/);
  assert.equal((await login('wrong-password')).status, 401);
  assert.equal((await login(bindings.ADMIN_PASSWORD, 'invalid')).status, 403);
  const signedIn = await login();
  assert.equal(signedIn.status, 200);
  assert.match(signedIn.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/);
  const cookie = signedIn.headers.get('set-cookie').split(';')[0];
  const adminHeaders = { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' };
  const panel = await call('/', { headers: { Cookie: cookie } });
  assert.equal(panel.status, 200);
  assert.match(await panel.text(), /id="logout"/);
  assert.equal((await call('/api/files')).status, 401);
  assert.equal((await call('/api/files', { headers: adminHeaders })).status, 200);
  assert.equal((await call('/api/tokens', { method: 'POST', headers: { Cookie: cookie }, body: json({ name: 'denied' }) })).status, 403);

  // The formerly public signing key must no longer grant administrator access.
  const legacyKey = 'imgflare-session-7f3c9a1e6b2d48c0a5e7f91b3d6c8a0e4f2b7d9c1a6e8b0d';
  const now = Date.now();
  for (const forged of [
    signCookie(legacyKey, { iat: now, exp: now + 600_000, nonce: 'legacy' }),
    signCookie(bindings.SESSION_SECRET, { iat: now - 2000, exp: now - 1000, nonce: 'expired' }),
  ]) {
    assert.equal((await call('/api/files', { headers: { Cookie: forged } })).status, 401);
  }
  console.log('✓ Panel login, Turnstile, CSRF, expired and legacy cookies');

  const tokenResponse = await call('/api/tokens', { method: 'POST', headers: adminHeaders, body: json({ name: "油猴 ' token\n\u0000" }) });
  assert.equal(tokenResponse.status, 200);
  const token = (await tokenResponse.json()).data;
  const keyHeaders = { 'X-API-Key': token.token, 'Content-Type': 'application/json' };
  const sha = 'a'.repeat(64);
  for (const headers of [keyHeaders, { ...keyHeaders, Cookie: cookie }]) {
    const checked = await call('/api/upload/check', { method: 'POST', headers, body: json({ sha256: sha }) });
    assert.equal(checked.status, 200); // no Origin and no login needed
    assert.equal(checked.headers.get('set-cookie'), null);
  }
  for (const key of ['invalid', 'cph_' + 'x'.repeat(200)]) {
    assert.equal((await call('/api/files', { headers: { Cookie: cookie, 'X-API-Key': key } })).status, 401);
  }
  for (const [method, path] of [
    ['GET', '/api/files'], ['GET', '/api/tokens'], ['POST', '/api/tokens'],
    ['DELETE', '/api/tokens/' + token.id], ['DELETE', '/api/files/anything'],
    ['GET', '/api/backup/latest'], ['GET', '/api/backup/status'], ['POST', '/api/backup/run'],
  ]) {
    for (const headers of [keyHeaders, { ...keyHeaders, Cookie: cookie }]) {
      assert.equal((await call(path, { method, headers })).status, 403, path);
    }
  }

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8S8AAAAASUVORK5CYII=', 'base64');
  const imageHash = createHash('sha256').update(png).digest('hex');
  // Execute the shipped userscript with a clipboard event and intercepted GM
  // requests. This verifies its anonymous/key-only behavior independently of
  // the panel, including the multipart upload and Markdown clipboard result.
  const handlers = new Map();
  const requestedPaths = [];
  const scriptWindow = { location: { host: 'external.test' } };
  scriptWindow.top = scriptWindow.self = scriptWindow;
  let copied;
  let scriptFailure;
  const done = new Promise((resolveDone, rejectDone) => { copied = resolveDone; scriptFailure = rejectDone; });
  const source = (await readFile(resolve(root, 'userscript/image-uploader.user.js'), 'utf8'))
    .replace(/\b(var|const|let) API_URL = [^;]+;/, `const API_URL = ${json(origin)};`)
    .replace(/\b(var|const|let) API_TOKEN = [^;]+;/, `const API_TOKEN = ${json(token.token)};`);
  runInNewContext(source, {
    window: scriptWindow,
    document: { readyState: 'complete', activeElement: null, querySelectorAll: () => [], addEventListener: (name, handler) => handlers.set(name, handler) },
    navigator: { clipboard: { writeText: async (value) => copied(value) } },
    crypto: globalThis.crypto, URL, File, Blob, FormData, TextEncoder, Uint8Array,
    HTMLElement: class {}, HTMLTextAreaElement: class {}, HTMLInputElement: class {},
    setTimeout, clearTimeout,
    console: { error: (message) => scriptFailure(new Error(message)) },
    GM_xmlhttpRequest: (details) => {
      void (async () => {
        assert.equal(details.anonymous, true);
        assert.equal(details.headers['X-API-Key'], token.token);
        assert.equal(details.headers.Cookie, undefined);
        const path = new URL(details.url).pathname;
        requestedPaths.push(path);
        const response = await call(path, { method: details.method, headers: details.headers, body: details.data });
        details.onload({ status: response.status, responseText: await response.text() });
      })().catch(scriptFailure);
    },
  });
  assert.deepEqual([...handlers.keys()], ['paste']);
  handlers.get('paste')({
    clipboardData: { files: [new File([png], 'script.png', { type: 'image/png' })], items: [] },
    preventDefault() {}, stopPropagation() {},
  });
  let timer;
  try {
    const markdown = await Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('userscript upload timed out')), 5000); })]);
    assert.match(markdown, /^!\[粘贴图片\]\(https:\/\/imgflare.test\/i\//);
    assert.deepEqual(requestedPaths, ['/api/upload/check', '/api/upload']);
  } finally { clearTimeout(timer); }
  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), "截图' test.png");
  const uploaded = await call('/api/upload', {
    method: 'POST', headers: { 'X-API-Key': token.token, 'X-File-SHA256': imageHash }, body: form,
  });
  assert.equal(uploaded.status, 200, await uploaded.clone().text());
  const file = (await uploaded.json()).file;
  const duplicate = await call('/api/upload/check', { method: 'POST', headers: keyHeaders, body: json({ sha256: imageHash }) });
  assert.equal((await duplicate.json()).exists, true);
  const publicImage = await call(new URL(file.url).pathname);
  assert.equal(publicImage.status, 200);
  assert.deepEqual(Buffer.from(await publicImage.arrayBuffer()), png);
  console.log('✓ API-key-only upload/dedup, token precedence and administrator boundaries');

  await db.prepare('INSERT INTO kv_meta(key,value) VALUES (?,?)').bind("quote'\nkey", "中文\u0000value'\n").run();
  const backup = await call('/api/backup/run', { method: 'POST', headers: adminHeaders });
  assert.equal(backup.status, 200, await backup.clone().text());
  const report = (await backup.json()).data;
  const downloaded = await call('/api/backup/latest', { headers: adminHeaders });
  assert.equal(downloaded.status, 200);
  const sql = await downloaded.text();
  assert.match(sql, /CREATE TABLE IF NOT EXISTS files/);
  assert.equal(createHash('sha256').update(sql).digest('hex'), report.sha256);
  const restored = await mf.getD1Database('RESTORE');
  await executeScript(restored, sql);
  for (const table of ['files', 'api_tokens', 'kv_meta']) {
    const original = (await db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results;
    const copy = (await restored.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results;
    assert.deepEqual(copy, original, table);
  }
  // Test both safety caps with the exact query used by Rust.
  for (const limits of [[1, 20000], [8388608, 0]]) {
    const result = await db.prepare(exportQuery).bind(...limits).all();
    assert.deepEqual(result.results, [{ statement: null }]);
  }
  const beforeFailure = objects.get('/imgflare-test/back/latest.sql').bytes;
  rejectBackup = true;
  assert.equal((await call('/api/backup/run', { method: 'POST', headers: adminHeaders })).status, 500);
  assert.deepEqual(objects.get('/imgflare-test/back/latest.sql').bytes, beforeFailure);
  assert.ok([...objects.keys()].every((key) => !key.includes('/.tmp/')));
  rejectBackup = false;
  const beforeCron = backupWrites;
  const worker = await mf.getWorker();
  await worker.scheduled({ cron: '0 4 * * *' });
  assert.equal(backupWrites, beforeCron + 1);
  console.log('✓ SQL restore of all tables, export bounds, failure retention and actual Cron entrypoint');

  assert.equal((await call('/api/tokens/' + token.id, { method: 'DELETE', headers: adminHeaders })).status, 204);
  assert.equal((await call('/api/upload/check', { method: 'POST', headers: keyHeaders, body: json({ sha256: imageHash }) })).status, 401);
  await mf.setOptions(runtimeOptions({ ...bindings, SESSION_SECRET: randomBytes(32).toString('hex') }));
  assert.equal((await call('/api/files', { headers: adminHeaders })).status, 401);
  assert.equal((await login()).status, 200);
  console.log('✓ Token revocation and signing-secret rotation');
} finally {
  await mf.dispose();
  await rm(state, { recursive: true, force: true });
}
