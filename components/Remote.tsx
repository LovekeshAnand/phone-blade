'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowRightIcon, CrosshairIcon, DeviceMobileIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { HAND_COLOR, HAND_NAME, type Hand } from '@/lib/protocol';
import { connectPhone, type Calibration, type PhoneState } from '@/lib/rtc';
import { steady, tiltDeg, turnDeg, type Sample } from '@/lib/calibration';
import { Button } from './ui';

type Stage = 'intro' | 'pairing' | 'center' | 'edge' | 'live';
type Link = Awaited<ReturnType<typeof connectPhone>>;

const SENS_KEY = 'phone-blades:sensitivity';
const HOLD_MS = 800; // hold steady this long to capture a calibration step
const MAX_TILT = 40; // the center pose must be roughly level: this is what prevents sideways calibrations
const MIN_TURN = 12; // degrees the phone must turn toward the right edge

function storedSensitivity() {
  try { const v = Number(localStorage.getItem(SENS_KEY)); return v >= 50 && v <= 150 ? v : 90; } catch { return 90; }
}

export default function Remote() {
  const [{ code, hand }] = useState(() => {
    const q = new URLSearchParams(location.search);
    return { code: q.get('pair'), hand: (q.get('h') === 'L' ? 'L' : 'R') as Hand };
  });
  const [stage, setStage] = useState<Stage>('intro');
  const [link, setLink] = useState<PhoneState>('connecting');
  const [sensorOk, setSensorOk] = useState(true);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState(0);
  const [sens, setSens] = useState(storedSensitivity);
  const [wizard, setWizard] = useState({ hint: '', hold: 0 });
  const linkRef = useRef<Link | null>(null);
  const samples = useRef<Sample[]>([]);
  const center = useRef<Sample | null>(null);
  const cfg = useRef<Calibration>({ gain: sens / 100 });
  const started = stage !== 'intro';
  const color = HAND_COLOR[hand];

  // Connection, motion stream and screen wake lock.
  useEffect(() => {
    if (!started || !code) return;
    let cancelled = false, retry = 0, wake: WakeLockSentinel | null = null;

    const connect = async () => {
      let dead = false;
      setLink('connecting');
      try {
        const l = await connectPhone(code,
          (m) => { if (m.t === 'hit') navigator.vibrate?.(m.good ? 18 : [50, 30, 50]); },
          (s) => {
            if (cancelled || dead) return;
            setLink(s);
            if (s === 'live') {
              setError('');
              if (cfg.current.center) linkRef.current?.config(cfg.current); // reconnect: restore this phone's calibration
              setStage((st) => (st === 'pairing' ? 'center' : st));
            }
            if (s === 'lost') { dead = true; linkRef.current?.close(); linkRef.current = null; retry = window.setTimeout(connect, 1500); }
          });
        if (cancelled) return l.close();
        linkRef.current = l;
      } catch (e) {
        if (cancelled) return;
        setError((e as Error).message || 'Could not pair. Check your connection.');
        retry = window.setTimeout(connect, 3000);
      }
    };

    const onOrient = (e: DeviceOrientationEvent) => {
      if (e.alpha == null || e.beta == null) return;
      const now = Date.now();
      samples.current.push({ t: now, a: e.alpha, b: e.beta });
      if (samples.current.length > 120) samples.current = samples.current.filter((s) => now - s.t < 1500);
      linkRef.current?.motion(e.alpha, e.beta);
    };
    const keepAwake = async () => { // a sleeping screen stops the motion sensors
      if (document.visibilityState === 'visible') try { wake = (await navigator.wakeLock?.request('screen')) ?? null; } catch {}
    };

    connect();
    addEventListener('deviceorientation', onOrient);
    keepAwake();
    document.addEventListener('visibilitychange', keepAwake);
    const iv = setInterval(() => { const last = samples.current.at(-1); setSensorOk(!!last && Date.now() - last.t < 1500); }, 700);
    return () => {
      cancelled = true;
      clearTimeout(retry);
      clearInterval(iv);
      linkRef.current?.close();
      removeEventListener('deviceorientation', onOrient);
      document.removeEventListener('visibilitychange', keepAwake);
      wake?.release().catch(() => {});
    };
  }, [started, code]);

  // Guided calibration: 1) aim at the middle of the screen, level and still. 2) turn to the right edge,
  // which also tells us whether this phone reports left and right the other way round.
  useEffect(() => {
    if (stage !== 'center' && stage !== 'edge') return;
    let holdStart = 0;
    const iv = setInterval(() => {
      const now = Date.now(), last = samples.current.at(-1);
      if (!last || now - last.t > 500) { holdStart = 0; return setWizard({ hint: 'Waiting for motion data from this phone', hold: 0 }); }
      let ok: boolean, hint: string;
      if (stage === 'center') {
        const tilt = tiltDeg(last);
        ok = Math.abs(tilt) < MAX_TILT;
        hint = ok ? 'Hold still' : tilt > 0 ? 'Lower the phone. Point it at the screen, not the ceiling.' : 'Raise the phone. Point it at the screen, not the floor.';
      } else {
        ok = Math.abs(turnDeg(center.current!, last)) >= MIN_TURN;
        hint = ok ? 'Hold still' : 'Turn the phone to the right edge of the screen';
      }
      holdStart = ok && steady(samples.current, now) ? holdStart || now : 0;
      const hold = holdStart ? Math.min(1, (now - holdStart) / HOLD_MS) : 0;
      setWizard({ hint, hold });
      if (hold < 1) return;
      if (stage === 'center') {
        center.current = last;
        cfg.current = { ...cfg.current, center: [last.a, last.b], mirror: false };
        linkRef.current?.config(cfg.current);
        navigator.vibrate?.(20);
        setStage('edge');
      } else {
        cfg.current = { ...cfg.current, mirror: turnDeg(center.current!, last) < 0 };
        linkRef.current?.config(cfg.current);
        navigator.vibrate?.([20, 40, 20]);
        setStage('live');
      }
    }, 100);
    return () => clearInterval(iv);
  }, [stage]);

  async function start() {
    setError('');
    const DOE = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
    if (typeof DOE.requestPermission === 'function') { // iPhone asks for motion access on a tap
      try {
        if ((await DOE.requestPermission()) !== 'granted') return setError('Motion access was turned off. Reload this page and allow it.');
      } catch { return setError('Motion access could not be requested. Reload this page and try again.'); }
    }
    setStage('pairing');
  }

  function recenter() {
    const last = samples.current.at(-1);
    if (stage !== 'live' || link !== 'live' || !last) return;
    cfg.current = { ...cfg.current, center: [last.a, last.b] }; // so a reconnect restores this pose
    linkRef.current?.cal();
    navigator.vibrate?.(15);
    setFlash((f) => f + 1);
  }

  function changeSensitivity(v: number) {
    setSens(v);
    cfg.current = { ...cfg.current, gain: v / 100 };
    linkRef.current?.config({ gain: v / 100 });
    try { localStorage.setItem(SENS_KEY, String(v)); } catch {}
  }

  if (!code) return (
    <Screen>
      <DeviceMobileIcon size={40} className="text-neutral-400" aria-hidden />
      <h1 className="text-3xl font-bold">Scan a code to play</h1>
      <p className="text-neutral-400">Open Phone Blades on a computer or TV, then scan one of the codes on that screen with this phone.</p>
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- full reload so device detection runs again */}
      <a href="/?display" className="text-sm font-semibold text-white underline underline-offset-4">Use this device as the game screen</a>
    </Screen>
  );

  if (stage === 'intro') return (
    <Screen>
      <HandLabel hand={hand} />
      <h1 className="text-3xl font-bold">Turn this phone into a blade</h1>
      <ol className="flex flex-col gap-3 text-left">
        <Step n={1} title="Grip it like a sword handle">Hold the bottom of the phone. The top edge is the blade.</Step>
        <Step n={2} title="Pair with the game screen">Works on WiFi or mobile data, any network.</Step>
        <Step n={3} title="Calibrate in two moves">Aim at the middle of the screen, then at its right edge.</Step>
      </ol>
      {!isSecureContext && <p className="text-sm text-yellow-300">Open this page over https, or the motion sensors stay blocked.</p>}
      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      <Button size="lg" className="w-full" onClick={start}>Pair this phone</Button>
    </Screen>
  );

  const healthy = link === 'live' && sensorOk && !error;
  const status = error || (link === 'connecting' ? (stage === 'pairing' ? 'Pairing with the game screen' : 'Reconnecting')
    : link === 'lost' ? 'Connection lost. Reconnecting' : !sensorOk ? 'No motion data from this phone' : 'Connected');
  const statusPill = (
    <p role="status" className={`flex items-center gap-2 rounded-full bg-ink-1 px-3 py-2 text-sm ${healthy ? 'text-neutral-200' : 'text-yellow-300'}`}>
      {healthy ? <span aria-hidden className="size-2 rounded-full bg-emerald-400" /> : <WarningCircleIcon size={16} aria-hidden />}
      {status}
    </p>
  );

  if (stage === 'pairing') return <Screen><HandLabel hand={hand} />{statusPill}<h1 className="text-3xl font-bold">Pairing</h1><p className="text-neutral-400">Keep the game screen open. This takes a few seconds.</p></Screen>;

  if (stage === 'center' || stage === 'edge') return (
    <Screen>
      <div className="flex items-center justify-between"><HandLabel hand={hand} /><span className="font-mono text-sm text-neutral-400">Step {stage === 'center' ? 1 : 2} of 2</span></div>
      {statusPill}
      <div className="flex flex-col items-center gap-6 py-6 text-center">
        {stage === 'center' ? <CrosshairIcon size={64} style={{ color }} aria-hidden /> : <ArrowRightIcon size={64} style={{ color }} aria-hidden />}
        <h1 className="text-3xl font-bold">{stage === 'center' ? 'Point at the middle of the screen' : 'Now point at the right edge of the screen'}</h1>
        <p className="text-lg text-neutral-300" aria-live="polite">{wizard.hint}</p>
        <div className="h-2 w-full overflow-hidden rounded-full bg-ink-3" aria-hidden>
          <div className="h-full origin-left rounded-full transition-transform duration-300 ease-soft" style={{ background: color, transform: `scaleX(${wizard.hold})` }} />
        </div>
        <p className="text-sm text-neutral-400">Hold the phone like a sword, top edge forward, and keep it still for a moment.</p>
      </div>
      {stage === 'edge' && <Button variant="ghost" onClick={() => setStage('live')}>Skip this step</Button>}
    </Screen>
  );

  return (
    <main onPointerDown={recenter} className="relative flex min-h-dvh touch-none select-none flex-col items-center justify-between gap-6 overflow-hidden bg-black px-6 py-8 text-center text-white">
      <div key={flash} className="flash pointer-events-none absolute inset-0" style={{ background: color }} aria-hidden />
      {statusPill}
      <div className="flex flex-col items-center gap-3">
        <h1 className="text-5xl font-bold" style={{ color }}>{HAND_NAME[hand]} blade</h1>
        <p className="max-w-xs text-lg text-neutral-300">Tap anywhere to recenter. Point at the middle of the screen first.</p>
      </div>
      <section onPointerDown={(e) => e.stopPropagation()} className="relative w-full max-w-sm rounded-2xl border border-ink-4 bg-ink-1 p-4 text-left">
        <label className="flex items-center justify-between text-sm font-semibold" htmlFor="sens">
          Sensitivity <span className="font-mono text-neutral-300">{sens}%</span>
        </label>
        <input id="sens" type="range" min={50} max={150} step={5} value={sens} onChange={(e) => changeSensitivity(Number(e.target.value))}
          className="mt-3 w-full" style={{ accentColor: color }} />
        <p className="mt-2 text-sm text-neutral-400">Lower means a calmer blade: you turn the phone further for the same move.</p>
        <Button variant="secondary" className="mt-4 w-full" onClick={() => setStage('center')}>Recalibrate</Button>
      </section>
    </main>
  );
}

function HandLabel({ hand }: { hand: Hand }) {
  return <p className="flex items-center gap-2 text-sm font-semibold"><span aria-hidden className="size-2 rounded-full" style={{ background: HAND_COLOR[hand] }} />{HAND_NAME[hand]} blade</p>;
}

function Screen({ children }: { children: React.ReactNode }) {
  return <main className="rise mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 bg-black px-6 py-12 text-white">{children}</main>;
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3 rounded-xl border border-ink-4 bg-ink-1 p-4">
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-white font-mono text-sm font-semibold text-black">{n}</span>
      <div><p className="font-semibold">{title}</p><p className="mt-1 text-sm text-neutral-400">{children}</p></div>
    </li>
  );
}
