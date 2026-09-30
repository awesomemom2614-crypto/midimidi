// Browser end-to-end check with Playwright + Chromium: load the page, let the
// example analyse, upload a synthetic WAV, download the .mid and verify it.
// Runs once with the analysis worker and once with the main-thread fallback.
//   node test/e2e.mjs [screenshot-dir]
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { stepBeats, drumPart, renderHits, encodeWav, writeGmMidi, beatTimeOn } from './synth.js';
import { parseMidi, beatTimesFromMidi } from './midi-parse.js';
import { tickToSeconds } from '../src/midiread.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotDir = process.argv[2];
const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = require(path.join(execSync('npm root -g').toString().trim(), 'playwright'));
}

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer(async (req, res) => {
  let file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  if (file.endsWith(path.sep)) file = path.join(file, 'index.html');
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'midimidi-'));
const truth = stepBeats([{ bpm: 110, until: 20 }, { bpm: 150, until: Infinity }], 40, 0.8);
// A drum part that starts on the first beat; the tab version has a 2-bar count-in.
const part = drumPart(Math.floor((truth.length - 1) / 4));
const hits = part.map((h) => ({ ...h, time: beatTimeOn(truth, h.beat) }));
const wavPath = path.join(tmp, 'step-110-150.wav');
await fs.writeFile(wavPath, encodeWav(renderHits(hits, 40, { sr: 44100, music: true }), 44100));
const tabPath = path.join(tmp, 'tab.mid');
await fs.writeFile(tabPath, writeGmMidi(part.map((h) => ({ ...h, beat: h.beat + 8 })), { tempos: [{ beat: 0, bpm: 120 }, { beat: 40, bpm: 96 }] }));
const trueKicks = hits.filter((h) => h.gm === 36).map((h) => h.time);

// Reads a stored zip into { name: Uint8Array }.
function unzip(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const end = buf.length - 22;
  const out = {};
  let p = v.getUint32(end + 16, true);
  for (let i = 0; i < v.getUint16(end + 10, true); i++) {
    const size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const local = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
    const lnl = v.getUint16(local + 26, true);
    out[name] = buf.subarray(local + 30 + lnl, local + 30 + lnl + size);
    p += 46 + nameLen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
  }
  return out;
}

async function downloadChart(page) {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#download-chart')]);
  assert.equal(dl.suggestedFilename(), 'step-110-150.zip');
  const files = unzip(new Uint8Array(await fs.readFile(await dl.path())));
  assert.deepEqual(Object.keys(files).sort(), ['step-110-150/notes.mid', 'step-110-150/song.ini', 'step-110-150/song.wav']);
  assert.match(new TextDecoder().decode(files['step-110-150/song.ini']), /pro_drums = True/);
  const midi = parseMidi(files['step-110-150/notes.mid']);
  // Tempos in notes.mid are the detected 110 -> 150 BPM, never the tab's 120 / 96.
  const bpms = midi.tracks[0].filter((e) => e.meta === 0x51).map((e) => 60e6 / ((e.data[0] << 16) | (e.data[1] << 8) | e.data[2]));
  assert.ok(bpms.slice(1).every((b) => Math.abs(b - 110) < 1 || Math.abs(b - 150) < 1), `tempos ${bpms.map((b) => b.toFixed(2))}`);
  const drums = midi.tracks[1];
  assert.equal(String.fromCharCode(...drums.find((e) => e.meta === 0x03).data), 'PART DRUMS');
  const kicks = drums.filter((e) => (e.status & 0xf0) === 0x90 && e.data[1] > 0 && e.data[0] === 96).map((e) => tickToSeconds(midi, e.tick));
  const matched = kicks.filter((k) => trueKicks.some((t) => Math.abs(t - k) < 0.035)).length;
  return { kicks: kicks.length, matched };
}

