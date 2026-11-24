// Bought songs → Runway (Library › Spotify › Buy list).
//
// Stores don't let apps buy on the operator's behalf, so Runway only opens
// each song's store page (Qobuz / Apple Music) and then picks up what was
// bought: it looks in Downloads for new audio files and Qobuz zips, unzips
// them (into Runway's own folder; the download is left as it is) and hands
// the audio files back for importing. Nothing here buys or pays for anything.

import { app, shell } from 'electron';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const AUDIO = new Set(['.mp3', '.m4a', '.flac', '.wav', '.aiff', '.aif', '.ogg', '.aac']);
const STORE_HOSTS = /^(www\.)?(qobuz\.com|music\.apple\.com|itunes\.apple\.com)$/i;

/** Opens a store page in the browser. Only Qobuz / Apple links. */
export async function openStoreLink(url: string): Promise<boolean> {
  try {
    const u = new URL(url);
    // itms: opens the iTunes Store inside the Music app (where Buy is).
    if ((u.protocol !== 'https:' && u.protocol !== 'itms:') || !STORE_HOSTS.test(u.hostname)) return false;
    await shell.openExternal(u.toString());
    return true;
  } catch {
    return false;
  }
}

// ── Apple: find the exact song in the iTunes Store ───────────────────
const norm = (s: string) => s.toLowerCase()
  .replace(/\s*[([].*?[)\]]\s*/g, ' ')        // (Live), [feat. …]
  .replace(/\s+-\s+.*$/, '')                  // " - Live at …"
  .replace(/&/g, 'and')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

const VERSION_WORDS = ['sped up', 'slowed', 'instrumental', 'karaoke', 'remix', 'acoustic', 'radio edit', 'demo', 'reprise', 'cover', 'piano version', 'lofi', 'lo-fi'];

export interface AppleStoreMatch {
  ok: boolean;
  url?: string;          // opens the song's page in the Music app's iTunes Store
  webUrl?: string;
  price?: number;
  currency?: string;
  title?: string;
  artist?: string;
  album?: string;
  durationMs?: number;
  reason?: string;
}

/**
 * Looks a song up in Apple's public iTunes catalog search and returns the
 * best match by title, artist and length. Read-only; buys nothing.
 */
export async function appleStoreLookup(q: { title: string; artist: string; durationMs: number }): Promise<AppleStoreMatch> {
  const country = (app.getLocaleCountryCode() || 'US').toLowerCase();
  const firstArtist = (q.artist || '').split(/,|&| feat\.? | ft\.? /i)[0].trim();
  const term = `${q.title.replace(/\s*[([].*?[)\]]\s*/g, ' ').trim()} ${firstArtist}`.trim();
  const url = `https://itunes.apple.com/search?${new URLSearchParams({ term, entity: 'song', limit: '25', country })}`;
  let data: { results?: Array<Record<string, unknown>> };
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (r.status === 403 || r.status === 429) return { ok: false, reason: 'Apple is limiting lookups right now. Try again in a minute.' };
    if (!r.ok) return { ok: false, reason: `Apple's store search answered ${r.status}.` };
    data = await r.json() as typeof data;
  } catch (e) {
    return { ok: false, reason: `Couldn't reach Apple's store search (${e instanceof Error ? e.message : String(e)}).` };
  }
  const want = norm(q.title), wantArtist = norm(firstArtist);
  let best: { score: number; r: Record<string, unknown> } | null = null;
  for (const r of data.results ?? []) {
    if (r.kind !== 'song' || typeof r.trackViewUrl !== 'string') continue;
    const name = norm(String(r.trackName ?? ''));
    const artist = norm(String(r.artistName ?? ''));
    let score = 0;
    if (name === want) score += 4; else if (name.startsWith(want) || want.startsWith(name)) score += 2; else continue;
    if (wantArtist && (artist.includes(wantArtist) || wantArtist.includes(artist))) score += 3;
    const d = Math.abs(Number(r.trackTimeMillis ?? 0) - q.durationMs) / 1000;
    if (d <= 3) score += 4; else if (d <= 10) score += 2; else if (d > 25) score -= 3;
    // A different version (sped up, instrumental…) unless that's what Spotify has.
    const raw = String(r.trackName ?? '').toLowerCase();
    for (const v of VERSION_WORDS) if (raw.includes(v) && !q.title.toLowerCase().includes(v)) score -= 4;
    if (/\blive\b/i.test(q.title) === /\blive\b/i.test(raw)) score += 1;
    if (typeof r.trackPrice === 'number' && r.trackPrice > 0) score += 1;   // buyable on its own
    if (!best || score > best.score) best = { score, r };
  }
  if (!best || best.score < 5) return { ok: false, reason: 'Not found in the iTunes Store.' };
  const r = best.r;
  const web = new URL(String(r.trackViewUrl));
  web.searchParams.delete('uo');
  web.searchParams.set('app', 'itunes');   // the iTunes Store page (with Buy), not Apple Music streaming
  const itms = process.platform === 'darwin' ? `itms://${web.host}${web.pathname}${web.search}` : web.toString();
  return {
    ok: true,
    url: itms,
    webUrl: web.toString(),
    price: typeof r.trackPrice === 'number' && r.trackPrice > 0 ? r.trackPrice : undefined,
    currency: typeof r.currency === 'string' ? r.currency : undefined,
    title: String(r.trackName ?? ''),
    artist: String(r.artistName ?? ''),
    album: String(r.collectionName ?? ''),
    durationMs: Number(r.trackTimeMillis ?? 0) || undefined,
  };
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 120_000 }, err => (err ? reject(err) : resolve()));
  });
}

