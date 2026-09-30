import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMidi, tickToSeconds } from '../src/midiread.js';
import { resolveConflicts, DEFAULT_GM_MAP, EXPERT_NOTE, TOM_MARKER } from '../src/drums/lanes.js';
import { chartToMidi } from '../src/chartmidi.js';
import { buildTempoMap } from '../src/tempomap.js';
import { readDrumPart, chartTimeSigs, placePart } from '../src/drums/songsterr.js';
import { timeToBeat, beatToTime, snapBeat } from '../src/drums/quantize.js';
import { zipFiles, crc32 } from '../src/zip.js';
import { songIni } from '../src/songini.js';
import { writeGmMidi } from './synth.js';

test('reader handles running status and sysex', () => {
  const track = [
    0x00, 0xf0, 0x03, 0x7e, 0x7f, 0xf7, // sysex
    0x00, 0x99, 36, 100, // note on, channel 10
    0x10, 38, 90, // running status note on
    0x10, 36, 0, // running status note on vel 0 (= off)
    0x00, 0xff, 0x2f, 0x00,
  ];
  const bytes = new Uint8Array([
    ...[0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0],
    ...[0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, track.length], ...track,
  ]);
  const midi = parseMidi(bytes);
  assert.equal(midi.format, 0);
  assert.equal(midi.ppq, 480);
  const notes = midi.tracks[0].filter((e) => e.status !== undefined);
  assert.deepEqual(notes.map((e) => [e.tick, e.status, ...e.data]), [[0, 0x99, 36, 100], [16, 0x99, 38, 90], [32, 0x99, 36, 0]]);
  assert.ok(midi.tracks[0][0].sysex);
});

test('rejects files that are not MIDI', () => {
  assert.throws(() => parseMidi(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])), /Not a MIDI file/);
});

test('conflicting cymbal and tom on one lane: tom moves to the next free tom lane', () => {
  const { notes, moved } = resolveConflicts([
    { beat: 1, lane: 'yellow', cymbal: true },
    { beat: 1, lane: 'yellow', cymbal: false },
    { beat: 1, lane: 'red', cymbal: false },
    { beat: 1, lane: 'red', cymbal: false },
  ]);
  assert.equal(moved, 1);
  assert.deepEqual(notes.map((n) => `${n.lane}${n.cymbal ? '-cym' : ''}`), ['red', 'yellow-cym', 'blue']);
});

test('chart MIDI: PART DRUMS with expert notes and tom markers only on toms', () => {
  const beats = Array.from({ length: 17 }, (_, i) => 0.5 + i * 0.5);
  const map = buildTempoMap(beats);
  const notes = [
    { beat: 1, lane: 'kick', cymbal: false },
    { beat: 1, lane: 'yellow', cymbal: true },
    { beat: 1.25, lane: 'yellow', cymbal: false },
    { beat: 1.5, lane: 'yellow', cymbal: true },
    { beat: 2, lane: 'green', cymbal: false },
  ];
  const midi = parseMidi(chartToMidi(map, notes, [{ beat: 0, num: 4, den: 4 }], { name: 'Test' }));
  assert.equal(midi.ppq, 480);
  assert.equal(midi.tracks.length, 2);
  const drums = midi.tracks[1];
  assert.equal(String.fromCharCode(...drums.find((e) => e.meta === 0x03).data), 'PART DRUMS');
  const ons = drums.filter((e) => (e.status & 0xf0) === 0x90 && e.data[1] > 0);
  const at = (tick) => ons.filter((e) => e.tick === tick).map((e) => e.data[0]).sort((x, y) => x - y);
  assert.deepEqual(at(480), [EXPERT_NOTE.kick, EXPERT_NOTE.yellow]);
  assert.deepEqual(at(600), [EXPERT_NOTE.yellow, TOM_MARKER.yellow]);
  assert.deepEqual(at(720), [EXPERT_NOTE.yellow]);
  assert.deepEqual(at(960), [EXPERT_NOTE.green, TOM_MARKER.green]);
  // The yellow tom marker must end before the yellow cymbal that follows it.
  const markerOff = drums.find((e) => e.tick > 600 && (e.status & 0xf0) === 0x80 && e.data[0] === TOM_MARKER.yellow);
  assert.ok(markerOff.tick <= 720);
  // Notes are short (no sustains); grid beat 1 is the first detected beat (0.5 s).
  const offs = drums.filter((e) => (e.status & 0xf0) === 0x80 && e.data[0] === EXPERT_NOTE.kick);
  assert.ok(offs[0].tick - 480 <= 30);
  assert.ok(Math.abs(tickToSeconds(midi, 480) - 0.5) < 1e-3);
});

