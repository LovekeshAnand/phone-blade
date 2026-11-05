'use client';

import { useEffect, useRef, useState } from 'react';
import { PauseIcon } from '@phosphor-icons/react';
import { CrosshairIcon, ArrowRightIcon } from '@phosphor-icons/react';
import { Engine, type CalibStep, type Mode, type Results, type Stats } from '@/lib/engine';
import { DIFFICULTY, type Difficulty } from '@/lib/beatmap';
import { HAND_COLOR, HAND_NAME, HANDS, type Hand, type Remotes } from '@/lib/protocol';
import { DisplayPairing, newCode } from '@/lib/rtc';
import type { Track } from '@/lib/track';
import { Lobby } from './Lobby';
import { Button } from './ui';

type Phase = 'lobby' | 'playing' | 'paused' | 'results';
type Run = { track: Track | null; difficulty: Difficulty; title: string; mode: Mode };
type Save = { state: 'saving' | 'saved' | 'practice' | 'error'; text: string };

const modeOf = (r: Remotes): Mode => (r.L && r.R ? 'duo' : r.L || r.R ? 'solo' : 'mouse');

/** Pairing codes for this tab. Kept across a refresh, so phones that already scanned can reconnect. */
function tabCodes(): Record<Hand, string> {
  try { const saved = sessionStorage.getItem('phone-blades:codes'); if (saved) return JSON.parse(saved); } catch {}
  const codes = { L: newCode(), R: newCode() };
  try { sessionStorage.setItem('phone-blades:codes', JSON.stringify(codes)); } catch {}
  return codes;
}

export default function Game() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const engine = useRef<Engine | null>(null);
  const pairing = useRef<DisplayPairing | null>(null);
  const remotesRef = useRef<Remotes>({ L: false, R: false });
  const run = useRef<Run | null>(null);
  const [codes] = useState(tabCodes);
  const [phase, setPhase] = useState<Phase>('lobby');
  const [remotes, setRemotes] = useState<Remotes>({ L: false, R: false });
  const [stats, setStats] = useState<Stats | null>(null);
  const [results, setResults] = useState<Results | null>(null);
  const [save, setSave] = useState<Save | null>(null);
  const [boardVersion, setBoardVersion] = useState(0);
  const [calib, setCalib] = useState<Partial<Record<Hand, CalibStep>>>({}); // blades whose phone is calibrating

  useEffect(() => {
    async function submit(r: Results) {
      const cur = run.current;
      if (!cur) return;
      if (cur.mode === 'mouse') return setSave({ state: 'practice', text: 'Mouse runs are practice. Pair a phone to get on the leaderboard.' });
      setSave({ state: 'saving', text: 'Saving your score' });
      try {
        const res = await fetch('/api/scores', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ song: cur.title, difficulty: cur.difficulty, mode: cur.mode, score: r.score, accuracy: r.accuracy, maxCombo: r.maxCombo, rank: r.rank, total: r.total }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error);
        setSave({ state: 'saved', text: `Saved. You are number ${body.place} on ${cur.title}, ${DIFFICULTY[cur.difficulty].label}.` });
        setBoardVersion((v) => v + 1);
      } catch (e) {
        setSave({ state: 'error', text: (e as Error).message || 'Your score could not be saved. Check your connection.' });
      }
    }

    const e = new Engine(canvas.current!, {
      stats: setStats,
      end: (r) => { setResults(r); setPhase('results'); submit(r); },
      haptic: (h, good) => pairing.current?.send(h, { t: 'hit', good }),
    });
    const p = new DisplayPairing(codes, {
      motion: (h, a, b) => e.orient(h, a, b),
      config: (h, c) => e.configure(h, c),
      cal: (h) => e.recenter(h),
      step: (h, step) => {
        const s = step === 'done' ? null : step;
        e.showCalibration(h, s);
        setCalib((c) => { const n = { ...c }; if (s) n[h] = s; else delete n[h]; return n; });
      },
      status: (h, live) => {
        remotesRef.current = { ...remotesRef.current, [h]: live };
        e.setRemotes(remotesRef.current);
        setRemotes(remotesRef.current);
        if (!live) { e.showCalibration(h, null); setCalib((c) => { const n = { ...c }; delete n[h]; return n; }); }
      },
    });
    engine.current = e;
    pairing.current = p;
    return () => { p.stop(); e.dispose(); };
  }, [codes]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      if (phase === 'playing') pause();
      else if (phase === 'paused') resume();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [phase]);

  function play(track: Track | null, difficulty: Difficulty, title: string) {
    run.current = { track, difficulty, title, mode: modeOf(remotesRef.current) };
    setResults(null); setSave(null);
    engine.current?.start(difficulty, track);
    setPhase('playing');
  }
  function pause() { engine.current?.pause(); setPhase('paused'); }
  function resume() { engine.current?.resume(); setPhase('playing'); }
  function toLobby() { engine.current?.quit(); setPhase('lobby'); }

  return (
    <div className="fixed inset-0 overflow-hidden bg-black text-white">
      <canvas ref={canvas} className="absolute inset-0 size-full" />

      {/* While a phone calibrates, the lobby steps aside so the zoomed in blade and its target ring are visible. */}
      <div hidden={phase !== 'lobby' || HANDS.some((h) => calib[h])} className="absolute inset-0 bg-black/70">
        <Lobby active={phase === 'lobby'} remotes={remotes} codes={codes} boardVersion={boardVersion} onPlay={play} />
      </div>

      {(phase === 'playing' || phase === 'paused') && stats && <Hud stats={stats} onPause={pause} />}

      {HANDS.some((h) => calib[h]) && <CalibrationGuide calib={calib} compact={phase !== 'lobby'} />}

      {phase === 'paused' && (
        <Overlay>
          <h2 className="text-4xl font-bold">Paused</h2>
          <p className="text-neutral-400">Press Esc or resume when you are ready.</p>
          <div className="flex gap-3">
            <Button size="lg" onClick={resume}>Resume</Button>
            <Button size="lg" variant="secondary" onClick={toLobby}>Quit to lobby</Button>
          </div>
        </Overlay>
      )}

      {phase === 'results' && results && (
        <Overlay>
          <p className="text-sm text-neutral-400">{results.failed ? 'Out of energy' : 'Song cleared'} · {results.title} · {DIFFICULTY[results.difficulty].label}</p>
          <div className={`text-9xl font-bold ${results.failed ? 'text-red-400' : 'text-white'}`}>{results.rank}</div>
          <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Score" value={results.score.toLocaleString()} />
            <Stat label="Accuracy" value={`${Math.round(results.accuracy * 100)}%`} />
            <Stat label="Best combo" value={results.maxCombo} />
            <Stat label="Blocks cut" value={`${results.hits}/${results.total}`} />
          </dl>
          {save && (
            <p role="status" className={`text-sm ${save.state === 'error' ? 'text-red-400' : save.state === 'saved' ? 'text-emerald-300' : 'text-neutral-400'}`}>{save.text}</p>
          )}
          <div className="flex gap-3">
            <Button size="lg" onClick={() => run.current && play(run.current.track, run.current.difficulty, run.current.title)}>Play again</Button>
            <Button size="lg" variant="secondary" onClick={toLobby}>Back to lobby</Button>
          </div>
        </Overlay>
      )}
    </div>
  );
}

