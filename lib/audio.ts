// Procedural soundtrack (Am–F–C–G) built from oscillators: no audio files, no licensing.
const ROOTS = [0, -4, 3, -2];
const CHORDS = [[0, 3, 7, 12], [0, 4, 7, 12], [0, 4, 7, 12], [0, 4, 7, 12]];
const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

export class Music {
  readonly ctx = new AudioContext();
  private out: GainNode;
  private noise: AudioBuffer;

  constructor() {
    const comp = this.ctx.createDynamicsCompressor();
    comp.connect(this.ctx.destination);
    this.out = this.ctx.createGain();
    this.out.gain.value = 0.5;
    this.out.connect(comp);
    this.noise = this.ctx.createBuffer(1, this.ctx.sampleRate, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  get now() { return this.ctx.currentTime; }

  private env(t: number, vol: number, dur: number) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.connect(this.out);
    return g;
  }

  private tone(type: OscillatorType, freq: number, t: number, dur: number, vol: number, cutoff: number) {
    const o = this.ctx.createOscillator(), f = this.ctx.createBiquadFilter();
    o.type = type; o.frequency.value = freq;
    f.type = 'lowpass'; f.frequency.value = cutoff;
    o.connect(f).connect(this.env(t, vol, dur));
    o.start(t); o.stop(t + dur);
  }

  private hit(t: number, dur: number, freq: number, vol: number, type: BiquadFilterType = 'highpass') {
    const s = this.ctx.createBufferSource(), f = this.ctx.createBiquadFilter();
    s.buffer = this.noise; f.type = type; f.frequency.value = freq;
    s.connect(f).connect(this.env(t, vol, dur));
    s.start(t, Math.random() * 0.5); s.stop(t + dur);
  }

  private kick(t: number) {
    const o = this.ctx.createOscillator();
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    o.connect(this.env(t, 1, 0.32));
    o.start(t); o.stop(t + 0.32);
  }

  /** Schedule one beat of music at audio time t. */
  beat(t: number, beat: number, B: number, energy: number) {
    const bar = Math.floor(beat / 4), b = beat % 4, root = ROOTS[bar % 4], chord = CHORDS[bar % 4];
    if (energy === 0) { this.hit(t, 0.03, 3000, b === 0 ? 0.6 : 0.35, 'bandpass'); return; } // count-in sticks
    if (energy >= 0.5) this.kick(t);
    this.hit(t + B / 2, 0.04, 8000, 0.14);
    if (energy >= 1) { this.hit(t + B / 4, 0.02, 9000, 0.05); this.hit(t + (3 * B) / 4, 0.02, 9000, 0.05); }
    if (energy >= 0.7 && b % 2 === 1) { this.hit(t, 0.16, 1800, 0.4, 'bandpass'); this.tone('triangle', 190, t, 0.08, 0.2, 2000); }
    this.tone('sawtooth', hz(33 + root), t + B / 2, B * 0.45, 0.22, 600); // offbeat pumping bass
    if (energy >= 1) for (let k = 0; k < 4; k++) this.tone('square', hz(57 + root + chord[(b + k) % 4]), t + (k * B) / 4, B * 0.2, 0.045, 2600);
    if (energy < 0.7 && b === 0) for (const n of chord.slice(0, 3)) this.tone('triangle', hz(57 + root + n), t, B * 4, 0.06, 1200); // breakdown pad
  }

  /** Play a decoded song file at audio time `at` (straight to the speakers, not through the synth compressor). */
  play(buffer: AudioBuffer, at: number) {
    const s = this.ctx.createBufferSource();
    s.buffer = buffer;
    s.connect(this.ctx.destination);
    s.start(at);
  }

  sfx(kind: 'cut' | 'bad' | 'bomb') {
    const t = this.now;
    if (kind === 'cut') this.hit(t, 0.09, 2500, 0.35);
    else if (kind === 'bad') this.tone('sawtooth', 90, t, 0.18, 0.25, 400);
    else { this.hit(t, 0.5, 200, 0.8, 'lowpass'); this.tone('sine', 50, t, 0.4, 0.6, 200); }
  }

  pause() { this.ctx.suspend().catch(() => {}); }
  resume() { this.ctx.resume().catch(() => {}); }
  close() { this.ctx.close().catch(() => {}); }
}
