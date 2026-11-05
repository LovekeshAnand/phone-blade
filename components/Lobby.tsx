'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import QRCode from 'qrcode';
import { CheckCircleIcon, FolderOpenIcon, GoogleLogoIcon, MusicNotesIcon, SignOutIcon, TrophyIcon } from '@phosphor-icons/react';
import { authClient } from '@/lib/auth/client';
import { DIFFICULTY, type Difficulty } from '@/lib/beatmap';
import { HAND_COLOR, HAND_NAME, type Hand, type Remotes } from '@/lib/protocol';
import { allowSavedFolder, canRememberFolder, folderFromFiles, pickFolder, savedFolder, type Folder, type LocalSong } from '@/lib/songs';
import { loadSong, scanSong, suggestDifficulty, type SongInfo, type Track } from '@/lib/track';
import { Button, Panel, Skeleton } from './ui';

export const BUILT_IN = 'Neon Run';
const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const DIFF_CHIP: Record<Difficulty, string> = { easy: 'bg-emerald-400/15 text-emerald-300', normal: 'bg-sky-400/15 text-sky-300', hard: 'bg-orange-400/15 text-orange-300' };
const MODE_LINE = {
  mouse: 'No phone paired yet. Your mouse moves the blade, and the run is practice only.',
  solo: 'Solo blade. Blocks come in every lane.',
  duo: 'Dual blades. Orange blocks on the left, cyan on the right.',
};

// Beat scans live in localStorage, keyed by file size and date, so the list is instant next visit.
const scanKey = (s: LocalSong) => `phone-blades:scan:${s.file}:${s.key}`;
const readScan = (s: LocalSong): SongInfo | null => {
  try { const v = localStorage.getItem(scanKey(s)); return v ? JSON.parse(v) : null; } catch { return null; }
};
const writeScan = (s: LocalSong, info: SongInfo) => {
  try { localStorage.setItem(scanKey(s), JSON.stringify({ ...info, beats: info.beats.map((b) => +b.toFixed(3)), energy: info.energy.map((e) => +e.toFixed(2)) })); } catch {}
};

type Props = {
  active: boolean;
  remotes: Remotes;
  codes: Record<Hand, string>;
  boardVersion: number;
  onPlay(track: Track | null, difficulty: Difficulty, title: string): void;
};

