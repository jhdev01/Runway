import type { KeyName, MultitracksCandidate, MultitracksResult } from '../shared/types';

// ─── MultiTracks.com song key lookup ────────────────────────────────
//
// MultiTracks publishes the ORIGINAL MASTER key for essentially every
// modern worship song. That's the number a worship team actually cares
// about, and it beats ID3 tags (usually blank) and GetSongBPM (pop
// catalog, spotty on CCM) for this library.
//
// There is no public API. The site's own search box posts JSON to
// https://api.multitracks.com/search/songs and renders the result
// client-side; we make the same unauthenticated request. Nothing here
// is scraped from a page or requires an account.
//
// Consequences we design around:
//   - The endpoint is undocumented and can change without notice. Every
//     failure path returns a `reason` string instead of throwing so the
//     UI can say "MultiTracks lookup unavailable" and fall through to
//     manual entry.
//   - We are a guest on someone else's server: results are cached for
//     the life of the process, one request per song, and callers are
//     throttled (see LOOKUP_MIN_GAP_MS).
//
// IMPORTANT: MultiTracks reports the key as a ROOT ONLY — "B", "Gb",
// "Ab". It does not distinguish major from minor. We therefore always
// return the MAJOR canonical spelling, and the UI must never silently
// replace an operator's minor key with the major equivalent. On the
// Camelot wheel a key and its relative minor share a number, so for
// pad/transition purposes the root is the load-bearing part — but the
// operator gets the final say.

/** Query we send. Matches the payload the site's own search box builds. */
interface SearchRequest {
  searchText: string;
  order: number;
  pageNumber: number;
  pageSize: number;
  siteID: number;
  languageCode: string;
  restrictedCountry: boolean;
  countryID: number;
}

interface SearchItem {
  songID?: string;
  title?: string;
  artist?: string;
  album?: string;
  songURL?: string;
  duration?: number;
  originalKey?: string;
  artists?: Array<{ artist?: string }>;
}

const SEARCH_URL = 'https://api.multitracks.com/search/songs';
const REQUEST_TIMEOUT_MS = 9000;
/** Minimum spacing between outbound requests. Batch runs stay polite. */
const LOOKUP_MIN_GAP_MS = 350;

// Positive AND negative results are cached — a batch run over a library
// full of the same handful of artists otherwise re-asks constantly, and
// a miss is a miss until the operator edits the tags.
const cache = new Map<string, MultitracksResult>();

let lastRequestAt = 0;
/** Serializes outbound requests so a 200-track batch never bursts. */
let requestChain: Promise<unknown> = Promise.resolve();

// ─── Key normalization ──────────────────────────────────────────────

// MultiTracks spells keys with flats plus the odd "Gb"; the project's
// canonical major names use sharps only for F#. Everything MultiTracks
// returns is a major-ring name (see the module note above).
const MT_KEY_TO_CANONICAL: Record<string, KeyName> = {
  'C': 'C', 'G': 'G', 'D': 'D', 'A': 'A', 'E': 'E', 'B': 'B', 'F': 'F',
  'F#': 'F#', 'Gb': 'F#',
  'C#': 'Db', 'Db': 'Db',
  'D#': 'Eb', 'Eb': 'Eb',
  'G#': 'Ab', 'Ab': 'Ab',
  'A#': 'Bb', 'Bb': 'Bb',
};

/**
 * Map a MultiTracks `originalKey` string onto a canonical KeyName.
 * Returns undefined for anything unrecognized (blank, "N/A", a minor
 * spelling we didn't expect) rather than guessing.
 */
export function normalizeMultitracksKey(raw: string | undefined): KeyName | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  // Defensive: if MultiTracks ever starts emitting minor spellings,
  // honor them instead of flattening to the major root.
  const minor = trimmed.match(/^([A-G][#b]?)\s*(m|min|minor)$/i);
  if (minor) {
    const root = MT_KEY_TO_CANONICAL[normalizeRootCase(minor[1])];
    if (!root) return undefined;
    // Relative minor of the major root, spelled canonically.
    const MAJOR_TO_MINOR: Partial<Record<KeyName, KeyName>> = {
      'C': 'Cm', 'G': 'Gm', 'D': 'Dm', 'A': 'Am', 'E': 'Em', 'B': 'Bm',
      'F': 'Fm', 'F#': 'F#m', 'Db': 'C#m', 'Eb': 'D#m', 'Ab': 'G#m', 'Bb': 'Bbm',
    };
    return MAJOR_TO_MINOR[root];
  }
  return MT_KEY_TO_CANONICAL[normalizeRootCase(trimmed)];
}

/** "gb" / "GB" → "Gb"; leaves "F#" alone. */
function normalizeRootCase(root: string): string {
  if (!root) return root;
  return root[0].toUpperCase() + root.slice(1).toLowerCase().replace('#', '#');
}

// ─── Text normalization + scoring ───────────────────────────────────

/**
 * Strip the noise that keeps a local file from matching a catalog entry:
 * punctuation, articles, and the version suffixes that ride along on
 * worship releases ("(Live)", "[Radio Version]", "feat. …").
 */
function normalizeTitle(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\((?:feat|ft)\.?[^)]*\)/g, ' ')
    .replace(/\[(?:feat|ft)\.?[^\]]*\]/g, ' ')
    .replace(/\b(?:feat|ft)\.?\s+.*$/, ' ')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeArtist(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\((?:feat|ft)\.?[^)]*\)/g, ' ')
    .replace(/\b(?:feat|ft)\.?\s+.*$/, ' ')
    .replace(/\b(?:the|band|music|worship collective)\b/g, ' ')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** The version markers that make a release a variant of the main cut. */
