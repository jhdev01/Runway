import * as fs from 'fs';
import * as path from 'path';
import type { Track, KeyName } from '../shared/types';

// music-metadata v10+ is pure ESM and cannot be require()'d from CommonJS.
// Use eval'd import() to bypass TypeScript's CommonJS transformation
// of regular dynamic imports back into require() calls.
type ParseFileFn = (filePath: string, opts?: { duration?: boolean }) => Promise<any>;
let _parseFile: ParseFileFn | null = null;
async function getParseFile(): Promise<ParseFileFn> {
  if (_parseFile) return _parseFile;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<any>;
  const mod = await dynamicImport('music-metadata');
  _parseFile = mod.parseFile as ParseFileFn;
  return _parseFile;
}

const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.aiff', '.aif', '.flac', '.m4a', '.ogg'];

export interface ScannedTrack {
  filePath: string;
  metadata: Partial<Track>;
}

export async function scanFolder(folderPath: string): Promise<ScannedTrack[]> {
  if (!fs.existsSync(folderPath)) return [];
  const out: ScannedTrack[] = [];

  const walk = async (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (AUDIO_EXTENSIONS.includes(ext)) {
          const metadata = await readTrackMetadata(full);
          out.push({ filePath: full, metadata });
        }
      }
    }
  };

  await walk(folderPath);
  return out;
}

export async function readTrackMetadata(filePath: string): Promise<Partial<Track>> {
  const baseName = path.basename(filePath, path.extname(filePath));
  try {
    const parseFile = await getParseFile();
    const m = await parseFile(filePath, { duration: true });
    const common = m.common;

    // Try to extract key — music-metadata exposes 'key' on common for ID3 TKEY
    let key: KeyName | undefined;
    const rawKey = (common as any).key;
    if (typeof rawKey === 'string') {
      key = normalizeKey(rawKey);
    }
    // Fallback: parse the key out of the filename
    if (!key) key = parseKeyFromFilename(baseName);

    let bpm: number | undefined;
    if (common.bpm) bpm = Math.round(common.bpm);

    // Embedded album artwork (ID3 APIC, FLAC PICTURE block, etc.).
    // music-metadata returns Buffer + mime per picture; we take the
    // first and turn it into a data URL so the renderer can <img src=>
    // it directly without needing a file:// or custom protocol.
    let albumArtUrl: string | undefined;
    const pic = common.picture && common.picture[0];
    if (pic && pic.data) {
      const fmt = pic.format || 'image/jpeg';
      // Some files report mimes as "JPEG" without prefix — normalize.
      const mime = fmt.startsWith('image/') ? fmt : `image/${fmt.toLowerCase()}`;
      // Buffer.toString('base64') for Node Buffer; pic.data may be a
      // Uint8Array depending on music-metadata version — coerce.
      const buf = Buffer.isBuffer(pic.data) ? pic.data : Buffer.from(pic.data as Uint8Array);
      albumArtUrl = `data:${mime};base64,${buf.toString('base64')}`;
      console.log(`[scanner] extracted ${Math.round(buf.length / 1024)}KB ${mime} art from ${path.basename(filePath)}`);
    } else {
      console.log(`[scanner] no embedded art in ${path.basename(filePath)}`);
    }

    return {
      filePath,
      title: common.title || baseName,
      artist: common.artist,
      album: common.album,
      durationSec: m.format.duration ? Math.round(m.format.duration * 10) / 10 : 0,
      sampleRate: m.format.sampleRate,
      bitrateBps: typeof m.format.bitrate === 'number' ? Math.round(m.format.bitrate) : undefined,
      codec: m.format.codec,
      container: m.format.container,
      channels: m.format.numberOfChannels,
      lossless: m.format.lossless,
      albumArtUrl,
      key,
      bpm,
    };
  } catch (err) {
    console.warn('[scanner] failed to read', filePath, err);
    return {
      filePath,
      title: baseName,
      durationSec: 0,
      key: parseKeyFromFilename(baseName),
    };
  }
}

// Map enharmonic spellings to the canonical KeyName values declared in shared/types.
// Major canonical: F#, Db, Ab, Eb, Bb (sharps for F#; flats elsewhere).
// Minor canonical: F#m, C#m, G#m, D#m, Bbm (sharps for the inner ring; Bbm is the flat one).
const ENHARMONIC_MAJOR: Record<string, KeyName> = {
  'C#': 'Db', 'Db': 'Db',
  'D#': 'Eb', 'Eb': 'Eb',
  'F#': 'F#', 'Gb': 'F#',
  'G#': 'Ab', 'Ab': 'Ab',
  'A#': 'Bb', 'Bb': 'Bb',
};
const ENHARMONIC_MINOR: Record<string, KeyName> = {
  'C#m': 'C#m', 'Dbm': 'C#m',
  'D#m': 'D#m', 'Ebm': 'D#m',
  'F#m': 'F#m', 'Gbm': 'F#m',
  'G#m': 'G#m', 'Abm': 'G#m',
  'A#m': 'Bbm', 'Bbm': 'Bbm',
};
const NATURAL_MAJOR = new Set(['C', 'D', 'E', 'F', 'G', 'A', 'B']);
const NATURAL_MINOR = new Set(['Cm', 'Dm', 'Em', 'Fm', 'Gm', 'Am', 'Bm']);

