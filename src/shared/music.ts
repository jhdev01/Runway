import type { KeyName } from './types';

// Camelot wheel mapping
// Outer ring (B) = major, inner ring (A) = minor
// Same number = relative major/minor (compatible)
// ±1 number = perfect fifth/fourth (compatible)
const CAMELOT: Record<KeyName, string> = {
  // Major (B ring)
  'Ab': '4B', 'Eb': '5B', 'Bb': '6B', 'F': '7B',
  'C': '8B', 'G': '9B', 'D': '10B', 'A': '11B',
  'E': '12B', 'B': '1B', 'F#': '2B', 'Db': '3B',
  // Minor (A ring)
  'Fm': '4A', 'Cm': '5A', 'Gm': '6A', 'Dm': '7A',
  'Am': '8A', 'Em': '9A', 'Bm': '10A', 'F#m': '11A',
  'C#m': '12A', 'G#m': '1A', 'D#m': '2A', 'Bbm': '3A',
};

export const ALL_KEYS: KeyName[] = [
  'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'Db', 'Ab', 'Eb', 'Bb', 'F',
  'Am', 'Em', 'Bm', 'F#m', 'C#m', 'G#m', 'D#m', 'Bbm', 'Fm', 'Cm', 'Gm', 'Dm',
];

export const MAJOR_KEYS: KeyName[] = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'Db', 'Ab', 'Eb', 'Bb', 'F'];
export const MINOR_KEYS: KeyName[] = ['Am', 'Em', 'Bm', 'F#m', 'C#m', 'G#m', 'D#m', 'Bbm', 'Fm', 'Cm', 'Gm', 'Dm'];

export function camelotOf(key: KeyName): string {
  return CAMELOT[key];
}

/**
 * Render a key name in either flat or sharp form for display. Internal
 * storage stays flat (Db/Ab/Eb/Bb/Bbm) — this only changes the label.
 */
const FLAT_TO_SHARP: Partial<Record<KeyName, string>> = {
  'Db': 'C#', 'Ab': 'G#', 'Eb': 'D#', 'Bb': 'A#',
  'Bbm': 'A#m',
};
const SHARP_TO_FLAT: Partial<Record<string, KeyName>> = {
  'C#': 'Db', 'G#': 'Ab', 'D#': 'Eb', 'A#': 'Bb',
  'A#m': 'Bbm',
};

export function displayKey(key: KeyName | undefined, mode: 'sharp' | 'flat' = 'sharp'): string {
  if (!key) return '—';
  if (mode === 'sharp') return FLAT_TO_SHARP[key] ?? key;
  return key;
}

/** Round-trip a possibly-sharp display label back to the canonical KeyName. */
export function canonicalKey(label: string): KeyName | undefined {
  if (label in CAMELOT) return label as KeyName;
  return SHARP_TO_FLAT[label];
}

// Enharmonic spellings Planning Center may use that aren't covered by the
// sharp↔flat table above (which only handles the four standard sharp
// majors + A#m). PCO minor keys come through with an "m" suffix; majors
// bare. These map the remaining spellings onto Runway's canonical names.
const PCO_ENHARMONIC: Record<string, KeyName> = {
  'Gb': 'F#', 'Cb': 'B', 'B#': 'C', 'E#': 'F',
  'Ebm': 'D#m', 'Abm': 'G#m', 'Dbm': 'C#m', 'Gbm': 'F#m',
};

/**
 * Map a Planning Center key string (e.g. "G", "Ab", "C#", "Em", "F#m",
 * "A#m") to Runway's canonical KeyName. PCO writes minor keys with a
 * trailing "m" and uses a mix of sharps/flats; we normalise whitespace,
 * try the canonical table, then the sharp↔flat table, then the extra
 * enharmonic spellings. Returns undefined when the string can't be
 * resolved (caller should skip + surface it, not guess).
 */
export function pcoKeyToRunway(pcoKey: string | null | undefined): KeyName | undefined {
  if (!pcoKey) return undefined;
  // Trim, drop any surrounding whitespace and a leading "of " some plans
  // include; keep only the first token (PCO occasionally appends notes).
  const raw = pcoKey.trim().split(/\s+/)[0];
  if (!raw) return undefined;
  // Normalise the accidental to a capital letter + optional #/b + optional m.
  const m = raw.match(/^([A-Ga-g])([#b]?)(m?)$/);
  if (!m) {
    // Fall back to a direct lookup for already-canonical or sharp labels.
    return canonicalKey(raw) ?? PCO_ENHARMONIC[raw];
  }
  const label = m[1].toUpperCase() + m[2] + m[3];
  return canonicalKey(label) ?? PCO_ENHARMONIC[label];
}

/**
 * Returns true if `from` and `to` are considered musically compatible
 * for transitions: same key, relative major/minor, or perfect 4th/5th.
 */
export function areKeysCompatible(from: KeyName, to: KeyName): boolean {
  if (from === to) return true;
  const a = CAMELOT[from];
  const b = CAMELOT[to];
  if (!a || !b) return false;

  const numA = parseInt(a);
  const numB = parseInt(b);
  const ringA = a.slice(-1);
  const ringB = b.slice(-1);

  // Relative major/minor: same number, different ring
  if (numA === numB && ringA !== ringB) return true;
  // Perfect 4th/5th: ±1 number, same ring (modular 1-12)
  if (ringA === ringB) {
    const diff = Math.abs(numA - numB);
    if (diff === 1 || diff === 11) return true;
  }
  return false;
}

/**
 * Returns a compatibility score: 0=identical, 1=relative or fifth, 2=somewhat related, 99=clash.
 * Lower is better for transitions.
 */
export function keyDistance(from: KeyName, to: KeyName): number {
  if (from === to) return 0;
  if (areKeysCompatible(from, to)) return 1;
  return 99;
}

/**
 * Returns all keys that are "compatible" with the given key
 * (same, relative major/minor, perfect 4th/5th).
 */
export function compatibleKeys(key: KeyName): KeyName[] {
  return ALL_KEYS.filter(k => k !== key && areKeysCompatible(key, k));
}

export function isMajor(key: KeyName): boolean {
  return MAJOR_KEYS.includes(key);
}

/**
 * Map a key to a stable color via its Camelot position. Compatible keys (relative
 * major/minor) share the same hue; major keys are brighter, minor keys deeper.
 * Returns CSS color strings.
 *  - bg: chip background (muted)
 *  - fg: chip text & border (lighter)
 *  - soft: low-opacity tint for whole-segment fills
 */
export function keyColor(key: KeyName | undefined): { bg: string; fg: string; soft: string; whisper: string } {
  const NEUTRAL = {
    bg: 'rgba(255,255,255,0.06)',
    fg: 'rgba(255,255,255,0.45)',
    soft: 'rgba(255,255,255,0.04)',
    whisper: 'rgba(255,255,255,0.02)',
  };
  if (!key) return NEUTRAL;
  const c = CAMELOT[key];
  if (!c) return NEUTRAL;
  const num = parseInt(c, 10);     // 1-12
  const isMaj = c.endsWith('B');
  const hue = ((num - 1) * 30) % 360;
  const sat = isMaj ? 50 : 38;
  const litBg = isMaj ? 26 : 20;
  return {
    bg: `hsl(${hue}, ${sat}%, ${litBg}%)`,
    fg: `hsl(${hue}, ${Math.min(70, sat + 18)}%, 75%)`,
    soft: `hsla(${hue}, ${sat}%, ${litBg + 8}%, 0.14)`,
    whisper: `hsla(${hue}, ${sat}%, ${litBg + 8}%, 0.13)`,
  };
}
