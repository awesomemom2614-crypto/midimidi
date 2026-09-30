import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ComplexFFT, RealFFT } from '../src/dsp/fft.js';
import { mulberry32 } from './synth.js';

function naiveMagnitude(x) {
  const n = x.length;
  const out = [];
  for (let k = 0; k <= n / 2; k++) {
    let re = 0;
    let im = 0;
    for (let t = 0; t < n; t++) {
      re += x[t] * Math.cos((2 * Math.PI * k * t) / n);
      im -= x[t] * Math.sin((2 * Math.PI * k * t) / n);
    }
    out.push(Math.hypot(re, im));
  }
  return out;
}

for (const n of [8, 64, 1024]) {
  test(`RealFFT magnitude matches a naive DFT (n=${n})`, () => {
    const rand = mulberry32(n);
    const x = Float64Array.from({ length: n }, () => rand() * 2 - 1);
    const got = new RealFFT(n).magnitude(x, new Float64Array(n / 2 + 1));
    const want = naiveMagnitude(x);
    for (let k = 0; k <= n / 2; k++) assert.ok(Math.abs(got[k] - want[k]) < 1e-9 * n, `bin ${k}: ${got[k]} vs ${want[k]}`);
  });
}

test('ComplexFFT of an impulse is flat', () => {
  const re = new Float64Array(16);
  const im = new Float64Array(16);
  re[0] = 1;
  new ComplexFFT(16).transform(re, im);
  for (let k = 0; k < 16; k++) {
    assert.ok(Math.abs(re[k] - 1) < 1e-12);
    assert.ok(Math.abs(im[k]) < 1e-12);
  }
});

test('FFT rejects sizes that are not powers of two', () => {
  assert.throws(() => new ComplexFFT(12));
});
