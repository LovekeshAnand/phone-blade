import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { Music } from './audio';
import { DIFFICULTY, notesForBeat, type Difficulty, type DifficultyCfg, type Dir, type Flow, type Note } from './beatmap';
import { bladeDir, calibrate, UP } from './orientation';
import { HANDS, HAND_COLOR, type Hand, type Remotes } from './protocol';
import { synthTrack, type Track } from './track';
import { swingScore } from './swing';

// Note: tuning knobs. Real phone sensors differ, so adjust these after playing.
// Adaptive smoothing: a still hand gets SMOOTH_MIN (hides sensor jitter); the faster the swing, the closer to raw (no lag).
const SMOOTH_MIN = 0.22; // per 60fps frame, 1 = raw
const SMOOTH_GAIN = 10; // per radian the blade is behind its target
const PREDICT = 0; // seconds of motion extrapolation to hide network delay (0 = off; higher overshoots at the end of swings and feels twitchy)
const MIN_SWING = 1.5; // blade tip speed (m/s) needed for a clean cut
const BLADE = 1.25; // reach from the hand (m)
const HIT_R = 0.42, BOMB_R = 0.2; // touch radius: a bit wider than the block, so near misses still cut
const HIT_Z = -0.9, SPAWN_Z = -28, MISS_Z = 0.8, CUT_FROM = -2.4, CUT_TO = -0.1;
const LANES = [-0.75, -0.25, 0.25, 0.75], ROWS = [0.72, 1.12, 1.52];
const HAND_X = 0.3, HAND_Y = 1.0, HAND_Z = -0.2;
// Arm model: phones know only their angle, so the hand drifts toward where the blade points. Big swings sweep wide
// arcs, small ones stay tight. 0 pins the hand in place.
const ARM = 0.25, REST_Y = Math.cos(Math.PI / 2.4);
const POST_WINDOW = 0.25; // seconds of follow-through counted after a cut
const SWING_STILL = 0.8; // tip speed (m/s) below which the blade counts as still and the swing arc restarts
const DIR_VEC: Record<Dir, [number, number] | null> = { up: [0, 1], down: [0, -1], left: [-1, 0], right: [1, 0], any: null };
const DIR_ROT: Record<Dir, number> = { up: 0, down: Math.PI, left: Math.PI / 2, right: -Math.PI / 2, any: 0 };

export type Mode = 'mouse' | 'solo' | 'duo';
export interface Judge { id: number; text: string; good: boolean }
export interface Stats { score: number; combo: number; mult: number; energy: number; progress: number; judge: Judge | null }
export interface Results { score: number; maxCombo: number; hits: number; total: number; accuracy: number; rank: string; failed: boolean; difficulty: Difficulty; title: string }
export interface EngineEvents { stats(s: Stats): void; end(r: Results): void; haptic(h: Hand, good: boolean): void }
export type CalibStep = 'center' | 'edge';

/** What the engine needs from the soundtrack. `Music` in the game; a scripted clock when rendering the trailer frame by frame. */
export interface SongClock {
  readonly now: number;
  beat(t: number, beat: number, B: number, energy: number): void;
  sfx(kind: 'cut' | 'bad' | 'bomb'): void;
  play(buffer: AudioBuffer, at: number): void;
  pause(): void;
  resume(): void;
  close(): void;
}

const VIEW = {
  play: { pos: new THREE.Vector3(0, 1.55, 1.0), look: new THREE.Vector3(0, 1.05, -5) },
  // Close behind the hands, so the blade being calibrated fills the screen and points into it.
  calibrate: { pos: new THREE.Vector3(0, 1.2, 0.45), look: new THREE.Vector3(0, 1.0, -3) },
};
const WHITE = new THREE.Color(1, 1, 1);
const EDGE_YAW = 25 * Math.PI / 180; // where the step 2 target ring sits (any turn past 12° completes the step)

interface Saber {
  group: THREE.Group; target: THREE.Quaternion; prev: THREE.Quaternion;
  center: THREE.Vector3; mirror: boolean; gain: number; needsCal: boolean; // calibration
  sample: THREE.Quaternion; sampleAt: number; // last sensor pose, for prediction
  tip: THREE.Vector3; vel: THREE.Vector3; trail: Trail;
  baseX: number; prevPos: THREE.Vector3; // arm model
  arc: number; swing: THREE.Vector3; // degrees turned in the current swing, and its direction on screen
}
interface Pending { h: Hand; start: number; post: number; off: number; until: number }
interface Block { root: THREE.Group; note: Note; time: number; spin: number }
interface Debris { mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>; vel: THREE.Vector3; spin: THREE.Vector3; life: number }

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _d = new THREE.Vector3(), _d2 = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _seg = new THREE.Line3();

