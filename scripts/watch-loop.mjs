/** Coalesce bursts and serialize rebuilds, including changes during a build. */
export function rebuildQueue(rebuild, onError = console.error, delay = 150) {
  const pending = new Set();
  let timer;
  let running = false;
  let stopped = false;
  async function drain() {
    if (running || stopped) return;
    running = true;
    while (pending.size && !stopped) {
      const changes = new Set(pending);
      pending.clear();
      try { await rebuild(changes); } catch (error) { onError(error); }
    }
    running = false;
  }
  return {
    change(kind) {
      if (stopped) return;
      pending.add(kind);
      clearTimeout(timer);
      timer = setTimeout(() => void drain(), delay);
    },
    stop() { stopped = true; pending.clear(); clearTimeout(timer); },
  };
}