async function unzip(zip: string, dest: string): Promise<void> {
  fs.mkdirSync(dest, { recursive: true });
  if (process.platform === 'darwin') await run('/usr/bin/ditto', ['-x', '-k', zip, dest]);
  else if (process.platform === 'win32') {
    await run('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`]);
  } else await run('unzip', ['-o', '-q', zip, '-d', dest]);
}

function audioFilesIn(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 4) return out;
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === '__MACOSX') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) audioFilesIn(p, out, depth + 1);
    else if (AUDIO.has(path.extname(e.name).toLowerCase())) out.push(p);
  }
  return out;
}

function subdirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => path.join(dir, e.name));
  } catch { return []; }
}

/** Where the Music app / iTunes keeps bought songs (Artist/Album/song.m4a). */
function musicMediaFolders(): string[] {
  const music = app.getPath('music');
  return [
    path.join(music, 'Music', 'Media.localized', 'Music'),
    path.join(music, 'Music', 'Media', 'Music'),
    path.join(music, 'iTunes', 'iTunes Media', 'Music'),
    path.join(music, 'iTunes', 'iTunes Music'),
  ].filter(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
}

/**
 * Audio files that arrived in Downloads since `sinceMs`: loose audio files
 * (and folders) plus the contents of zips, unzipped into Runway's folder.
 * Returns absolute paths, oldest first.
 */
export async function findPurchases(sinceMs: number): Promise<{ files: string[]; zips: number; reason?: string }> {
  const dl = app.getPath('downloads');
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dl, { withFileTypes: true }); } catch (e) {
    return { files: [], zips: 0, reason: `Couldn’t read the Downloads folder (${e instanceof Error ? e.message : String(e)}). If macOS asked whether Runway can access Downloads, allow it.` };
  }
  const files: Array<{ p: string; t: number }> = [];
  let zips = 0;
  const unzipRoot = path.join(app.getPath('userData'), 'purchases-unzipped');
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dl, e.name);
    let st: fs.Stats;
    try { st = fs.statSync(p); } catch { continue; }
    const t = Math.max(st.mtimeMs, st.birthtimeMs || 0);
    if (t < sinceMs) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (e.isFile() && AUDIO.has(ext)) files.push({ p, t });
    else if (e.isDirectory()) for (const f of audioFilesIn(p)) files.push({ p: f, t });
    else if (e.isFile() && ext === '.zip') {
      const dest = path.join(unzipRoot, `${path.basename(e.name, '.zip')}-${Math.round(st.size)}`);
      try {
        if (!fs.existsSync(dest)) await unzip(p, dest);
        const inside = audioFilesIn(dest);
        if (inside.length) zips++;
        for (const f of inside) files.push({ p: f, t });
      } catch { /* not a music zip, or couldn't unzip: skip */ }
    }
  }
  // iTunes Store purchases go straight into the Music app's media folder.
  // Only album folders changed since then are opened, so a big library stays quick.
  for (const root of musicMediaFolders()) {
    for (const artist of subdirs(root)) {
      for (const album of subdirs(artist)) {
        let ast: fs.Stats;
        try { ast = fs.statSync(album); } catch { continue; }
        if (ast.mtimeMs < sinceMs) continue;
        let names: string[] = [];
        try { names = fs.readdirSync(album); } catch { continue; }
        for (const n of names) {
          if (n.startsWith('.') || !AUDIO.has(path.extname(n).toLowerCase())) continue;
          const p = path.join(album, n);
          let st: fs.Stats;
          try { st = fs.statSync(p); } catch { continue; }
          const t = Math.max(st.mtimeMs, st.birthtimeMs || 0);
          if (t >= sinceMs) files.push({ p, t });
        }
      }
    }
  }
  files.sort((a, b) => a.t - b.t);
  const seen = new Set<string>();
  return { files: files.map(f => f.p).filter(p => (seen.has(p) ? false : (seen.add(p), true))), zips };
}