const browser = await playwright.chromium.launch();
let failed = false;
try {
  for (const [label, query] of [['worker', ''], ['main thread', '?worker=0']]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); });
    // Web fonts are cosmetic; keep the test offline.
    await page.route((url) => !url.href.startsWith(base), (route) => route.abort());
    await page.goto(base + query);

    // The example analyses on load.
    await page.waitForSelector('body[data-state="done"]', { timeout: 60000 });
    const exampleEvents = Number(await page.textContent('#s-events'));
    assert.ok(exampleEvents >= 3, `example should show several tempo events, got ${exampleEvents}`);

    await page.setInputFiles('#file', wavPath);
    await page.waitForFunction(() => document.querySelector('#source-name').textContent.includes('step-110-150'));
    await page.waitForSelector('body[data-state="done"]', { timeout: 60000 });
    const rows = await page.$$eval('#rows tr', (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent)));
    const bpms = rows.filter((r) => !r[0].includes('lead-in')).map((r) => Number(r[2]));
    assert.equal(bpms.length, 2, `expected 2 tempos, got ${JSON.stringify(rows)}`);
    assert.ok(Math.abs(bpms[0] - 110) < 1 && Math.abs(bpms[1] - 150) < 1, `tempos ${bpms}`);

    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#download')]);
    assert.equal(dl.suggestedFilename(), 'step-110-150.tempo.mid');
    const midi = parseMidi(new Uint8Array(await fs.readFile(await dl.path())));
    const tempos = midi.tracks[0].filter((e) => e.meta === 0x51);
    assert.equal(tempos.length, rows.length);
    const grid = beatTimesFromMidi(midi, 60);
    const firstFast = truth.find((t) => t >= 20);
    const nearest = grid.reduce((a, b) => (Math.abs(b - firstFast) < Math.abs(a - firstFast) ? b : a));
    assert.ok(Math.abs(nearest - firstFast) < 0.03, `grid misses the tempo change: ${nearest} vs ${firstFast}`);

    // Doubling re-tracks at twice the tempo.
    await page.click('#double');
    await page.waitForFunction(() => document.body.dataset.state === 'done' && document.querySelector('#scale-label').textContent === '×2');
    const doubled = await page.$$eval('#rows tr:not(.lead) td:nth-child(3)', (tds) => tds.map((td) => Number(td.textContent)));
    assert.ok(Math.abs(doubled[0] - 220) < 2, `doubled first tempo ${doubled[0]}`);

    // Songsterr: load the tab, let it align, download the song folder.
    await page.click('#halve');
    await page.waitForFunction(() => document.body.dataset.state === 'done' && document.querySelector('#scale-label').textContent === '×1');
    await page.click('label:has(#mode-songsterr)');
    await page.setInputFiles('#part-file', tabPath);
    await page.waitForFunction(() => /notes:/.test(document.querySelector('#drum-stats').textContent));
    const source = await page.textContent('#tempo-source');
    assert.match(source, /detected from the recording .*The tab's tempo \(96–120 BPM\) is ignored/);
    const tab = await downloadChart(page);
    assert.ok(tab.matched >= 0.97 * trueKicks.length && tab.kicks <= trueKicks.length, `tab kicks ${tab.matched}/${tab.kicks} of ${trueKicks.length}`);

    // Detect from the audio itself.
    await page.click('label:has(#mode-detect)');
    await page.click('#detect-run');
    await page.waitForFunction(() => document.body.dataset.state === 'done' && /notes:/.test(document.querySelector('#drum-stats').textContent), null, { timeout: 120000 });
    const det = await downloadChart(page);
    assert.ok(det.matched >= 0.85 * trueKicks.length, `detected kicks ${det.matched}/${det.kicks} of ${trueKicks.length}`);

    assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`);
    if (shotDir) {
      await page.click('label:has(#mode-songsterr)');
      await page.screenshot({ path: path.join(shotDir, `e2e-${label.replace(' ', '-')}.png`), fullPage: true });
    }
    console.log(`ok - ${label}: ${rows.length} events, tempos ${bpms.join(' → ')}; tab kicks ${tab.matched}/${trueKicks.length}, detected kicks ${det.matched}/${det.kicks}`);
    await page.close();
  }
} catch (err) {
  failed = true;
  console.error(err);
} finally {
  await browser.close();
  server.close();
  await fs.rm(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
