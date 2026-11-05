'use client';

import { useSyncExternalStore } from 'react';
import Game from '@/components/Game';
import Remote from '@/components/Remote';

// One link for everyone: a scanned pairing code or a phone opens the remote, a computer opens the game screen.
// Renders nothing on the server (null snapshot), so both only ever run in the browser.
function detect(): 'game' | 'remote' {
  const q = new URLSearchParams(location.search);
  if (q.has('pair')) return 'remote';
  if (q.has('display')) return 'game';
  const ua = navigator.userAgent;
  const mobile = /Android|iPhone|iPad|iPod|Mobi/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1); // iPadOS reports as Mac
  return mobile ? 'remote' : 'game';
}
const subscribe = () => () => {};

export default function Page() {
  const kind = useSyncExternalStore(subscribe, detect, () => null);
  if (!kind) return null;
  return kind === 'remote' ? <Remote /> : <Game />;
}
