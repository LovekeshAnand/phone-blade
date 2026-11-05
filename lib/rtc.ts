'use client';

import { HANDS, type Hand } from './protocol';

// Phone ↔ game screen over a direct WebRTC data channel: works on the same Wi-Fi, mobile data, or across networks.
// Neon only carries the one-time handshake (offer/answer) through /api/signal.

export type CtlToPhone = { t: 'hit'; good: boolean };
/** cal = recenter on the next pose. cfg = result of the guided calibration and/or a new sensitivity. */
export type Calibration = { center?: [number, number]; mirror?: boolean; gain?: number };
export type CtlToDisplay = { t: 'cal' } | ({ t: 'cfg' } & Calibration);

let ice: Promise<RTCIceServer[]> | null = null;
const iceServers = () =>
  (ice ??= fetch('/api/ice').then((r) => r.json()).catch(() => [{ urls: 'stun:stun.l.google.com:19302' }]));

/** Wait until all network candidates are in the description, so one offer + one answer is the whole handshake. */
function gathered(pc: RTCPeerConnection, ms = 2500) {
  return new Promise<void>((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const done = () => { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', check); resolve(); };
    const check = () => { if (pc.iceGatheringState === 'complete') done(); };
    const timer = setTimeout(done, ms);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

async function post(code: string, kind: 'offer' | 'answer', sdp: string) {
  const r = await fetch('/api/signal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, kind, sdp }) });
  if (!r.ok) throw new Error('Could not reach the pairing service.');
  return (await r.json()) as { id: number };
}

async function poll(codes: string[], kind: 'offer' | 'answer', after: number) {
  const r = await fetch(`/api/signal?codes=${codes.join(',')}&kind=${kind}&after=${after}`);
  return r.ok ? ((await r.json()) as { id: number; code: string; sdp: string }[]) : [];
}

/** 144 random bits, URL safe. One per blade slot, so every QR code is unique and unguessable. */
export function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_');
}

interface DisplayEvents {
  motion(h: Hand, a: number, b: number): void;
  cal(h: Hand): void;
  config(h: Hand, c: Calibration): void;
  status(h: Hand, live: boolean): void;
}

/** Game screen side: watches for phone offers on its two codes and answers them. */
export class DisplayPairing {
  private peers: Partial<Record<Hand, { pc: RTCPeerConnection; ctl?: RTCDataChannel }>> = {};
  private live: Record<Hand, boolean> = { L: false, R: false };
  private after = 0;
  private timer = 0;
  private stopped = false;

  constructor(readonly codes: Record<Hand, string>, private ev: DisplayEvents) {
    const tick = async () => {
      if (this.stopped) return;
      try {
        for (const offer of await poll(HANDS.map((h) => codes[h]), 'offer', this.after)) {
          this.after = Math.max(this.after, offer.id);
          const h = HANDS.find((k) => codes[k] === offer.code);
          if (h) await this.accept(h, offer.sdp).catch(() => {});
        }
      } catch { /* offline for a moment: try again next tick */ }
      this.timer = window.setTimeout(tick, this.live.L && this.live.R ? 3000 : 1000);
    };
    tick();
  }

  private setLive(h: Hand, live: boolean) {
    if (this.live[h] === live) return;
    this.live[h] = live;
    this.ev.status(h, live);
  }

  private async accept(h: Hand, sdp: string) {
    this.peers[h]?.pc.close(); // a rescan or reconnect replaces the old link
    this.ev.cal(h); // forget the previous phone's calibration before this one's messages arrive
    const pc = new RTCPeerConnection({ iceServers: await iceServers() });
    const peer: { pc: RTCPeerConnection; ctl?: RTCDataChannel } = { pc };
    this.peers[h] = peer;
    pc.ondatachannel = ({ channel }) => {
      if (channel.label === 'motion') channel.onmessage = (e) => { const [a, b] = JSON.parse(e.data); this.ev.motion(h, a, b); };
      else {
        peer.ctl = channel;
        channel.onmessage = (e) => {
          const m = JSON.parse(e.data) as CtlToDisplay;
          if (m.t === 'cal') this.ev.cal(h);
          else if (m.t === 'cfg') this.ev.config(h, { center: m.center, mirror: m.mirror, gain: m.gain });
        };
      }
    };
    pc.onconnectionstatechange = () => { if (this.peers[h] === peer) this.setLive(h, pc.connectionState === 'connected'); };
    await pc.setRemoteDescription({ type: 'offer', sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await gathered(pc);
    await post(this.codes[h], 'answer', pc.localDescription!.sdp);
  }

  send(h: Hand, m: CtlToPhone) {
    const c = this.peers[h]?.ctl;
    if (c?.readyState === 'open') c.send(JSON.stringify(m));
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    for (const p of Object.values(this.peers)) p?.pc.close();
  }
}

export type PhoneState = 'connecting' | 'live' | 'lost';

/** Phone side: offer a link on the scanned code and wait for the game screen to answer. */
export async function connectPhone(code: string, onCtl: (m: CtlToPhone) => void, onState: (s: PhoneState) => void) {
  const pc = new RTCPeerConnection({ iceServers: await iceServers() });
  const motion = pc.createDataChannel('motion', { ordered: false, maxRetransmits: 0 }); // stale poses are useless: never resend
  const ctl = pc.createDataChannel('ctl'); // reliable: calibration and haptics must arrive
  const queued: string[] = []; // messages sent before the channel opens go out the moment it does
  ctl.onopen = () => { for (const m of queued.splice(0)) ctl.send(m); };
  const sendCtl = (m: CtlToDisplay) => { const s = JSON.stringify(m); if (ctl.readyState === 'open') ctl.send(s); else queued.push(s); };
  ctl.onmessage = (e) => onCtl(JSON.parse(e.data));
  pc.onconnectionstatechange = () =>
    onState(pc.connectionState === 'connected' ? 'live' : ['failed', 'disconnected', 'closed'].includes(pc.connectionState) ? 'lost' : 'connecting');

  await pc.setLocalDescription(await pc.createOffer());
  await gathered(pc);
  const { id } = await post(code, 'offer', pc.localDescription!.sdp);
  for (let i = 0; i < 40 && !pc.remoteDescription; i++) { // about 30 seconds
    const [answer] = await poll([code], 'answer', id);
    if (answer) await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    else await new Promise((r) => setTimeout(r, 750));
  }
  if (!pc.remoteDescription) { pc.close(); throw new Error('The game screen did not answer. Make sure it is open, then scan again.'); }

  return {
    motion(a: number, b: number) {
      if (motion.readyState === 'open' && motion.bufferedAmount < 2048) motion.send(JSON.stringify([+a.toFixed(1), +b.toFixed(1)]));
    },
    cal() { sendCtl({ t: 'cal' }); },
    config(c: Calibration) { sendCtl({ t: 'cfg', ...c }); },
    close() { pc.close(); },
  };
}
