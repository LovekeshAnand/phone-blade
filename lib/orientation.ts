import { Quaternion, Vector3 } from 'three';

export const UP = new Vector3(0, 1, 0);
const DEG = Math.PI / 180, X = new Vector3(1, 0, 0), MAX_PITCH_FIX = 30 * DEG;
const ID = new Quaternion(), _q = new Quaternion(), _q2 = new Quaternion(), _c = new Vector3();

/**
 * Where the phone's top edge (the blade) points, in game space: x right, y up, -z toward the screen.
 * deviceorientation is R = Rz(alpha)·Rx(beta)·Ry(gamma); the top edge only depends on alpha (heading) and
 * beta (tilt), so rolling the wrist (gamma) never moves the blade.
 * `mirror` flips left and right for phones whose heading turns the other way (found during calibration).
 */
export function bladeDir(a: number, b: number, mirror = false, out = new Vector3()) {
  const A = (mirror ? -a : a) * DEG, B = b * DEG;
  return out.set(-Math.sin(A) * Math.cos(B), Math.sin(B), -Math.cos(A) * Math.cos(B));
}

/** Heading of a direction: 0 is straight at the screen, positive is to the right. */
export const yawOf = (d: Vector3) => Math.atan2(d.x, -d.z);

/**
 * Turn `center` into "straight at the screen" (levelling up to 30° of tilt, so a TV mounted high still feels natural),
 * then scale how far the blade moves away from that by `gain` (the sensitivity setting).
 */
export function calibrate(dir: Vector3, center: Vector3, gain: number, out = new Vector3()) {
  const pitch = Math.max(-MAX_PITCH_FIX, Math.min(MAX_PITCH_FIX, Math.asin(Math.max(-1, Math.min(1, center.y)))));
  const fix = _q.setFromAxisAngle(X, -pitch).multiply(_q2.setFromAxisAngle(UP, yawOf(center)));
  out.copy(dir).applyQuaternion(fix);
  _c.copy(center).applyQuaternion(fix);
  if (gain === 1) return out;
  const delta = _q2.setFromUnitVectors(_c, out);
  return out.copy(_c).applyQuaternion(_q.slerpQuaternions(ID, delta, gain));
}
