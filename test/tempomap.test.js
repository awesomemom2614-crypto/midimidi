import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTempoMap } from '../src/tempomap.js';
import { mulberry32 } from './synth.js';

function beatsFrom(intervals, start, jitterMs = 0, seed = 7) {
  const rand = mulberry32(seed);
  const out = [];
  let t = start;
  for (const d of [0, ...intervals]) {
    t += d;
    out.push(t + ((rand() * 2 - 1) * jitterMs) / 1000);
  }
  return out;
}

const repeat = (value, count) => Array.from({ length: count }, () => value);
const changes = (map) => map.events.filter((e) => !e.leadIn);

function assertGridFollowsBeats(map, beats, toleranceMs) {
  const grid = map.gridTimes;
  for (let i = map.anchor; i < beats.length; i++) {
    const g = grid[map.leadInBeats + (i - map.anchor)];
    assert.ok(Math.abs(g - beats[i]) <= toleranceMs / 1000 + 1e-4, `beat ${i}: grid ${g.toFixed(4)} vs beat ${beats[i].toFixed(4)}`);
  }
}

test('steady tempo with jitter collapses to a single tempo', () => {
  const beats = beatsFrom(repeat(0.5, 100), 0.5, 4);
  const map = buildTempoMap(beats, { toleranceMs: 20 });
  const c = changes(map);
  assert.equal(c.length, 1);
  assert.ok(Math.abs(c[0].bpm - 120) < 0.2, `bpm ${c[0].bpm}`);
  assertGridFollowsBeats(map, beats, 20);
});

test('a tempo jump becomes exactly one change on the right beat', () => {
  const beats = beatsFrom([...repeat(0.6, 40), ...repeat(60 / 140, 60)], 0.5, 3);
  const map = buildTempoMap(beats, { toleranceMs: 20 });
  const c = changes(map);
  assert.equal(c.length, 2);
  assert.ok(Math.abs(c[0].bpm - 100) < 0.5);
  assert.ok(Math.abs(c[1].bpm - 140) < 0.5);
  assert.equal(c[1].beat, map.leadInBeats + 40);
  assert.ok(Math.abs(c[1].time - beats[40]) < 1e-4);
  assertGridFollowsBeats(map, beats, 20);
});

test('a gradual ramp becomes a staircase that stays within tolerance', () => {
  const intervals = [];
  for (let i = 0; i < 120; i++) intervals.push(60 / (90 + (40 * i) / 119));
  const beats = beatsFrom(intervals, 0.5, 2);
  const map = buildTempoMap(beats, { toleranceMs: 15 });
  const c = changes(map);
  assert.ok(c.length >= 5, `only ${c.length} changes`);
  for (let k = 1; k < c.length; k++) assert.ok(c[k].bpm > c[k - 1].bpm - 0.5, 'staircase should rise');
  assertGridFollowsBeats(map, beats, 15);
});

test('tolerance 0 gives a tempo event on every beat', () => {
  const intervals = Array.from({ length: 20 }, (_, i) => 0.5 + 0.01 * Math.sin(i));
  const beats = beatsFrom(intervals, 0.5);
  const map = buildTempoMap(beats, { toleranceMs: 0 });
  assert.equal(changes(map).length, 20);
  assertGridFollowsBeats(map, beats, 0.01);
});

test('lead-in keeps the first beat on the grid', () => {
  const beats = beatsFrom(repeat(0.5, 16), 1.3);
  const map = buildTempoMap(beats);
  assert.equal(map.anchor, 0);
  assert.equal(map.leadInBeats, 3);
  assert.ok(map.events[0].leadIn);
  assert.ok(Math.abs(map.gridTimes[3] - 1.3) < 1e-5);
});

test('no lead-in when the first beat is at time zero', () => {
  const beats = beatsFrom(repeat(0.5, 8), 0);
  const map = buildTempoMap(beats);
  assert.equal(map.leadInBeats, 0);
  assert.equal(map.events.length, 1);
  assert.equal(map.events[0].beat, 0);
});

test('a beat right at the start is skipped rather than forcing a huge lead-in tempo', () => {
  const beats = beatsFrom(repeat(0.5, 8), 0.05);
  const map = buildTempoMap(beats);
  assert.equal(map.anchor, 1);
  const lead = map.events[0];
  assert.ok(lead.leadIn && lead.bpm > 60 && lead.bpm < 240, `lead-in ${lead.bpm}`);
});

test('bar and beat numbers follow the time signature', () => {
  const beats = beatsFrom([...repeat(0.5, 10), ...repeat(0.4, 10)], 0);
  const map = buildTempoMap(beats, { beatsPerBar: 3 });
  const second = changes(map)[1];
  assert.equal(second.beat, 10);
  assert.equal(second.bar, 4);
  assert.equal(second.beatInBar, 2);
});

test('fewer than two beats gives an empty map', () => {
  assert.equal(buildTempoMap([]).events.length, 0);
  assert.equal(buildTempoMap([1.0]).events.length, 0);
});
