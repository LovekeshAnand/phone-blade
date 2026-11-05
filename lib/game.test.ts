import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { phoneQuat, recenterOffset, UP } from './orientation';
import { DIFFICULTY, notesForBeat, type Difficulty, type Flow } from './beatmap';
import { analyze, suggestDifficulty, synthTrack } from './track';
import type { Hand } from './protocol';

const blade = (a: number, b: number, g: number) => UP.clone().applyQuaternion(phoneQuat(a, b, g));
const near = (v: Vector3, x: number, y: number, z: number) => assert.ok(v.distanceTo(new Vector3(x, y, z)) < 1e-6, `${v.toArray()}`);

test('phone attitude maps to blade direction', () => {
  near(blade(0, 0, 0), 0, 0, -1); // flat, top edge forward
  near(blade(0, 90, 0), 0, 1, 0); // tipped up
  near(blade(90, 0, 0), -1, 0, 0); // alpha is counter-clockwise → left
  near(blade(0, 0, 60), 0, 0, -1); // rolling the wrist doesn't move the blade
  // recenter: any heading + a slight tilt becomes exactly "straight at the screen"
  for (const [a, b] of [[137, 10], [-30, -15], [5, 0]]) {
    const raw = phoneQuat(a, b, 25);
    near(UP.clone().applyQuaternion(recenterOffset(raw).multiply(raw)), 0, 0, -1);
  }
  // after recentering, turning the phone still turns the blade the same way
  const raw = phoneQuat(137, 0, 0), fix = recenterOffset(raw);
  near(UP.clone().applyQuaternion(fix.clone().multiply(phoneQuat(137 + 90, 0, 0))), -1, 0, 0);
  // a steep tilt (aiming at a high TV) is only levelled by 30°
  const steep = phoneQuat(0, 50, 0), up = UP.clone().applyQuaternion(recenterOffset(steep).multiply(steep));
  assert.ok(Math.abs(Math.asin(up.y) * 180 / Math.PI - 20) < 1e-6, `left ${up.y}`);
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
