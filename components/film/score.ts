// Original synthwave score for the Phone Blades trailer (120 BPM, A minor, Am F C G).
// Synthesised and rendered offline, so the preview and the final video use the exact same audio.

export const BPM = 120;
export const BAR = 2; // seconds
export const BARS = 30;
export const LENGTH = BARS * BAR; // 60 s

export type Cue = { t: number; kind: 'cut' | 'lock' };

const ROOT = [57, 53, 60, 55]; // A3 F3 C4 G3
const CHORD = [[0, 3, 7], [0, 4, 7], [0, 4, 7], [0, 4, 7]];
// The drop hook: [beat, midi, length in beats] per chord bar.
const MELODY: [number, number, number][][] = [
  [[0, 69, 1], [1, 72, 0.5], [1.5, 76, 0.5], [2, 74, 1], [3, 72, 1]],
  [[0, 72, 0.5], [0.5, 69, 0.5], [1, 65, 1], [2, 69, 1], [3, 72, 1]],
  [[0, 76, 1], [1, 79, 0.5], [1.5, 76, 0.5], [2, 74, 1], [3, 72, 1]],
  [[0, 71, 1], [1, 74, 1], [2, 67, 2]],
];
const hz = (m: number) => 440 * 2 ** ((m - 69) / 12);
const B = 60 / BPM;

export class Studio {
  private out: GainNode;
  private verb: ConvolverNode;
  private delay: DelayNode;
  private duck: GainNode; // sidechain pump for pad, bass and arp
  private noise: AudioBuffer;

  constructor(private ctx: BaseAudioContext) {
    const c = ctx;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -16; comp.ratio.value = 3; comp.attack.value = 0.005; comp.release.value = 0.2;
    const limit = c.createDynamicsCompressor();
    limit.threshold.value = -2; limit.ratio.value = 20; limit.attack.value = 0.001; limit.release.value = 0.08;
    this.out = c.createGain(); this.out.gain.value = 0.7;
    this.out.connect(comp).connect(limit).connect(c.destination);

    this.verb = c.createConvolver(); this.verb.buffer = this.impulse(2.8);
    const vg = c.createGain(); vg.gain.value = 0.35; this.verb.connect(vg).connect(this.out);

    this.delay = c.createDelay(1); this.delay.delayTime.value = 0.375; // dotted eighth
    const fb = c.createGain(); fb.gain.value = 0.38;
    const lp = c.createBiquadFilter(); lp.frequency.value = 2800;
    this.delay.connect(lp).connect(fb).connect(this.delay);
    const dg = c.createGain(); dg.gain.value = 0.3; lp.connect(dg).connect(this.out);

    this.duck = c.createGain(); this.duck.connect(this.out);
    this.noise = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  private impulse(sec: number) {
    const len = Math.floor(this.ctx.sampleRate * sec), buf = this.ctx.createBuffer(2, len, this.ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = buf.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3; }
    return buf;
  }

  /** Envelope gain routed to `dest`, plus optional reverb and delay sends. */
  private env(t: number, vol: number, attack: number, hold: number, release: number, dest: AudioNode, verb = 0, delay = 0) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.setValueAtTime(vol, t + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
    g.connect(dest);
    if (verb) { const s = this.ctx.createGain(); s.gain.value = verb; g.connect(s).connect(this.verb); }
    if (delay) { const s = this.ctx.createGain(); s.gain.value = delay; g.connect(s).connect(this.delay); }
    return g;
  }

  private osc(type: OscillatorType, f: number, t: number, end: number, dest: AudioNode, detune = 0) {
    const o = this.ctx.createOscillator();
    o.type = type; o.frequency.value = f; o.detune.value = detune;
    o.connect(dest); o.start(t); o.stop(end);
    return o;
  }

  private noiseSrc(t: number, end: number, dest: AudioNode) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise; s.loop = true;
    s.connect(dest); s.start(t, Math.random()); s.stop(end);
  }

  private filter(type: BiquadFilterType, f: number, q = 0.7, dest: AudioNode) {
    const flt = this.ctx.createBiquadFilter();
    flt.type = type; flt.frequency.value = f; flt.Q.value = q; flt.connect(dest);
    return flt;
  }

  kick(t: number, vol = 1) {
    const g = this.env(t, vol, 0.002, 0.04, 0.32, this.out);
    const o = this.osc('sine', 150, t, t + 0.45, g);
    o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    this.noiseSrc(t, t + 0.02, this.filter('highpass', 4000, 0.7, this.env(t, vol * 0.25, 0.001, 0.005, 0.01, this.out)));
    this.duck.gain.setValueAtTime(0.4, t); this.duck.gain.linearRampToValueAtTime(1, t + 0.28);
  }

  snare(t: number, vol = 0.55, verb = 0.5) {
    this.noiseSrc(t, t + 0.3, this.filter('bandpass', 1800, 0.8, this.env(t, vol, 0.002, 0.02, 0.22, this.out, verb)));
    this.osc('triangle', 190, t, t + 0.2, this.env(t, vol * 0.5, 0.002, 0.01, 0.12, this.out));
  }

