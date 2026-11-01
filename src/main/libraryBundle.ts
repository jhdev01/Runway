import * as fs from 'fs';
import * as path from 'path';
import type {
  AppConfig, Track, Playlist, PadFile,
  LibraryBundleManifest, LibraryImportMode, LibraryBundlePreview, LibraryImportReport,
} from '../shared/types';

/**
 * Playlist + audio bundles.
 *
 * A bundle is a plain folder (no zip — works the same on macOS and Windows
 * and the operator can open it in Finder / Explorer):
 *
 *   Runway Library 2026-11-01/
 *     library.json   ← playlists, track records (keys, trims, fades…), pads
 *     audio/         ← every song the playlists use
 *     pads/          ← every pad file
 *
 * File paths inside library.json are RELATIVE to the bundle so it can be
 * moved anywhere. Importing copies audio into this computer's managed
 * library and rewrites paths to point there.
 *
 * Nothing here touches scheduling or timing — it only moves files and
 * edits playlist / track records.
 */

export const BUNDLE_MANIFEST = 'library.json';
const FORMAT = 'runway-library';

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const baseLower = (p: string) => path.basename(p || '').toLowerCase();

/** Pick a filename in `dir` that doesn't clash with `taken` (lowercased). */
function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name.toLowerCase())) { taken.add(name.toLowerCase()); return name; }
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; ; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!taken.has(candidate.toLowerCase())) { taken.add(candidate.toLowerCase()); return candidate; }
  }
}

// ---------------------------------------------------------------- export ---

export async function exportLibraryBundle(
  cfg: AppConfig,
  parentDir: string,
  appVersion: string,
): Promise<{ bundleDir: string; playlists: number; tracks: number; pads: number; missingFiles: string[] }> {
  const stamp = new Date();
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const label = `${stamp.getFullYear()}-${pad2(stamp.getMonth() + 1)}-${pad2(stamp.getDate())}`;
  let bundleDir = path.join(parentDir, `Runway Library ${label}`);
  for (let i = 2; fs.existsSync(bundleDir); i++) {
    bundleDir = path.join(parentDir, `Runway Library ${label} (${i})`);
  }
  const audioOut = path.join(bundleDir, 'audio');
  const padsOut = path.join(bundleDir, 'pads');
  await fs.promises.mkdir(audioOut, { recursive: true });
  await fs.promises.mkdir(padsOut, { recursive: true });

  const missingFiles: string[] = [];

  // Every track any playlist uses, plus any library track not in a playlist
  // (so a full export really is the full library).
  const tracks = cfg.tracks ?? [];
  const takenAudio = new Set<string>();
  const outTracks: Track[] = [];
  for (const t of tracks) {
    let rel = t.filePath;
    if (t.filePath && fs.existsSync(t.filePath)) {
      const name = uniqueName(path.basename(t.filePath), takenAudio);
      await fs.promises.copyFile(t.filePath, path.join(audioOut, name));
      rel = `audio/${name}`;
    } else {
      // Keep the record (keys/trims/playlist membership) but flag it — the
      // importer will treat it as missing and offer to find it.
      missingFiles.push(t.title || path.basename(t.filePath || 'unknown'));
      rel = `audio/${path.basename(t.filePath || 'missing')}`;
    }
    outTracks.push({ ...t, filePath: rel });
  }

  const takenPads = new Set<string>();
  const outPads: PadFile[] = [];
  for (const p of cfg.pads ?? []) {
    if (p.filePath && fs.existsSync(p.filePath)) {
      const name = uniqueName(path.basename(p.filePath), takenPads);
      await fs.promises.copyFile(p.filePath, path.join(padsOut, name));
      outPads.push({ ...p, filePath: `pads/${name}` });
    } else {
      missingFiles.push(`${p.key} pad (${path.basename(p.filePath || '')})`);
    }
  }

  const manifest: LibraryBundleManifest = {
    format: FORMAT,
    version: 1,
    exportedAt: stamp.toISOString(),
    appVersion,
    playlists: cfg.playlists ?? [],
    tracks: outTracks,
    pads: outPads,
  };
  await fs.promises.writeFile(
    path.join(bundleDir, BUNDLE_MANIFEST),
    JSON.stringify(manifest, null, 2),
    'utf8',
  );
  return {
    bundleDir,
    playlists: manifest.playlists.length,
    tracks: outTracks.length,
    pads: outPads.length,
    missingFiles,
  };
}