function canonicalKey(rootUpper: string, accidental: string, minor: boolean): KeyName | undefined {
  const symbol = rootUpper + (accidental || '') + (minor ? 'm' : '');
  if (minor) {
    if (NATURAL_MINOR.has(symbol)) return symbol as KeyName;
    return ENHARMONIC_MINOR[symbol];
  }
  if (NATURAL_MAJOR.has(symbol)) return symbol as KeyName;
  return ENHARMONIC_MAJOR[symbol];
}

/**
 * Normalize key strings from ID3 TKEY tag (which can be messy)
 * to our canonical KeyName type. Rejects Camelot-style entries.
 */
function normalizeKey(raw: string): KeyName | undefined {
  const trimmed = raw.trim();
  const match = trimmed.match(/^([A-G])([#b]?)(m|min|minor)?$/i);
  if (!match) return undefined;
  const [, root, accidental, minorTag] = match;
  return canonicalKey(root.toUpperCase(), accidental || '', !!minorTag);
}

/**
 * Try to extract a key from a filename. Recognizes common patterns:
 *   "Song - Cm.mp3"          → Cm
 *   "Song [Db].mp3"          → Db
 *   "Song (E) live.mp3"      → E
 *   "Song in F#m.mp3"        → F#m
 *   "Song _Bbm_ stems.mp3"   → Bbm
 *
 * Conservative: requires the key to be set off by a clear delimiter so we
 * don't false-positive on "A" or "Em" appearing inside a word.
 */
/**
 * Stricter "the filename IS the key" parser, used when scanning a pad folder
 * where each file is named exactly like its key (A.wav, C#.wav, Bbm.wav, etc.).
 * `folderHint` ('major' | 'minor') comes from the parent folder name and is
 * applied when the filename has no minor suffix.
 */
function parseKeyAsExactName(
  baseName: string,
  folderHint: 'major' | 'minor' | null,
): KeyName | undefined {
  const trimmed = baseName.trim();
  const match = trimmed.match(/^([A-G])([#b]?)(m|min|minor)?$/i);
  if (!match) return undefined;
  const [, root, accidental, minorTag] = match;
  const isMinor = !!minorTag || folderHint === 'minor';
  return canonicalKey(root.toUpperCase(), accidental || '', isMinor);
}

export interface PadScanResult {
  filePath: string;
  key: KeyName;
}

/**
 * Walk `folderPath` recursively for audio files where each filename matches
 * a key name. Returns one entry per matched file.
 *
 * `mode`:
 *   undefined / null → auto-detect: parent folder names containing "minor"
 *                      mark children minor, "major" marks major; otherwise
 *                      a plain key (like "A") is treated as major.
 *   'major' / 'minor' → forces every plain key (no `m` suffix in the name)
 *                       to that mode. Useful when the user is scanning a
 *                       folder where the files are bare letters (A.wav,
 *                       C.wav) and they know they're all the same flavor.
 */
export async function scanPadFolder(
  folderPath: string,
  mode?: 'major' | 'minor' | null,
): Promise<PadScanResult[]> {
  if (!fs.existsSync(folderPath)) return [];
  const out: PadScanResult[] = [];

  const isMinorFolder = (name: string): boolean =>
    /^min(or)?$/i.test(name);
  const isMajorFolder = (name: string): boolean =>
    /^maj(or)?$/i.test(name);

  const walk = (dir: string, hint: 'major' | 'minor' | null) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // When the caller forces a mode, ignore folder-name hints so a
        // "Major" subfolder under a Minor scan still gets minor mapping.
        const next = mode
          ? hint
          : isMinorFolder(entry.name)
            ? 'minor'
            : isMajorFolder(entry.name)
              ? 'major'
              : hint;
        walk(full, next);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!AUDIO_EXTENSIONS.includes(ext)) continue;
        const baseName = path.basename(entry.name, ext);
        const key = parseKeyAsExactName(baseName, mode ?? hint);
        if (key) out.push({ filePath: full, key });
      }
    }
  };

  // When the caller didn't force a mode, also look at the picked folder's
  // own name — the user may have selected the "Minor" subfolder directly
  // (so there are no nested Minor/ folders to provide the hint).
  const startingHint: 'major' | 'minor' | null =
    mode
      ?? (isMinorFolder(path.basename(folderPath))
        ? 'minor'
        : isMajorFolder(path.basename(folderPath))
          ? 'major'
          : null);

  walk(folderPath, startingHint);
  return out;
}

function parseKeyFromFilename(name: string): KeyName | undefined {
  // Bracketed: [C], (Cm), {F#m}
  const bracketed = name.match(/[\[\(\{]\s*([A-G])([#b]?)\s*(m|min|minor)?\s*[\]\)\}]/i);
  if (bracketed) {
    const k = canonicalKey(bracketed[1].toUpperCase(), bracketed[2] || '', !!bracketed[3]);
    if (k) return k;
  }
  // "in C", "in Cm" (whole-word)
  const inKey = name.match(/\bin\s+([A-G])([#b]?)(m|min|minor)?\b/i);
  if (inKey) {
    const k = canonicalKey(inKey[1].toUpperCase(), inKey[2] || '', !!inKey[3]);
    if (k) return k;
  }
  // Trailing token after a dash, underscore, or space: "Song - Cm", "Song_Bbm"
  // Anchor to end-of-name so we don't grab "A" out of an artist name.
  const trailing = name.match(/[-_\s]([A-G])([#b]?)(m|min|minor)?\s*$/i);
  if (trailing) {
    const k = canonicalKey(trailing[1].toUpperCase(), trailing[2] || '', !!trailing[3]);
    if (k) return k;
  }
  return undefined;
}
