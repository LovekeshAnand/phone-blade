import { bladeDir, yawOf } from './orientation';

// Checks used by the phone's guided calibration.
export type Sample = { t: number; a: number; b: number }; // time (ms), deviceorientation alpha, beta

const DEG = 180 / Math.PI;

/** True when the blade has stayed within `deg` of where it points now for the last `ms`. */
export function steady(samples: Sample[], now: number, ms = 600, deg = 3) {
  const recent = samples.filter((s) => now - s.t <= ms);
  if (recent.length < 3 || recent[recent.length - 1].t - recent[0].t < ms * 0.7) return false;
  const last = recent[recent.length - 1], cur = bladeDir(last.a, last.b);
  return recent.every((s) => bladeDir(s.a, s.b).angleTo(cur) * DEG < deg);
}

/** Up/down tilt of the blade in degrees: 0 is level, 90 is pointing at the ceiling. */
export const tiltDeg = (s: Sample) => Math.asin(Math.max(-1, Math.min(1, bladeDir(s.a, s.b).y))) * DEG;

/** How far the blade turned from `from` to `to`, in degrees. Positive means right, as this phone reports it. */
export function turnDeg(from: Sample, to: Sample) {
  const d = yawOf(bladeDir(to.a, to.b)) - yawOf(bladeDir(from.a, from.b));
  return Math.atan2(Math.sin(d), Math.cos(d)) * DEG;
}
