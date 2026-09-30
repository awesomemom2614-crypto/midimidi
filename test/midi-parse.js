// Test helpers built on the app's MIDI reader.
export { parseMidi } from '../src/midiread.js';

// Seconds at each whole beat 0..lastBeat implied by the tempo events.
export function beatTimesFromMidi(midi, lastBeat) {
  const tempos = midi.tracks[0]
    .filter((e) => e.meta === 0x51)
    .map((e) => ({ beat: e.tick / midi.ppq, us: (e.data[0] << 16) | (e.data[1] << 8) | e.data[2] }));
  const out = [];
  let us = 0;
  let k = 0;
  for (let beat = 0; beat <= lastBeat; beat++) {
    while (k + 1 < tempos.length && tempos[k + 1].beat <= beat) k++;
    out.push(us / 1e6);
    us += tempos[k].us;
  }
  return out;
}
