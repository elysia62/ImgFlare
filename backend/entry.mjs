import { WorkerEntrypoint } from "cloudflare:workers";
import wasmModule from "./index_bg.wasm";
import * as bindings from "./index_bg.js";
import { fetchWithLimit } from "./request-limits.mjs";

const instance = new WebAssembly.Instance(wasmModule, { "./index_bg.js": bindings });
bindings.__wbg_set_wasm(instance.exports);
instance.exports.__wbindgen_start();

export default class Entrypoint extends WorkerEntrypoint {
  fetch(request) {
    return fetchWithLimit(request, (request) => bindings.fetch(request, this.env, this.ctx));
  }
  scheduled(event) {
    return bindings.scheduled(event, this.env, this.ctx);
  }
}
