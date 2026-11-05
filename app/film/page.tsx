'use client';

import { useSyncExternalStore } from 'react';
import Film from '@/components/film/Film';

// The launch trailer, played live by the game engine. /film?render is the frame by frame mode used to encode the video.
const subscribe = () => () => {};

export default function Page() {
  const ready = useSyncExternalStore(subscribe, () => true, () => false);
  return ready ? <Film /> : null;
}
