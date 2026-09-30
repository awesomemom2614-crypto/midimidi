// Runs the analysis off the main thread. Keeps the onset envelope between
// calls so re-tracking with new settings skips the expensive spectral pass.
import { Analyzer } from './analyze.js';

const analyzer = new Analyzer();

self.onmessage = (e) => {
  const { id, type, samples, sr, tracking } = e.data;
  try {
    let result;
    if (type === 'transcribe') {
      result = analyzer.transcribe(samples ?? null, sr);
    } else {
      if (type === 'load') analyzer.load(samples, sr);
      result = analyzer.track(tracking);
    }
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message ?? String(err) });
  }
};

self.postMessage({ type: 'ready' });
