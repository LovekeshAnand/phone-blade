'use client';

import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import QRCode from 'qrcode';
import * as THREE from 'three';
import { ArrowRightIcon, CheckCircleIcon, CrosshairIcon } from '@phosphor-icons/react';
import { Engine, type CalibStep, type Results, type SongClock, type Stats } from '@/lib/engine';
import { HAND_COLOR, HAND_NAME, type Hand } from '@/lib/protocol';
import type { Track } from '@/lib/track';
import { LENGTH, renderScore, Studio, toWav, type Cue } from './score';

// The launch trailer, played by the real game engine. ?render switches to frame by frame mode for the encoder.
const FPS = 30, W = 1920, H = 1080, FRAMES = LENGTH * FPS;
const RENDER = typeof window !== 'undefined' && new URLSearchParams(location.search).has('render');

let virtualMs = 0;
const rafQueue = new Map<number, FrameRequestCallback>();
if (RENDER) { // time only moves when the encoder asks for the next frame
  let id = 0;
  performance.now = () => virtualMs;
  window.requestAnimationFrame = (cb) => { rafQueue.set(++id, cb); return id; };
  window.cancelAnimationFrame = (i) => { rafQueue.delete(i); };
}
const stepFrames = () => { const cbs = [...rafQueue.values()]; rafQueue.clear(); for (const cb of cbs) cb(virtualMs); };

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const ease = (x: number) => 1 - (1 - clamp01(x)) ** 3;
const inOut = (x: number) => { x = clamp01(x); return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2; };
const fade = (t: number, a: number, b: number, f = 0.5) => clamp01((t - a) / f) * clamp01((b - t) / f);
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const DEG = 180 / Math.PI;

const SONG_AT = 32; // the drop: gameplay starts on this beat
const TRACK: Track = {
  title: 'Neon Run', bpm: 120, duration: 20, buffer: null,
  beats: Array.from({ length: 40 }, (_, i) => i * 0.5),
  energy: Array.from({ length: 40 }, (_, i) => (i < 6 ? 0 : i >= 37 ? 0.6 : 1.1)),
};
// Calibration choreography per blade: [step 1 starts, aimed, step 1 locks, step 2 locks]
const CAL: Record<Hand, { start: number; aimed: number; lock1: number; lock2: number; off: [number, number] }> = {
  R: { start: 22.2, aimed: 25.0, lock1: 25.8, lock2: 28.4, off: [-38, 8] },
  L: { start: 22.8, aimed: 25.6, lock1: 26.4, lock2: 29.0, off: [30, -10] },
};
const HOLD = 0.8;
const LOCKS: Cue[] = (['R', 'L'] as Hand[]).flatMap((h) => [{ t: CAL[h].lock1, kind: 'lock' as const }, { t: CAL[h].lock2, kind: 'lock' as const }]);

// Camera keyframes [time, position, look target]; gameplay uses its own drift.
const CAM: [number, [number, number, number], [number, number, number]][] = [
  [0, [0, 1.9, 6.5], [0, 1.5, -6]],
  [5.5, [0, 1.55, 1.25], [0, 1.2, -5]],
  [9, [0.45, 1.45, 1.15], [0, 1.25, -4]],
  [12, [-0.35, 1.5, 1.3], [0, 1.2, -4.5]],
  [21.6, [0, 1.6, 2.0], [0, 1.2, -5]],
  [22.6, [0, 1.2, 0.45], [0, 1.0, -3]],
  [29.6, [0, 1.2, 0.45], [0, 1.0, -3]],
  [31.6, [0, 1.55, 1.0], [0, 1.05, -5]],
];
function camAt(t: number) {
  if (t >= 32 && t < 52) {
    const k = t - 32, x = Math.sin(k * 0.3) * 0.3;
    return { pos: [x, 1.55 + Math.sin(k * 0.45) * 0.05, 1.0 + 0.1 * Math.sin(k * 0.2)], look: [x * 0.3, 1.05, -5] };
  }
  if (t >= 52) { const k = inOut((t - 52) / 8); return { pos: [0, lerp(1.6, 1.95, k), lerp(1.2, 3.2, k)], look: [0, 1.2, -5] }; }
  let i = 0;
  while (i < CAM.length - 2 && CAM[i + 1][0] <= t) i++;
  const [t0, p0, l0] = CAM[i], [t1, p1, l1] = CAM[i + 1], k = inOut((t - t0) / (t1 - t0));
  return { pos: p0.map((v, j) => lerp(v, p1[j], k)), look: l0.map((v, j) => lerp(v, l1[j], k)) };
}