// ---------------------------------------------------------------- import ---

export async function readBundle(bundleDir: string): Promise<LibraryBundleManifest> {
  // Accept either the bundle folder or the library.json inside it.
  const manifestPath = bundleDir.toLowerCase().endsWith('.json')
    ? bundleDir
    : path.join(bundleDir, BUNDLE_MANIFEST);
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
  } catch {
    throw new Error(`That folder isn't a Runway playlist export (no ${BUNDLE_MANIFEST} found).`);
  }
  const m = raw as Partial<LibraryBundleManifest>;
  if (m?.format !== FORMAT || !Array.isArray(m.playlists) || !Array.isArray(m.tracks)) {
    throw new Error(`That folder isn't a Runway playlist export.`);
  }
  return {
    format: FORMAT,
    version: m.version ?? 1,
    exportedAt: m.exportedAt ?? '',
    appVersion: m.appVersion ?? '',
    playlists: m.playlists,
    tracks: m.tracks,
    pads: Array.isArray(m.pads) ? m.pads : [],
  };
}

/** Find the existing playlist an imported one corresponds to (id, then name). */
function matchPlaylist(existing: Playlist[], incoming: Playlist): Playlist | undefined {
  return existing.find(p => p.id === incoming.id)
    ?? existing.find(p => p.name.trim().toLowerCase() === incoming.name.trim().toLowerCase());
}

/** Find the existing library track an imported one corresponds to (id, then filename). */
function matchTrack(existing: Track[], incoming: Track): Track | undefined {
  return existing.find(t => t.id === incoming.id)
    ?? existing.find(t => baseLower(t.filePath) === baseLower(incoming.filePath));
}

export function previewBundle(cfg: AppConfig, m: LibraryBundleManifest, bundleDir: string): LibraryBundlePreview {
  const existing = cfg.playlists ?? [];
  return {
    bundleDir,
    exportedAt: m.exportedAt,
    playlists: m.playlists.map(p => ({
      name: p.name,
      trackCount: p.trackIds.length,
      existsAlready: !!matchPlaylist(existing, p),
    })),
    trackCount: m.tracks.length,
    padCount: m.pads.length,
  };
}

/**
 * Apply a bundle to the config.
 *
 *  add      Every imported playlist is added as a NEW playlist. A name that
 *           already exists gets " (imported)" appended. Existing playlists
 *           are untouched.
 *  merge    A playlist with the same name gets the imported songs it doesn't
 *           already have appended at the end; its settings stay as they are.
 *           Playlists that don't exist yet are added.
 *  replace  A playlist with the same name is replaced by the imported one
 *           (songs AND settings), keeping its id so services and actions
 *           that point at it still work. Playlists not in the export are
 *           kept. Matching tracks take the imported keys/trims/fades.
 *
 * Songs are never duplicated in the library: an imported song that's
 * already in the library (same id or same filename) reuses that record.
 */