const VARIANT_WORDS = /\b(live|radio|acoustic|remix|instrumental|reprise|medley|version|edit|mix|extended|demo|spontaneous|session|unplugged|choir)\b/;

function tokens(s: string): string[] {
  return s.split(' ').filter(Boolean);
}

/** Jaccard overlap of two token sets — 0..1, order-insensitive. */
function tokenOverlap(a: string, b: string): number {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / (ta.size + tb.size - shared);
}

/**
 * Score one catalog hit against what we know about the local file.
 * Returns 0..1; `MATCH_FLOOR` decides what's worth showing at all.
 *
 * Signals, in rough order of weight:
 *   - title agreement (exact normalized match >> token overlap)
 *   - artist agreement, checked against every credited artist so
 *     "Maverick City Music" matches a Chandler Moore feature
 *   - duration agreement, when we have a local duration — the single
 *     best way to tell a radio edit from an album cut, and those two
 *     are frequently in different keys
 *   - a small penalty for variant releases when the local title has no
 *     variant marker of its own
 */
function scoreCandidate(
  item: SearchItem,
  wantTitle: string,
  wantArtist: string,
  wantDurationSec: number | undefined,
): number {
  const mtTitle = normalizeTitle(item.title ?? '');
  if (!mtTitle) return 0;

  let score = 0;

  // Title — the dominant signal.
  if (mtTitle === wantTitle) {
    score += 0.55;
  } else {
    const overlap = tokenOverlap(mtTitle, wantTitle);
    // A one-word-in-common brush ("Praise" vs "Praise The Lord") is not
    // a match; require substantial overlap before crediting anything.
    if (overlap < 0.5) return 0;
    score += 0.55 * overlap;
  }

  // Artist — required when we know it, because worship covers share
  // titles constantly and a cover is often in a different key.
  if (wantArtist) {
    const credited = [item.artist ?? '', ...(item.artists ?? []).map(a => a.artist ?? '')]
      .map(normalizeArtist)
      .filter(Boolean);
    let bestArtist = 0;
    for (const c of credited) {
      if (c === wantArtist) { bestArtist = 1; break; }
      if (c.includes(wantArtist) || wantArtist.includes(c)) {
        bestArtist = Math.max(bestArtist, 0.85);
        continue;
      }
      bestArtist = Math.max(bestArtist, tokenOverlap(c, wantArtist));
    }
    if (bestArtist < 0.34) return 0;
    score += 0.3 * bestArtist;
  } else {
    // No artist on the file — we can't verify, so cap the confidence.
    // The UI shows these as "needs a look" rather than auto-applying.
    score += 0.1;
  }

  // Duration — strong disambiguator between cuts of the same song.
  if (wantDurationSec && wantDurationSec > 0 && item.duration && item.duration > 0) {
    const deltaSec = Math.abs(item.duration - wantDurationSec);
    if (deltaSec <= 2) score += 0.15;
    else if (deltaSec <= 6) score += 0.1;
    else if (deltaSec <= 15) score += 0.04;
    else if (deltaSec > 45) score -= 0.12;
  }

  // Prefer the plain album cut unless the local file asked for a variant.
  const localWantsVariant = VARIANT_WORDS.test(wantTitle);
  const mtIsVariant = VARIANT_WORDS.test(mtTitle);
  if (mtIsVariant && !localWantsVariant) score -= 0.12;
  if (!mtIsVariant && localWantsVariant) score -= 0.04;

  return Math.max(0, Math.min(1, score));
}

/** Below this, we'd rather report "no match" than offer a guess. */
const MATCH_FLOOR = 0.55;

// ─── Lookup ─────────────────────────────────────────────────────────

/**
 * Trim a filename-ish title down to something the catalog search will
 * actually match. Long credit lists are the main offender: searching
 * "Praise (feat. Brandon Lake, Chris Brown & Chandler Moore) Elevation
 * Worship" returns zero rows, while "Praise Elevation Worship" finds it
 * immediately. Version markers ("[Live]", "- Radio Version") are dropped
 * too — scoreCandidate() still prefers the matching cut afterwards.
 */
