// Runs the built Rust/Wasm Worker against local D1. Outbound R2 and Turnstile
// calls are intercepted; no credentials or production resources are used.
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

// Miniflare is provided by the project's pinned Wrangler dependency.
const requireWrangler = createRequire(import.meta.resolve('wrangler/package.json'));
const { Miniflare, Response, FormData, Log, LogLevel } = requireWrangler('miniflare');
const root = fileURLToPath(new URL('..', import.meta.url));
const state = await mkdtemp(join(tmpdir(), 'imgflare-test-'));
const origin = 'https://imgflare.test';
const objects = new Map();
let rejectBackup = false;
let backupWrites = 0;
let rejectDelete = false;
let imageReads = 0;
let beforePut = async () => {};
let afterPut = async () => {};
let beforeDelete = async () => {};
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
  modulesRoot: resolve(root, 'dist/worker'),
  modules: {
    'shim.mjs': { type: 'esm', contents: await readFile(resolve(root, 'dist/worker/shim.mjs'), 'utf8') },
    'index_bg.wasm': { type: 'wasm', contents: await readFile(resolve(root, 'dist/worker/index_bg.wasm')) },
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
      await beforePut(key);
      objects.set(key, { bytes, headers: Object.fromEntries(request.headers) });
      await afterPut(key);
      if (key.endsWith('/back/latest.sql')) backupWrites++;
      return new Response(null, { headers: { etag: '"test-etag"' } });
    }
    if (request.method === 'DELETE') {
      if (rejectDelete) return new Response('unavailable', { status: 503 });
      await beforeDelete(key);
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    const object = objects.get(key);
    if (!object) return new Response(null, { status: 404 });
    if (request.method === 'GET') imageReads++;
    const range = request.headers.get('range');
    let bytes = object.bytes;
    const headers = { ...object.headers, etag: '"test-etag"', 'last-modified': 'Thu, 01 Oct 2026 00:00:00 GMT' };
    if (range) {
      const [,start,end] = /^bytes=(\d+)-(\d+)$/.exec(range);
      bytes = bytes.subarray(Number(start),Number(end)+1);
      headers['content-range'] = `bytes ${start}-${end}/${object.bytes.length}`;
    }
    headers['content-length'] = String(bytes.length);
    return new Response(request.method === 'HEAD' ? null : bytes, { status: range ? 206 : 200, headers });
  };
const runtimeOptions = (values) => ({
  resourcePersistencePath: state,
  telemetry: { enabled: false },
  log: new Log(LogLevel.NONE),
  workers: ['imgflare-test', 'imgflare-peer'].map(name => ({
    config: {
      name,
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
          return new Response(await readFile(resolve(root, 'dist/assets' + name)), {
            headers: { 'Content-Type': 'text/html' },
          });
        } },
      },
    },
    dev: { outboundService: { type: 'fetcher', handler: outbound } },
  })),
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
  const statements = sql.replace(/^\s*--.*$/gm, '').split(';').map((s) => s.trim()).filter(Boolean);
  if (statements.length) await db.batch(statements.map((s) => db.prepare(s)));
};