export async function applyBundle(
  cfg: AppConfig,
  m: LibraryBundleManifest,
  bundleDir: string,
  mode: LibraryImportMode,
  dirs: { audioDir: string; padsDir: string },
): Promise<{ config: AppConfig; report: LibraryImportReport }> {
  const root = bundleDir.toLowerCase().endsWith('.json') ? path.dirname(bundleDir) : bundleDir;
  await fs.promises.mkdir(dirs.audioDir, { recursive: true });
  await fs.promises.mkdir(dirs.padsDir, { recursive: true });

  const report: LibraryImportReport = {
    mode,
    playlistsAdded: 0, playlistsMerged: 0, playlistsReplaced: 0,
    tracksAdded: 0, tracksReused: 0, filesCopied: 0,
    padsAdded: 0, padsReplaced: 0,
    missingFiles: [],
  };

  // Copy one bundle file into a library dir. Reuses an identical file
  // (same name + size) already there; otherwise picks a non-clashing name.
  const copyIn = async (rel: string, destDir: string): Promise<string | null> => {
    const src = path.join(root, rel);
    if (!fs.existsSync(src)) return null;
    const name = path.basename(rel);
    let dest = path.join(destDir, name);
    if (fs.existsSync(dest)) {
      if (fs.statSync(dest).size === fs.statSync(src).size) return dest;
      const taken = new Set(fs.readdirSync(destDir).map(n => n.toLowerCase()));
      dest = path.join(destDir, uniqueName(name, taken));
    }
    await fs.promises.copyFile(src, dest);
    report.filesCopied++;
    return dest;
  };

  // ---- Tracks: map every imported track id → the id used locally.
  const tracks = [...(cfg.tracks ?? [])];
  const idMap = new Map<string, string>();
  for (const inc of m.tracks) {
    const match = matchTrack(tracks, inc);
    const copied = await copyIn(inc.filePath, dirs.audioDir);
    if (!copied) report.missingFiles.push(inc.title || path.basename(inc.filePath));

    if (match) {
      idMap.set(inc.id, match.id);
      report.tracksReused++;
      const idx = tracks.indexOf(match);
      const localMissing = !match.filePath || !fs.existsSync(match.filePath);
      if (mode === 'replace') {
        tracks[idx] = {
          ...inc,
          id: match.id,
          filePath: copied ?? match.filePath,
        };
      } else if (localMissing && copied) {
        // Keep the operator's local edits, but heal a broken file link.
        tracks[idx] = { ...match, filePath: copied };
      }
    } else {
      const id = tracks.some(t => t.id === inc.id) ? newId() : inc.id;
      idMap.set(inc.id, id);
      tracks.push({
        ...inc,
        id,
        // Missing in the bundle too → keep a path under the library dir so
        // "Fix missing audio files" can find it later by filename.
        filePath: copied ?? path.join(dirs.audioDir, path.basename(inc.filePath)),
      });
      report.tracksAdded++;
    }
  }

  // ---- Playlists.
  const sequenceIds = new Set((cfg.actionSequences ?? []).map(s => s.id));
  const playlists = [...(cfg.playlists ?? [])];
  const nowIso = new Date().toISOString();
  const remapIds = (ids: string[]) => ids.map(id => idMap.get(id)).filter((x): x is string => !!x);
  const cleanSeq = (id?: string) => (id && sequenceIds.has(id) ? id : undefined);

  for (const inc of m.playlists) {
    const incomingIds = remapIds(inc.trackIds);
    const match = matchPlaylist(playlists, inc);

    if (mode === 'add' || !match) {
      let name = inc.name;
      const names = new Set(playlists.map(p => p.name.trim().toLowerCase()));
      if (names.has(name.trim().toLowerCase())) {
        name = `${inc.name} (imported)`;
        for (let i = 2; names.has(name.trim().toLowerCase()); i++) name = `${inc.name} (imported ${i})`;
      }
      const id = playlists.some(p => p.id === inc.id) ? newId() : inc.id;
      playlists.push({
        ...inc,
        id,
        name,
        trackIds: incomingIds,
        actionSequenceId: cleanSeq(inc.actionSequenceId),
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      report.playlistsAdded++;
    } else if (mode === 'merge') {
      const idx = playlists.indexOf(match);
      const have = new Set(match.trackIds);
      playlists[idx] = {
        ...match,
        trackIds: [...match.trackIds, ...incomingIds.filter(id => !have.has(id))],
        updatedAt: nowIso,
      };
      report.playlistsMerged++;
    } else {
      const idx = playlists.indexOf(match);
      playlists[idx] = {
        ...inc,
        id: match.id,
        name: match.name,
        trackIds: incomingIds,
        actionSequenceId: cleanSeq(inc.actionSequenceId) ?? match.actionSequenceId,
        createdAt: match.createdAt,
        updatedAt: nowIso,
      };
      report.playlistsReplaced++;
    }
  }

  // ---- Pads (one per key + texture).
  const pads = [...(cfg.pads ?? [])];
  for (const inc of m.pads) {
    const copied = await copyIn(inc.filePath, dirs.padsDir);
    if (!copied) { report.missingFiles.push(`${inc.key} pad`); continue; }
    const idx = pads.findIndex(p => p.key === inc.key && p.texture === inc.texture);
    if (idx === -1) {
      pads.push({ ...inc, filePath: copied });
      report.padsAdded++;
    } else {
      const localMissing = !fs.existsSync(pads[idx].filePath);
      if (mode === 'replace' || localMissing) {
        pads[idx] = { ...inc, filePath: copied };
        report.padsReplaced++;
      }
    }
  }

  return { config: { ...cfg, tracks, playlists, pads }, report };
}