function searchTitle(title: string): string {
  return title
    .replace(/\((?:feat|ft)\.?[^)]*\)/gi, ' ')
    .replace(/\[(?:feat|ft)\.?[^\]]*\]/gi, ' ')
    .replace(/\b(?:feat|ft)\.?\s+.*$/i, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s+-\s+.*$/, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Artist credits get the same treatment, for the same reason. */
function searchArtist(artist: string): string {
  return artist
    .replace(/\((?:feat|ft)\.?[^)]*\)/gi, ' ')
    .replace(/\b(?:feat|ft)\.?\s+.*$/i, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function searchMultitracks(searchText: string): Promise<SearchItem[]> {
  const body: SearchRequest = {
    searchText,
    // `order: 1` is the site's relevance sort. The endpoint rejects a
    // null order with `{ result: 0 }` and no items, so it must be set.
    order: 1,
    pageNumber: 1,
    pageSize: 20,
    siteID: 1,
    languageCode: 'en',
    restrictedCountry: false,
    countryID: 1,
  };
  const res = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-type': 'application/json',
      // The endpoint is CORS-guarded for browsers; from the main
      // process we send the site origin so the request looks like what
      // the server expects rather than an anonymous cross-origin poke.
      'Origin': 'https://www.multitracks.com',
      'Referer': 'https://www.multitracks.com/search/',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`MultiTracks HTTP ${res.status}`);
  const json = await res.json() as { items?: SearchItem[] };
  return Array.isArray(json.items) ? json.items : [];
}

/**
 * Find the original master key for `artist` — `title` on MultiTracks.
 *
 * `durationSec` is optional but worth passing: it's what separates the
 * radio edit from the album cut when the two sit in different keys.
 *
 * Never throws. Every failure comes back as `{ alternates: [], reason }`.
 */
export async function multitracksLookup(
  artist: string,
  title: string,
  durationSec?: number,
): Promise<MultitracksResult> {
  const wantTitle = normalizeTitle(title);
  const wantArtist = normalizeArtist(artist);
  if (!wantTitle) return { alternates: [], reason: 'No song title to search on' };

  const cacheKey = `${wantArtist}|${wantTitle}|${durationSec ? Math.round(durationSec) : ''}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  // Chain onto the previous lookup and hold LOOKUP_MIN_GAP_MS between
  // requests, so a "tag my whole library" run trickles instead of
  // bursting a few hundred requests at someone else's server.
  const run = requestChain.then(async (): Promise<MultitracksResult> => {
    const wait = LOOKUP_MIN_GAP_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastRequestAt = Date.now();

    // Searching "title artist" is what an operator would type, and it's
    // what the endpoint ranks best on. Progressively widen: cleaned
    // title + artist, then cleaned title alone (catches the case where
    // the file's artist spelling isn't in the catalog at all), then the
    // raw title as the operator typed it. Each attempt is one request,
    // and we stop at the first that returns rows.
    const qTitle = searchTitle(title) || title;
    const qArtist = searchArtist(artist);
    const queries = [
      qArtist ? `${qTitle} ${qArtist}` : qTitle,
      qTitle,
      title.trim(),
    ].filter((q, i, arr) => q && arr.indexOf(q) === i);

    let items: SearchItem[] = [];
    let usedQuery = queries[0];
    for (const q of queries) {
      items = await searchMultitracks(q);
      usedQuery = q;
      if (items.length > 0) break;
      // Stay polite between the widening attempts too.
      lastRequestAt = Date.now();
      await new Promise(r => setTimeout(r, LOOKUP_MIN_GAP_MS));
    }
    if (items.length === 0) {
      return { alternates: [], reason: `No MultiTracks result for "${queries[0]}"` };
    }

    const scored: MultitracksCandidate[] = [];
    for (const item of items) {
      const key = normalizeMultitracksKey(item.originalKey);
      if (!key) continue;   // no published key — nothing to import
      const score = scoreCandidate(item, wantTitle, wantArtist, durationSec);
      if (score < MATCH_FLOOR) continue;
      scored.push({
        key,
        title: item.title ?? '',
        artist: item.artist ?? '',
        album: item.album ?? '',
        url: item.songURL ? `https://www.multitracks.com${item.songURL}` : 'https://www.multitracks.com/',
        durationSec: item.duration,
        score,
      });
    }
    scored.sort((a, b) => b.score - a.score);

    if (scored.length === 0) {
      return {
        alternates: [],
        reason: `MultiTracks found songs for "${usedQuery}" but none matched "${artist || '?'} — ${title}" closely enough`,
      };
    }

    const [best, ...rest] = scored;
    // Only surface alternates that actually disagree about the key —
    // five listings of the same song in B is noise, not a choice.
    const alternates: MultitracksCandidate[] = [];
    const seenKeys = new Set<KeyName>([best.key]);
    for (const c of rest) {
      if (seenKeys.has(c.key)) continue;
      seenKeys.add(c.key);
      alternates.push(c);
      if (alternates.length >= 4) break;
    }
    return { best, alternates };
  });

  // Keep the chain alive even when a lookup fails, or one network blip
  // would wedge every later request behind a rejected promise.
  requestChain = run.catch(() => undefined);

  let result: MultitracksResult;
  try {
    result = await run;
  } catch (err) {
    // Don't cache transient failures — the operator retrying after the
    // network comes back should actually re-request.
    console.warn('[multitracks] lookup failed:', err);
    return { alternates: [], reason: String(err instanceof Error ? err.message : err) };
  }
  cache.set(cacheKey, result);
  return result;
}
