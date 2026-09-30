import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTempoMap } from '../src/tempomap.js';
import { tempoMapToMidi, PPQ } from '../src/midi.js';
import { parseMidi, beatTimesFromMidi } from './midi-parse.js';

function sampleMap(beatsPerBar = 4) {
  const beats = [];
  let t = 0.73;
  for (let i = 0; i < 700; i++) {
    beats.push(t);
    t += i < 300 ? 0.6 : i < 500 ? 60 / (100 + (i - 300) * 0.2) : 60 / 140;
  }
  return { beats, map: buildTempoMap(beats, { toleranceMs: 10, beatsPerBar }) };
}

test('writes a format 1 file whose tempos reproduce the map exactly', () => {
  const { map } = sampleMap();
  const midi = parseMidi(tempoMapToMidi(map, { name: 'song.wav' }));
  assert.equal(midi.format, 1);
  assert.equal(midi.ppq, PPQ);
  assert.equal(midi.tracks.length, 1);

  const tempos = midi.tracks[0].filter((e) => e.meta === 0x51);
  assert.equal(tempos.length, map.events.length);
  tempos.forEach((e, i) => {
    assert.equal(e.tick, map.events[i].beat * PPQ);
    assert.equal((e.data[0] << 16) | (e.data[1] << 8) | e.data[2], map.events[i].microsPerBeat);
  });

  const times = beatTimesFromMidi(midi, map.gridTimes.length - 1);
  times.forEach((s, i) => assert.ok(Math.abs(s - map.gridTimes[i]) < 1e-9));
});

test('MIDI grid lands on the detected beat at every tempo change', () => {
  const { beats, map } = sampleMap();
  const midi = parseMidi(tempoMapToMidi(map));
  const times = beatTimesFromMidi(midi, map.gridTimes.length - 1);
  for (const e of map.events.filter((ev) => !ev.leadIn)) {
    const detected = beats[map.anchor + e.beat - map.leadInBeats];
    assert.ok(Math.abs(times[e.beat] - detected) < 0.001, `beat ${e.beat}: ${times[e.beat]} vs ${detected}`);
  }
});

test('writes track name and time signature', () => {
  const { map } = sampleMap(3);
  const midi = parseMidi(tempoMapToMidi(map, { name: 'Café' }));
  const name = midi.tracks[0].find((e) => e.meta === 0x03);
  assert.equal(String.fromCharCode(...name.data), 'Caf?');
  const sig = midi.tracks[0].find((e) => e.meta === 0x58);
  assert.deepEqual(sig.data, [3, 2, 24, 8]);
  assert.equal(midi.tracks[0].at(-1).meta, 0x2f);
});

test('optional click track puts a note on every grid beat with accents on bar starts', () => {
  const { map } = sampleMap();
  const midi = parseMidi(tempoMapToMidi(map, { click: true }));
  assert.equal(midi.tracks.length, 2);
  const ons = midi.tracks[1].filter((e) => e.status === 0x99);
  assert.equal(ons.length, map.gridTimes.length);
  ons.forEach((e, i) => {
    assert.equal(e.tick, i * PPQ);
    assert.equal(e.data[0], i % 4 === 0 ? 76 : 77);
  });
});
