#!/usr/bin/env bun
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { rebuildQueue } from './watch-loop.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const children = new Set();
const watchers = [];
const startupChanges = new Set();
let ready = false;
let stopping = false;
function start(command, args) {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', detached: process.platform !== 'win32' });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = start(command,args);
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}
const build = (kind) => run('bun', ['run', `build:${kind}`]);
const migrate = () => run('bunx', ['wrangler','d1','migrations','apply','DB','--local']);
const queue = rebuildQueue(async (changes) => {
  if (changes.has('migrations')) await migrate();
  if (changes.has('worker') || changes.has('migrations')) await build('worker');
  if (changes.has('assets')) await build('assets');
  console.log('[dev] source changes rebuilt');
});
function observe(path, handler, recursive = false) {
  watchers.push(watch(new URL(path, new URL('..', import.meta.url)), { recursive }, (_event,name) => {
    if (name && !stopping) handler(String(name));
  }));
}
function stop() {
  stopping = true;
  queue.stop();
  for (const watcher of watchers) watcher.close();
  for (const child of children) {
    try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch {}
  }
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
function changed(kind) { if (ready) queue.change(kind); else startupChanges.add(kind); }
try {
  // Register before the first build so changes during startup aren't lost.
  observe('backend', (name) => changed(name.startsWith('migrations/') ? 'migrations' : 'worker'), true);
  observe('web', (name) => { if (!name.endsWith('image-uploader.user.js')) changed('assets'); }, true);
  observe('Cargo.toml', () => changed('worker'));
  observe('Cargo.lock', () => changed('worker'));
  observe('scripts', (name) => {
    if (name === 'build-assets.mjs') changed('assets');
    if (name === 'build-worker.mjs') changed('worker');
  });
  await run('bun', ['run','build']);
  await migrate();
  ready = true;
  for (const kind of startupChanges) queue.change(kind);
  console.log('[dev] watching Rust, SQL, TypeScript, HTML and CSS');
  await run('bunx', ['wrangler','dev', ...(process.argv.includes('--cron') ? ['--test-scheduled'] : [])]);
} catch (error) {
  if (!stopping) { console.error(error); process.exitCode = 1; }
} finally { stop(); }
