// End-to-end on synthetic drum tracks whose beat grid is known exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Analyzer, analyzeSamples } from '../src/analyze.js';
import { buildTempoMap } from '../src/tempomap.js';
import { tempoMapToMidi } from '../src/midi.js';
import { parseMidi, beatTimesFromMidi } from './midi-parse.js';
import { constantBeats, stepBeats, rampBeats, renderDrums, beatAccuracy } from './synth.js';

const SR = 22050;
const changes = (map) => map.events.filter((e) => !e.leadIn);

function run(truth, duration, pattern, toleranceMs = 20) {
  const result = analyzeSamples(renderDrums(truth, duration, { sr: SR, pattern }), SR);
  const beats = Array.from(result.beats);
  return { beats, map: buildTempoMap(beats, { toleranceMs }), accuracy: beatAccuracy(beats, truth, 0.015) };
}

test('steady 120 BPM rock groove: every beat found, one tempo', () => {
  const truth = constantBeats(120, 40);
  const { map, accuracy } = run(truth, 40, 'rock');
  assert.ok(accuracy.f >= 0.95, `F=${accuracy.f}`);
  const c = changes(map);
  assert.equal(c.length, 1);
  assert.ok(Math.abs(c[0].bpm - 120) < 0.5, `bpm ${c[0].bpm}`);
});

test('100 -> 140 BPM jump: two tempos, change on the right beat', () => {
  const truth = stepBeats([{ bpm: 100, until: 30 }, { bpm: 140, until: Infinity }], 55);
  const { map, accuracy } = run(truth, 55, 'four');
  assert.ok(accuracy.f >= 0.95, `F=${accuracy.f}`);
  const c = changes(map);
  assert.equal(c.length, 2, c.map((e) => e.bpm.toFixed(1)).join(', '));
  assert.ok(Math.abs(c[0].bpm - 100) < 1);
  assert.ok(Math.abs(c[1].bpm - 140) < 1);
  const firstFast = truth.find((t) => t >= 30);
  assert.ok(Math.abs(c[1].time - firstFast) < 60 / 140, `change at ${c[1].time}, expected ${firstFast}`);
});

test('90 -> 130 BPM ramp: MIDI grid follows the drift', () => {
  const truth = rampBeats(90, 130, 10, 60, 70);
  const { beats, map, accuracy } = run(truth, 70, 'rock');
  assert.ok(accuracy.f >= 0.95, `F=${accuracy.f}`);
  const c = changes(map);
  assert.ok(c.length >= 5, `only ${c.length} changes`);
  assert.ok(Math.abs(c[0].bpm - 90) < 2, `first ${c[0].bpm}`);
  assert.ok(Math.abs(c.at(-1).bpm - 130) < 2, `last ${c.at(-1).bpm}`);

  const midi = parseMidi(tempoMapToMidi(map));
  const grid = beatTimesFromMidi(midi, map.gridTimes.length - 1);
  for (let i = map.anchor; i < beats.length; i++) {
    const g = grid[map.leadInBeats + i - map.anchor];
    assert.ok(Math.abs(g - beats[i]) < 0.021, `beat ${i}: grid ${g} vs detected ${beats[i]}`);
  }
  const onTruth = beatAccuracy(grid.slice(map.leadInBeats), truth, 0.03);
  assert.ok(onTruth.f >= 0.95, `grid vs truth F=${onTruth.f}`);
});

test('doubling the tempo re-tracks at twice the rate', () => {
  const truth = constantBeats(100, 30);
  const analyzer = new Analyzer();
  analyzer.load(renderDrums(truth, 30, { sr: SR }), SR);
  const normal = analyzer.track();
  const doubled = analyzer.track({ tempoScale: 2 });
  const bpm = changes(buildTempoMap(Array.from(doubled.beats)))[0].bpm;
  assert.ok(Math.abs(bpm - 200) < 2, `bpm ${bpm}`);
  assert.ok(Math.abs(doubled.beats.length - 2 * normal.beats.length) <= 2);
});

test('silence and very short input do not throw', () => {
  const silent = analyzeSamples(new Float32Array(SR * 3), SR);
  assert.ok(silent.beats.length <= 1, `found ${silent.beats.length} beats in silence`);
  const tiny = analyzeSamples(new Float32Array(100), SR);
  assert.equal(buildTempoMap(Array.from(tiny.beats)).events.length, 0);
});