  hat(t: number, vol = 0.12, open = false) {
    this.noiseSrc(t, t + (open ? 0.25 : 0.06), this.filter('highpass', 8000, 0.7, this.env(t, vol, 0.001, 0.005, open ? 0.18 : 0.04, this.out)));
  }

  bass(t: number, midi: number, dur: number, vol = 0.32) {
    const lp = this.filter('lowpass', 900, 1.2, this.env(t, vol, 0.005, dur * 0.5, dur * 0.5, this.duck));
    this.osc('sawtooth', hz(midi), t, t + dur + 0.1, lp);
    this.osc('square', hz(midi - 12), t, t + dur + 0.1, lp);
  }

  pad(t: number, notes: number[], dur: number, cutoff: number, vol: number, sweepTo?: number) {
    const lp = this.filter('lowpass', cutoff, 0.5, this.env(t, vol, 0.45, dur, 1.4, this.duck, 0.6));
    if (sweepTo) lp.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    for (const n of notes) for (const d of [-11, 0, 11]) this.osc('sawtooth', hz(n), t, t + dur + 1.6, lp, d);
  }

  arp(t: number, midi: number, cutoff: number, vol: number) {
    this.osc('square', hz(midi), t, t + 0.2, this.filter('lowpass', cutoff, 2, this.env(t, vol, 0.003, 0.04, 0.09, this.duck, 0.15, 0.55)));
  }

  lead(t: number, midi: number, dur: number, vol = 0.13) {
    const lp = this.filter('lowpass', 3200, 1, this.env(t, vol, 0.012, dur * 0.85, 0.28, this.out, 0.25, 0.35));
    const lfo = this.ctx.createOscillator(), depth = this.ctx.createGain();
    lfo.frequency.value = 5.5; depth.gain.value = 6; lfo.connect(depth); lfo.start(t + 0.15); lfo.stop(t + dur + 0.4);
    for (const d of [-7, 7]) depth.connect(this.osc('sawtooth', hz(midi), t, t + dur + 0.4, lp, d).detune);
    this.osc('sine', hz(midi - 12), t, t + dur + 0.4, lp);
  }

  bell(t: number, midi: number, vol = 0.12) {
    const g = this.env(t, vol, 0.002, 0.02, 1.8, this.out, 0.7, 0.3);
    this.osc('sine', hz(midi), t, t + 2, g);
    this.osc('sine', hz(midi) * 2.76, t, t + 1, this.env(t, vol * 0.3, 0.002, 0.01, 0.6, this.out, 0.5));
  }

  impact(t: number) {
    const o = this.osc('sine', 60, t, t + 2, this.env(t, 0.9, 0.003, 0.15, 1.6, this.out, 0.5));
    o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(30, t + 1.2);
    this.noiseSrc(t, t + 1.4, this.filter('lowpass', 500, 0.7, this.env(t, 0.5, 0.002, 0.05, 1.2, this.out, 0.8)));
  }

