import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { bladeDir, calibrate, yawOf } from './orientation';
import { steady, tiltDeg, turnDeg, type Sample } from './calibration';
import { DIFFICULTY, notesForBeat, type Difficulty, type Flow } from './beatmap';
import { analyze, suggestDifficulty, synthTrack } from './track';
import type { Hand } from './protocol';

const DEG = 180 / Math.PI;
const near = (v: Vector3, x: number, y: number, z: number) => assert.ok(v.distanceTo(new Vector3(x, y, z)) < 1e-6, `${v.toArray()}`);

test('phone attitude maps to blade direction', () => {
  near(bladeDir(0, 0), 0, 0, -1); // flat, top edge forward
  near(bladeDir(0, 90), 0, 1, 0); // tipped up
  near(bladeDir(90, 0), -1, 0, 0); // alpha is counter-clockwise → left
  near(bladeDir(90, 0, true), 1, 0, 0); // a mirrored phone turns the other way
});

test('calibration: any center becomes straight ahead, turns keep their direction, sensitivity scales them', () => {
  for (const [a, b] of [[137, 10], [-30, -15], [5, 0], [250, 25]]) {
    const c = bladeDir(a, b);
    near(calibrate(c, c, 1), 0, 0, -1);
    near(calibrate(c, c, 0.6), 0, 0, -1); // sensitivity never moves the center
  }
  const c = bladeDir(137, 0);
  near(calibrate(bladeDir(137 + 90, 0), c, 1), -1, 0, 0); // turning left from center → blade left
  // sensitivity: a 20° turn right becomes 10° at 50% and 30° at 150%
  const right20 = bladeDir(137 - 20, 0);
  assert.ok(Math.abs(yawOf(calibrate(right20, c, 0.5)) * DEG - 10) < 1e-6);
  assert.ok(Math.abs(yawOf(calibrate(right20, c, 1.5)) * DEG - 30) < 1e-6);
  // a steep center (aiming at a high TV) is only levelled by 30°
  const steep = bladeDir(0, 50);
  assert.ok(Math.abs(Math.asin(calibrate(steep, steep, 1).y) * DEG - 20) < 1e-6);
});

test('guided calibration checks', () => {
  const hold = (a: number, b: number, ms = 800): Sample[] => Array.from({ length: 20 }, (_, i) => ({ t: (i * ms) / 19, a: a + Math.sin(i) * 0.3, b }));
  assert.ok(steady(hold(10, 0), 800), 'small hand tremor still counts as steady');
  const swing: Sample[] = Array.from({ length: 20 }, (_, i) => ({ t: i * 40, a: i * 2, b: 0 }));
  assert.ok(!steady(swing, 760), 'a moving phone is not steady');
  assert.ok(!steady(hold(10, 0).slice(-3), 800), 'needs enough history');
  // The 90° bug: holding the phone upright made the heading meaningless. Tilt check rejects that pose.
  assert.ok(Math.abs(tiltDeg({ t: 0, a: 0, b: 85 })) > 40);
  assert.ok(Math.abs(tiltDeg({ t: 0, a: 0, b: 8 })) < 40);
  // Turning right lowers alpha on a normal phone, so it reads as a positive turn; a mirrored phone reads negative.
  assert.ok(Math.abs(turnDeg({ t: 0, a: 30, b: 0 }, { t: 0, a: 0, b: 0 }) - 30) < 1e-6);
  assert.ok(turnDeg({ t: 0, a: 30, b: 0 }, { t: 0, a: 60, b: 0 }) < 0);
  assert.ok(Math.abs(turnDeg({ t: 0, a: 350, b: 0 }, { t: 0, a: 10, b: 0 }) + 20) < 1e-6, 'wraps across 0/360');
});

test('beatmap adapts to solo and duo', () => {
  for (const diff of Object.keys(DIFFICULTY) as Difficulty[]) {
    for (const hands of [['R'], ['L'], ['L', 'R']] as Hand[][]) {
      const flow: Flow = { L: 'up', R: 'up' };
      let notes = 0;
      const { energy } = synthTrack(110);
      for (let beat = 0; beat < energy.length; beat++) {
        const out = notesForBeat(beat, energy[beat], DIFFICULTY[diff], hands, flow);
        if (beat < 8) assert.equal(out.length, 0, 'count-in is empty');
        for (const n of out.filter((n) => !n.bomb)) {
          notes++;
          assert.ok(hands.includes(n.hand));
          if (hands.length === 2) assert.equal(n.lane < 2, n.hand === 'L', 'duo keeps colours on their side');
        }
        for (const bomb of out.filter((n) => n.bomb)) assert.ok(!out.some((n) => !n.bomb && n.lane === bomb.lane), 'bombs never share a lane');
      }
      assert.ok(notes > 60, `${diff}/${hands}: ${notes} notes`);
    }
  }
});

test('beat tracker finds tempo and phase of a song', () => {
  for (const [bpm, offset] of [[96, 0.37], [128, 1.1], [75, 0.2]]) {
    const sr = 22050, secs = 40, x = new Float32Array(sr * secs), period = 60 / bpm;
    for (let t = offset; t < secs; t += period) // dhol-ish hit on every beat, quieter tabla on off-beats
      for (const [at, amp] of [[t, 0.8], [t + period / 2, 0.25]] as const)
        for (let i = 0; i < sr * 0.15 && at * sr + i < x.length; i++)
          x[Math.floor(at * sr) + i] += amp * Math.exp(-i / (sr * 0.03)) * Math.sin((2 * Math.PI * 70 * i) / sr);
    for (let i = 0; i < x.length; i++) x[i] += (Math.random() - 0.5) * 0.02; // background hiss
    const r = analyze(x, sr);
    assert.ok(Math.abs(r.bpm - bpm) < 1, `bpm ${r.bpm} vs ${bpm}`);
    const errs = r.beats.map((b) => { const k = (b - offset) / period; return Math.abs(k - Math.round(k)) * period; });
    assert.ok(errs.sort((a, b) => a - b)[Math.floor(errs.length / 2)] < 0.03, `beats off by ${errs[Math.floor(errs.length / 2)]}s`);
    assert.ok(r.beats.every((b, i) => b >= 2.5 || r.energy[i] === 0), 'lead-in has no blocks');
    assert.ok(r.energy.filter((e) => e > 0).length > r.beats.length * 0.7, 'most beats get blocks');
  }
});

test('difficulty suggestion follows tempo', () => {
  assert.equal(suggestDifficulty({ bpm: 80 }), 'easy'); // slow romantic
  assert.equal(suggestDifficulty({ bpm: 105 }), 'normal'); // groovy
  assert.equal(suggestDifficulty({ bpm: 130 }), 'hard'); // dhol banger
});
