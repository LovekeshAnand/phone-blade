import { Euler, Quaternion, Vector3 } from 'three';

export const UP = new Vector3(0, 1, 0);
const DEG = Math.PI / 180;
// deviceorientation is R = Rz(alpha)·Rx(beta)·Ry(gamma) in the Earth frame (x east, y north, z up).
// Rx(-90°) turns that into three.js world space (y up, -z forward).
const EARTH_TO_WORLD = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
const _q = new Quaternion(), _e = new Euler();

/** Phone attitude as a world quaternion. The blade is the phone's +Y axis (its top edge). */
export function phoneQuat(a: number, b: number, g: number, out = new Quaternion()) {
  return out.copy(EARTH_TO_WORLD).multiply(_q.setFromEuler(_e.set(b * DEG, g * DEG, a * DEG, 'ZXY')));
}

const X = new Vector3(1, 0, 0), MAX_PITCH_FIX = 30 * DEG;

/**
 * Correction that makes wherever the phone points right now count as "straight at the screen" (-Z):
 * first turn its heading to face the screen, then level out a small up/down tilt
 * (capped at 30°, so aiming at a TV mounted high on the wall still feels natural).
 */
export function recenterOffset(q: Quaternion, out = new Quaternion()) {
  const d = UP.clone().applyQuaternion(q);
  const yaw = new Quaternion().setFromAxisAngle(UP, Math.atan2(d.x, -d.z));
  const pitch = Math.max(-MAX_PITCH_FIX, Math.min(MAX_PITCH_FIX, Math.atan2(d.y, Math.hypot(d.x, d.z))));
  return out.setFromAxisAngle(X, -pitch).multiply(yaw);
}