/** Where each blade points before gameplay, as phone heading/tilt (degrees). */
function bladePose(h: Hand, t: number): [number, number] {
  const sway = (f: number, p: number) => Math.sin(t * f + p + (h === 'L' ? 1.7 : 0));
  if (t < 6 || t >= 52.6) return [h === 'R' ? 22 + sway(0.9, 0) * 2 : -22 + sway(0.9, 0) * 2, 48 + sway(0.7, 1) * 2];
  if (t < 12) return h === 'R' ? [-phoneYaw(t), phonePitch(t)] : [-6 + sway(0.6, 0) * 4, -34];
  if (t < CAL[h].start) return [(h === 'R' ? -8 : 8) + sway(0.6, 0) * 5, -20 + sway(0.5, 2) * 3];
  const c = CAL[h], tremor = Math.sin(t * 9) * 0.3;
  if (t < c.aimed) { const k = inOut((t - c.start - 0.8) / (c.aimed - c.start - 0.8)); return [lerp(c.off[0], 0, k) + tremor, lerp(c.off[1], 0, k)]; }
  if (t < c.lock1) return [tremor, 0];
  if (t < c.lock2 - HOLD) { const k = inOut((t - c.lock1) / (c.lock2 - HOLD - c.lock1)); return [lerp(0, -27, k) + tremor, 0]; }
  if (t < c.lock2 + 0.6) return [-27 + tremor, 0];
  const k = inOut((t - c.lock2 - 0.6) / 1.2);
  return [lerp(-27, h === 'R' ? -6 : 6, k) + sway(0.8, 0) * 3, lerp(0, -12, k)];
}
const phoneYaw = (t: number) => Math.sin((t - 6) * 1.1) * 28;
const phonePitch = (t: number) => 12 + Math.sin((t - 6) * 0.8) * 16;

function calibAt(h: Hand, t: number): { step: CalibStep | 'done' | null; progress: number } {
  const c = CAL[h];
  if (t < c.start) return { step: null, progress: 0 };
  if (t < c.lock1) return { step: 'center', progress: clamp01((t - (c.lock1 - HOLD)) / HOLD) };
  if (t < c.lock2) return { step: 'edge', progress: clamp01((t - (c.lock2 - HOLD)) / HOLD) };
  return { step: 'done', progress: 1 };
}

