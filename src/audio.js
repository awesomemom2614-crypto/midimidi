// Decoding (browser codecs via Web Audio) and playback with a click on every
// beat of the tempo map, so the map can be checked by ear.
import { ANALYSIS_SR } from './dsp/onset.js';

export async function decodeFile(file) {
  const data = await file.arrayBuffer();
  let buffer;
  try {
    buffer = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(data);
  } catch {
    throw new Error(`Couldn't decode “${file.name}”. Try WAV, FLAC, OGG or MP3.`);
  }
  return { buffer, samples: await toAnalysisRate(buffer) };
}

// Mono mixdown resampled to the analysis rate.
async function toAnalysisRate(buffer) {
  const length = Math.max(1, Math.ceil(buffer.duration * ANALYSIS_SR));
  const ctx = new OfflineAudioContext(1, length, ANALYSIS_SR);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start();
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0).slice();
}

export function bufferFromSamples(samples, sampleRate) {
  const buffer = new AudioBuffer({ length: samples.length, sampleRate, numberOfChannels: 1 });
  buffer.copyToChannel(samples, 0);
  return buffer;
}

export class Player {
  constructor() {
    this.ctx = null;
    this.buffer = null;
    this.clicks = [];
    this.beatsPerBar = 4;
    this.clickOn = true;
    this.offset = 0;
    this.playing = false;
    this.onEnd = null;
  }

  setBuffer(buffer) {
    this.stop();
    this.buffer = buffer;
    this.offset = 0;
  }

  setClicks(times, beatsPerBar) {
    this.clicks = times;
    this.beatsPerBar = beatsPerBar;
    if (this.playing) this.nextClick = this.clickIndexAt(this.position());
  }

  get duration() {
    return this.buffer ? this.buffer.duration : 0;
  }

  position() {
    if (!this.playing) return this.offset;
    return Math.min(this.duration, this.offset + this.ctx.currentTime - this.startedAt);
  }

  async play() {
    if (!this.buffer || this.playing) return;
    this.ctx ??= new AudioContext();
    await this.ctx.resume();
    if (this.offset >= this.duration - 0.05) this.offset = 0;
    this.source = this.ctx.createBufferSource();
    this.source.buffer = this.buffer;
    this.source.connect(this.ctx.destination);
    this.startedAt = this.ctx.currentTime + 0.05;
    this.source.start(this.startedAt, this.offset);
    this.source.onended = () => {
      if (!this.playing) return;
      this.playing = false;
      this.offset = 0;
      clearInterval(this.timer);
      this.onEnd?.();
    };
    this.playing = true;
    this.nextClick = this.clickIndexAt(this.offset);
    this.timer = setInterval(() => this.schedule(), 25);
    this.schedule();
  }

  pause() {
    if (!this.playing) return;
    this.offset = this.position();
    this.stop();
  }

  stop() {
    if (!this.playing) return;
    this.playing = false;
    clearInterval(this.timer);
    try { this.source.stop(); } catch { /* already stopped */ }
  }

  seek(t) {
    const was = this.playing;
    this.stop();
    this.offset = Math.max(0, Math.min(this.duration, t));
    if (was) this.play();
  }

  clickIndexAt(t) {
    let i = 0;
    while (i < this.clicks.length && this.clicks[i] < t - 0.001) i++;
    return i;
  }

  // Look-ahead scheduler: queue clicks that fall in the next 150 ms.
  schedule() {
    const now = this.position();
    while (this.nextClick < this.clicks.length && this.clicks[this.nextClick] < now + 0.15) {
      const t = this.clicks[this.nextClick];
      if (this.clickOn && t >= now - 0.01) this.blip(this.startedAt + (t - this.offset), this.nextClick % this.beatsPerBar === 0);
      this.nextClick++;
    }
  }

  blip(when, accent) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.frequency.value = accent ? 1760 : 1320;
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(accent ? 0.5 : 0.3, when + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(when);
    osc.stop(when + 0.06);
  }
}
