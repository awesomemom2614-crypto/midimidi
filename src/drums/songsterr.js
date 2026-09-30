// Drum parts from a MIDI export (e.g. Songsterr), placed onto the detected
// tempo map by musical position: the part's beat b lands on grid beat
// offset + b, where offset is found by matching its hits to the audio.
import { parseMidi, trackName, tempoEvents } from '../midiread.js';
import { TARGET_BY_ID, resolveConflicts } from './lanes.js';
import { beatToTime } from './quantize.js';

export function readDrumPart(bytes) {
  const midi = parseMidi(bytes);
  const notes = [];
  const timeSigs = [];
  let name = '';
  const collect = (t, onlyChannel10) => {
    for (const e of t) {
      if (e.status === undefined) continue;
      const kind = e.status & 0xf0;
      if (kind !== 0x90 || e.data[1] === 0) continue;
      if (onlyChannel10 && (e.status & 0x0f) !== 9) continue;
      notes.push({ beat: e.tick / midi.ppq, gm: e.data[0], velocity: e.data[1] });
    }
  };
  for (const t of midi.tracks) {
    const before = notes.length;
    collect(t, true);
    if (notes.length > before && !name) name = trackName(t);
    for (const e of t) {
      if (e.meta === 0x58) timeSigs.push({ beat: e.tick / midi.ppq, num: e.data[0], den: 2 ** e.data[1] });
    }
  }
  // No channel 10? Fall back to a track that calls itself drums.
  if (!notes.length) {
    const t = midi.tracks.find((tr) => /drum|perc/i.test(trackName(tr)));
    if (t) { collect(t, false); name = trackName(t); }
  }
  if (!notes.length) throw new Error('No drum notes found. The file needs a drum track on MIDI channel 10.');
  notes.sort((a, b) => a.beat - b.beat);
  timeSigs.sort((a, b) => a.beat - b.beat);
  const dedupedSigs = timeSigs.filter((s, i) => i === 0 || s.beat !== timeSigs[i - 1].beat || s.num !== timeSigs[i - 1].num);
  if (!dedupedSigs.length || dedupedSigs[0].beat > 0) dedupedSigs.unshift({ beat: 0, num: 4, den: 4 });
  // The tab's own tempo is only reported (and used to spot half/double-time
  // mismatches); the chart always takes its tempo map from the recording.
  const tempos = tempoEvents(midi);
  const endTick = Math.max(...notes.map((n) => n.beat)) * midi.ppq;
  const spans = new Map();
  tempos.forEach((t, i) => {
    const until = Math.max(t.tick, Math.min(endTick, tempos[i + 1]?.tick ?? endTick));
    const b = Math.round(6e9 / t.us) / 100; // BPM to 2 decimals
    spans.set(b, (spans.get(b) ?? 0) + (until - t.tick));
  });
  const bpm = [...spans.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const tempoBpms = tempos.map((t) => 60e6 / t.us);
  const tempoRange = [Math.min(...tempoBpms), Math.max(...tempoBpms)];
  const counts = {};
  for (const n of notes) counts[n.gm] = (counts[n.gm] ?? 0) + 1;
  return { name, notes, timeSigs: dedupedSigs, bpm, tempoRange, tempoChanges: tempos.length - 1, counts, endBeat: notes[notes.length - 1].beat };
}

// How well the part's hits line up with audio onsets for each whole-beat
// offset. Kick notes are matched against low-frequency onsets, everything
// else against all onsets. Returns the best offset and the closest
// alternatives (a steady groove shifted by a bar scores almost the same, so
// these are worth checking by ear).
export function autoAlign(part, grid, onset, { minOffset = -16, maxOffset = 64 } = {}) {
  const { env, envLow, fps } = onset;
  const hits = part.notes.filter((n) => n.velocity > 20);
  const strengthAt = (curve, t) => {
    const f = Math.round(t * fps);
    let m = 0;
    for (let k = f - 2; k <= f + 2; k++) if (k >= 0 && k < curve.length && curve[k] > m) m = curve[k];
    return m;
  };
  const last = grid.length - 1;
  const scores = [];
  for (let o = minOffset; o <= Math.min(maxOffset, last); o++) {
    let s = 0;
    for (const n of hits) {
      const beat = o + n.beat;
      if (beat < 0 || beat > last) continue;
      const kick = n.gm === 35 || n.gm === 36;
      s += strengthAt(kick && envLow ? envLow : env, beatToTime(grid, beat));
    }
    scores.push({ offset: o, score: hits.length ? s / hits.length : 0 });
  }
  const ranked = [...scores].sort((a, b) => b.score - a.score);
  const best = ranked[0] ?? { offset: 0, score: 0 };
  const alternatives = ranked.slice(1).filter((r) => r.score >= 0.9 * best.score).slice(0, 3);
  return { offset: best.offset, score: best.score, alternatives, scores };
}

// Lane notes on the grid for a given offset and GM mapping.
export function placePart(part, offset, mapping, lastBeat) {
  const placed = [];
  let early = 0;
  let late = 0;
  let ignored = 0;
  for (const n of part.notes) {
    const target = TARGET_BY_ID[mapping[n.gm] ?? 'ignore'];
    if (!target?.lane) { ignored++; continue; }
    const beat = offset + n.beat;
    if (beat < -1e-6) { early++; continue; }
    if (beat > lastBeat + 1e-6) { late++; continue; }
    placed.push({ beat: Math.max(0, beat), lane: target.lane, cymbal: target.cymbal, velocity: n.velocity });
  }
  const resolved = resolveConflicts(placed);
  return { ...resolved, early, late, ignored };
}

// Time signatures for the chart: the part's bars shifted by the offset, with
// a pickup bar filling whatever comes before bar 1.
export function chartTimeSigs(part, offset, endBeat) {
  const bars = [];
  const sigs = part.timeSigs;
  let k = 0;
  const partEnd = Math.max(part.endBeat + 1, endBeat - offset + 1);
  for (let start = 0; start < partEnd;) {
    while (k + 1 < sigs.length && sigs[k + 1].beat <= start + 1e-9) k++;
    const len = (sigs[k].num * 4) / sigs[k].den;
    bars.push({ start: start + offset, len, num: sigs[k].num, den: sigs[k].den });
    start += len;
  }
  const out = [];
  const first = bars.find((b) => b.start + b.len > 1e-9);
  if (!first) return [{ beat: 0, num: 4, den: 4 }];
  if (first.start > 1e-9) {
    const r = first.start % first.len;
    if (r > 1e-9) out.push({ beat: 0, ...sigForLength(r) });
    out.push({ beat: r, num: first.num, den: first.den });
  } else if (first.start < -1e-9) {
    out.push({ beat: 0, ...sigForLength(first.start + first.len) });
  }
  for (const b of bars) {
    if (b.start < -1e-9 || b.start > endBeat) continue;
    out.push({ beat: b.start, num: b.num, den: b.den });
  }
  return out.filter((s, i) => i === 0 || s.num !== out[i - 1].num || s.den !== out[i - 1].den || s.pickup || out[i - 1].pickup);
}

function sigForLength(len) {
  if (Math.abs(len - Math.round(len)) < 1e-6) return { num: Math.round(len), den: 4, pickup: true };
  if (Math.abs(len * 2 - Math.round(len * 2)) < 1e-6) return { num: Math.round(len * 2), den: 8, pickup: true };
  return { num: Math.max(1, Math.round(len * 4)), den: 16, pickup: true };
}