export default function Film() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const engine = useRef<Engine | null>(null);
  const clock = useRef({ t: 0, started: false, calib: { L: null, R: null } as Record<Hand, CalibStep | null> });
  const stats = useRef<Stats | null>(null);
  const results = useRef<Results | null>(null);
  const judgeAt = useRef({ id: 0, t: -9 });
  const cuts = useRef<number[]>([]);
  const live = useRef<{ ctx: AudioContext; studio: Studio; t0: number } | null>(null);
  const [view, setView] = useState<View>({ t: 0, stats: null, results: null, judgeAge: 9, dirs: {} });
  const [qr, setQr] = useState<Partial<Record<Hand, string>>>({});
  const [scale, setScale] = useState(1);
  const [state, setState] = useState<'idle' | 'loading' | 'playing'>('idle');

  /** Puts the engine in the right state for film time t: camera, blades, calibration view, gameplay. */
  function drive(ft: number) {
    const e = engine.current, c = clock.current;
    if (!e) return;
    c.t = ft;
    const cam = camAt(ft);
    e.setCamera(new THREE.Vector3(...cam.pos), new THREE.Vector3(...cam.look), true);
    e.ignite(ft < 2 ? 0 : ease((ft - 2) / 0.45));
    for (const h of ['L', 'R'] as Hand[]) {
      const step = calibAt(h, ft).step;
      const show = step === 'center' || step === 'edge' ? step : null;
      if (show !== c.calib[h]) { e.showCalibration(h, show); c.calib[h] = show; }
      if (ft < SONG_AT - 0.4 || ft >= 52.6) e.orient(h, ...bladePose(h, ft));
    }
    if (!c.started && ft >= SONG_AT - 0.4) { c.started = true; e.autopilot = true; e.start('normal', TRACK); }
    const j = stats.current?.judge;
    if (j && j.id !== judgeAt.current.id) judgeAt.current = { id: j.id, t: ft };
  }

  /** Everything the overlays need for one frame, read after the engine has stepped. */
  function snapshot(ft: number): View {
    const e = engine.current;
    return {
      t: ft, stats: stats.current, results: results.current, judgeAge: ft - judgeAt.current.t,
      dirs: e ? { L: e.bladeDirection('L'), R: e.bladeDirection('R') } : {},
    };
  }

  useEffect(() => {
    const song: SongClock = {
      get now() { return clock.current.t; },
      beat() {}, play() {}, pause() {}, resume() {}, close() {},
      sfx(kind) {
        if (kind !== 'cut') return;
        cuts.current.push(clock.current.t);
        const l = live.current;
        if (l) l.studio.swish(l.ctx.currentTime);
      },
    };
    const e = new Engine(canvas.current!, { stats: (s) => { stats.current = s; }, end: (r) => { results.current = r; }, haptic() {} }, () => song);
    e.setRemotes({ L: true, R: true });
    for (const h of ['L', 'R'] as Hand[]) e.configure(h, { center: [0, 0], mirror: false, gain: 1 });
    e.ignite(0);
    engine.current = e;

    Promise.all((['L', 'R'] as Hand[]).map(async (h) => [h, await QRCode.toDataURL(`https://phone-blades.vercel.app/?pair=launch-film-${h}`, { margin: 1, width: 360 })] as const))
      .then((pairs) => {
        setQr(Object.fromEntries(pairs));
        if (RENDER) (window as unknown as { __film: unknown }).__film = {
          fps: FPS, frames: FRAMES, ready: true,
          frame: (i: number) => { const ft = i / FPS; virtualMs = ft * 1000; drive(ft); stepFrames(); const v = snapshot(ft); flushSync(() => setView(v)); },
          audio: async () => {
            const buf = await renderScore([...LOCKS, ...cuts.current.map((c) => ({ t: c, kind: 'cut' as const }))]);
            const bytes = new Uint8Array(toWav(buf));
            let s = '';
            for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
            return btoa(s);
          },
        };
      });

    const fit = () => setScale(RENDER ? 1 : Math.min(innerWidth / W, innerHeight / H));
    fit(); addEventListener('resize', fit);
    return () => { removeEventListener('resize', fit); e.dispose(); live.current?.ctx.close(); };
  }, []);

  async function play() {
    setState('loading');
    const buf = await renderScore(LOCKS);
    const ctx = new AudioContext(), src = ctx.createBufferSource();
    src.buffer = buf; src.connect(ctx.destination);
    const t0 = ctx.currentTime + 0.15;
    src.start(t0);
    live.current = { ctx, studio: new Studio(ctx), t0 };
    setState('playing');
    const loop = () => {
      const ft = ctx.currentTime - t0;
      drive(Math.max(0, ft));
      setView(snapshot(Math.max(0, ft)));
      if (ft < LENGTH) requestAnimationFrame(loop); else setState('idle');
    };
    requestAnimationFrame(loop);
  }

  const { t } = view;
  return (
    <div className="fixed inset-0 grid place-items-center overflow-hidden bg-black">
      <div className="relative overflow-hidden bg-black text-white" style={{ width: W, height: H, transform: `scale(${scale})`, flex: 'none' }}>
        <canvas ref={canvas} className="absolute inset-0 size-full" style={{ filter: 'contrast(1.14) saturate(1.25) brightness(0.9)' }} />
        <Scenes view={view} qr={qr} />
        {/* soft vignette and fades */}
        <div className="pointer-events-none absolute inset-0" style={{ boxShadow: 'inset 0 0 260px 60px rgba(0,0,0,0.85)' }} />
        <div className="pointer-events-none absolute inset-0 bg-white" style={{ opacity: Math.max(fade(t, 2, 2.6, 0.02) * 0.5 * (1 - (t - 2) / 0.6), fade(t, 32, 32.6, 0.02) * 0.8 * (1 - (t - 32) / 0.6), 0) }} />
        <div className="pointer-events-none absolute inset-0 bg-black" style={{ opacity: Math.max(1 - t / 0.8, clamp01((t - (LENGTH - 0.9)) / 0.8)) }} />
      </div>
      {!RENDER && state !== 'playing' && (
        <button onClick={play} disabled={state === 'loading'}
          className="absolute rounded-lg bg-white px-6 py-3 text-base font-semibold text-black transition duration-300 ease-soft hover:bg-neutral-200 active:scale-[0.98]">
          {state === 'loading' ? 'Preparing soundtrack' : 'Play the trailer'}
        </button>
      )}
    </div>
  );
}

