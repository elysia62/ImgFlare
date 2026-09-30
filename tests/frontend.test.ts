import { afterEach, beforeEach, expect, test } from 'bun:test';
import { ApiError, parseUploadResult, uploadFile } from '../web/frontend/src/api.ts';
import { FileBrowser } from '../web/frontend/src/files.ts';
import { UploadQueue } from '../web/frontend/src/upload.ts';
import { renderQueue } from '../web/frontend/src/app.ts';
import { makeThumbnail } from '../web/shared/thumbnail.ts';

// A small DOM boundary; the queue, API client and browser are the real modules.
class Element extends EventTarget {
  children: Element[] = [];
  parent: Element | null = null;
  className = '';
  textContent = '';
  value = '';
  hidden = false;
  disabled = false;
  style: Record<string, string> = {};
  isConnected = true;
  setAttribute(key: string, value: string) { (this as any)[key] = value; }
  append(...nodes: Element[]) { for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node); } }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this);
    this.parent = null;
  }
  replaceWith(node: Element) {
    if (!this.parent) return;
    const parent = this.parent;
    const index = parent.children.indexOf(this);
    parent.children[index] = node;
    node.parent = parent;
    this.parent = null;
  }
  replaceChildren(...nodes: Element[]) { for (const node of [...this.children]) node.remove(); this.append(...nodes); }
  querySelector(selector: string): Element | null {
    for (const node of this.children) {
      if (node.className.split(' ').includes(selector.slice(1))) return node;
      const found = node.querySelector(selector);
      if (found) return found;
    }
    return null;
  }
}
class Xhr extends EventTarget {
  static instances: Xhr[] = [];
  upload = new EventTarget();
  status = 200;
  responseText = '';
  timeout = 0;
  constructor() { super(); Xhr.instances.push(this); }
  open() {}
  setRequestHeader() {}
  send() {}
}
const originals = new Map(['document','window','fetch','XMLHttpRequest'].map(key => [key,Object.getOwnPropertyDescriptor(globalThis,key)]));
beforeEach(() => {
  Object.assign(globalThis, {
    document: { createElement: () => new Element(), createTextNode: (text: string) => Object.assign(new Element(),{textContent:text}) },
    window: { setTimeout, clearTimeout }, XMLHttpRequest: Xhr,
  });
  Xhr.instances = [];
});
afterEach(() => {
  for (const [key,descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis,key,descriptor);
    else Reflect.deleteProperty(globalThis,key);
  }
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return {promise,resolve};
}
const tick = () => new Promise(resolve => setTimeout(resolve,0));
const file = (id: string) => ({id,sha256:'a'.repeat(64),name:id+'.png',contentType:'image/png',size:100,url:'https://test/i/'+id+'.png',markdown:'image',createdAt:1,thumbnailUrl:null});
const page = (ids: string[], cursor: string | null = null) => Response.json({success:true,data:{files:ids.map(file),total:3,limit:24,offset:0,nextCursor:cursor}});

test('search supersedes an in-flight load and ignores late results and finalizers', async () => {
  const requests: {path:string;signal:AbortSignal;result:ReturnType<typeof deferred<Response>>}[] = [];
  globalThis.fetch = ((path,init) => {
    const result = deferred<Response>();
    requests.push({path:String(path),signal:init!.signal!,result});
    return result.promise; // Intentionally ignore abort to exercise stale-result protection.
  }) as typeof fetch;
  const list = new Element(), more = new Element(), search = new Element();
  const browser = new FileBrowser({list:list as any,loadMore:more as any,search:search as any});
  const first = browser.refresh();
  search.value = 'latest';
  search.dispatchEvent(new Event('input'));
  await new Promise(resolve => setTimeout(resolve,270));
  expect(requests.length).toBe(2);
  expect(requests[0]!.signal.aborted).toBe(true);
  expect(requests[1]!.path).toContain('q=latest');
  requests[0]!.result.resolve(page(['stale']));
  await first;
  expect(more.disabled).toBe(true);
  requests[1]!.result.resolve(page(['latest'],'1:latest'));
  await tick();
  expect(list.querySelector('.shot-name')!.textContent).toBe('latest.png');
  expect(more.disabled).toBe(false);
  const existing = list.children[0];
  more.dispatchEvent(new Event('click'));
  expect(requests[2]!.path).toContain('cursor=1%3Alatest');
  requests[2]!.result.resolve(page(['second']));
  await tick();
  expect(list.children[0]).toBe(existing);
  expect(list.children.length).toBe(2);
  expect(more.hidden).toBe(true);
});

test('clear and dismiss retain hashing and checking work until it finishes', async () => {
  const bytes = deferred<ArrayBuffer>();
  const checked = deferred<Response>();
  globalThis.fetch = (() => checked.promise) as typeof fetch;
  const input = new File(['sample'],'sample.png');
  input.arrayBuffer = () => bytes.promise;
  const queue = new UploadQueue(1024);
  queue.add([input]);
  const key = queue.list()[0]!.key;
  expect(queue.list()[0]!.state).toBe('hashing');
  queue.remove(key); queue.clearFinished();
  expect(queue.list().length).toBe(1);
  bytes.resolve(new TextEncoder().encode('sample').buffer);
  await tick();
  expect(queue.list()[0]!.state).toBe('checking');
  queue.remove(key); queue.clearFinished();
  expect(queue.list().length).toBe(1);
  checked.resolve(Response.json({success:true,exists:true,file:file('same')}));
  await tick();
  expect(queue.list()[0]!.state).toBe('duplicate');
  queue.clearFinished();
  expect(queue.list()).toEqual([]);
  expect(queue.activeCount).toBe(0);
});

test('progress updates preserve DOM rows and completion renders actions', () => {
  const task: any = {key:'task',file:new File(['x'],'x.png'),state:'uploading',progress:0.1,attempts:0};
  const queue: any = {list:()=>[task],remove:()=>{}};
  const list = new Element();
  renderQueue(list as any,queue);
  const row = list.children[0];
  task.progress = 0.6;
  renderQueue(list as any,queue);
  expect(list.children[0]).toBe(row);
  expect(list.querySelector('.queue-progress')!.textContent).toBe('60%');
  expect(list.querySelector('.progress-fill')!.style.width).toBe('60%');
  expect(list.querySelector('.queue-dismiss')!.disabled).toBe(true);
  task.state = 'success'; task.result = {file:file('done')};
  renderQueue(list as any,queue);
  expect(list.children[0]).not.toBe(row);
  expect(list.querySelector('.copy-row')).not.toBeNull();
  expect(list.querySelector('.queue-dismiss')!.disabled).toBe(false);
});

test('invalid upload envelopes fail explicitly and upload timeouts are retryable', async () => {
  for (const bad of [null,[],{}, {success:true}, {success:true,deduplicated:false,file:null}]) {
    expect(() => parseUploadResult(bad,200)).toThrow('invalid_response');
  }
  expect(parseUploadResult({success:true,deduplicated:false,file:file('ok')},200).file.id).toBe('ok');
  const upload = uploadFile(new File(['x'],'x.png'),'a'.repeat(64));
  const rejection = upload.catch(error => error);
  expect(Xhr.instances[0]!.timeout).toBe(120_000);
  Xhr.instances[0]!.dispatchEvent(new Event('timeout'));
  const error = await rejection;
  expect(error).toBeInstanceOf(ApiError);
  expect(error.code).toBe('timeout');
});

test('unsupported thumbnail runtime falls back without blocking upload', async () => {
  expect(await makeThumbnail(new Blob(['image']))).toBeNull();
});
