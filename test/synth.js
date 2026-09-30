// Test helpers: the synthetic tracks live in src/ (the page uses them for its
// demo); beat matching is test-only.
export * from '../src/synth.js';

// One-to-one matching of detected beats to true beats within ±tol seconds.
export function beatAccuracy(detected, truth, tol) {
  let j = 0;
  let hits = 0;
  const errors = [];
  for (const d of detected) {
    while (j < truth.length && truth[j] < d - tol) j++;
    if (j < truth.length && Math.abs(truth[j] - d) <= tol) {
      hits++;
      errors.push(d - truth[j]);
      j++;
    }
  }
  const precision = hits / Math.max(1, detected.length);
  const recall = hits / Math.max(1, truth.length);
  const f = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { f, precision, recall, errors };
}