type View = { t: number; stats: Stats | null; results: Results | null; judgeAge: number; dirs: Partial<Record<Hand, THREE.Vector3>> };

function Scenes({ view, qr }: { view: View; qr: Partial<Record<Hand, string>> }) {
  const { t, stats, results, judgeAge, dirs } = view;
  const dim = Math.max(fade(t, 6, 12, 0.6) * 0.45, fade(t, 12, 22, 0.6) * 0.72, fade(t, 52, 60, 0.6) * 0.72);
  return (
    <>
      <div className="pointer-events-none absolute inset-0 bg-black" style={{ opacity: dim }} />
      {t < 6.2 && <TitleScene t={t} />}
      {t >= 5.8 && t < 12.4 && <PhoneScene t={t} />}
      {t >= 11.8 && t < 22.4 && <PairScene t={t} qr={qr} />}
      {t >= 22 && t < 32 && <CalibScene t={t} />}
      {t >= 31.8 && t < 52.4 && <PlayScene t={t} stats={stats} judgeAge={judgeAge} dirs={dirs} />}
      {t >= 52 && t < 56.4 && <ResultsScene t={t} stats={stats} results={results} />}
      {t >= 56 && <EndCard t={t} />}
    </>
  );
}

/* ---------- scenes ---------- */

function Rise({ t, at, out, children, className = '', dist = 32 }: { t: number; at: number; out: number; children: React.ReactNode; className?: string; dist?: number }) {
  const k = ease((t - at) / 0.7), o = Math.min(clamp01((t - at) / 0.5), clamp01((out - t) / 0.4));
  return <div className={className} style={{ opacity: o, transform: `translateY(${(1 - k) * dist}px)` }}>{children}</div>;
}

const heading = 'bg-[linear-gradient(90deg,#ffffff,#9b9b9b)] bg-clip-text text-transparent';

function TitleScene({ t }: { t: number }) {
  // neon flicker as the sign comes on
  const x = t - 2.05, flicker = x < 0 ? 0 : x < 0.07 ? 1 : x < 0.13 ? 0.15 : x < 0.3 ? 1 : x < 0.36 ? 0.3 : 1;
  return (
    <div className="absolute inset-x-0 top-[150px] flex flex-col items-center gap-6">
      <h1 className="text-8xl font-bold tracking-tight" style={{ opacity: flicker * clamp01((5.9 - t) / 0.4), textShadow: '0 0 40px rgba(25,230,255,0.35), 0 0 80px rgba(255,122,26,0.25)' }}>
        Phone Blades
      </h1>
      <Rise t={t} at={3.0} out={5.9}><p className="text-3xl text-neutral-300">Your phone is the blade.</p></Rise>
    </div>
  );
}

function PhoneScene({ t }: { t: number }) {
  const o = fade(t, 6, 12.2, 0.5), yaw = phoneYaw(t), pitch = phonePitch(t);
  const beam = ease((t - 6.6) / 0.6);
  return (
    <div className="absolute inset-0" style={{ opacity: o }}>
      <div className="absolute left-[160px] top-[300px] flex flex-col gap-2">
        {['No headset.', 'No app.', 'Just your phone.'].map((line, i) => (
          <Rise key={line} t={t} at={6.5 + i * 0.8} out={12}><p className={`text-7xl font-bold ${i === 2 ? heading : 'text-white'}`}>{line}</p></Rise>
        ))}
        <Rise t={t} at={9.2} out={12}><p className="mt-6 text-2xl text-neutral-400">Open phone-blades.vercel.app on any screen.</p></Rise>
      </div>
      <div className="absolute right-[300px] top-[230px]" style={{ perspective: 1400 }}>
        <div style={{ transform: `rotateY(${-yaw * 0.9}deg) rotateX(${(pitch - 12) * 0.6}deg) scale(1.15)`, transformStyle: 'preserve-3d' }}>
          <div className="absolute left-1/2 -translate-x-1/2 rounded-full" style={{
            bottom: 620, width: 10, height: 520 * beam, background: '#e8fbff',
            boxShadow: `0 0 24px 8px ${HAND_COLOR.R}, 0 0 80px 24px ${HAND_COLOR.R}66`,
          }} />
          <Phone hand="R" screen="live" />
        </div>
      </div>
    </div>
  );
}

