import type { Hand } from './protocol';

export type Dir = 'up' | 'down' | 'left' | 'right' | 'any';
export interface Note { beat: number; hand: Hand; lane: number; row: number; dir: Dir; bomb?: boolean }

export interface DifficultyCfg { label: string; bpm: number; speed: number; density: number; doubles: number; halfBeats: number; bombs: number }
export const DIFFICULTY = {
  easy: { label: 'Easy', bpm: 100, speed: 8, density: 0.55, doubles: 0.1, halfBeats: 0, bombs: 0.04 },
  normal: { label: 'Normal', bpm: 115, speed: 10, density: 0.75, doubles: 0.25, halfBeats: 0.08, bombs: 0.07 },
  hard: { label: 'Hard', bpm: 130, speed: 12, density: 0.9, doubles: 0.35, halfBeats: 0.2, bombs: 0.1 },
} satisfies Record<string, DifficultyCfg>;
export type Difficulty = keyof typeof DIFFICULTY;

// Song shape: count-in, verse, chorus, breakdown, drop, outro. [until bar, energy]
const SECTIONS: [number, number][] = [[2, 0], [10, 0.7], [26, 1], [30, 0.4], [46, 1.2], [50, 0.5]];
export const BARS = 50;
export function energyAt(bar: number) {
  for (const [until, e] of SECTIONS) if (bar < until) return e;
  return 0;
}

export type Flow = Record<Hand, Dir>;
const OPP: Record<Dir, Dir> = { up: 'down', down: 'up', left: 'right', right: 'left', any: 'any' };
const ALL: Dir[] = ['up', 'down', 'left', 'right', 'any'];

/**
 * Notes for one beat, generated live so the map adapts the moment a phone joins or leaves.
 * hands = active blades: one → solo (every lane, one colour), two → duo (left lanes orange, right lanes cyan).
 * flow keeps each blade swinging naturally (down after up, etc.). e = this beat's energy (0 = no blocks).
 */
export function notesForBeat(beat: number, e: number, cfg: DifficultyCfg, hands: Hand[], flow: Flow, rnd = Math.random): Note[] {
  if (!e) return [];
  const solo = hands.length === 1, out: Note[] = [];
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];

  for (const off of rnd() < cfg.halfBeats * e ? [0, 0.5] : [0]) {
    if (rnd() > cfg.density * Math.min(e, 1)) continue;
    const who: Hand[] = solo ? [hands[0]] : rnd() < cfg.doubles * e ? ['L', 'R'] : [pick(['L', 'R'] as const)];
    for (const hand of who) {
      const dir = (flow[hand] = rnd() < 0.7 ? OPP[flow[hand]] : pick(ALL));
      const lane = solo ? pick([0, 1, 2, 3]) : (hand === 'L' ? 0 : 2) + pick([0, 1]);
      out.push({ beat: beat + off, hand, lane, row: pick([0, 1, 1, 2]), dir });
    }
  }
  if (rnd() < cfg.bombs * e) {
    const free = [0, 1, 2, 3].filter((l) => !out.some((n) => n.lane === l));
    if (free.length) out.push({ beat, hand: hands[0], lane: pick(free), row: pick([0, 2]), dir: 'any', bomb: true });
  }
  return out;
}