/** Ribbon behind the blade tip, faded via vertex colours under additive blending. */
class Trail {
  static N = 18;
  readonly mesh: THREE.Mesh;
  private pos = new Float32Array(Trail.N * 6);
  private attr: THREE.BufferAttribute;
  private filled = false;
  constructor(color: THREE.Color) {
    const N = Trail.N, col = new Float32Array(N * 6), idx: number[] = [];
    for (let i = 0; i < N; i++) {
      const f = (1 - i / (N - 1)) ** 2 * 0.5;
      col.set([color.r * f * 0.25, color.g * f * 0.25, color.b * f * 0.25, color.r * f, color.g * f, color.b * f], i * 6);
      if (i < N - 1) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    }
    const geo = new THREE.BufferGeometry();
    this.attr = new THREE.BufferAttribute(this.pos, 3);
    geo.setAttribute('position', this.attr);
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx);
    this.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    this.mesh.frustumCulled = false;
  }
  push(base: THREE.Vector3, tip: THREE.Vector3) {
    if (!this.filled) { for (let i = 0; i < Trail.N; i++) this.pos.set([base.x, base.y, base.z, tip.x, tip.y, tip.z], i * 6); this.filled = true; }
    else this.pos.copyWithin(6, 0, this.pos.length - 6);
    this.pos.set([base.x, base.y, base.z, tip.x, tip.y, tip.z], 0);
    this.attr.needsUpdate = true;
  }
}

/** Pooled spark particles. */
class Sparks {
  static MAX = 600;
  readonly points: THREE.Points;
  private pos = new Float32Array(Sparks.MAX * 3).fill(-100);
  private col = new Float32Array(Sparks.MAX * 3);
  private vel = new Float32Array(Sparks.MAX * 3);
  private life = new Float32Array(Sparks.MAX);
  private next = 0;
  constructor() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.points = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.035, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.points.frustumCulled = false;
  }
  emit(at: THREE.Vector3, color: THREE.Color, dir: THREE.Vector3, n: number) {
    for (let k = 0; k < n; k++) {
      const i = this.next, sp = 1.5 + Math.random() * 3.5;
      this.next = (i + 1) % Sparks.MAX;
      _v.randomDirection().multiplyScalar(sp * 0.6).addScaledVector(dir, sp * 0.6);
      this.pos.set([at.x, at.y, at.z], i * 3);
      this.vel.set([_v.x, _v.y, _v.z], i * 3);
      this.col.set([color.r * 1.6, color.g * 1.6, color.b * 1.6], i * 3);
      this.life[i] = 0.4 + Math.random() * 0.4;
    }
  }
  update(dt: number) {
    for (let i = 0; i < Sparks.MAX; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      this.vel[i * 3 + 1] -= 5 * dt;
      for (let j = 0; j < 3; j++) { this.pos[i * 3 + j] += this.vel[i * 3 + j] * dt; this.col[i * 3 + j] *= this.life[i] > 0 ? 1 - dt * 2.2 : 0; }
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;
  }
}