export function Lobby({ active, remotes, codes, boardVersion, onPlay }: Props) {
  const session = authClient.useSession();
  const user = session.data?.user;
  const [difficulty, setDifficulty] = useState<Difficulty>('normal');
  const [folder, setFolder] = useState<Folder | { prompt: string } | null | 'loading'>('loading');
  const [scans, setScans] = useState<Record<string, SongInfo | 'error'>>({});
  const [selected, setSelected] = useState<LocalSong | null>(null);
  const [track, setTrack] = useState<Track | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const pickId = useRef(0);
  const filesInput = useRef<HTMLInputElement>(null);
  const songs = folder && folder !== 'loading' && 'songs' in folder ? folder.songs : null;
  const title = selected?.title ?? BUILT_IN;
  const mode = remotes.L && remotes.R ? 'duo' : remotes.L || remotes.R ? 'solo' : 'mouse';

  useEffect(() => { savedFolder().then(setFolder).catch(() => setFolder(null)); }, []);

  // Scan songs one at a time in the background (decoded audio is large). Paused while a song is playing.
  useEffect(() => {
    if (!active || !songs) return;
    let cancelled = false;
    (async () => {
      for (const s of songs) {
        let info: SongInfo | 'error' | null = readScan(s);
        if (!info) {
          try { info = await scanSong(await (await s.getFile()).arrayBuffer()); writeScan(s, info); } catch { info = 'error'; }
        }
        if (cancelled) return;
        const result = info;
        setScans((prev) => (prev[s.file] ? prev : { ...prev, [s.file]: result }));
      }
    })();
    return () => { cancelled = true; };
  }, [active, songs]);

  async function choose(song: LocalSong | null) {
    const id = ++pickId.current; // a later click wins over a slow load
    setSelected(song); setTrack(null); setError('');
    if (!song) return setLoading(false);
    const known = scans[song.file];
    const info = known && known !== 'error' ? known : undefined;
    if (info) setDifficulty(suggestDifficulty(info));
    setLoading(true);
    try {
      const t = await loadSong(await (await song.getFile()).arrayBuffer(), song.title, info);
      if (id !== pickId.current) return;
      setTrack(t);
      setDifficulty(suggestDifficulty(t));
    } catch (e) {
      if (id !== pickId.current) return;
      setSelected(null);
      setError(e instanceof Error && e.message.includes('beat') ? e.message : `${song.title} could not be read. Try an MP3, M4A or WAV file.`);
    } finally {
      if (id === pickId.current) setLoading(false);
    }
  }

  async function chooseFolder() {
    setError('');
    if (!canRememberFolder()) return filesInput.current?.click();
    try { setFolder(await pickFolder()); }
    catch (e) { if ((e as Error).name !== 'AbortError') setError('That folder could not be opened. Try another one.'); }
  }

  async function allowFolder() {
    const f = await allowSavedFolder().catch(() => null);
    if (f) setFolder(f); else setError('The browser did not allow access to the music folder.');
  }

  const folderAction =
    folder === 'loading' ? null
      : folder && 'prompt' in folder ? <Button size="sm" variant="secondary" onClick={allowFolder}><FolderOpenIcon size={16} />Open {folder.prompt}</Button>
        : <Button size="sm" variant={folder ? 'ghost' : 'secondary'} onClick={chooseFolder}><FolderOpenIcon size={16} />{folder ? folder.name : 'Choose music folder'}</Button>;

  return (
    <div className="absolute inset-0 overflow-y-auto">
      <a href="#setup" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-20 focus:rounded-lg focus:bg-white focus:px-3 focus:py-2 focus:text-black">Skip to content</a>
      <TopBar name={user?.name} />
      <main className="mx-auto grid max-w-6xl gap-6 px-6 pb-16 pt-24 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex flex-col gap-6">
          <header className="rise max-w-[680px] pt-6">
            <h1 className="bg-[linear-gradient(90deg,#ffffff,#9b9b9b)] bg-clip-text text-4xl font-bold tracking-tight text-transparent md:text-5xl">
              Your phone is the blade.<br />Slice every block on the beat.
            </h1>
            <p className="mt-4 max-w-[680px] text-lg text-neutral-400">
              Scan a code with your phone, pick a song and swing. One phone plays solo. A second phone gives you both hands.
            </p>
          </header>

          <div id="setup">
            {session.isPending ? <Panel><Skeleton className="h-72" /></Panel>
              : !user ? <AccountPanel />
                : (
                  <Panel title="Song" action={folderAction}>
                    <div role="radiogroup" aria-label="Song" className="flex max-h-80 flex-col gap-2 overflow-y-auto">
                      <SongRow active={!selected} onClick={() => choose(null)} title={BUILT_IN} meta="Built in track" />
                      {songs?.map((s) => {
                        const info = scans[s.file];
                        return (
                          <SongRow key={s.file} active={selected?.file === s.file} onClick={() => choose(s)} title={s.title}
                            meta={selected?.file === s.file && loading ? 'Loading' : info === 'error' ? 'Unreadable file' : info ? `${Math.round(info.bpm)} BPM · ${fmtTime(info.duration)}` : null}
                            badge={info && info !== 'error' ? suggestDifficulty(info) : undefined} />
                        );
                      })}
                    </div>

                    {folder === null && (
                      <div className="mt-4 flex gap-3 rounded-xl border border-ink-4 bg-ink-2 p-4">
                        <MusicNotesIcon size={24} className="shrink-0 text-neutral-400" aria-hidden />
                        <div>
                          <p className="text-sm font-semibold">Play your own songs</p>
                          <p className="mt-1 text-sm text-neutral-400">Choose a folder of MP3 files on this computer. The songs never leave it, and each one gets a beat map of its own.</p>
                        </div>
                      </div>
                    )}
                    {songs?.length === 0 && (
                      <p className="mt-4 text-sm text-neutral-400">No audio files in this folder. Add MP3, M4A or WAV files, then choose it again.</p>
                    )}
                    <input ref={filesInput} type="file" accept="audio/*" multiple hidden
                      onChange={(e) => { if (e.target.files?.length) setFolder(folderFromFiles(e.target.files)); e.target.value = ''; }} />

                    <h2 className="mb-3 mt-6 text-base font-semibold">Difficulty</h2>
                    <div role="radiogroup" aria-label="Difficulty" className="grid grid-cols-3 gap-2 rounded-xl bg-ink-2 p-1">
                      {(Object.keys(DIFFICULTY) as Difficulty[]).map((d) => (
                        <button key={d} role="radio" aria-checked={difficulty === d} onClick={() => setDifficulty(d)}
                          className={`rounded-lg px-3 py-2 text-sm font-semibold transition duration-300 ease-soft focus-visible:outline-2 focus-visible:outline-white
                            ${difficulty === d ? 'bg-ink-4 text-white' : 'text-neutral-400 hover:text-white'}`}>
                          {DIFFICULTY[d].label}
                        </button>
                      ))}
                    </div>

                    {error && <p role="alert" className="mt-4 text-sm text-red-400">{error}</p>}
                    <Button size="lg" className="mt-6 w-full" disabled={loading || (!!selected && !track)}
                      onClick={() => onPlay(selected ? track : null, difficulty, title)}>
                      {loading ? 'Loading song' : `Play ${title}`}
                    </Button>
                    <p className="mt-3 text-sm text-neutral-400">{MODE_LINE[mode]}</p>
                  </Panel>
                )}
          </div>
        </div>

        <aside className="flex flex-col gap-6">
          <PhonesPanel codes={codes} remotes={remotes} />
          <Leaderboard song={title} difficulty={difficulty} version={boardVersion} me={user?.id} />
        </aside>
      </main>
    </div>
  );
}

