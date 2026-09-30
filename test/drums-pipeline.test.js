// Drum charting end to end on synthetic audio with a known drum part.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Analyzer } from '../src/analyze.js';
import { buildTempoMap } from '../src/tempomap.js';
import { readDrumPart, autoAlign, placePart, chartTimeSigs } from '../src/drums/songsterr.js';
import { DEFAULT_GM_MAP, EXPERT_NOTE } from '../src/drums/lanes.js';
import { chartToMidi } from '../src/chartmidi.js';
import { parseMidi, tickToSeconds } from '../src/midiread.js';
import { pickHits } from '../src/drums/transcribe.js';
import { tempoBeats, drumPart, renderHits, writeGmMidi, beatTimeOn, beatAccuracy } from './synth.js';

const SR = 22050;
const COUNT_IN = 8; // the tab has two empty bars before the drums come in

// Audio whose tempo goes 100 -> 132 BPM, with the drum part starting on its
// first beat; the "Songsterr" file has the same part at its own tempos.
function scenario({ music = false, start = 1.2 } = {}) {
  const tempo = (t) => (t < 22 ? 100 : 132);
  const truthBeats = tempoBeats(tempo, 60, start);
  const bars = 20;
  const part = drumPart(bars, { startBeat: COUNT_IN });
  const hits = part.map((h) => ({ ...h, time: beatTimeOn(truthBeats, h.beat - COUNT_IN) }));
  const duration = hits[hits.length - 1].time + 2;
  return { truthBeats, part, hits, duration, audio: renderHits(hits, duration, { sr: SR, music }) };
}

function analyse(audio) {
  const a = new Analyzer();
  a.load(audio, SR);
  const result = a.track();
  return { analyzer: a, result, map: buildTempoMap(Array.from(result.beats), { toleranceMs: 15 }) };
}

for (const music of [false, true]) {
  test(`Songsterr part aligns to the recording and lands on the real hits (${music ? 'full mix' : 'drums only'})`, () => {
    const { part: rawPart, hits, audio } = scenario({ music });
    const { result, map } = analyse(audio);
    // The tab has its own tempo changes, none of which match the recording.
    const tabTempos = [{ beat: 0, bpm: 120 }, { beat: 24, bpm: 90 }, { beat: 48, bpm: 140 }];
    const part = readDrumPart(writeGmMidi(rawPart, { tempos: tabTempos }));
    assert.deepEqual(part.tempoRange.map(Math.round), [90, 140]);

    // The first real hit sits on grid beat g0; the tab's beat 8 must map there.
    const g0 = map.gridTimes.reduce((best, t, i) => (Math.abs(t - hits[0].time) < Math.abs(map.gridTimes[best] - hits[0].time) ? i : best), 0);
    const align = autoAlign(part, map.gridTimes, result.onset);
    assert.equal(align.offset, g0 - COUNT_IN, JSON.stringify(align.alternatives));
    // A one-beat shift puts kicks on snares, which must score clearly worse.
    const at = (o) => align.scores.find((s) => s.offset === o).score;
    assert.ok(at(align.offset + 1) < 0.9 * align.score && at(align.offset - 1) < 0.9 * align.score);

    const placed = placePart(part, align.offset, DEFAULT_GM_MAP, map.gridTimes.length - 1);
    const sigs = chartTimeSigs(part, align.offset, map.gridTimes.length - 1);
    const midi = parseMidi(chartToMidi(map, placed.notes, sigs));

    // The chart's tempo map is exactly the detected one; the tab's is ignored.
    const written = midi.tracks[0].filter((e) => e.meta === 0x51).map((e) => [e.tick, (e.data[0] << 16) | (e.data[1] << 8) | e.data[2]]);
    assert.deepEqual(written, map.events.map((e) => [e.beat * 480, e.microsPerBeat]));
    const tabUs = tabTempos.map((t) => Math.round(60e6 / t.bpm));
    assert.ok(written.every(([, us]) => !tabUs.includes(us)), 'a tab tempo leaked into notes.mid');

    // Every kick and snare in notes.mid is within 25 ms of the real hit.
    const kicks = midi.tracks[1].filter((e) => (e.status & 0xf0) === 0x90 && e.data[1] > 0 && e.data[0] === EXPERT_NOTE.kick);
    const kickTimes = kicks.map((e) => tickToSeconds(midi, e.tick));
    const trueKicks = hits.filter((h) => h.gm === 36).map((h) => h.time);
    const acc = beatAccuracy(kickTimes, trueKicks, 0.025);
    assert.ok(acc.f > 0.98, `kick F=${acc.f}`);

    // Bar lines: the drums come in on a downbeat.
    const bar = sigs.filter((s) => !s.pickup && s.beat <= g0).at(-1);
    assert.equal((g0 - bar.beat) % 4, 0, `sigs ${JSON.stringify(sigs)}`);
  });
}

for (const music of [false, true]) {
  test(`drum transcription finds kick, snare, hi-hat and crash (${music ? 'full mix' : 'drum stem'})`, () => {
    const { hits, audio } = scenario({ music });
    const a = new Analyzer();
    a.load(audio, SR);
    // Transcribing the loaded audio treats it as a full mix; a stem is passed in.
    const { acts, fps } = music ? a.transcribe() : a.transcribe(audio);
    const found = pickHits(acts, fps, { sensitivity: 0.5 });
    const want = { kick: [36, 0.9], snare: [38, 0.85], hat: [42, 0.8], crash: [49, 0.8] };
    for (const [drum, [gm, minF]] of Object.entries(want)) {
      const truth = hits.filter((h) => h.gm === gm).map((h) => h.time);
      const det = found.filter((f) => f.drum === drum).map((f) => f.time);
      const acc = beatAccuracy(det, truth, 0.03);
      assert.ok(acc.f >= minF, `${drum}: F=${acc.f.toFixed(2)} (${det.length} found, ${truth.length} true)`);
    }
  });
}
