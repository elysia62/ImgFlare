import { WorkerEntrypoint } from "cloudflare:workers";
import wasmModule from "./index_bg.wasm";
import { initSync, fetch as workerFetch, scheduled as workerScheduled } from "./index.js";
import { fetchWithLimit } from "./request-limits.mjs";

// Workers supplies a compiled module. Let wasm-bindgen wire all SDK imports.
initSync({ module: wasmModule });

export default class Entrypoint extends WorkerEntrypoint {
  fetch(request) {
    return fetchWithLimit(request, (request) => workerFetch(request, this.env, this.ctx));
  }
  scheduled(event) {
    return workerScheduled(event, this.env, this.ctx);
  }
}
