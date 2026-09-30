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
import { stepBeats, renderDrums, encodeWav } from './synth.js';
import { parseMidi, beatTimesFromMidi } from './midi-parse.js';

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
const wavPath = path.join(tmp, 'step-110-150.wav');
await fs.writeFile(wavPath, encodeWav(renderDrums(truth, 40, { sr: 44100 }), 44100));

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

    assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`);
    if (shotDir) {
      await page.click('#halve');
      await page.waitForFunction(() => document.body.dataset.state === 'done' && document.querySelector('#scale-label').textContent === '×1');
      await page.screenshot({ path: path.join(shotDir, `e2e-${label.replace(' ', '-')}.png`), fullPage: true });
    }
    console.log(`ok - ${label}: ${rows.length} events, tempos ${bpms.join(' → ')}`);
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