function Hud({ stats, onPause }: { stats: Stats; onPause(): void }) {
  return (
    <>
      <div className="pointer-events-none absolute left-6 top-6">
        <div className="font-mono text-5xl font-semibold tabular-nums">{stats.score.toLocaleString()}</div>
        {stats.combo > 1 && <div className="mt-2 text-lg text-neutral-300">{stats.combo} combo <span className="font-mono font-semibold text-white">×{stats.mult}</span></div>}
      </div>
      <Button variant="secondary" size="sm" className="absolute right-6 top-6" onClick={onPause} aria-label="Pause"><PauseIcon size={16} weight="fill" />Pause</Button>
      <div className="pointer-events-none absolute left-1/2 top-6 h-1 w-64 -translate-x-1/2 overflow-hidden rounded-full bg-ink-4" aria-hidden>
        <div className="h-full origin-left bg-white transition-transform duration-300 ease-soft" style={{ transform: `scaleX(${stats.progress})` }} />
      </div>
      <div className="pointer-events-none absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-3">
        <span className="text-sm text-neutral-400">Energy</span>
        <div className="h-2 w-64 overflow-hidden rounded-full bg-ink-4">
          <div className={`h-full origin-left transition-transform duration-300 ease-soft ${stats.energy < 0.25 ? 'bg-red-400' : 'bg-white'}`} style={{ transform: `scaleX(${stats.energy})` }} />
        </div>
      </div>
      {stats.judge && (
        <div key={stats.judge.id} className={`judge pointer-events-none absolute left-1/2 top-[30%] text-4xl font-bold ${stats.judge.good ? 'text-white' : 'text-red-400'}`}>
          {stats.judge.text}
        </div>
      )}
    </>
  );
}

function CalibrationGuide({ calib, compact }: { calib: Partial<Record<Hand, CalibStep>>; compact: boolean }) {
  return (
    <div className={`rise pointer-events-none absolute inset-x-0 flex flex-col items-center gap-3 px-6 ${compact ? 'top-20' : 'top-12'}`} role="status">
      {!compact && <h2 className="text-3xl font-bold">Calibrating</h2>}
      {(['R', 'L'] as Hand[]).filter((h) => calib[h]).map((h) => (
        <div key={h} className="flex items-center gap-4 rounded-2xl border border-ink-4 bg-ink-1/90 px-6 py-4 backdrop-blur">
          {calib[h] === 'center' ? <CrosshairIcon size={32} style={{ color: HAND_COLOR[h] }} aria-hidden /> : <ArrowRightIcon size={32} style={{ color: HAND_COLOR[h] }} aria-hidden />}
          <div>
            <p className="text-sm font-semibold" style={{ color: HAND_COLOR[h] }}>{HAND_NAME[h]} blade · Step {calib[h] === 'center' ? 1 : 2} of 2</p>
            <p className="text-lg">{calib[h] === 'center' ? 'Point at the middle of the screen. Put the blade tip in the ring.' : 'Now turn to the right edge of the screen.'}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function Overlay({ children }: { children: React.ReactNode }) {
  return <div className="rise absolute inset-0 flex flex-col items-center justify-center gap-6 overflow-y-auto bg-black/80 p-6 text-center">{children}</div>;
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-ink-4 bg-ink-1 px-6 py-4">
      <dd className="font-mono text-2xl font-semibold tabular-nums">{value}</dd>
      <dt className="mt-1 text-sm text-neutral-400">{label}</dt>
    </div>
  );
}
