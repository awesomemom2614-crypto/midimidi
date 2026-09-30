// Picks where the analysis runs: a module worker when the host allows one,
// otherwise the main thread. Both expose the same two calls.
import { Analyzer } from './analyze.js';

export async function createEngine({ allowWorker = true } = {}) {
  if (allowWorker && typeof Worker !== 'undefined') {
    try {
      return await workerEngine();
    } catch {
      // Fall through to the main thread.
    }
  }
  return mainThreadEngine();
}

function workerEngine() {
  const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('worker did not start')); }, 5000);
    const pending = new Map();
    let nextId = 1;
    worker.addEventListener('error', (e) => {
      clearTimeout(timer);
      reject(e);
      for (const p of pending.values()) p.reject(new Error('Analysis worker crashed'));
      pending.clear();
    });
    worker.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg.type === 'ready') {
        clearTimeout(timer);
        resolve(engine);
        return;
      }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result); else p.reject(new Error(msg.error));
    });
    const call = (payload) => new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { resolve: res, reject: rej });
      worker.postMessage({ id, ...payload });
    });
    const engine = {
      kind: 'worker',
      analyze: (samples, sr, tracking) => call({ type: 'load', samples, sr, tracking }),
      retrack: (tracking) => call({ type: 'track', tracking }),
      transcribe: (stem, sr) => call({ type: 'transcribe', samples: stem, sr }),
    };
  });
}

function mainThreadEngine() {
  const analyzer = new Analyzer();
  // Yield once so the status line paints before the long synchronous pass.
  const later = (fn) => new Promise((res, rej) => setTimeout(() => { try { res(fn()); } catch (err) { rej(err); } }, 30));
  return {
    kind: 'main',
    analyze: (samples, sr, tracking) => later(() => { analyzer.load(samples, sr); return analyzer.track(tracking); }),
    retrack: (tracking) => later(() => analyzer.track(tracking)),
    transcribe: (stem, sr) => later(() => analyzer.transcribe(stem, sr)),
  };
}