function PairScene({ t, qr }: { t: number; qr: Partial<Record<Hand, string>> }) {
  const o = fade(t, 12, 22.2, 0.6);
  const rIn = ease((t - 12.8) / 1.0), lIn = ease((t - 15.6) / 1.0), out = ease((t - 21.2) / 0.8);
  const screen = (h: Hand, scanAt: number) => (t < scanAt ? 'scan' : t < scanAt + 0.8 ? 'pairing' : 'connected') as PhoneScreenKind;
  const paired = { R: clamp01((t - 15.7) / 0.3), L: clamp01((t - 18.5) / 0.3) };
  return (
    <div className="absolute inset-0" style={{ opacity: o }}>
      <Rise t={t} at={12.4} out={17} className="absolute left-[120px] top-[90px]"><p className={`text-6xl font-bold ${heading}`}>Scan to pair.</p></Rise>
      <Rise t={t} at={17.3} out={21.8} className="absolute left-[120px] top-[90px]">
        <p className={`text-6xl font-bold ${heading}`}>Two phones. Any network.</p>
        <div className="mt-6 flex gap-3">
          {['WiFi', 'Mobile data', 'A private code for every player'].map((c) => (
            <span key={c} className="rounded-xl border border-ink-4 bg-ink-1 px-4 py-2 text-xl text-neutral-200">{c}</span>
          ))}
        </div>
      </Rise>
      <div className="absolute left-1/2 top-[290px]" style={{ transform: `translateX(-50%) translateY(${out * 40}px)` }}>
        <TV qr={qr} paired={paired} scanning={{ R: fade(t, 13.8, 14.9, 0.2), L: fade(t, 16.6, 17.7, 0.2) }} />
      </div>
      <div className="absolute" style={{ perspective: 1400, left: 1590, top: 470, transform: `translate(${(1 - rIn) * 520 + out * 300}px, ${(1 - rIn) * 520 + out * 500}px)` }}>
        <div style={{ transform: 'rotateY(-24deg) rotateX(8deg) scale(0.9)' }}><Phone hand="R" screen={screen('R', 14.9)} flash={fade(t, 14.9, 15.15, 0.05)} /></div>
      </div>
      <div className="absolute" style={{ perspective: 1400, left: 20, top: 470, transform: `translate(${-(1 - lIn) * 520 - out * 300}px, ${(1 - lIn) * 520 + out * 500}px)` }}>
        <div style={{ transform: 'rotateY(24deg) rotateX(8deg) scale(0.9)' }}><Phone hand="L" screen={screen('L', 17.7)} flash={fade(t, 17.7, 17.95, 0.05)} /></div>
      </div>
    </div>
  );
}

function CalibScene({ t }: { t: number }) {
  const o = fade(t, 22, 31.8, 0.5);
  return (
    <div className="absolute inset-0" style={{ opacity: o }}>
      <Rise t={t} at={22.4} out={31.6} className="absolute inset-x-0 top-[70px] text-center"><p className={`text-6xl font-bold ${heading}`}>Aim. Hold. Calibrated.</p></Rise>
      <div className="absolute inset-x-0 top-[190px] flex justify-center gap-4">
        {(['R', 'L'] as Hand[]).map((h) => {
          const c = calibAt(h, t);
          if (!c.step) return null;
          return (
            <div key={h} className="flex items-center gap-4 rounded-2xl border border-ink-4 bg-ink-1/90 px-6 py-4">
              {c.step === 'done' ? <CheckCircleIcon size={36} weight="fill" style={{ color: HAND_COLOR[h] }} /> : c.step === 'center' ? <CrosshairIcon size={36} style={{ color: HAND_COLOR[h] }} /> : <ArrowRightIcon size={36} style={{ color: HAND_COLOR[h] }} />}
              <div>
                <p className="text-base font-semibold" style={{ color: HAND_COLOR[h] }}>{HAND_NAME[h]} blade · {c.step === 'done' ? 'Calibrated' : `Step ${c.step === 'center' ? 1 : 2} of 2`}</p>
                <p className="text-xl">{c.step === 'center' ? 'Point at the middle of the screen' : c.step === 'edge' ? 'Turn to the right edge' : 'Ready to play'}</p>
              </div>
            </div>
          );
        })}
      </div>
      {(['L', 'R'] as Hand[]).map((h) => {
        const c = calibAt(h, t), k = ease((t - CAL[h].start + 0.4) / 0.8);
        return (
          <div key={h} className="absolute bottom-[60px]" style={{ [h === 'L' ? 'left' : 'right']: 90, transform: `translateY(${(1 - k) * 300}px) scale(0.72)`, transformOrigin: 'bottom center' } as React.CSSProperties}>
            <Phone hand={h} screen={c.step === 'done' ? 'live' : c.step === 'edge' ? 'edge' : 'center'} progress={c.progress} />
          </div>
        );
      })}
    </div>
  );
}

