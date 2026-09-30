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

// A Songsterr-style export: constant tempo, a guitar track on channel 1 and
// the drums on channel 10. hits: [{ beat, gm }].
import { writeSmf, metaEvent, ascii, tempoEvent, timeSigEvent } from '../src/midi.js';
export function writeGmMidi(hits, { bpm = 120, ppq = 960, timeSigs = [{ beat: 0, num: 4, den: 4 }] } = {}) {
  const conductor = [tempoEvent(0, Math.round(60e6 / bpm)), ...timeSigs.map((s) => timeSigEvent(s.beat * ppq, s.num, s.den))];
  const guitar = [{ tick: 0, data: metaEvent(0x03, ascii('Guitar')) }, { tick: 0, data: [0x90, 40, 90] }, { tick: ppq, data: [0x80, 40, 0] }];
  const drums = [{ tick: 0, data: metaEvent(0x03, ascii('Drums')) }];
  for (const h of hits) {
    const tick = Math.round(h.beat * ppq);
    drums.push({ tick, data: [0x99, h.gm, h.velocity ?? 100] }, { tick: tick + ppq / 8, data: [0x89, h.gm, 0], order: -1 });
  }
  return writeSmf([conductor, guitar, drums], ppq);
}

// Seconds for a fractional beat on a list of beat times.
export function beatTimeOn(beats, b) {
  const i = Math.max(0, Math.min(beats.length - 2, Math.floor(b)));
  return beats[i] + (b - i) * (beats[i + 1] - beats[i]);
}