  riser(t0: number, t1: number, vol = 0.3) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(vol, t1 - 0.02); g.gain.linearRampToValueAtTime(0, t1);
    g.connect(this.out);
    const s = this.ctx.createGain(); s.gain.value = 0.5; g.connect(s).connect(this.verb);
    const bp = this.filter('bandpass', 300, 1.5, g);
    bp.frequency.setValueAtTime(300, t0); bp.frequency.exponentialRampToValueAtTime(9000, t1);
    this.noiseSrc(t0, t1, bp);
  }

  swish(t: number) {
    const bp = this.filter('bandpass', 1500, 1.2, this.env(t, 0.22, 0.004, 0.03, 0.09, this.out, 0.15));
    bp.frequency.setValueAtTime(1500, t); bp.frequency.exponentialRampToValueAtTime(7000, t + 0.12);
    this.noiseSrc(t, t + 0.16, bp);
  }

  cue(c: Cue) {
    if (c.kind === 'cut') this.swish(c.t);
    else { this.bell(c.t, 88, 0.16); this.bell(c.t + 0.06, 93, 0.1); }
  }

  /** The whole song. Sections follow the trailer's scenes. */
  compose() {
    for (let b = 0; b < BARS; b++) {
      const t = b * BAR, ch = b % 4, root = ROOT[ch], tones = CHORD[ch].map((x) => root + x);
      const beats = [0, 1, 2, 3].map((i) => t + i * B);

      // Pad runs through everything, opening up in the intro and drop.
      if (b <= 2) this.pad(t, [...tones, root - 12], BAR, 300 + b * 500, 0.05, 800 + b * 600);
      else if (b < 11) this.pad(t, [...tones, root - 12], BAR, 1600, 0.055);
      else if (b < 15) this.pad(t, [...tones, root + 12], BAR, 1200, 0.06);
      else if (b === 15) this.pad(t, [...tones, root + 12], BAR, 1200, 0.06, 4500);
      else if (b < 26) this.pad(t, [...tones, root - 12], BAR, 2200, 0.05);
      else if (b < 28) this.pad(t, [...tones, root + 12], BAR, 1500, 0.06);
      else if (b === 28) this.pad(t, [57, 60, 64, 69, 45], BAR * 2, 1400, 0.07, 500);

      if (b <= 2) this.osc('sine', hz(33), t, t + BAR, this.env(t, 0.18, 0.5, BAR - 0.6, 0.3, this.out)); // sub drone
      if (b >= 3 && b < 6) { this.kick(t, 0.55); for (let i = 0; i < 8; i++) this.arp(t + i * B / 2, tones[i % 3] + 12, 900 + (b - 3) * 350, 0.05); }

      if (b >= 6 && b < 11) {
        for (const bt of beats) this.kick(bt);
        for (const bt of beats) this.hat(bt + B / 2, 0.12);
        for (let i = 0; i < 8; i++) this.bass(t + i * B / 2, root - 24, B / 2 * 0.8);
        for (let i = 0; i < 16; i++) this.arp(t + i * B / 4, [tones[0], tones[1], tones[2], tones[0] + 12][i % 4] + 12, 1800, 0.045);
        if (b >= 8) { this.snare(beats[1]); this.snare(beats[3]); }
      }
      if (b >= 11 && b < 15) { // calibration breakdown
        this.osc('sine', hz(root - 24), t, t + B * 2, this.env(t, 0.14, 0.01, 0.3, 0.6, this.out));
        for (let i = 0; i < 8; i += 2) this.arp(t + i * B / 2, tones[(i / 2) % 3] + 12, 1400, 0.05);
      }
      if (b === 15) { // build into the drop
        this.kick(beats[0], 0.8); this.kick(beats[1], 0.8);
        for (let i = 0; i < 4; i++) this.snare(t + i * B / 2, 0.18 + i * 0.05, 0.3);
        for (let i = 0; i < 8; i++) this.snare(t + 2 * B + i * B / 4, 0.38 + i * 0.05, 0.3);
        this.riser(t - BAR, t + BAR, 0.32);
      }
      if (b >= 16 && b < 26) { // the drop
        for (const bt of beats) this.kick(bt);
        this.snare(beats[1], 0.6, 0.45); this.snare(beats[3], 0.6, 0.45);
        for (let i = 0; i < 16; i++) this.hat(t + i * B / 4, i % 2 ? 0.13 : 0.07, i % 8 === 6);
        for (let i = 0; i < 8; i++) this.bass(t + i * B / 2, root - 24 + (i % 2 ? 12 : 0), B / 2 * 0.8, 0.3);
        for (let i = 0; i < 16; i++) this.arp(t + i * B / 4, [tones[0], tones[2], tones[1] + 12, tones[2] + 12][i % 4] + 12, 2600, 0.04);
        const m = b < 24 ? MELODY[ch] : MELODY[(ch + 2) % 4];
        for (const [bt, n, len] of m) this.lead(t + bt * B, n, len * B * 0.95, b >= 20 ? 0.15 : 0.13);
      }
      if (b >= 26 && b < 28) { // results: half time
        this.kick(beats[0], 0.8); this.kick(beats[2], 0.8);
        for (const bt of beats) this.hat(bt + B / 2, 0.08);
        for (const [bt, n, len] of MELODY[ch]) this.lead(t + bt * B, n, len * B * 0.95, 0.07);
      }
    }
    this.riser(0, 2, 0.25);
    this.impact(2); for (let i = 0; i < 4; i++) this.bell(2 + i * 0.25, [81, 84, 88, 93][i], 0.09); // ignition
    this.impact(32); // drop
    this.riser(54, 56, 0.2);
    this.impact(56); for (let i = 0; i < 5; i++) this.bell(56 + i * 0.3, [69, 72, 76, 81, 84][i], 0.1); // end card
  }
}

/** Render the score plus cues (blade cuts, calibration locks) to one buffer. */
export async function renderScore(cues: Cue[], sampleRate = 48000) {
  const ctx = new OfflineAudioContext(2, Math.ceil(LENGTH * sampleRate), sampleRate);
  const s = new Studio(ctx);
  s.compose();
  for (const c of cues) if (c.t < LENGTH) s.cue(c);
  return ctx.startRendering();
}

/** 16 bit PCM WAV. */
export function toWav(buf: AudioBuffer) {
  const ch = buf.numberOfChannels, len = buf.length, out = new DataView(new ArrayBuffer(44 + len * ch * 2));
  const w = (o: number, s: string) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); out.setUint32(4, 36 + len * ch * 2, true); w(8, 'WAVEfmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true);
  out.setUint32(24, buf.sampleRate, true); out.setUint32(28, buf.sampleRate * ch * 2, true);
  out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true); w(36, 'data'); out.setUint32(40, len * ch * 2, true);
  const data = [...Array(ch)].map((_, i) => buf.getChannelData(i));
  for (let i = 0, o = 44; i < len; i++) for (let c = 0; c < ch; c++, o += 2) out.setInt16(o, Math.max(-1, Math.min(1, data[c][i])) * 32767, true);
  return out.buffer;
}
