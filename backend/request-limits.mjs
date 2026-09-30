// Limit the actual incoming stream before multipart parsing can allocate files.
const UPLOAD_LIMIT = 50 * 1024 * 1024 + 512 * 1024;
const THUMBNAIL_LIMIT = 256 * 1024 + 64 * 1024;
// Bound multipart buffers in each isolate. Queued request bodies remain unread.
// This is a memory guard, not persistent application state.
let active = false;
const waiting = [];
async function acquire() {
  if (!active) { active = true; return true; }
  if (waiting.length >= 3) return false;
  await new Promise(resolve => waiting.push(resolve));
  return true;
}
function release() {
  const next = waiting.shift();
  if (next) next();
  else active = false;
}
const tooLarge = () => Response.json({ success: false, error: "file_too_large" }, {
  status: 413, headers: { "Cache-Control": "no-store" },
});

export async function fetchWithLimit(request, run) {
  const path = new URL(request.url).pathname;
  const limit = path === "/api/upload" ? UPLOAD_LIMIT
    : /^\/api\/files\/[^/]+\/thumbnail$/.test(path) ? THUMBNAIL_LIMIT : 0;
  if (request.method !== "POST" || !limit) return run(request);
  const length = request.headers.get("Content-Length");
  if (length && /^\d+$/.test(length) && Number(length) > limit) return tooLarge();
  if (!request.body) return run(request);
  if (!await acquire()) return Response.json({ success: false, error: "upload_busy" }, {
    status: 429, headers: { "Retry-After": "2", "Cache-Control": "no-store" },
  });
  let received = 0;
  let exceeded = false;
  const body = request.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > limit) {
        exceeded = true;
        controller.error(new Error("file_too_large"));
      } else controller.enqueue(chunk);
    },
  }));
  try {
    const response = await run(new Request(request, { body, duplex: "half" }));
    return exceeded ? tooLarge() : response;
  } catch (error) {
    if (exceeded) return tooLarge();
    throw error;
  } finally {
    release();
  }
}