function TopBar({ name }: { name?: string }) {
  return (
    <nav aria-label="Main" className="fixed inset-x-0 top-4 z-10 mx-auto flex w-fit items-center gap-4 rounded-xl border border-ink-4 bg-ink-1/80 px-4 py-2 backdrop-blur">
      <span className="flex items-center gap-2 text-sm font-semibold">
        {/* eslint-disable-next-line @next/next/no-img-element -- tiny static svg */}
        <img src="/icon.svg" alt="" width={20} height={20} className="rounded" />
        Phone Blades
      </span>
      {name && (
        <>
          <span aria-hidden className="h-4 w-px bg-ink-4" />
          <span className="text-sm text-neutral-300">{name}</span>
          <Button size="sm" variant="ghost" onClick={() => authClient.signOut()}><SignOutIcon size={16} />Sign out</Button>
        </>
      )}
    </nav>
  );
}

function SongRow({ active, onClick, title, meta, badge }: { active: boolean; onClick(): void; title: string; meta: string | null; badge?: Difficulty }) {
  return (
    <button role="radio" aria-checked={active} onClick={onClick}
      className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-3 text-left transition duration-300 ease-soft focus-visible:outline-2 focus-visible:outline-white active:scale-[0.99]
        ${active ? 'bg-white text-black' : 'bg-ink-2 text-neutral-200 hover:bg-ink-3'}`}>
      <span className="truncate font-semibold">{title}</span>
      <span className="flex shrink-0 items-center gap-2 text-sm">
        {meta === null ? <Skeleton className="h-4 w-24" /> : <span className={`font-mono ${active ? 'text-black/60' : 'text-neutral-400'}`}>{meta}</span>}
        {badge && <span className={`rounded-md px-2 py-0.5 text-xs font-semibold ${active ? 'bg-black/10 text-black' : DIFF_CHIP[badge]}`}>{DIFFICULTY[badge].label}</span>}
      </span>
    </button>
  );
}

/** The auth SDK throws on HTTP errors, so read its message instead of guessing at the cause. */
function errorText(err: unknown) {
  const e = err as { message?: string; status?: number } | null;
  if (e?.status === 403) return 'Sign in is blocked for this site address. The site owner needs to add it as a trusted domain in Neon Auth.';
  return e?.message || 'Could not reach the sign in service. Check your connection and try again.';
}

function AccountPanel() {
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const email = String(f.get('email') ?? '').trim(), password = String(f.get('password') ?? ''), name = String(f.get('name') ?? '').trim();
    if (mode === 'up' && name.length < 2) return setError('Enter a player name with at least 2 characters.');
    if (password.length < 8) return setError('Use a password with at least 8 characters.');
    setBusy(true); setError('');
    try {
      const res = mode === 'up' ? await authClient.signUp.email({ email, password, name }) : await authClient.signIn.email({ email, password });
      if (res.error) setError(res.error.message || 'That did not work. Check your details and try again.');
    } catch (err) {
      setError(errorText(err));
    } finally { setBusy(false); }
  }

  async function google() {
    setBusy(true); setError('');
    try {
      const res = await authClient.signIn.social({ provider: 'google', callbackURL: location.origin + '/' });
      if (res?.error) setError(res.error.message || 'Google sign in did not start. Try again.');
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    } // on success the browser leaves for Google, so busy stays on
  }

  const field = 'w-full rounded-lg border border-ink-4 bg-ink-2 px-3 py-2 text-base text-white placeholder:text-neutral-500 focus:border-neutral-400 focus:outline-none';
  return (
    <Panel title={mode === 'in' ? 'Sign in to play' : 'Create your player'}>
      <p className="mb-4 text-sm text-neutral-400">Your scores go on the leaderboard under your player name.</p>
      <Button type="button" variant="secondary" size="lg" className="w-full" disabled={busy} onClick={google}>
        <GoogleLogoIcon size={20} weight="bold" aria-hidden />Continue with Google
      </Button>
      <div className="my-4 flex items-center gap-3 text-sm text-neutral-500" aria-hidden>
        <span className="h-px flex-1 bg-ink-4" />or use email<span className="h-px flex-1 bg-ink-4" />
      </div>
      <form onSubmit={submit} className="flex flex-col gap-3">
        {mode === 'up' && (
          <label className="flex flex-col gap-2 text-sm font-semibold">Player name
            <input name="name" required minLength={2} maxLength={40} autoComplete="nickname" className={field} placeholder="Riya" />
          </label>
        )}
        <label className="flex flex-col gap-2 text-sm font-semibold">Email
          <input name="email" type="email" required autoComplete="email" className={field} placeholder="you@example.com" />
        </label>
        <label className="flex flex-col gap-2 text-sm font-semibold">Password
          <input name="password" type="password" required minLength={8} autoComplete={mode === 'up' ? 'new-password' : 'current-password'} className={field} />
        </label>
        {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
        <Button type="submit" size="lg" className="mt-2 w-full" disabled={busy}>
          {busy ? (mode === 'in' ? 'Signing in' : 'Creating player') : mode === 'in' ? 'Sign in' : 'Create player'}
        </Button>
      </form>
      <p className="mt-4 text-sm text-neutral-400">
        {mode === 'in' ? 'New here?' : 'Already have a player?'}{' '}
        <button className="font-semibold text-white underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-white" onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); setError(''); }}>
          {mode === 'in' ? 'Create a player' : 'Sign in'}
        </button>
      </p>
    </Panel>
  );
}

function PhonesPanel({ codes, remotes }: { codes: Record<Hand, string>; remotes: Remotes }) {
  const [qr, setQr] = useState<Partial<Record<Hand, string>>>({});
  useEffect(() => {
    for (const h of ['R', 'L'] as Hand[])
      QRCode.toDataURL(`${location.origin}/?pair=${codes[h]}&h=${h}`, { margin: 1, width: 224 }).then((img) => setQr((q) => ({ ...q, [h]: img })));
  }, [codes]);
  const paired = Number(remotes.L) + Number(remotes.R);

  return (
    <Panel title="Phones" action={<span className="text-sm text-neutral-400">{paired} of 2 paired</span>}>
      <div className="grid grid-cols-2 gap-4">
        {(['R', 'L'] as Hand[]).map((h) => (
          <div key={h} className="flex flex-col gap-2">
            <div className="relative aspect-square overflow-hidden rounded-xl bg-white p-2">
              {/* eslint-disable-next-line @next/next/no-img-element -- data URL QR code */}
              {qr[h] ? <img src={qr[h]} alt={`QR code to pair a phone as the ${HAND_NAME[h].toLowerCase()} blade`} className="size-full" /> : <Skeleton className="size-full" />}
              {remotes[h] && (
                <div className="absolute inset-0 grid place-items-center bg-ink-1/95">
                  <CheckCircleIcon size={40} weight="fill" style={{ color: HAND_COLOR[h] }} aria-hidden />
                </div>
              )}
            </div>
            <p className="flex items-center gap-2 text-sm font-semibold">
              <span aria-hidden className="size-2 rounded-full" style={{ background: HAND_COLOR[h] }} />{HAND_NAME[h]} blade
            </p>
            <p className="-mt-1 text-sm text-neutral-400">{remotes[h] ? 'Paired' : 'Scan to pair'}</p>
          </div>
        ))}
      </div>
      <p className="mt-4 text-sm text-neutral-400">Works on WiFi or mobile data. Each code belongs to this screen only.</p>
    </Panel>
  );
}

type Row = { user_id: string; user_name: string; score: number; accuracy: number; rank: string };

function Leaderboard({ song, difficulty, version, me }: { song: string; difficulty: Difficulty; version: number; me?: string }) {
  const key = `${song}|${difficulty}|${version}`;
  const [data, setData] = useState<{ key: string; rows: Row[] | 'error' } | null>(null);
  useEffect(() => {
    let off = false;
    fetch(`/api/scores?song=${encodeURIComponent(song)}&difficulty=${difficulty}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((rows: Row[]) => { if (!off) setData({ key, rows }); })
      .catch(() => { if (!off) setData({ key, rows: 'error' }); });
    return () => { off = true; };
  }, [key, song, difficulty]);
  const rows = data?.key === key ? data.rows : null;

  return (
    <Panel title="Leaderboard" action={<span className="max-w-40 truncate text-sm text-neutral-400">{song} · {DIFFICULTY[difficulty].label}</span>}>
      {rows === null ? (
        <div className="flex flex-col gap-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-10" />)}</div>
      ) : rows === 'error' ? (
        <p className="text-sm text-red-400">The leaderboard could not load. Check your connection.</p>
      ) : rows.length === 0 ? (
        <div className="flex items-center gap-3 rounded-xl bg-ink-2 p-4">
          <TrophyIcon size={24} className="shrink-0 text-neutral-400" aria-hidden />
          <p className="text-sm text-neutral-400">No scores yet. Finish a run with a phone to take first place.</p>
        </div>
      ) : (
        <ol className="flex flex-col gap-1">
          {rows.map((r, i) => (
            <li key={r.user_id} className={`grid grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-3 py-2 ${r.user_id === me ? 'bg-ink-3' : ''}`}>
              <span className="font-mono text-sm text-neutral-500">{i + 1}</span>
              <span className="truncate text-sm font-semibold">{r.user_name}{r.user_id === me && <span className="font-normal text-neutral-400"> (you)</span>}</span>
              <span className="text-right font-mono text-sm">{r.score.toLocaleString()}<span className="ml-2 text-neutral-500">{r.rank}</span></span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
