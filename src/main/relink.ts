import * as fs from 'fs';
import * as path from 'path';
import type { AppConfig, RelinkReport } from '../shared/types';

// Same extension set the importer / scanner accept. Kept local so relink
// doesn't depend on fileScanner's internals.
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.aiff', '.aif', '.flac', '.m4a', '.ogg']);

interface NameIndex {
  // Exact filename → first absolute path found.
  exact: Map<string, string>;
  // Lowercased filename → first absolute path found. Fallback for
  // case-insensitive filesystems (macOS / Windows default) where a track
  // saved as "Be Glad.MP3" should still match "be glad.mp3".
  lower: Map<string, string>;
}

/**
 * Recursively index audio files under the given folders by filename.
 * Earlier folders win, and within a folder the first file seen for a given
 * name wins — so pass the most-authoritative folder (the managed library
 * dir) first. Unreadable folders are skipped silently.
 */
function indexFolders(folders: string[]): NameIndex {
  const exact = new Map<string, string>();
  const lower = new Map<string, string>();

  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // missing / unreadable folder — nothing to add
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile()) {
        if (!AUDIO_EXTS.has(path.extname(e.name).toLowerCase())) continue;
        if (!exact.has(e.name)) exact.set(e.name, full);
        const lc = e.name.toLowerCase();
        if (!lower.has(lc)) lower.set(lc, full);
      }
    }
  };

  for (const f of folders) {
    if (f) walk(f);
  }
  return { exact, lower };
}

/** Find a replacement path for a (possibly-broken) filePath by filename. */
function resolveByName(filePath: string, index: NameIndex): string | null {
  if (!filePath) return null;
  const base = path.basename(filePath);
  return index.exact.get(base) ?? index.lower.get(base.toLowerCase()) ?? null;
}

/**
 * Repoint every track / pad filePath to the matching file on this machine.
 *
 * A path that already resolves to an existing file is left untouched. A
 * broken path is matched by FILENAME against the search folders and, when
 * found, rewritten — preserving the track id (and therefore every playlist
 * link) plus all metadata (key, bpm, trims, fades).
 *
 * Tracks are searched audio-dir-first; pads pads-dir-first. Any operator-
 * supplied `extraFolders` are searched last (recursively) so files kept
 * outside the managed library can still be reconnected.
 *
 * This never reads, decodes, or reorders audio — it only rewrites file
 * locations. No scheduling / timing behavior is involved.
 */
export function relinkConfig(
  cfg: AppConfig,
  dirs: { audioDir: string; padsDir: string; extraFolders?: string[] },
): { config: AppConfig; report: RelinkReport } {
  const extra = dirs.extraFolders ?? [];
  const trackIndex = indexFolders([dirs.audioDir, dirs.padsDir, ...extra]);
  const padIndex = indexFolders([dirs.padsDir, dirs.audioDir, ...extra]);

  const report: RelinkReport = {
    tracksOk: 0, tracksRelinked: 0, tracksMissing: 0,
    padsOk: 0, padsRelinked: 0, padsMissing: 0,
    missingNames: [], changed: false,
  };

  const tracks = (cfg.tracks ?? []).map((t) => {
    if (t.filePath && fs.existsSync(t.filePath)) { report.tracksOk++; return t; }
    const found = resolveByName(t.filePath, trackIndex);
    if (found && found !== t.filePath) {
      report.tracksRelinked++;
      report.changed = true;
      return { ...t, filePath: found };
    }
    report.tracksMissing++;
    report.missingNames.push(path.basename(t.filePath || t.title || 'unknown track'));
    return t;
  });

  const pads = (cfg.pads ?? []).map((p) => {
    if (p.filePath && fs.existsSync(p.filePath)) { report.padsOk++; return p; }
    const found = resolveByName(p.filePath, padIndex);
    if (found && found !== p.filePath) {
      report.padsRelinked++;
      report.changed = true;
      return { ...p, filePath: found };
    }
    report.padsMissing++;
    report.missingNames.push(path.basename(p.filePath || `${p.key} pad`));
    return p;
  });

  return { config: { ...cfg, tracks, pads }, report };
}