export class Engine {
  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(70, 1, 0.05, 120);
  private sabers: Record<Hand, Saber>;
  private remotes: Remotes = { L: false, R: false };
  private music: SongClock | null = null;
  /** Attract mode: the engine swings both blades itself, perfectly on the beat. Used for the trailer. */
  autopilot = false;
  private calib: Partial<Record<Hand, { step: CalibStep; ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial> }>> = {};
  private cam = { pos: VIEW.play.pos.clone(), look: VIEW.play.look.clone(), toPos: VIEW.play.pos.clone(), toLook: VIEW.play.look.clone(), locked: false };
  private state: 'idle' | 'playing' | 'paused' = 'idle';
  private difficulty: Difficulty = 'normal';
  private cfg: DifficultyCfg = DIFFICULTY.normal;
  private track: Track = synthTrack(DIFFICULTY.normal.bpm);
  private pulseIdx = 0;
  private songStart = 0;
  private schedBeat = 0;
  private flow: Flow = { L: 'up', R: 'up' };
  private blocks: Block[] = [];
  private debris: Debris[] = [];
  private pending: Pending[] = []; // cuts waiting for their follow-through to be scored
  private sparks = new Sparks();
  private rings: THREE.LineSegments[] = [];
  private ringMat = new THREE.LineBasicMaterial();
  private grid = new THREE.GridHelper(80, 80, 0x2a2f66, 0x141838);
  private st = { score: 0, combo: 0, maxCombo: 0, hits: 0, total: 0, points: 0, energy: 0.6 };
  private judge: Judge | null = null;
  private raf = 0;
  private last = performance.now();
  private statsAt = 0;
  private shake = 0;
  private colors = { L: new THREE.Color(HAND_COLOR.L), R: new THREE.Color(HAND_COLOR.R) };
  private geo = {
    block: new RoundedBoxGeometry(0.46, 0.46, 0.46, 3, 0.06),
    edges: new THREE.EdgesGeometry(new THREE.BoxGeometry(0.47, 0.47, 0.47)),
    arrow: new THREE.ShapeGeometry(new THREE.Shape([new THREE.Vector2(-0.13, -0.06), new THREE.Vector2(0.13, -0.06), new THREE.Vector2(0, 0.09)])),
    dot: new THREE.CircleGeometry(0.06, 24),
    half: new THREE.BoxGeometry(0.46, 0.23, 0.46),
    bomb: new THREE.IcosahedronGeometry(0.17, 1),
    spikes: new THREE.EdgesGeometry(new THREE.OctahedronGeometry(0.27)),
  };
  private mat = {
    block: { L: this.blockMat('L'), R: this.blockMat('R') },
    edge: { L: new THREE.LineBasicMaterial({ color: this.colors.L.clone().multiplyScalar(2) }), R: new THREE.LineBasicMaterial({ color: this.colors.R.clone().multiplyScalar(2) }) },
    mark: new THREE.MeshBasicMaterial({ color: new THREE.Color(2, 2, 2) }),
    bomb: new THREE.MeshStandardMaterial({ color: 0x15151c, metalness: 0.7, roughness: 0.3 }),
    spikes: new THREE.LineBasicMaterial({ color: new THREE.Color(2, 0.15, 0.3) }),
  };