test('Songsterr-style export: drum channel found, guitar ignored', () => {
  const part = readDrumPart(writeGmMidi([{ beat: 0, gm: 36 }, { beat: 1, gm: 38 }, { beat: 1.5, gm: 42 }], { bpm: 140 }));
  assert.equal(part.notes.length, 3);
  assert.equal(part.name, 'Drums');
  assert.ok(Math.abs(part.bpm - 140) < 0.01);
  assert.deepEqual(part.counts, { 36: 1, 38: 1, 42: 1 });
});

test('placing a part: offset shifts beats, notes outside the audio are counted', () => {
  const part = readDrumPart(writeGmMidi([{ beat: 0, gm: 36 }, { beat: 4, gm: 38 }, { beat: 30, gm: 42 }, { beat: 5, gm: 99 }]));
  const placed = placePart(part, -2, DEFAULT_GM_MAP, 20);
  assert.equal(placed.early, 1);
  assert.equal(placed.late, 1);
  assert.equal(placed.ignored, 1);
  assert.deepEqual(placed.notes.map((n) => [n.beat, n.lane]), [[2, 'red']]);
});

test('time signatures: pickup bar before bar 1, and a bar cut at the start', () => {
  const part = { timeSigs: [{ beat: 0, num: 4, den: 4 }, { beat: 8, num: 3, den: 4 }], endBeat: 20 };
  assert.deepEqual(chartTimeSigs(part, 3, 30).map(({ beat, num, den }) => [beat, num, den]), [[0, 3, 4], [3, 4, 4], [11, 3, 4]]);
  assert.deepEqual(chartTimeSigs(part, 6, 30).map(({ beat, num, den }) => [beat, num, den]), [[0, 2, 4], [2, 4, 4], [14, 3, 4]]);
  assert.deepEqual(chartTimeSigs(part, -1, 30).map(({ beat, num, den }) => [beat, num, den]), [[0, 3, 4], [3, 4, 4], [7, 3, 4]]);
  assert.deepEqual(chartTimeSigs(part, 1.5, 30).map(({ beat, num, den }) => [beat, num, den]), [[0, 3, 8], [1.5, 4, 4], [9.5, 3, 4]]);
});

test('grid conversions round-trip and snap', () => {
  const grid = [0, 0.5, 1.1, 1.6, 2.0];
  for (const t of [0.2, 0.9, 1.35, 1.99]) assert.ok(Math.abs(beatToTime(grid, timeToBeat(grid, t)) - t) < 1e-9);
  assert.ok(Math.abs(timeToBeat(grid, 2.2) - 4.5) < 1e-9);
  assert.equal(snapBeat(1.13, 4), 1.25);
  assert.equal(snapBeat(1.3, 3), 4 / 3);
});

test('zip holds several files with correct CRCs and offsets', () => {
  const a = new TextEncoder().encode('hello');
  const b = new Uint8Array(300).map((_, i) => i);
  const zip = zipFiles([{ name: 'notes.mid', data: a }, { name: 'song.ini', data: b }]);
  const v = new DataView(zip.buffer);
  const endAt = zip.length - 22;
  assert.equal(v.getUint32(endAt, true), 0x06054b50);
  assert.equal(v.getUint16(endAt + 10, true), 2);
  let p = v.getUint32(endAt + 16, true);
  for (const [name, data] of [['notes.mid', a], ['song.ini', b]]) {
    assert.equal(v.getUint32(p, true), 0x02014b50);
    assert.equal(v.getUint32(p + 16, true), crc32(data));
    const local = v.getUint32(p + 42, true);
    const nameLen = v.getUint16(local + 26, true);
    assert.equal(new TextDecoder().decode(zip.subarray(local + 30, local + 30 + nameLen)), name);
    assert.deepEqual(zip.subarray(local + 30 + nameLen, local + 30 + nameLen + data.length), data);
    p += 46 + v.getUint16(p + 28, true);
  }
});

test('song.ini turns on pro drums', () => {
  const ini = songIni({ name: 'My Song\nx', lengthMs: 123456.4 });
  assert.match(ini, /^\[song\]/);
  assert.match(ini, /pro_drums = True/);
  assert.match(ini, /name = My Song x\r\n/);
  assert.match(ini, /song_length = 123456/);
});
