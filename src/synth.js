// Synthetic drum tracks with a known beat grid. Used for the demo track on
// first load and as ground truth in the tests.

export function constantBeats(bpm, duration, start = 0.5) {
  return tempoBeats(() => bpm, duration, start);
}

// sections: [{ bpm, until }] — tempo jumps at each `until` (seconds).
export function stepBeats(sections, duration, start = 0.5) {
  return tempoBeats((t) => (sections.find((s) => t < s.until) ?? sections[sections.length - 1]).bpm, duration, start);
}

export function rampBeats(bpm0, bpm1, rampStart, rampEnd, duration, start = 0.5) {
  return tempoBeats((t) => {
    if (t <= rampStart) return bpm0;
    if (t >= rampEnd) return bpm1;
    return bpm0 + ((bpm1 - bpm0) * (t - rampStart)) / (rampEnd - rampStart);
  }, duration, start);
}

// Each beat lasts 60 / tempo(t) seconds, with tempo read at the beat's start,
// so tempo steps land exactly on a beat.
export function tempoBeats(tempo, duration, start = 0.5) {
  const beats = [];
  for (let t = start; t < duration - 0.2; t += 60 / tempo(t)) beats.push(t);
  return beats;
}

export function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Drum grooves over a sustained bass drone and background noise.
//   rock: kick on 1 and 3, snare on 2 and 4, closed hi-hat on every eighth
//   four: kick on every beat, clap on 2 and 4, open hi-hat on the off-beats
export function renderDrums(beats, duration, { sr = 22050, noise = 0.03, seed = 1, pattern = 'rock' } = {}) {
  const rand = mulberry32(seed);
  const out = new Float32Array(Math.ceil(duration * sr));
  const add = (at, len, fn) => {
    const s0 = Math.round(at * sr);
    const n = Math.round(len * sr);
    for (let i = 0; i < n && s0 + i < out.length; i++) if (s0 + i >= 0) out[s0 + i] += fn(i / sr);
  };
  const kick = (at) => add(at, 0.25, (t) => 0.7 * Math.exp(-t / 0.08) * Math.sin(2 * Math.PI * (50 * t + 60 * 0.03 * (1 - Math.exp(-t / 0.03)))));
  const snare = (at) => add(at, 0.2, (t) => 0.35 * Math.exp(-t / 0.06) * (rand() * 2 - 1 + 0.5 * Math.sin(2 * Math.PI * 190 * t)));
  const hat = (at, decay, level) => add(at, 6 * decay, (t) => level * Math.exp(-t / decay) * (rand() * 2 - 1));
  beats.forEach((b, i) => {
    const next = beats[i + 1];
    const off = next === undefined ? undefined : (b + next) / 2;
    if (pattern === 'four') {
      kick(b);
      if (i % 2 === 1) snare(b);
      if (off !== undefined) hat(off, 0.05, 0.12);
    } else {
      if (i % 2 === 0) kick(b); else snare(b);
      hat(b, 0.015, 0.12);
      if (off !== undefined) hat(off, 0.015, 0.12);
    }
  });
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    out[i] += 0.05 * Math.sin(2 * Math.PI * 55 * t) + noise * (rand() * 2 - 1);
  }
  return out;
}

export function encodeWav(samples, sr) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
  return new Uint8Array(buf);
}
