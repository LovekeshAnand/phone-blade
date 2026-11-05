'use client';

import { useEffect, useRef, useState } from 'react';
import { CrosshairIcon, DeviceMobileIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { HAND_COLOR, HAND_NAME, type Hand } from '@/lib/protocol';
import { connectPhone, type PhoneState } from '@/lib/rtc';
import { Button } from './ui';

type Stage = 'intro' | 'calibrate' | 'live';
type Link = Awaited<ReturnType<typeof connectPhone>>;

export default function Remote() {
  const [{ code, hand }] = useState(() => {
    const q = new URLSearchParams(location.search);
    return { code: q.get('pair'), hand: (q.get('h') === 'L' ? 'L' : 'R') as Hand };
  });
  const [started, setStarted] = useState(false);
  const [stage, setStage] = useState<Stage>('intro');
  const [link, setLink] = useState<PhoneState>('connecting');
  const [sensorOk, setSensorOk] = useState(true);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState(0);
  const linkRef = useRef<Link | null>(null);
  const color = HAND_COLOR[hand];

  useEffect(() => {
    if (!started || !code) return;
    let cancelled = false, retry = 0, lastEvt = 0, wake: WakeLockSentinel | null = null;

    const connect = async () => {
      let dead = false;
      setLink('connecting');
      try {
        const l = await connectPhone(code,
          (m) => { if (m.t === 'hit') navigator.vibrate?.(m.good ? 18 : [50, 30, 50]); },
          (s) => {
            if (cancelled || dead) return;
            setLink(s);
            if (s === 'live') { setError(''); setStage((st) => (st === 'intro' ? 'calibrate' : st)); }
            if (s === 'lost') { // reconnect, then ask for a fresh calibration
              dead = true;
              linkRef.current?.close(); linkRef.current = null;
              setStage('calibrate');
              retry = window.setTimeout(connect, 1500);
            }
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
      if (e.alpha == null) return;
      lastEvt = Date.now();
      linkRef.current?.motion(e.alpha, e.beta ?? 0, e.gamma ?? 0);
    };
    const keepAwake = async () => { // a sleeping screen stops the motion sensors
      if (document.visibilityState === 'visible') try { wake = (await navigator.wakeLock?.request('screen')) ?? null; } catch {}
    };

    connect();
    addEventListener('deviceorientation', onOrient);
    keepAwake();
    document.addEventListener('visibilitychange', keepAwake);
    const iv = setInterval(() => setSensorOk(Date.now() - lastEvt < 1500), 700);
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

  async function start() {
    setError('');
    const DOE = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
    if (typeof DOE.requestPermission === 'function') { // iPhone asks for motion access on a tap
      try {
        if ((await DOE.requestPermission()) !== 'granted') return setError('Motion access was turned off. Reload this page and allow it.');
      } catch { return setError('Motion access could not be requested. Reload this page and try again.'); }
    }
    setStarted(true);
  }

  function tap() {
    if (link !== 'live') return;
    linkRef.current?.cal();
    navigator.vibrate?.(15);
    setFlash((f) => f + 1);
    setStage('live');
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

  if (!started) return (
    <Screen>
      <p className="flex items-center gap-2 text-sm font-semibold"><span aria-hidden className="size-2 rounded-full" style={{ background: color }} />{HAND_NAME[hand]} blade</p>
      <h1 className="text-3xl font-bold">Turn this phone into a blade</h1>
      <ol className="flex flex-col gap-3 text-left">
        <Step n={1} title="Grip it like a sword handle">Hold the bottom of the phone. The top edge is the blade.</Step>
        <Step n={2} title="Pair with the game screen">Works on WiFi or mobile data, any network.</Step>
        <Step n={3} title="Aim and tap to calibrate">Point the top edge at the screen and tap once.</Step>
      </ol>
      {!isSecureContext && <p className="text-sm text-yellow-300">Open this page over https, or the motion sensors stay blocked.</p>}
      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      <Button size="lg" className="w-full" onClick={start}>Pair this phone</Button>
    </Screen>
  );

  const status = error ? error
    : link === 'connecting' ? (stage === 'intro' ? 'Pairing with the game screen' : 'Reconnecting')
      : link === 'lost' ? 'Connection lost. Reconnecting'
        : !sensorOk ? 'No motion data from this phone' : 'Connected';

  return (
    <main onPointerDown={tap} className="relative flex min-h-dvh touch-none select-none flex-col items-center justify-center gap-6 overflow-hidden bg-black px-6 text-center text-white">
      <div key={flash} className="flash pointer-events-none absolute inset-0" style={{ background: color }} aria-hidden />
      <p role="status" className={`flex items-center gap-2 rounded-full bg-ink-1 px-3 py-2 text-sm ${link === 'live' && sensorOk && !error ? 'text-neutral-200' : 'text-yellow-300'}`}>
        {link === 'live' && sensorOk && !error ? <span aria-hidden className="size-2 rounded-full bg-emerald-400" /> : <WarningCircleIcon size={16} aria-hidden />}
        {status}
      </p>
      <h1 className="text-5xl font-bold" style={{ color }}>{HAND_NAME[hand]} blade</h1>
      {stage === 'live' ? (
        <p className="max-w-xs text-lg text-neutral-300">Tap anywhere to recenter. Point at the screen first.</p>
      ) : (
        <div className="flex max-w-xs flex-col items-center gap-3">
          <CrosshairIcon size={48} style={{ color }} aria-hidden />
          <p className="text-lg text-neutral-200">Point the top of this phone at the game screen, then tap anywhere.</p>
        </div>
      )}
    </main>
  );
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