function PlayScene({ t, stats, judgeAge, dirs }: { t: number; stats: Stats | null; judgeAge: number; dirs: Partial<Record<Hand, THREE.Vector3>> }) {
  const o = fade(t, 32, 52.2, 0.3);
  const corner = [['Solo or dual blades.', 38], ['Bring your own music.', 42.5], ['Climb the leaderboard.', 47]] as const;
  return (
    <div className="absolute inset-0" style={{ opacity: o }}>
      {stats && (
        <>
          <div className="absolute left-[64px] top-[56px]">
            <div className="font-mono text-7xl font-semibold tabular-nums">{stats.score.toLocaleString()}</div>
            {stats.combo > 1 && <div className="mt-2 text-2xl text-neutral-300">{stats.combo} combo <span className="font-mono font-semibold text-white">×{stats.mult}</span></div>}
          </div>
          <div className="absolute left-1/2 top-[56px] h-1.5 w-[420px] -translate-x-1/2 overflow-hidden rounded-full bg-ink-4">
            <div className="h-full origin-left bg-white" style={{ transform: `scaleX(${stats.progress})` }} />
          </div>
          {stats.judge && judgeAge < 0.6 && (
            <div className="absolute left-1/2 top-[300px] text-6xl font-bold" style={{
              opacity: 1 - judgeAge / 0.6, transform: `translate(-50%, ${-judgeAge * 40}px) scale(${1.1 - judgeAge * 0.15})`,
              color: stats.judge.good ? '#ffffff' : '#f87171', textShadow: '0 0 30px rgba(255,255,255,0.35)',
            }}>{stats.judge.text}</div>
          )}
        </>
      )}
      <Rise t={t} at={32.15} out={35.4} className="absolute inset-x-0 top-[420px] text-center" dist={0}>
        <p className="text-8xl font-bold" style={{ transform: `scale(${1.25 - 0.25 * ease((t - 32.15) / 0.5)})`, textShadow: '0 0 50px rgba(25,230,255,0.4)' }}>Slice on the beat.</p>
      </Rise>
      {corner.map(([text, at]) => (
        <Rise key={text} t={t} at={at} out={at + 3.6} className="absolute bottom-[110px] left-1/2 -translate-x-1/2 rounded-2xl border border-ink-4 bg-ink-1/85 px-8 py-4">
          <p className="text-4xl font-bold">{text}</p>
        </Rise>
      ))}
      {(['L', 'R'] as Hand[]).map((h) => {
        const d = dirs[h], yaw = d ? Math.atan2(d.x, -d.z) * DEG : 0, pitch = d ? Math.asin(Math.max(-1, Math.min(1, d.y))) * DEG : 0;
        return (
          <div key={h} className="absolute bottom-[40px]" style={{ [h === 'L' ? 'left' : 'right']: 70, perspective: 1000 } as React.CSSProperties}>
            <div style={{ transform: `scale(0.55) rotateY(${-yaw * 0.8}deg) rotateX(${pitch * 0.5}deg)`, transformOrigin: 'bottom center' }}>
              <Phone hand={h} screen="live" />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ResultsScene({ t, stats, results }: { t: number; stats: Stats | null; results: Results | null }) {
  const o = fade(t, 52, 56.2, 0.5), score = results?.score ?? stats?.score ?? 0;
  const board = [['You', score, true], ['Riya', Math.round(score * 0.861), false], ['Arjun', Math.round(score * 0.793), false], ['Kabir', Math.round(score * 0.712), false]] as const;
  return (
    <div className="absolute inset-0 flex items-center justify-center gap-24" style={{ opacity: o }}>
      <div className="flex flex-col items-center gap-4">
        <Rise t={t} at={52.2} out={56}><p className="text-2xl text-neutral-400">Song cleared · Neon Run · Normal</p></Rise>
        <Rise t={t} at={52.4} out={56}><p className="text-9xl font-bold" style={{ textShadow: '0 0 60px rgba(25,230,255,0.45)' }}>{results?.rank ?? 'S'}</p></Rise>
        <Rise t={t} at={52.7} out={56} className="flex gap-4">
          {[['Score', score.toLocaleString()], ['Accuracy', `${Math.round((results?.accuracy ?? 0.94) * 100)}%`], ['Best combo', String(results?.maxCombo ?? stats?.combo ?? 0)]].map(([l, v]) => (
            <div key={l} className="rounded-xl border border-ink-4 bg-ink-1 px-8 py-5 text-center">
              <div className="font-mono text-4xl font-semibold">{v}</div><div className="mt-1 text-lg text-neutral-400">{l}</div>
            </div>
          ))}
        </Rise>
      </div>
      <Rise t={t} at={53.2} out={56} className="w-[460px] rounded-2xl border border-ink-4 bg-ink-1 p-6">
        <p className="mb-4 text-2xl font-semibold">Leaderboard</p>
        {board.map(([name, sc, me], i) => (
          <div key={name} className={`grid grid-cols-[40px_1fr_auto] items-center rounded-lg px-4 py-3 text-xl ${me ? 'bg-ink-3' : ''}`}>
            <span className="font-mono text-neutral-500">{i + 1}</span><span className="font-semibold">{name}</span><span className="font-mono">{sc.toLocaleString()}</span>
          </div>
        ))}
      </Rise>
    </div>
  );
}

function EndCard({ t }: { t: number }) {
  const k = ease((t - 56) / 0.8);
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 bg-black/70" style={{ opacity: clamp01((t - 56) / 0.3) }}>
      <svg width="140" height="140" viewBox="0 0 32 32" style={{ transform: `scale(${0.7 + 0.3 * k})`, filter: 'drop-shadow(0 0 18px rgba(25,230,255,0.6)) drop-shadow(0 0 18px rgba(255,122,26,0.5))' }} aria-hidden>
        <path d="M7 25 L24 8" stroke={HAND_COLOR.L} strokeWidth="3.5" strokeLinecap="round" />
        <path d="M25 25 L8 8" stroke={HAND_COLOR.R} strokeWidth="3.5" strokeLinecap="round" />
      </svg>
      <Rise t={t} at={56.3} out={61}><h2 className="text-8xl font-bold tracking-tight">Phone Blades</h2></Rise>
      <Rise t={t} at={56.8} out={61}><p className="text-4xl text-white">Play free at <span className="font-semibold" style={{ color: HAND_COLOR.R }}>phone-blades.vercel.app</span></p></Rise>
      <Rise t={t} at={57.4} out={61}><p className="text-2xl text-neutral-400">Two phones. One beat.</p></Rise>
    </div>
  );
}

/* ---------- devices ---------- */

type PhoneScreenKind = 'scan' | 'pairing' | 'connected' | 'center' | 'edge' | 'live';

function Phone({ hand, screen, progress = 0, flash = 0 }: { hand: Hand; screen: PhoneScreenKind; progress?: number; flash?: number }) {
  const color = HAND_COLOR[hand];
  return (
    <div className="relative rounded-[48px] border-[3px] border-[#3a3a3a] bg-[#0b0b0b] p-[10px]" style={{ width: 300, height: 620, boxShadow: `0 40px 120px rgba(0,0,0,0.7), 0 0 60px ${color}33` }}>
      <div className="relative size-full overflow-hidden rounded-[38px] bg-black">
        <div className="absolute left-1/2 top-3 z-10 h-7 w-24 -translate-x-1/2 rounded-full bg-[#050505]" />
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center">
          {screen === 'scan' && (
            <>
              <div className="relative grid size-48 place-items-center rounded-2xl bg-[#151515]">
                <div className="size-36 rounded-lg bg-white/90" style={{ backgroundImage: 'repeating-linear-gradient(90deg,#000 0 6px,transparent 6px 12px),repeating-linear-gradient(0deg,#000 0 6px,transparent 6px 12px)', opacity: 0.85 }} />
                {[0, 1, 2, 3].map((i) => <span key={i} className="absolute size-8 border-white" style={{ borderWidth: 0, [i < 2 ? 'top' : 'bottom']: 8, [i % 2 ? 'right' : 'left']: 8, [`border${i < 2 ? 'Top' : 'Bottom'}Width`]: 3, [`border${i % 2 ? 'Right' : 'Left'}Width`]: 3 } as React.CSSProperties} />)}
              </div>
              <p className="text-base font-semibold">Point your camera at the code</p>
            </>
          )}
          {screen === 'pairing' && (<><Dot color={color} label={`${HAND_NAME[hand]} blade`} /><p className="text-3xl font-bold">Pairing</p><p className="text-sm text-neutral-400">Connecting to the game screen</p></>)}
          {(screen === 'connected' || screen === 'live') && (
            <>
              <span className="flex items-center gap-2 rounded-full bg-ink-1 px-3 py-2 text-sm text-neutral-200"><span className="size-2 rounded-full bg-emerald-400" />Connected</span>
              <p className="text-4xl font-bold" style={{ color }}>{HAND_NAME[hand]} blade</p>
              {screen === 'live' && (
                <div className="mt-6 w-full rounded-2xl border border-ink-4 bg-ink-1 p-4 text-left">
                  <div className="flex justify-between text-sm font-semibold"><span>Sensitivity</span><span className="font-mono text-neutral-300">90%</span></div>
                  <div className="mt-3 h-1.5 rounded-full bg-ink-4"><div className="h-full w-[60%] rounded-full" style={{ background: color }} /></div>
                </div>
              )}
            </>
          )}
          {(screen === 'center' || screen === 'edge') && (
            <>
              <span className="font-mono text-sm text-neutral-400">Step {screen === 'center' ? 1 : 2} of 2</span>
              {screen === 'center' ? <CrosshairIcon size={56} style={{ color }} /> : <ArrowRightIcon size={56} style={{ color }} />}
              <p className="text-2xl font-bold">{screen === 'center' ? 'Point at the middle of the screen' : 'Now point at the right edge'}</p>
              <p className="text-sm text-neutral-300">{progress > 0 ? 'Hold still' : 'Aim with the top edge'}</p>
              <div className="h-2 w-full overflow-hidden rounded-full bg-ink-3"><div className="h-full origin-left rounded-full" style={{ background: color, transform: `scaleX(${progress})` }} /></div>
            </>
          )}
        </div>
        <div className="pointer-events-none absolute inset-0 bg-white" style={{ opacity: flash * 0.8 }} />
      </div>
    </div>
  );
}

function Dot({ color, label }: { color: string; label: string }) {
  return <p className="flex items-center gap-2 text-sm font-semibold"><span className="size-2 rounded-full" style={{ background: color }} />{label}</p>;
}

function TV({ qr, paired, scanning }: { qr: Partial<Record<Hand, string>>; paired: Record<Hand, number>; scanning: Record<Hand, number> }) {
  const n = Number(paired.R >= 1) + Number(paired.L >= 1);
  return (
    <div className="rounded-[28px] border-[3px] border-[#2a2a2a] bg-[#0a0a0a] p-4" style={{ width: 1080, boxShadow: '0 60px 160px rgba(0,0,0,0.8), 0 0 80px rgba(91,71,214,0.18)' }}>
      <div className="grid grid-cols-[1fr_440px] items-center gap-10 rounded-2xl bg-black px-12 py-10">
        <div>
          <p className={`text-5xl font-bold leading-tight ${heading}`}>Your phone is the blade.<br />Slice every block on the beat.</p>
          <p className="mt-4 text-xl text-neutral-400">Scan a code with your phone, pick a song and swing.</p>
        </div>
        <div className="rounded-2xl border border-ink-4 bg-ink-1 p-6">
          <div className="mb-4 flex justify-between"><span className="text-xl font-semibold">Phones</span><span className="text-lg text-neutral-400">{n} of 2 paired</span></div>
          <div className="grid grid-cols-2 gap-4">
            {(['R', 'L'] as Hand[]).map((h) => (
              <div key={h}>
                <div className="relative aspect-square overflow-hidden rounded-xl bg-white p-2" style={{ boxShadow: scanning[h] ? `0 0 0 4px ${HAND_COLOR[h]}, 0 0 40px ${HAND_COLOR[h]}` : 'none' }}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- data URL */}
                  {qr[h] && <img src={qr[h]} alt="" className="size-full" />}
                  <div className="absolute inset-0 grid place-items-center bg-ink-1" style={{ opacity: paired[h] }}>
                    <CheckCircleIcon size={64} weight="fill" style={{ color: HAND_COLOR[h], transform: `scale(${0.6 + 0.4 * ease(paired[h] * 2)})` }} />
                  </div>
                </div>
                <p className="mt-2 flex items-center gap-2 text-lg font-semibold"><span className="size-2.5 rounded-full" style={{ background: HAND_COLOR[h] }} />{HAND_NAME[h]} blade</p>
                <p className="text-base text-neutral-400">{paired[h] >= 1 ? 'Paired' : 'Scan to pair'}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
