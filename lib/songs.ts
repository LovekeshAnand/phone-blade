'use client';

// The music folder stays on this computer: nothing is uploaded. Chrome and Edge remember the folder,
// so picking it is a one time step (at most a one click "allow" on later visits).

export interface LocalSong { file: string; title: string; key: string; getFile(): Promise<File> }
export type Folder = { name: string; songs: LocalSong[] };

const AUDIO = /\.(mp3|m4a|aac|wav|ogg|flac)$/i;
const titleOf = (file: string) => file.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();

type DirHandle = FileSystemDirectoryHandle & {
  values(): AsyncIterable<FileSystemHandle>;
  queryPermission(o: { mode: 'read' }): Promise<PermissionState>;
  requestPermission(o: { mode: 'read' }): Promise<PermissionState>;
};

function store<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    const open = indexedDB.open('phone-blades', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('handles');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const req = op(open.result.transaction('handles', mode).objectStore('handles'));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    };
  });
}

async function list(dir: DirHandle): Promise<Folder> {
  const songs: LocalSong[] = [];
  for await (const h of dir.values()) {
    if (h.kind !== 'file' || !AUDIO.test(h.name)) continue;
    const fh = h as FileSystemFileHandle, f = await fh.getFile();
    songs.push({ file: h.name, title: titleOf(h.name), key: `${f.size}-${f.lastModified}`, getFile: () => fh.getFile() });
  }
  return { name: dir.name, songs: songs.sort((a, b) => a.title.localeCompare(b.title)) };
}

export const canRememberFolder = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window;

/** The remembered folder: its songs, 'prompt' when the browser wants one click to allow it again, or null. */
export async function savedFolder(): Promise<Folder | { prompt: string } | null> {
  const dir = (await store('readonly', (s) => s.get('music')).catch(() => null)) as DirHandle | null;
  if (!dir) return null;
  return (await dir.queryPermission({ mode: 'read' })) === 'granted' ? list(dir) : { prompt: dir.name };
}

/** Must run from a click. */
export async function allowSavedFolder(): Promise<Folder | null> {
  const dir = (await store('readonly', (s) => s.get('music'))) as DirHandle | null;
  return dir && (await dir.requestPermission({ mode: 'read' })) === 'granted' ? list(dir) : null;
}

/** Must run from a click. Throws AbortError if the person closes the picker. */
export async function pickFolder(): Promise<Folder> {
  const dir = (await (window as unknown as { showDirectoryPicker(o: object): Promise<DirHandle> }).showDirectoryPicker({ id: 'music', mode: 'read' }));
  await store('readwrite', (s) => s.put(dir, 'music')).catch(() => {});
  return list(dir);
}

/** Browsers without folder access (Firefox, Safari): a folder chosen through a file input, for this visit only. */
export function folderFromFiles(files: FileList): Folder {
  const songs = [...files].filter((f) => AUDIO.test(f.name)).map((f) => ({ file: f.name, title: titleOf(f.name), key: `${f.size}-${f.lastModified}`, getFile: async () => f }));
  return { name: files[0]?.webkitRelativePath.split('/')[0] || 'Music', songs: songs.sort((a, b) => a.title.localeCompare(b.title)) };
}
