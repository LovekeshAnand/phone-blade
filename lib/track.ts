import { BARS, energyAt, type Difficulty } from './beatmap';

/** What the engine plays: beat times (s from song start) with a loudness-based energy per beat. */
export interface Track { title: string; bpm: number; beats: number[]; energy: number[]; duration: number; buffer: AudioBuffer | null }

export function synthTrack(bpm: number): Track {
  const B = 60 / bpm, n = BARS * 4;
  return {
    title: 'Neon Run (built-in)', bpm, duration: n * B, buffer: null,
    beats: Array.from({ length: n }, (_, i) => i * B),
    energy: Array.from({ length: n }, (_, i) => energyAt(Math.floor(i / 4))),
  };
}

const HOP = 512;
const LEAD_IN = 2.5; // seconds of song before the first block, so blocks have time to fly in

/**
 * Beat-track mono samples: onset envelope → tempo by autocorrelation → best phase → walk the grid,
 * nudging each beat toward the nearest strong onset. Quiet passages get low energy = fewer blocks.
 * ponytail: one global tempo + local snapping. Songs with big tempo changes (live recordings, medleys) will drift.
 */
export function analyze(samples: Float32Array, sr: number): { bpm: number; beats: number[]; energy: number[] } {
  const frames = Math.floor(samples.length / HOP), fps = sr / HOP;
  const raw = new Float32Array(frames), rms = new Float32Array(frames);
  const a = Math.exp((-2 * Math.PI * 150) / sr); // one-pole low-pass ~150 Hz: dhol, kick and bass carry the beat
  let lp = 0, prevLow = 0, prevAll = 0;
  for (let f = 0; f < frames; f++) {
    let low = 0, all = 0;
    for (let i = f * HOP, end = i + HOP; i < end; i++) { const x = samples[i]; lp = a * lp + (1 - a) * x; low += lp * lp; all += x * x; }
    const lowL = Math.log1p((1000 * low) / HOP), allL = Math.log1p((1000 * all) / HOP);
    raw[f] = 1.5 * Math.max(0, lowL - prevLow) + Math.max(0, allL - prevAll);
    prevLow = lowL; prevAll = allL;
    rms[f] = Math.sqrt(all / HOP);
  }

  // Remove the local average so sustained loud parts don't look like constant onsets.
  const env = new Float32Array(frames), w = Math.round(fps * 0.25), sum = new Float64Array(frames + 1);
  for (let f = 0; f < frames; f++) sum[f + 1] = sum[f] + raw[f];
  let mean = 0;
  for (let f = 0; f < frames; f++) {
    const lo = Math.max(0, f - w), hi = Math.min(frames, f + w + 1);
    env[f] = Math.max(0, raw[f] - (sum[hi] - sum[lo]) / (hi - lo));
    mean += env[f] / frames;
  }

  // Tempo: autocorrelation over 70–160 BPM with a soft preference around 110 (avoids half/double-time picks).
  const minLag = Math.floor((fps * 60) / 160), maxLag = Math.ceil((fps * 60) / 70);
  const ac = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) { let s = 0; for (let f = lag; f < frames; f++) s += env[f] * env[f - lag]; ac[lag] = s; }
  let lag = minLag, best = -Infinity;
  for (let l = minLag; l <= maxLag; l++) {
    const score = ac[l] * Math.exp(-0.5 * (Math.log2((60 * fps) / l / 110) / 0.6) ** 2);
    if (score > best) { best = score; lag = l; }
  }
  // Fine search around that peak: the (period, phase) grid that lands on the most onset strength wins.
  // A slightly wrong period drifts off the beat over a whole song, so this matters more than it looks.
  const comb = (P: number, p: number) => { let s = 0; for (let t = p; t < frames; t += P) s += env[Math.round(t)] ?? 0; return s; };
  let period = lag, phase = 0; best = -Infinity;
  for (let P = lag - 1; P <= lag + 1; P += 0.02)
    for (let p = 0; p < P; p++) { const s = comb(P, p); if (s > best) { best = s; period = P; phase = p; } }

  // Double-time check: if every other beat is much weaker, those are off-beats, so halve the tempo.
  if ((60 * fps) / period > 140) {
    const even = comb(2 * period, phase), odd = comb(2 * period, phase + period);
    if (Math.min(even, odd) < 0.7 * Math.max(even, odd)) { if (odd > even) phase += period; period *= 2; }
  }

  // Walk the grid, pulling each beat halfway toward a strong nearby onset to follow small drifts.
  const beatFrames: number[] = [], win = Math.max(1, Math.round(period * 0.08));
  for (let t = phase; t < frames; ) {
    let bi = Math.round(t), bv = 0;
    for (let k = -win; k <= win; k++) { const i = Math.round(t) + k; if (env[i] > bv) { bv = env[i]; bi = i; } }
    const snapped = bv > 2 * mean ? (t + bi) / 2 : t;
    beatFrames.push(snapped);
    t = snapped + period;
  }
  if (beatFrames.length < 16) throw new Error("Couldn't find a steady beat in this song.");

  // Loudness per beat, relative to the song's loud parts.
  const loud = beatFrames.map((f, i) => {
    const lo = Math.round(f), hi = Math.max(lo + 1, Math.min(frames, Math.round(beatFrames[i + 1] ?? f + period)));
    let s = 0; for (let k = lo; k < hi; k++) s += rms[k];
    return s / (hi - lo);
  });
  const p90 = [...loud].sort((x, y) => x - y)[Math.floor(loud.length * 0.9)] || 1;
  const beats = beatFrames.map((f) => f / fps);
  const energy = loud.map((l, i) => {
    const e = l / p90;
    return beats[i] < LEAD_IN || e < 0.3 ? 0 : Math.min(1.2, 0.3 + e * 0.8);
  });
  return { bpm: (60 * fps) / period, beats, energy };
}

/** Beat analysis without the audio: small enough to cache per song. */
export type SongInfo = Omit<Track, 'title' | 'buffer'>;

const decode = (data: ArrayBuffer) => new OfflineAudioContext(1, 1, 44100).decodeAudioData(data);

function scanBuffer(buffer: AudioBuffer): SongInfo {
  const mono = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) mono[i] += d[i] / buffer.numberOfChannels;
  }
  return { ...analyze(mono, buffer.sampleRate), duration: buffer.duration };
}

/** Decode + beat-track, then drop the audio (used for the lobby's background scan). */
export async function scanSong(data: ArrayBuffer): Promise<SongInfo> { return scanBuffer(await decode(data)); }

/** Decode a song for playing; reuses a cached scan when there is one. */
export async function loadSong(data: ArrayBuffer, title: string, info?: SongInfo): Promise<Track> {
  const buffer = await decode(data);
  return { title, ...(info ?? scanBuffer(buffer)), buffer };
}

/** Faster songs → harder. Energy is relative to each song's own peaks, so it can't rank songs against each other.
 * ponytail: tempo-only thresholds; tune after playing real songs (romantic ballads ~70–95 BPM, dance tracks ~100–130). */
export function suggestDifficulty({ bpm }: Pick<SongInfo, 'bpm'>): Difficulty {
  return bpm < 90 ? 'easy' : bpm < 118 ? 'normal' : 'hard';
}