try {
  const db = await mf.getD1Database('DB');
  const migrations = (await readdir(resolve(root, 'backend/migrations'))).filter(name => name.endsWith('.sql')).sort();
  for (const migration of migrations) {
    if (migration === 'init_04.sql') await db.prepare("INSERT INTO kv_meta(key,value) VALUES ('token_touch:revoked','123')").run();
    await executeScript(db, await readFile(resolve(root, 'backend/migrations', migration), 'utf8'));
  }
  assert.equal(await db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_files_created_at'").first(), null);
  const imagePlan = (await db.prepare('EXPLAIN QUERY PLAN SELECT * FROM files WHERE r2_key=? OR thumbnail_r2_key=?').bind('i/example.png', 't/example.webp').all()).results;
  assert.ok(imagePlan.some(row => row.detail.includes('idx_files_thumbnail')), 'thumbnail lookup uses its index');
  assert.ok(!imagePlan.some(row => row.detail.includes('SCAN files')), 'image reads must not scan every file');
  const exportQuery = await readFile(resolve(root, 'backend/src/backup.sql'), 'utf8');
  assert.deepEqual((await db.prepare(exportQuery).bind(8388608, 20000).all()).results, []);

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
  assert.equal((await call('/api/files', { headers: adminHeaders })).headers.get('cache-control'), 'no-store');
  assert.equal((await call('/api/files')).headers.get('cache-control'), 'no-store');
  assert.equal((await call('/api/tokens', { method: 'POST', headers: { Cookie: cookie }, body: json({ name: 'denied' }) })).status, 403);

  // Invalid signatures and expired sessions cannot grant administrator access.
  const now = Date.now();
  for (const forged of [
    signCookie('wrong-signing-secret-for-test', { iat: now, exp: now + 600_000, nonce: 'invalid' }),
    signCookie(bindings.SESSION_SECRET, { iat: now - 2000, exp: now - 1000, nonce: 'expired' }),
  ]) {
    assert.equal((await call('/api/files', { headers: { Cookie: forged } })).status, 401);
  }
  console.log('✓ Panel login, Turnstile, CSRF, invalid signatures and expired cookies');

  // Reserve attempts before validation so a concurrent burst cannot lose counts.
  const loginIp = '198.51.100.42';
  const loginKey = 'login_fail:' + loginIp;
  const attemptLogin = (password = 'wrong-password', challenge = 'valid-test-challenge') => call('/api/login', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': loginIp },
    body: json({username: bindings.ADMIN_USERNAME, password, 'cf-turnstile-response': challenge}),
  });
  const burst = await Promise.all(Array.from({length:16}, () => attemptLogin()));
  assert.equal(burst.filter(r => r.status === 401).length, 8);
  assert.equal(burst.filter(r => r.status === 429).length, 8);
  const counter = await db.prepare('SELECT value FROM kv_meta WHERE key=?').bind(loginKey).first();
  assert.equal(counter.value.split(':')[0], '8');
  await db.prepare('UPDATE kv_meta SET value=? WHERE key=?').bind('8:' + (Date.now() - 900001), loginKey).run();
  assert.equal((await attemptLogin(bindings.ADMIN_PASSWORD)).status, 200);
  assert.equal(await db.prepare('SELECT value FROM kv_meta WHERE key=?').bind(loginKey).first(), null);
  assert.equal((await attemptLogin('wrong-password','invalid')).status,403);
  assert.equal((await db.prepare('SELECT value FROM kv_meta WHERE key=?').bind(loginKey).first()).value.split(':')[0], '1');
  await db.prepare('DELETE FROM kv_meta WHERE key=?').bind(loginKey).run();
  console.log('✓ Atomic login limits, window expiry and successful-login reset');

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
  const lastUsedAt = () => db.prepare('SELECT last_used_at FROM api_tokens WHERE id=?').bind(token.id).first('last_used_at');
  assert.ok(await lastUsedAt() >= token.createdAt, 'first use records the token timestamp');
  const recentUse = Date.now() - 60_000;
  await db.prepare('UPDATE api_tokens SET last_used_at=? WHERE id=?').bind(recentUse, token.id).run();
  assert.equal((await call('/api/upload/check', { method:'POST', headers:keyHeaders, body:json({sha256:sha}) })).status, 200);
  assert.equal(await lastUsedAt(), recentUse, 'repeated use within an hour does not write a timestamp');
  await db.prepare('UPDATE api_tokens SET last_used_at=? WHERE id=?').bind(Date.now() - 3_600_001, token.id).run();
  assert.equal((await call('/api/upload/check', { method:'POST', headers:keyHeaders, body:json({sha256:sha}) })).status, 200);
  assert.ok(await lastUsedAt() > recentUse, 'use after an hour refreshes the timestamp');
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
  let overrideScriptRequest;
  const scriptDocument = {
    readyState: 'complete', activeElement: null, querySelectorAll: () => [],
    addEventListener: (name, handler) => handlers.set(name, handler),
    execCommand: (command, _showUi, text) => {
      assert.equal(command, 'insertText');
      scriptDocument.activeElement.inserted.push(text);
      return true;
    },
  };
  class ScriptElement {
    isContentEditable = false;
    inserted = [];
    focus() { scriptDocument.activeElement = this; }
  }
  class ScriptTextarea extends ScriptElement {
    inputEvents = 0;
    constructor(value, start, end = start) {
      super();
      this.value = value;
      this.setSelectionRange(start, end);
    }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    dispatchEvent(event) {
      assert.equal(event.type, 'input');
      assert.equal(event.bubbles, true);
      this.inputEvents++;
    }
  }
  class ScriptInput extends ScriptElement { type = 'text'; value = '单行输入'; }
  const source = (await readFile(resolve(root, 'web/userscript/image-uploader.user.js'), 'utf8'))
    .replace(/\b(var|const|let) API_URL = [^;]+;/, `const API_URL = ${json(origin)};`)
    .replace(/\b(var|const|let) API_TOKEN = [^;]+;/, `const API_TOKEN = ${json(token.token)};`);
  runInNewContext(source, {
    window: scriptWindow,
    document: scriptDocument,
    navigator: { clipboard: { writeText: async (value) => copied(value) } },
    crypto: globalThis.crypto, URL, File, Blob, FormData, TextEncoder, Uint8Array, Event,
    HTMLElement: ScriptElement, HTMLTextAreaElement: ScriptTextarea, HTMLInputElement: ScriptInput,
    setTimeout, clearTimeout,
    console: { error: (message) => scriptFailure(new Error(message)) },
    GM_xmlhttpRequest: (details) => {
      void (async () => {
        assert.equal(details.anonymous, true);
        assert.equal(details.headers['X-API-Key'], token.token);
        assert.equal(details.headers.Cookie, undefined);
        const path = new URL(details.url).pathname;
        requestedPaths.push(path);
        const response = overrideScriptRequest ? await overrideScriptRequest(details)
          : await call(path, { method: details.method, headers: details.headers, body: details.data });
        details.onload({ status: response.status, responseText: await response.text() });
      })().catch(scriptFailure);
    },
  });
  assert.deepEqual([...handlers.keys()], ['paste']);
  const pasteImages = async (count = 1, expectedFailures = 0) => {
    const copies = [];
    let failures = 0;
    const done = new Promise((resolveDone, rejectDone) => {
      const finish = () => { if (copies.length + failures === count) resolveDone(copies); };
      copied = value => { copies.push(value); finish(); };
      scriptFailure = error => {
        if (++failures > expectedFailures) rejectDone(error);
        else finish();
      };
    });
    handlers.get('paste')({
      clipboardData: {
        files: Array.from({ length: count }, (_, i) => new File([png], `script-${i}.png`, { type: 'image/png' })),
        items: [],
      },
      preventDefault() {}, stopPropagation() {},
    });
    let timer;
    try {
      return await Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('userscript upload timed out')), 5000); })]);
    } finally { clearTimeout(timer); }
  };
  const [block] = await pasteImages();
  assert.match(block, /^\n!\[粘贴图片\]\(https:\/\/imgflare.test\/i\/[^\n]+\)\n$/);
  assert.deepEqual(requestedPaths, ['/api/upload/check', '/api/upload']);
  const imageMarkdown = block.trim();
  for (const [value, start, end, expected] of [
    ['前后', 1, 1, `前\n${imageMarkdown}\n后`],
    ['', 0, 0, block],
    ['前后', 0, 0, `${block}前后`],
    ['前后', 2, 2, `前后${block}`],
    ['前\n\n后', 2, 2, `前\n${imageMarkdown}\n后`],
    ['前  后', 2, 2, `前 \n${imageMarkdown}\n 后`],
    ['前选中后', 1, 3, `前\n${imageMarkdown}\n后`],
  ]) {
    const editor = scriptDocument.activeElement = new ScriptTextarea(value, start, end);
    assert.deepEqual(await pasteImages(), [block]);
    assert.equal(editor.value, expected);
    assert.equal(editor.selectionStart, expected.indexOf(imageMarkdown) + imageMarkdown.length + 1);
    assert.equal(editor.selectionEnd, editor.selectionStart);
    assert.equal(editor.inputEvents, 1);
  }
  // Consecutive and concurrent uploads keep one image per line, including when
  // the first insertion reuses an existing newline after the cursor.
  const multiEditor = scriptDocument.activeElement = new ScriptTextarea('前\n\n后', 2);
  await pasteImages();
  await pasteImages(3);
  assert.equal(multiEditor.value, `前\n${Array(4).fill(imageMarkdown).join('\n')}\n后`);
  assert.equal(multiEditor.inputEvents, 4);
  assert.equal(multiEditor.selectionStart, multiEditor.value.indexOf('后'));

  const richEditor = scriptDocument.activeElement = new ScriptElement();
  richEditor.isContentEditable = true;
  assert.deepEqual(await pasteImages(), [block]);
  assert.deepEqual(richEditor.inserted, [block], 'rich editors receive both line breaks');
  const singleLine = scriptDocument.activeElement = new ScriptInput();
  assert.deepEqual(await pasteImages(), [block]);
  assert.equal(singleLine.value, '单行输入', 'single-line inputs only copy the multiline result');
  console.log('✓ Userscript line breaks, selection replacement, consecutive/batch paste and clipboard formatting');
  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), "截图' test.png");
  const uploaded = await call('/api/upload', {
    method: 'POST', headers: { 'X-API-Key': token.token, 'X-File-SHA256': imageHash }, body: form,
  });
  assert.equal(uploaded.status, 200, await uploaded.clone().text());
  const file = (await uploaded.json()).file;
  for (const prefix of ['/api', '//api', '///api']) {
    const largeForm = new FormData();
    largeForm.append('file', new Blob([png], {type:'image/png'}), 'thumbnail.png');
    largeForm.append('padding', 'x'.repeat(400*1024));
    const encoded = new Response(largeForm);
    const bytes = await encoded.arrayBuffer();
    const oversized = await call(prefix + '/files/' + file.id + '/thumbnail', {
      method:'POST', headers:{Origin:origin,Cookie:cookie,'Content-Type':encoded.headers.get('content-type')}, body:bytes,
    });
    assert.equal(oversized.status, 413, 'all leading-slash variants enforce the body limit');
  }
  const orderedEditor = scriptDocument.activeElement = new ScriptTextarea('前后', 1);
  overrideScriptRequest = async details => {
    if (new URL(details.url).pathname.endsWith('/check')) {
      return Response.json({success:true,exists:false});
    }
    const name = details.data.get('file').name;
    const index = Number(name.match(/script-(\d+)/)?.[1]);
    assert.ok(Number.isInteger(index));
    await new Promise(resolve => setTimeout(resolve, index === 0 ? 60 : index === 1 ? 30 : 0));
    return Response.json({success:true,deduplicated:false,file:{...file,url:file.url + '#' + index}});
  };
  await pasteImages(3);
  assert.equal(orderedEditor.value, '前\n' + [0,1,2].map(i => `![粘贴图片](${file.url}#${i})`).join('\n') + '\n后');
  const failedEditor = scriptDocument.activeElement = new ScriptTextarea('前后', 1);
  overrideScriptRequest = async details => {
    if (new URL(details.url).pathname.endsWith('/check')) {
      return Response.json({success:true,exists:false});
    }
    const name = details.data.get('file').name;
    const index = Number(name.match(/script-(\d+)/)?.[1]);
    assert.ok(Number.isInteger(index));
    if (index === 0) {
      await new Promise(resolve => setTimeout(resolve, 60));
      return Response.json({success:false,error:'unauthorized'}, {status:401});
    }
    return Response.json({success:true,deduplicated:false,file:{...file,url:file.url + '#' + index}});
  };
  const remainingCopies = await pasteImages(3, 1);
  assert.equal(remainingCopies.length, 2);
  assert.equal(failedEditor.value, '前\n' + [1,2].map(i => `![粘贴图片](${file.url}#${i})`).join('\n') + '\n后');
  scriptDocument.activeElement = orderedEditor;
  for (const payload of [null, {}, {success:true,exists:true,file:{}}]) {
    overrideScriptRequest = async () => Response.json(payload);
    const before = orderedEditor.value;
    await assert.rejects(pasteImages(), /invalid_response/);
    assert.equal(orderedEditor.value, before);
  }
  overrideScriptRequest = async details => Response.json(new URL(details.url).pathname.endsWith('/check')
    ? {success:true,exists:false} : {success:true,deduplicated:false,file:{}});
  await assert.rejects(pasteImages(), /invalid_response/);
  overrideScriptRequest = undefined;
  const duplicate = await call('/api/upload/check', { method: 'POST', headers: keyHeaders, body: json({ sha256: imageHash }) });
  assert.equal((await duplicate.json()).exists, true);
  const publicImage = await call(new URL(file.url).pathname);
  assert.equal(publicImage.status, 200);
  assert.deepEqual(Buffer.from(await publicImage.arrayBuffer()), png);
  const imagePath = new URL(file.url).pathname;
  const head = await call(imagePath, { method: 'HEAD' });
  assert.equal(head.headers.get('content-length'), String(png.length));
  assert.equal(head.headers.get('etag'), '"test-etag"');
  assert.equal(await head.text(), '');
  const conditioned = await call(imagePath, { headers: { 'If-None-Match': '"test-etag"' } });
  assert.equal(conditioned.status, 304);
  assert.equal(await conditioned.text(), '');
  const reads = imageReads;
  assert.deepEqual(Buffer.from(await (await call(imagePath)).arrayBuffer()), png);
  assert.equal(imageReads, reads, 'full response served from edge cache');
  const ranged = await call(imagePath, { headers: { Range: 'bytes=2-8', 'If-Range': '"test-etag"' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), `bytes 2-8/${png.length}`);
  assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), png.subarray(2,9));
  assert.equal((await call(imagePath, { headers: { Range: 'bytes=999-', 'If-Range': '"test-etag"' } })).status, 416);
  assert.equal((await call(imagePath.replace('.png','.jpg'))).status, 404);
  const thumbnailForm = new FormData();
  thumbnailForm.append('file', new Blob([png], { type:'image/png' }), 'preview.png');
  const thumb = await call(`/api/files/${file.id}/thumbnail`, {
    method:'POST', headers:{ Cookie:cookie, Origin:origin }, body:thumbnailForm,
  });
  assert.equal(thumb.status, 200, await thumb.clone().text());
  file.thumbnailUrl = (await thumb.json()).data.thumbnailUrl;
  assert.match(file.thumbnailUrl, /\/t\//);
  assert.deepEqual(Buffer.from(await (await call(new URL(file.thumbnailUrl).pathname)).arrayBuffer()),png);

  // Same timestamp ties and concurrent newer insertions must not shift a cursor.
  const inserted = [];
  const tieTime = Date.now()+10000;
  for (const id of ['cursor-c','cursor-b','cursor-a']) {
    inserted.push(id);
    await db.prepare('INSERT INTO files(id,sha256,r2_key,original_name,content_type,size,created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(id,id,'i/'+id+'.png','cursor-test.png','image/png',1,tieTime).run();
  }
  const page1 = (await (await call('/api/files?q=cursor-test&limit=2', {headers:adminHeaders})).json()).data;
  assert.deepEqual(page1.files.map(f=>f.id),['cursor-c','cursor-b']);
  assert.ok(!('offset' in page1));
  assert.equal((await call('/api/files?offset=1', {headers:adminHeaders})).status,400);
  await db.prepare('INSERT INTO files(id,sha256,r2_key,original_name,content_type,size,created_at) VALUES (?,?,?,?,?,?,?)')
    .bind('cursor-new','cursor-new','i/cursor-new.png','cursor-test.png','image/png',1,Date.now()+20000).run();
  inserted.push('cursor-new');
  const page2 = (await (await call('/api/files?q=cursor-test&limit=2&cursor='+encodeURIComponent(page1.nextCursor), {headers:adminHeaders})).json()).data;
  assert.deepEqual(page2.files.map(f=>f.id),['cursor-a']);
  assert.equal(page2.nextCursor,null);
  assert.equal((await call('/api/files?cursor=invalid', {headers:adminHeaders})).status,400);
  for (const id of inserted) await db.prepare('DELETE FROM files WHERE id=?').bind(id).run();

  // Force D1 failure after R2 upload, and make immediate cleanup fail too.
  await db.prepare("CREATE TRIGGER fail_upload BEFORE INSERT ON files BEGIN SELECT RAISE(ABORT, 'injected failure'); END").run();
  const failedForm = new FormData();
  const failedBytes = Buffer.concat([png,Buffer.from('failure')]);
  failedForm.append('file',new Blob([failedBytes]),'failure.png');
  rejectDelete = true;
  assert.equal((await call('/api/upload', {method:'POST',headers:{'X-API-Key':token.token,'X-File-SHA256':createHash('sha256').update(failedBytes).digest('hex')},body:failedForm})).status,500);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM cleanup_jobs').first()).n,1);
  await db.prepare('DROP TRIGGER fail_upload').run();
  rejectDelete = false;
  await db.prepare('UPDATE cleanup_jobs SET not_before=0').run();
  await (await mf.getWorker()).scheduled({cron:'*/15 * * * *'});
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM cleanup_jobs').first()).n,0);
  assert.ok([...objects.keys()].every(key=>!objects.get(key).bytes.equals(failedBytes)));

  // Exercise the 50 MiB cap with the built Wasm, including checksum verification.
  const large = Buffer.alloc(50*1024*1024);
  png.copy(large);
  const largeForm = new FormData();
  largeForm.append('file',new Blob([large]),'large.png');
  const largeUpload = await call('/api/upload',{method:'POST',headers:{'X-API-Key':token.token,'X-File-SHA256':createHash('sha256').update(large).digest('hex')},body:largeForm});
  assert.equal(largeUpload.status,200,await largeUpload.clone().text());
  const largeId = (await largeUpload.json()).file.id;
  assert.equal((await call('/api/files/'+largeId,{method:'DELETE',headers:adminHeaders})).status,204);
  console.log('✓ Upload/dedup, 50 MiB streaming, thumbnails, cursors, HTTP caching and recoverable upload failure');

  await db.prepare('INSERT INTO kv_meta(key,value) VALUES (?,?)').bind("quote'\nkey", "中文\u0000value'\n").run();
  const beforeSnapshot = new Map();
  for (const table of ['files','api_tokens','kv_meta','cleanup_jobs','backup_snapshots']) {
    beforeSnapshot.set(table,(await db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results);
  }
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
  for (const table of ['files', 'api_tokens', 'kv_meta', 'cleanup_jobs', 'backup_snapshots']) {
    const original = beforeSnapshot.get(table);
    const copy = (await restored.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results;
    assert.deepEqual(copy, original, table);
    assert.deepEqual((await restored.prepare(`PRAGMA table_info(${table})`).all()).results,(await db.prepare(`PRAGMA table_info(${table})`).all()).results,table+' columns');
  }
  // Snapshot export precedes registration of this very backup.
  assert.equal((await restored.prepare('SELECT COUNT(*) AS n FROM backup_snapshots').first()).n,0);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM backup_snapshots').first()).n,1);
  const migrated = (await db.prepare("SELECT type,name,tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf%' AND name NOT LIKE 'd1_%' ORDER BY type,name").all()).results;
  const restoredSchema = (await restored.prepare("SELECT type,name,tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf%' AND name NOT LIKE 'd1_%' ORDER BY type,name").all()).results;
  assert.deepEqual(restoredSchema,migrated,'backup schema matches migrations');
  assert.equal((await restored.prepare('SELECT COUNT(*) AS n FROM maintenance_locks').first()).n, 0, 'running locks are not restored');
  assert.deepEqual((await restored.prepare('PRAGMA table_info(maintenance_locks)').all()).results,
    (await db.prepare('PRAGMA table_info(maintenance_locks)').all()).results);
  assert.deepEqual((await restored.prepare('SELECT name FROM d1_migrations ORDER BY name').all()).results.map(row=>row.name),
    (await readdir(resolve(root,'backend/migrations'))).filter(name=>name.endsWith('.sql')).sort(), 'restore marks the matching migrations as applied');
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
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM maintenance_locks').first()).n, 0, 'failed backup releases its lease');

  // Separate Worker instances share the lease, including during R2 requests.
  const peer = await mf.getWorker('imgflare-peer');
  const runBackup = () => call('/api/backup/run', { method: 'POST', headers: adminHeaders });
  // getWorker's RPC transport validates Origin against Miniflare's local hosts.
  const peerOrigin = 'https://localhost';
  const peerBackup = () => peer.fetch(peerOrigin + '/api/backup/run', {
    method: 'POST', headers: { ...adminHeaders, Origin: peerOrigin },
  });
  const datedKey = 'back/' + new Date().toISOString().slice(0, 10) + '.sql';
  const datedPath = '/imgflare-test/' + datedKey;
  const runHeldBackup = async (hook, check, expectedStatus = 200) => {
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    let held = false;
    const intercept = async key => {
      if (key === datedPath && !held) {
        held = true;
        entered.resolve();
        await release.promise;
      }
    };
    if (hook === 'before') beforePut = intercept;
    else afterPut = intercept;
    const pending = runBackup();
    // A regression that fails before PUT should fail this test instead of hanging.
    const timeout = setTimeout(() => entered.reject(new Error('backup did not reach R2')), 10000);
    try {
      await entered.promise;
      await check();
    } finally {
      clearTimeout(timeout);
      release.resolve();
      beforePut = afterPut = async () => {};
      const response = await pending;
      assert.equal(response.status, expectedStatus, await response.clone().text());
      if (expectedStatus === 429) assert.equal((await response.json()).error, 'backup_lock_lost');
    }
  };
  await db.prepare("INSERT INTO kv_meta(key,value) VALUES ('race-marker','older')").run();
  await runHeldBackup('before', async () => {
    await db.prepare("UPDATE kv_meta SET value='newer' WHERE key='race-marker'").run();
    const busy = await peerBackup();
    assert.equal(busy.status, 429);
    assert.equal((await busy.json()).error, 'backup_busy');
  });
  assert.equal((await peerBackup()).status, 200, 'a subsequent backup can publish newer data');
  const newerValue = Buffer.from('newer').toString('hex').toUpperCase();
  assert.ok(objects.get('/imgflare-test/back/latest.sql').bytes.toString().includes(newerValue));
  assert.deepEqual(objects.get(datedPath).bytes, objects.get('/imgflare-test/back/latest.sql').bytes);
  await db.prepare("DELETE FROM kv_meta WHERE key='race-marker'").run();

  // A retry must renew an old cleanup job before writing the same dated key.
  await db.prepare('DELETE FROM backup_snapshots WHERE r2_key=?').bind(datedKey).run();
  await db.prepare('INSERT INTO cleanup_jobs(r2_key,not_before,created_at) VALUES (?,0,0)').bind(datedKey).run();
  await runHeldBackup('after', async () => {
    const job = await db.prepare('SELECT not_before FROM cleanup_jobs WHERE r2_key=?').bind(datedKey).first();
    assert.ok(job.not_before > Date.now(), 'retry refreshes cleanup grace');
    // Simulate an already selected/expired job; the shared lease still protects it.
    await db.prepare('UPDATE cleanup_jobs SET not_before=0 WHERE r2_key=?').bind(datedKey).run();
    await peer.scheduled({ cron: '*/15 * * * *' });
    assert.ok(objects.has(datedPath), 'cleanup cannot delete an in-flight snapshot');
  });
  assert.ok(objects.has(datedPath));
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM cleanup_jobs WHERE r2_key=?').bind(datedKey).first()).n, 0);

  // Cleanup must also hold the lease throughout a slow DELETE, not just query it.
  await db.prepare('DELETE FROM backup_snapshots WHERE r2_key=?').bind(datedKey).run();
  await db.prepare('INSERT INTO cleanup_jobs(r2_key,not_before,created_at) VALUES (?,0,0)').bind(datedKey).run();
  const deleting = Promise.withResolvers();
  const finishDelete = Promise.withResolvers();
  beforeDelete = async key => {
    if (key === datedPath) { deleting.resolve(); await finishDelete.promise; }
  };
  const pendingCleanup = peer.scheduled({ cron: '*/15 * * * *' });
  const deleteTimeout = setTimeout(() => deleting.reject(new Error('cleanup did not reach R2')), 10000);
  try {
    await deleting.promise;
    assert.equal((await runBackup()).status, 429);
  } finally {
    clearTimeout(deleteTimeout);
    finishDelete.resolve();
    beforeDelete = async () => {};
    await pendingCleanup;
  }
  assert.equal((await runBackup()).status, 200);

  // Losing a lease stops publication and cannot release a successor's lease.
  const beforeLeaseLoss = objects.get('/imgflare-test/back/latest.sql').bytes;
  await runHeldBackup('after', async () => {
    await db.prepare("UPDATE maintenance_locks SET owner='replacement-worker',expires_at=? WHERE name='backup'")
      .bind(Date.now() + 900000).run();
  }, 429);
  assert.deepEqual(objects.get('/imgflare-test/back/latest.sql').bytes, beforeLeaseLoss);
  assert.equal((await db.prepare("SELECT owner FROM maintenance_locks WHERE name='backup'").first()).owner, 'replacement-worker');
  // A terminated Worker leaves a lease that a later invocation can reclaim.
  await db.prepare("UPDATE maintenance_locks SET expires_at=0 WHERE name='backup'").run();
  assert.equal((await runBackup()).status, 200);
  console.log('✓ Cross-instance backup exclusion, retry grace, cleanup races and expired-lease recovery');
  const beforeCron = backupWrites;
  const worker = await mf.getWorker();
  await worker.scheduled({ cron: '0 4 * * *' });
  assert.equal(backupWrites, beforeCron + 1);
  await db.prepare('INSERT INTO cleanup_jobs(r2_key,not_before,created_at) VALUES (?,0,0)').bind(new URL(file.url).pathname.slice(1)).run();
  await worker.scheduled({cron:'*/15 * * * *'});
  assert.ok(objects.has('/imgflare-test'+imagePath),'cleanup protects already committed objects');
  // Retention keeps the last three days and queues the rest for cleanup.
  // Timestamps are relative to now, because pruning is by age, not by count.
  const day = 86_400_000;
  const nowMs = Date.now();
  const dateOf = (ms) => new Date(ms).toISOString().slice(0, 10);
  // Four days old and beyond: past the window, so these must disappear.
  const expiredKeys = [];
  for (let n = 4; n <= 6; n++) {
    const key = `back/${dateOf(nowMs - n * day)}.sql`;
    expiredKeys.push(key);
    objects.set('/imgflare-test/' + key, { bytes: Buffer.from('old'), headers: { 'content-type': 'application/sql' } });
    await db.prepare('INSERT INTO backup_snapshots(r2_key,created_at,sha256,size) VALUES (?,?,?,?)')
      .bind(key, nowMs - n * day, 'old', 3).run();
  }
  // One and two days old: inside the window, so these must survive.
  const keptKeys = [1, 2].map((n) => `back/${dateOf(nowMs - n * day)}.sql`);
  for (const [index, key] of keptKeys.entries()) {
    objects.set('/imgflare-test/' + key, { bytes: Buffer.from('recent'), headers: { 'content-type': 'application/sql' } });
    await db.prepare('INSERT INTO backup_snapshots(r2_key,created_at,sha256,size) VALUES (?,?,?,?)')
      .bind(key, nowMs - (index + 1) * day, 'recent', 6).run();
  }
  assert.equal((await call('/api/backup/run', { method: 'POST', headers: adminHeaders })).status, 200);
  const survived = (await db.prepare('SELECT r2_key FROM backup_snapshots').all()).results.map(r => r.r2_key);
  for (const key of expiredKeys) {
    assert.ok(!survived.includes(key), `expired snapshot ${key} is removed from the index`);
    assert.ok(!objects.has('/imgflare-test/' + key), `expired object ${key} is deleted from R2`);
  }
  for (const key of keptKeys) {
    assert.ok(survived.includes(key), `snapshot ${key} is inside the window and kept`);
  }
  assert.ok(objects.has('/imgflare-test/back/latest.sql'), 'the latest alias is never pruned');
  assert.equal((await call('/' + expiredKeys[0])).status, 404);
  // Filenames carry the date, so a same-day rerun overwrites instead of piling up.
  assert.ok(objects.has('/imgflare-test/back/' + dateOf(nowMs) + '.sql'), 'the snapshot key is derived from the current date');
  assert.equal(
    (await db.prepare('SELECT COUNT(*) AS n FROM backup_snapshots WHERE r2_key=?').bind('back/' + dateOf(nowMs) + '.sql').first()).n,
    1, 'one snapshot per day, even after a second run',
  );
  assert.ok(![...objects.keys()].some(key => key.includes('/back/history/')), 'no history directory is written');

  // Failed D1 deletion leaves both index and object. Failed R2 deletion is deferred.
  await db.prepare("CREATE TRIGGER fail_delete BEFORE DELETE ON files BEGIN SELECT RAISE(ABORT, 'injected failure'); END").run();
  assert.equal((await call('/api/files/'+file.id,{method:'DELETE',headers:adminHeaders})).status,500);
  assert.equal((await call(imagePath)).status,200);
  await db.prepare('DROP TRIGGER fail_delete').run();
  rejectDelete = true;
  assert.equal((await call('/api/files/'+file.id,{method:'DELETE',headers:adminHeaders})).status,204);
  assert.equal((await call(imagePath)).status,404,'D1 gate prevents a stale cache hit');
  assert.equal((await call(new URL(file.thumbnailUrl).pathname)).status,404);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM cleanup_jobs').first()).n,2);
  const writesBeforeCleanup=backupWrites;
  rejectDelete=false;
  await worker.scheduled({cron:'*/15 * * * *'});
  assert.equal(backupWrites,writesBeforeCleanup,'cleanup cron must not create a backup');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM cleanup_jobs').first()).n,0);
  assert.ok(!objects.has('/imgflare-test'+imagePath));
  console.log('✓ Full schema restore, backup retention, Cron retries and deletion cache invalidation');

  assert.equal((await call('/api/tokens/' + token.id, { method: 'DELETE', headers: adminHeaders })).status, 204);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM kv_meta WHERE key GLOB 'token_touch:*'").first()).n, 0);
  assert.equal((await call('/api/upload/check', { method: 'POST', headers: keyHeaders, body: json({ sha256: imageHash }) })).status, 401);
  await mf.setOptions(runtimeOptions({ ...bindings, SESSION_SECRET: randomBytes(32).toString('hex') }));
  assert.equal((await call('/api/files', { headers: adminHeaders })).status, 401);
  assert.equal((await login()).status, 200);
  console.log('✓ Token revocation and signing-secret rotation');
} finally {
  await mf.dispose();
  await rm(state, { recursive: true, force: true });
}
