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
    if (u.protocol !== 'https:' || !STORE_HOSTS.test(u.hostname)) return false;
    await shell.openExternal(u.toString());
    return true;
  } catch {
    return false;
  }
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
  files.sort((a, b) => a.t - b.t);
  return { files: files.map(f => f.p), zips };
}