  constructor(private canvas: HTMLCanvasElement, private ev: EngineEvents, private makeMusic: () => SongClock = () => new Music()) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.camera.position.set(0, 1.55, 1.0);
    this.camera.lookAt(0, 1.05, -5);
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.4, 0.3));
    this.composer.addPass(new OutputPass());
    this.buildWorld();
    this.sabers = { L: this.makeSaber('L'), R: this.makeSaber('R') };
    this.scene.add(this.sparks.points);
    this.resize();
    addEventListener('resize', this.resize);
    addEventListener('pointermove', this.onPointer);
    this.raf = requestAnimationFrame(this.frame);
  }

  // ---------- public API ----------
  get mode(): Mode { return this.remotes.L && this.remotes.R ? 'duo' : this.remotes.L || this.remotes.R ? 'solo' : 'mouse'; }

  setRemotes(r: Remotes) { this.remotes = { ...r }; }

  orient(h: Hand, a: number, b: number) {
    const s = this.sabers[h], now = performance.now() / 1000;
    bladeDir(a, b, s.mirror, _d);
    if (s.needsCal) { s.center.copy(_d); s.needsCal = false; s.sampleAt = 0; } // provisional until the phone's calibration arrives
    const q = _q2.setFromUnitVectors(UP, calibrate(_d, s.center, s.gain, _d2));
    // Predict a little ahead from the last two samples to hide the Wi-Fi + sensor delay.
    const gap = now - s.sampleAt;
    if (s.sampleAt && gap > 0.004 && gap < 0.08) s.target.slerpQuaternions(s.sample, q, 1 + Math.min(2, PREDICT / gap));
    else s.target.copy(q);
    s.sample.copy(q);
    s.sampleAt = now;
  }

  /** The next motion sample becomes "straight at the screen". */
  recenter(h: Hand) { this.sabers[h].needsCal = true; }

  /** Calibration from the phone's guided setup: center pose, left/right direction, sensitivity. */
  configure(h: Hand, c: { center?: [number, number]; mirror?: boolean; gain?: number }) {
    const s = this.sabers[h];
    if (typeof c.mirror === 'boolean') s.mirror = c.mirror;
    if (Number.isFinite(c.gain)) s.gain = Math.min(1.5, Math.max(0.5, c.gain!));
    if (c.center) { bladeDir(c.center[0], c.center[1], s.mirror, s.center); s.needsCal = false; s.sampleAt = 0; }
  }

  /**
   * Show the calibration view for a blade: the camera moves in close behind the hands and a glowing ring marks
   * where the blade tip should point (step 1: straight at the screen, step 2: to the right). null hides it.
   */
  showCalibration(h: Hand, step: CalibStep | null) {
    const cur = this.calib[h];
    if (cur && (!step || cur.step !== step)) { this.scene.remove(cur.ring); cur.ring.geometry.dispose(); cur.ring.material.dispose(); delete this.calib[h]; }
    if (step && !this.calib[h]) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.07, 0.095, 48), new THREE.MeshBasicMaterial({ color: this.colors[h], transparent: true, side: THREE.DoubleSide, depthWrite: false }));
      this.scene.add(ring);
      this.calib[h] = { step, ring };
    }
    if (!this.cam.locked) {
      const v = Object.keys(this.calib).length ? VIEW.calibrate : VIEW.play;
      this.cam.toPos.copy(v.pos); this.cam.toLook.copy(v.look);
    }
  }

  /** Take over the camera (trailer shots). Pass null to hand it back to the game. */
  setCamera(pos: THREE.Vector3Like | null, look?: THREE.Vector3Like, instant = false) {
    this.cam.locked = !!pos;
    const v = Object.keys(this.calib).length ? VIEW.calibrate : VIEW.play;
    this.cam.toPos.copy(pos ?? v.pos); this.cam.toLook.copy(look ?? v.look);
    if (instant) { this.cam.pos.copy(this.cam.toPos); this.cam.look.copy(this.cam.toLook); }
  }

  /** Blade length from 0 (hilt only) to 1 (full), for the ignition effect. */
  ignite(k: number) {
    const len = BLADE - 0.1, f = Math.max(0.001, Math.min(1, k));
    for (const h of HANDS) for (const m of this.sabers[h].group.children.slice(1)) { m.scale.y = f; m.position.y = 0.1 + (len * f) / 2; }
  }

  /** Where a blade points right now (world space, unit vector). */
  bladeDirection(h: Hand, out = new THREE.Vector3()) { return out.copy(UP).applyQuaternion(this.sabers[h].group.quaternion); }

  /** song = a beat-tracked audio file, or null for the built-in synth track. */
  start(difficulty: Difficulty, song: Track | null = null) {
    this.quit();
    this.music = this.makeMusic();
    this.difficulty = difficulty;
    const base = DIFFICULTY[difficulty];
    this.track = song ?? synthTrack(base.bpm);
    // fast songs get fewer blocks per beat so Easy stays easy
    this.cfg = { ...base, density: base.density * Math.min(1.2, Math.max(0.5, base.bpm / this.track.bpm)) };
    this.pulseIdx = 0;
    this.st = { score: 0, combo: 0, maxCombo: 0, hits: 0, total: 0, points: 0, energy: 0.6 };
    this.pending = [];
    this.judge = null;
    this.flow = { L: 'up', R: 'up' };
    this.songStart = this.music.now + 0.4;
    if (this.track.buffer) this.music.play(this.track.buffer, this.songStart);
    this.schedBeat = 0;
    this.state = 'playing';
    this.emit();
  }
  pause() { if (this.state === 'playing') { this.music?.pause(); this.state = 'paused'; } }
  resume() { if (this.state === 'paused') { this.music?.resume(); this.state = 'playing'; } }
  quit() {
    this.music?.close();
    this.music = null;
    this.state = 'idle';
    for (const b of this.blocks) this.scene.remove(b.root);
    this.blocks = [];
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    removeEventListener('resize', this.resize);
    removeEventListener('pointermove', this.onPointer);
    this.quit();
    this.composer.dispose();
    this.renderer.dispose();
  }

  // ---------- setup ----------
  private blockMat(h: Hand) {
    return new THREE.MeshStandardMaterial({ color: this.colors[h], emissive: this.colors[h], emissiveIntensity: 0.3, roughness: 0.35, metalness: 0.2 });
  }

  private buildWorld() {
    const s = this.scene;
    s.background = new THREE.Color(0x04050a);
    s.fog = new THREE.Fog(0x04050a, 10, 42);
    s.add(new THREE.HemisphereLight(0x8899ff, 0x10101a, 1.3));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(1, 3, 2);
    s.add(sun);
    this.grid.position.set(0, -0.01, -36);
    s.add(this.grid);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 80), new THREE.MeshStandardMaterial({ color: 0x0a0c16, roughness: 0.6, metalness: 0.4 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0, -36);
    s.add(floor);
    for (const h of HANDS) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.025, 80), new THREE.MeshBasicMaterial({ color: this.colors[h].clone().multiplyScalar(1.1) }));
      rail.position.set(h === 'L' ? -1.2 : 1.2, 0.015, -36);
      s.add(rail);
    }
    const ringGeo = new THREE.EdgesGeometry(new THREE.PlaneGeometry(7.5, 5));
    for (let i = 0; i < 16; i++) {
      const ring = new THREE.LineSegments(ringGeo, this.ringMat);
      ring.position.set(0, 2.2, -4 - i * 3);
      this.rings.push(ring);
      s.add(ring);
    }
  }

  private makeSaber(h: Hand): Saber {
    const color = this.colors[h], len = BLADE - 0.1;
    const group = new THREE.Group();
    group.position.set(h === 'L' ? -HAND_X : HAND_X, HAND_Y, HAND_Z);
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.026, 0.22, 12), new THREE.MeshStandardMaterial({ color: 0x2a2c38, metalness: 0.9, roughness: 0.25 }));
    const core = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, len, 8), new THREE.MeshBasicMaterial({ color: color.clone().lerp(new THREE.Color(1, 1, 1), 0.7).multiplyScalar(2) }));
    const glow = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, len, 12), new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(1.4), transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }));
    core.position.y = glow.position.y = 0.1 + len / 2;
    group.add(handle, core, glow);
    const rest = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2.4, 0, 0));
    group.quaternion.copy(rest);
    const trail = new Trail(color);
    this.scene.add(group, trail.mesh);
    return { group, target: rest.clone(), prev: rest.clone(), center: new THREE.Vector3(0, 0, -1), mirror: false, gain: 0.8, needsCal: true, sample: rest.clone(), sampleAt: 0, tip: this.along(group, BLADE, new THREE.Vector3()), vel: new THREE.Vector3(), trail,
      baseX: group.position.x, prevPos: group.position.clone(), arc: 0, swing: new THREE.Vector3() };
  }

  private along(g: THREE.Object3D, dist: number, out: THREE.Vector3, q = g.quaternion, pos = g.position) {
    return out.copy(UP).multiplyScalar(dist).applyQuaternion(q).add(pos);
  }

  private resize = () => {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.fov = w / h < 1 ? 90 : 70; // portrait screens need a wider view
    this.camera.updateProjectionMatrix();
  };

  private onPointer = (e: PointerEvent) => {
    if (this.mode !== 'mouse' || e.pointerType === 'touch') return;
    const yaw = -(e.clientX / innerWidth - 0.5) * 2.2, pitch = (0.5 - e.clientY / innerHeight) * 2.2;
    this.sabers.R.target.setFromEuler(new THREE.Euler(-Math.PI / 2 + pitch, yaw, 0, 'YXZ'));
  };

  private activeHands(): Hand[] {
    const a = HANDS.filter((h) => this.remotes[h]);
    return a.length ? a : ['R'];
  }

  // ---------- loop ----------
  private frame = () => {
    this.raf = requestAnimationFrame(this.frame);
    const nowMs = performance.now(), dt = Math.min(Math.max((nowMs - this.last) / 1000, 0.001), 0.05);
    this.last = nowMs;
    const active = this.activeHands();
    const t = this.music && this.state !== 'idle' ? this.music.now : nowMs / 1000;

    if (this.autopilot && this.state === 'playing') for (const h of active) this.autoAim(h, t);

    for (const h of HANDS) {
      const s = this.sabers[h], on = active.includes(h);
      s.group.visible = s.trail.mesh.visible = on;
      const x = active.length === 2 ? (h === 'L' ? -HAND_X : HAND_X) : 0;
      s.baseX += (x - s.baseX) * Math.min(1, dt * 6);
      s.prev.copy(s.group.quaternion);
      s.prevPos.copy(s.group.position);
      const follow = Math.min(1, SMOOTH_MIN + s.group.quaternion.angleTo(s.target) * SMOOTH_GAIN);
      s.group.quaternion.slerp(s.target, 1 - (1 - follow) ** (dt * 60));
      _d.copy(UP).applyQuaternion(s.group.quaternion);
      s.group.position.set(s.baseX + ARM * _d.x, HAND_Y + ARM * (_d.y - REST_Y), HAND_Z);
      this.along(s.group, BLADE, _v);
      s.vel.lerp(_v2.subVectors(_v, s.tip).divideScalar(dt), 0.5);
      s.tip.copy(_v);
      this.trackSwing(s);
      s.trail.push(this.along(s.group, 0.45, _v2), s.tip);
    }

    if (this.state === 'playing') { this.updateSong(t, active); this.scorePending(t); }
    this.updateWorld(t, dt);
    this.sparks.update(dt);
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.life -= dt;
      d.vel.y -= 9.8 * dt;
      d.mesh.position.addScaledVector(d.vel, dt);
      d.mesh.rotation.x += d.spin.x * dt; d.mesh.rotation.y += d.spin.y * dt; d.mesh.rotation.z += d.spin.z * dt;
      d.mesh.material.opacity = clamp01(d.life / 0.9);
      if (d.life <= 0) { this.scene.remove(d.mesh); d.mesh.material.dispose(); this.debris.splice(i, 1); }
    }
    this.updateCalibration(nowMs / 1000);
    this.shake = Math.max(0, this.shake - dt * 0.25);
    const ease = 1 - Math.exp(-dt * 3); // camera glides between views
    this.cam.pos.lerp(this.cam.toPos, ease);
    this.cam.look.lerp(this.cam.toLook, ease);
    this.camera.position.set(this.cam.pos.x + (Math.random() - 0.5) * this.shake, this.cam.pos.y + (Math.random() - 0.5) * this.shake, this.cam.pos.z);
    this.camera.lookAt(this.cam.look);
    this.composer.render();
  };

  /** Measure how far the blade has turned in one continuous direction: a reversal or a pause starts a new swing. */
  private trackSwing(s: Saber) {
    const sp = Math.hypot(s.vel.x, s.vel.y);
    if (sp < SWING_STILL) { s.arc = 0; s.swing.set(0, 0, 0); return; }
    _v2.set(s.vel.x / sp, s.vel.y / sp, 0);
    const turned = s.prev.angleTo(s.group.quaternion) * (180 / Math.PI);
    s.arc = s.swing.dot(_v2) > 0 ? s.arc + turned : turned;
    s.swing.copy(_v2);
  }

  /** Follow-through: keep counting the arc after a cut until the swing stops, reverses, or the window closes. */
  private scorePending(now: number) {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i], s = this.sabers[p.h], post = s.arc - p.start;
      const broke = post < p.post; // the arc restarted: the swing ended
      if (!broke) p.post = post;
      if (!broke && now < p.until) continue;
      const { pts, text } = swingScore(p.start, p.post, p.off);
      this.st.points += pts;
      this.st.score += pts * this.mult;
      this.setJudge(text, true);
      this.pending.splice(i, 1);
      this.emit();
    }
  }

  /** Calibration rings sit where the blade tip should be; they pulse, and lock bright when the tip lines up. */
  private updateCalibration(t: number) {
    for (const h of HANDS) {
      const c = this.calib[h];
      if (!c) continue;
      const s = this.sabers[h], yaw = c.step === 'edge' ? EDGE_YAW : 0;
      c.ring.position.set(s.group.position.x + Math.sin(yaw) * BLADE, s.group.position.y, s.group.position.z - Math.cos(yaw) * BLADE);
      c.ring.lookAt(this.camera.position);
      const locked = s.tip.distanceTo(c.ring.position) < 0.12;
      c.ring.scale.setScalar(locked ? 1.15 : 1 + 0.12 * Math.sin(t * 6));
      c.ring.material.color.copy(this.colors[h]).lerp(WHITE, locked ? 0.55 : 0).multiplyScalar(locked ? 1.15 : 1.2); // a soft lock, not a bloom flare
    }
  }

  /** Attract mode: wind up opposite the arrow, then sweep through the next block of this hand exactly on its beat. */
  private autoAim(h: Hand, now: number) {
    const s = this.sabers[h];
    let next: Block | null = null, after: Block | null = null;
    for (const b of this.blocks) {
      if (b.note.bomb || b.note.hand !== h || b.time < now - 0.15) continue;
      if (!next || b.time < next.time) { after = next; next = b; } else if (!after || b.time < after.time) after = b;
    }
    const pivot = s.group.position;
    if (!next) { // idle sway while waiting
      _v.set(pivot.x + Math.sin(now * 1.7 + (h === 'L' ? 1 : 0)) * 0.15, 1.05, pivot.z - 1);
    } else {
      const d = DIR_VEC[next.note.dir] ?? [0, -1];
      const half = after && after.time - next.time < 0.35 ? 0.055 : 0.08; // quicker swings for fast pairs
      const k = -0.7 + 1.4 * clamp01((now - next.time + half) / (2 * half)); // -0.7 wound up → +0.7 follow through
      _v.set(next.root.position.x + d[0] * k, next.root.position.y + d[1] * k, HIT_Z);
    }
    s.target.setFromUnitVectors(UP, _v2.subVectors(_v, pivot).normalize());
  }

  private updateWorld(t: number, dt: number) {
    let pulse = 0.3 + 0.2 * Math.sin(t * 2);
    if (this.state !== 'idle') {
      const { beats, energy, bpm } = this.track, rel = t - this.songStart;
      while (this.pulseIdx < beats.length - 1 && beats[this.pulseIdx + 1] <= rel) this.pulseIdx++;
      const since = rel - beats[this.pulseIdx];
      pulse = since < 0 ? 0 : Math.exp(-since * (bpm / 60) * 5) * (energy[this.pulseIdx] >= 0.5 ? 1 : 0.35);
    }
    this.ringMat.color.setRGB(0.48, 0.36, 1).multiplyScalar(0.25 + 1.6 * pulse);
    const v = this.state === 'playing' ? this.cfg.speed * 0.5 : this.state === 'paused' ? 0 : 1.5;
    for (const r of this.rings) { r.position.z += v * dt; if (r.position.z > 2) r.position.z -= 48; }
    this.grid.position.z = -36 + ((this.grid.position.z + 36 + v * dt) % 1);
  }

  private updateSong(now: number, active: Hand[]) {
    const { beats, energy, bpm, buffer, duration } = this.track, B = 60 / bpm, travel = (HIT_Z - SPAWN_Z) / this.cfg.speed;
    const beatTime = (b: number) => { const i = Math.floor(b); return beats[i] + (b - i) * ((beats[i + 1] ?? beats[i] + B) - beats[i]); };
    while (this.schedBeat < beats.length && this.songStart + beats[this.schedBeat] < now + travel) {
      const i = this.schedBeat++;
      if (!buffer) this.music!.beat(this.songStart + beats[i], i, B, energy[i]); // synth track plays itself beat by beat
      for (const n of notesForBeat(i, energy[i], this.cfg, active, this.flow)) this.spawn(n, this.songStart + beatTime(n.beat));
    }

    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i], z = HIT_Z - (b.time - now) * this.cfg.speed;
      const ease = 1 - (1 - clamp01((1 - (b.time - now) / travel) / 0.2)) ** 3; // fly-in: grow + unspin
      b.root.position.z = z;
      b.root.scale.setScalar(0.05 + 0.95 * ease);
      b.root.rotation.z = b.spin * (1 - ease);
      if (b.note.bomb) { b.root.rotation.x += 0.03; b.root.rotation.y += 0.02; }
      if (z > CUT_FROM && z < CUT_TO) {
        const order = active.includes(b.note.hand) ? [b.note.hand, ...active.filter((x) => x !== b.note.hand)] : active; // own blade first
        const h = this.touching(b.root.position, order, b.note.bomb ? BOMB_R : HIT_R);
        if (h) { this.cut(b, h); this.remove(i); continue; }
      }
      if (z > MISS_Z) {
        if (!b.note.bomb) this.fail('MISS');
        this.remove(i);
      }
    }

    if (nowMs() - this.statsAt > 250) this.emit();
    if (this.state === 'playing' && this.schedBeat >= beats.length && !this.blocks.length && now > this.songStart + duration + 0.3) this.finish(false);
  }

  private spawn(note: Note, time: number) {
    if (note.bomb && this.autopilot) return; // attract mode plays a clean run
    const root = new THREE.Group();
    if (note.bomb) root.add(new THREE.Mesh(this.geo.bomb, this.mat.bomb), new THREE.LineSegments(this.geo.spikes, this.mat.spikes));
    else {
      const mark = new THREE.Mesh(note.dir === 'any' ? this.geo.dot : this.geo.arrow, this.mat.mark);
      mark.position.z = 0.235;
      mark.rotation.z = DIR_ROT[note.dir];
      root.add(new THREE.Mesh(this.geo.block, this.mat.block[note.hand]), new THREE.LineSegments(this.geo.edges, this.mat.edge[note.hand]), mark);
    }
    root.position.set(LANES[note.lane], ROWS[note.row], SPAWN_Z);
    root.scale.setScalar(0.05);
    this.scene.add(root);
    this.blocks.push({ root, note, time, spin: (Math.random() - 0.5) * Math.PI });
  }

  private remove(i: number) { this.scene.remove(this.blocks[i].root); this.blocks.splice(i, 1); }

  /** Which blade touches pos? Samples 5 blade poses between frames so fast swings can't tunnel through. */
  private hitOff = 0; // how far from the block's center the last touch was, 0 to 1
  private touching(pos: THREE.Vector3, active: Hand[], radius: number): Hand | null {
    for (const h of active) {
      const s = this.sabers[h];
      for (let k = 0; k <= 4; k++) {
        _q.slerpQuaternions(s.prev, s.group.quaternion, k / 4);
        _d2.lerpVectors(s.prevPos, s.group.position, k / 4);
        this.along(s.group, 0.1, _seg.start, _q, _d2);
        this.along(s.group, BLADE, _seg.end, _q, _d2);
        const dist = _seg.closestPointToPoint(pos, true, _v).distanceTo(pos);
        if (dist < radius) { this.hitOff = dist / radius; return h; }
      }
    }
    return null;
  }

  private cut(b: Block, h: Hand) {
    const s = this.sabers[h], v = s.vel, sp = Math.hypot(v.x, v.y), pos = b.root.position;
    if (b.note.bomb) {
      this.music?.sfx('bomb');
      this.sparks.emit(pos, new THREE.Color(1, 0.1, 0.2), _v.set(0, 1, 0), 60);
      this.shake = 0.12;
      this.ev.haptic(h, false);
      this.fail('BOMB!', 0.18, false);
      return;
    }
    const need = DIR_VEC[b.note.dir];
    const problem = h !== b.note.hand ? 'WRONG COLOR' : sp < MIN_SWING ? 'SWING HARDER' : need && (v.x * need[0] + v.y * need[1]) / sp < 0.45 ? 'WRONG WAY' : null;
    this.ev.haptic(h, !problem);
    if (problem) { this.music?.sfx('bad'); this.shake = 0.04; this.fail(problem); return; }

    const st = this.st, now = this.music?.now ?? 0;
    st.combo++; st.maxCombo = Math.max(st.maxCombo, st.combo); st.hits++; st.total++;
    st.energy = Math.min(1, st.energy + 0.025);
    this.pending.push({ h, start: s.arc, post: 0, off: this.hitOff, until: now + POST_WINDOW }); // scored once the follow-through is in
    this.music?.sfx('cut');

    const ang = Math.atan2(v.y, v.x), perp = new THREE.Vector3(-Math.sin(ang), Math.cos(ang), 0), color = this.colors[b.note.hand];
    for (const side of [1, -1]) {
      const m = this.mat.block[b.note.hand].clone();
      m.transparent = true;
      const mesh = new THREE.Mesh(this.geo.half, m);
      mesh.position.copy(pos).addScaledVector(perp, side * 0.1);
      mesh.rotation.z = ang;
      this.scene.add(mesh);
      this.debris.push({ mesh, vel: perp.clone().multiplyScalar(side * 1.8).add(new THREE.Vector3(v.x * 0.12, 0.8, 2.5)), spin: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, side).multiplyScalar(8), life: 0.9 });
    }
    this.sparks.emit(pos, color, _v.set(v.x, v.y, 0).normalize(), 30);
    this.emit();
  }

  private get mult() { return 1 + Math.min(3, Math.floor(this.st.combo / 8)); }

  private fail(text: string, drain = 0.08, counts = true) {
    this.st.combo = 0;
    if (counts) this.st.total++;
    this.st.energy -= drain * (this.difficulty === 'easy' ? 0.5 : 1);
    this.setJudge(text, false);
    this.emit();
    if (this.st.energy <= 0) this.finish(true);
  }

  private setJudge(text: string, good: boolean) { this.judge = { id: (this.judge?.id ?? 0) + 1, text, good }; }

  private emit() {
    this.statsAt = nowMs();
    const now = this.music?.now ?? 0;
    this.ev.stats({ score: this.st.score, combo: this.st.combo, mult: this.mult, energy: Math.max(0, this.st.energy), progress: this.state === 'idle' ? 0 : clamp01((now - this.songStart) / this.track.duration), judge: this.judge });
  }

  private finish(failed: boolean) {
    this.scorePending(Infinity); // score any follow-through still open
    const st = this.st, accuracy = st.total ? st.points / (st.total * 100) : 0;
    const rank = failed ? 'F' : accuracy >= 0.9 ? 'S' : accuracy >= 0.8 ? 'A' : accuracy >= 0.65 ? 'B' : accuracy >= 0.5 ? 'C' : 'D';
    this.quit();
    this.ev.end({ score: st.score, maxCombo: st.maxCombo, hits: st.hits, total: st.total, accuracy, rank, failed, difficulty: this.difficulty, title: this.track.title });
  }
}

const nowMs = () => performance.now();
