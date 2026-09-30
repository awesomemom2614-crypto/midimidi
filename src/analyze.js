// The analysis pipeline shared by the worker, the main-thread fallback and the
// tests: onset envelope -> local tempo curve -> beats. The envelope is kept so
// changing the BPM range or doubling/halving only re-runs the cheap stages.
import { onsetStrength } from './dsp/onset.js';
import { estimateTempoCurve } from './dsp/tempo.js';
import { trackBeats } from './dsp/beats.js';
import { melSpectrogram, separateDrums } from './drums/transcribe.js';

export const DEFAULT_TRACKING = { minBpm: 60, maxBpm: 200, tempoScale: 1 };

export class Analyzer {
  load(samples, sr) {
    this.samples = samples;
    this.sr = sr;
    const { env, envLow, fps } = onsetStrength(samples, sr);
    this.env = env;
    this.envLow = envLow;
    this.fps = fps;
    this.duration = samples.length / sr;
  }

  track({ minBpm = DEFAULT_TRACKING.minBpm, maxBpm = DEFAULT_TRACKING.maxBpm, tempoScale = 1 } = {}) {
    if (!this.env) throw new Error('No audio loaded');
    const curve = estimateTempoCurve(this.env, this.fps, { minBpm, maxBpm });
    const period = curve.period;
    if (tempoScale !== 1) for (let i = 0; i < period.length; i++) period[i] /= tempoScale;
    const beats = trackBeats(this.env, this.fps, period);
    return {
      beats,
      curve: { times: curve.times, bpm: curve.bpm.map((b) => b * tempoScale) },
      duration: this.duration,
      onset: { env: this.env, envLow: this.envLow, fps: this.fps },
    };
  }

  // Drum activations for the loaded audio, or for a separate drum stem.
  transcribe(stem = null, sr = this.sr) {
    const samples = stem ?? this.samples;
    if (!samples) throw new Error('No audio loaded');
    const spec = melSpectrogram(samples, sr);
    return { acts: separateDrums(spec, { fullMix: !stem }), fps: spec.fps };
  }
}

export function analyzeSamples(samples, sr, tracking = DEFAULT_TRACKING) {
  const a = new Analyzer();
  a.load(samples, sr);
  return a.track(tracking);
}
