import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithLimit } from '../backend/request-limits.mjs';
import { rebuildQueue } from '../scripts/watch-loop.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('multipart limits count the actual stream even without Content-Length', async () => {
  const request = new Request('https://test/api/files/id/thumbnail', {
    method:'POST', duplex:'half', body:new ReadableStream({
      start(controller) {
        for (let n=0;n<6;n++) controller.enqueue(new Uint8Array(64*1024));
        controller.close();
      },
    }),
  });
  const response = await fetchWithLimit(request, async request => {
    try { await request.arrayBuffer(); return new Response('ok'); }
    catch { return new Response('invalid multipart',{status:400}); }
  });
  assert.equal(response.status,413);
  assert.equal((await response.json()).error,'file_too_large');
});
test('large declared bodies are rejected before the handler, valid bodies pass', async () => {
  let called = false;
  const response = await fetchWithLimit(new Request('https://test/api/upload', {
    method:'POST', headers:{'Content-Length':String(51*1024*1024)},
  }), () => { called=true; });
  assert.equal(response.status,413);
  assert.equal(called,false);
  const accepted = await fetchWithLimit(new Request('https://test/api/upload', {method:'POST',body:'small'}),
    async request => new Response(await request.text()));
  assert.equal(await accepted.text(),'small');
});
test('multipart parsing is bounded per isolate and permits are released on errors', async () => {
  let releaseFirst;
  const held = new Promise(done=>{releaseFirst=done;});
  let entered=0;
  const request = () => new Request('https://test/api/upload',{method:'POST',body:'small'});
  const first = fetchWithLimit(request(),async () => { entered++; await held; throw new Error('failed upload'); }).catch(error=>error);
  await new Promise(resolve=>setTimeout(resolve,0));
  const queued = Array.from({length:3},()=>fetchWithLimit(request(),async request=>{
    entered++; return new Response(await request.text());
  }));
  const busy = await fetchWithLimit(request(),()=>{throw new Error('must not parse');});
  assert.equal(busy.status,429);
  assert.equal(entered,1);
  releaseFirst();
  assert.equal((await first).message,'failed upload');
  for (const response of await Promise.all(queued)) assert.equal(await response.text(),'small');
  assert.equal(entered,4);
});
test('watcher coalesces edits, serializes builds and retries after failures', async () => {
  let release;
  const held = new Promise(done=>{release=done;});
  const runs=[];
  let active=0;
  let maximum=0;
  const errors=[];
  let done;
  const finished = new Promise(resolve=>{done=resolve;});
  const queue = rebuildQueue(async changes => {
    maximum=Math.max(maximum,++active);
    runs.push([...changes].sort());
    try {
      if (runs.length===1) await held;
      if (runs.length===2) throw new Error('build failed');
      if (runs.length===3) done();
    } finally { active--; }
  },error=>{
    errors.push(error);
    queue.change('worker');
  },1);
  queue.change('assets'); queue.change('assets'); queue.change('worker');
  await new Promise(resolve=>setTimeout(resolve,10));
  queue.change('migrations');
  await new Promise(resolve=>setTimeout(resolve,10));
  release();
  await finished;
  queue.stop();
  assert.equal(maximum,1);
  assert.deepEqual(runs,[['assets','worker'],['migrations'],['worker']]);
  assert.equal(errors.length,1);
});

test('dev command watches real files, ignores generated output and shuts down', {timeout:10000}, async () => {
  const root=await mkdtemp(join(tmpdir(),'imgflare-dev-'));
  let child;
  let output='';
  try {
    for (const dir of ['scripts','backend/migrations','web/shared','web/userscript','bin']) await mkdir(join(root,dir),{recursive:true});
    for (const name of ['dev.mjs','watch-loop.mjs']) await copyFile(new URL('../scripts/'+name,import.meta.url),join(root,'scripts',name));
    for (const name of ['Cargo.toml','Cargo.lock','web/styles.css','web/shared/image.ts','backend/source.rs']) await writeFile(join(root,name),'initial');
    const log=join(root,'commands.jsonl');
    const stub=`#!/usr/bin/env node\nimport {appendFileSync} from 'node:fs';\nimport {basename} from 'node:path';\nappendFileSync(process.env.TEST_COMMAND_LOG,JSON.stringify({command:basename(process.argv[1]),args:process.argv.slice(2)})+'\\n');\nif(process.argv.includes('dev')) setInterval(()=>{},1000);\n`;
    for (const name of ['bun','bunx']) { await writeFile(join(root,'bin',name),stub); await chmod(join(root,'bin',name),0o755); }
    child=spawn(process.execPath,[join(root,'scripts/dev.mjs')],{
      env:{...process.env,PATH:join(root,'bin')+':'+process.env.PATH,TEST_COMMAND_LOG:log},
      stdio:['ignore','pipe','pipe'],
    });
    child.stdout.on('data',chunk=>{output+=chunk;}); child.stderr.on('data',chunk=>{output+=chunk;});
    const commands=async()=> (await readFile(log,'utf8').catch(()=>'' )).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
    const until=async predicate=> {
      for (let n=0;n<100;n++) { if (await predicate()) return; await new Promise(resolve=>setTimeout(resolve,30)); }
      assert.fail('dev watcher timed out: '+output);
    };
    await until(async()=> (await commands()).some(command=>command.args.includes('dev')));
    await writeFile(join(root,'web/styles.css'),'changed css');
    await writeFile(join(root,'web/shared/image.ts'),'changed shared source');
    await writeFile(join(root,'backend/source.rs'),'changed Rust');
    await writeFile(join(root,'backend/migrations/init_03.sql'),'new migration');
    await until(async()=> (await commands()).some(command=>command.args.includes('build:assets')));
    const calls=await commands();
    assert.equal(calls.filter(call=>call.args.includes('build:worker')).length,1);
    assert.equal(calls.filter(call=>call.args.includes('build:assets')).length,1);
    assert.equal(calls.filter(call=>call.args.includes('migrations')).length,2);
    await writeFile(join(root,'web/userscript/image-uploader.user.js'),'generated');
    await new Promise(resolve=>setTimeout(resolve,220));
    assert.equal((await commands()).length,calls.length);
    const closed=new Promise(resolve=>child.once('close',resolve));
    child.kill('SIGTERM');
    await closed;
    assert.equal(child.exitCode,0,output);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await rm(root,{recursive:true,force:true});
  }
});
