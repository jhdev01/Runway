/**
 * Buy list: which Spotify songs you already own as files, store links for
 * the rest, and picking up what you bought (from Downloads) as Library
 * tracks linked to their Spotify songs, with the song's key and edits
 * carried over. Nothing here buys anything: stores only allow purchases by
 * the operator, in the store.
 */

import type { KeyName, SpotifyPlaylistTrack, SpotifyTrackEdit, Track } from '@shared/types';
import { useAppStore, generateId } from '../state/store';
import { allImportedSpotifySongs } from './spotifyWaveformScan';

const plain = (s: string) => (s ?? '').toLowerCase()
  .replace(/\s+-\s+.*$/, '')
  .replace(/[([](?:feat|ft|with|live|radio|single|acoustic|remaster|edit|version|studio|deluxe)\b[^)\]]*[)\]]/g, '')
  .replace(/[’']/g, '')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();
const firstArtist = (s: string | undefined) => plain((s ?? '').split(/,\s*|\s+&\s+|\s+feat\.?\s+/i)[0] ?? '');

/** Same song? Title must match; artist must overlap; length within 12 s when both known. */
function sameSong(title: string, artist: string | undefined, durSec: number | undefined, sp: SpotifyPlaylistTrack): boolean {
  if (plain(title) !== plain(sp.title)) return false;
  const a = firstArtist(artist), b = firstArtist(sp.artist);
  if (a && b && !(a.includes(b) || b.includes(a))) return false;
  const sd = sp.durationMs / 1000;
  if (durSec && sd && Math.abs(durSec - sd) > 12) return false;
  return true;
}

/** The Library track that is this Spotify song's bought copy, if any. */
export function ownedTrackFor(sp: SpotifyPlaylistTrack): Track | undefined {
  const st = useAppStore.getState();
  const linked = st.config.spotify?.ownedLinks?.[sp.uri];
  if (linked) {
    const t = st.config.tracks.find(x => x.id === linked);
    if (t) return t;
  }
  return st.config.tracks.find(t => sameSong(t.title, t.artist, t.durationSec, sp));
}

export const qobuzSearchUrl = (sp: SpotifyPlaylistTrack) =>
  `https://www.qobuz.com/us-en/search?q=${encodeURIComponent(`${plain(sp.title)} ${firstArtist(sp.artist)}`)}`;
export const appleSearchUrl = (sp: SpotifyPlaylistTrack) =>
  `https://music.apple.com/us/search?term=${encodeURIComponent(`${plain(sp.title)} ${firstArtist(sp.artist)}`)}`;

/**
 * Link a Library track to a Spotify song and carry the song's key and
 * edits over to the track (only fields the track doesn't have yet). Trims
 * and markers are only copied when the two are the same length (±2 s);
 * otherwise the file is a different cut and positions wouldn't line up.
 */
function link(sp: SpotifyPlaylistTrack, track: Track): boolean {
  const st = useAppStore.getState();
  const latest = st.config.spotify;
  st.updateConfig({ spotify: { ...latest, ownedLinks: { ...(latest?.ownedLinks ?? {}), [sp.uri]: track.id } } });
  const e: SpotifyTrackEdit = latest?.trackEdits?.[sp.uri] ?? {};
  const patch: Partial<Track> = {};
  if (e.key && !track.key) patch.key = e.key as KeyName;
  const sameLength = !track.durationSec || Math.abs(track.durationSec - sp.durationMs / 1000) <= 2;
  if (sameLength) {
    if (e.trimStartSec !== undefined && track.trimStartSec === undefined) patch.trimStartSec = e.trimStartSec;
    if (e.trimEndSec !== undefined && track.trimEndSec === undefined) patch.trimEndSec = e.trimEndSec;
    if (e.fadeInSec !== undefined && track.editFadeInSec === undefined) patch.editFadeInSec = e.fadeInSec;
    if (e.fadeOutSec !== undefined && track.editFadeOutSec === undefined) patch.editFadeOutSec = e.fadeOutSec;
    if (e.landSec !== undefined && track.editServiceLandSec === undefined) patch.editServiceLandSec = e.landSec;
  }
  if (Object.keys(patch).length) st.updateTrack(track.id, patch);
  return sameLength;
}

export interface PurchaseImport { found: number; imported: number; linked: number; differentCut: number; unmatched: string[]; reason?: string }

/**
 * Looks in Downloads for songs bought since `sinceMs` (loose audio files
 * and Qobuz zips), adds new ones to the Library, and links each to its
 * Spotify song. Safe to run repeatedly: files already in the Library are
 * matched, not imported twice.
 */
export async function importPurchases(sinceMs: number): Promise<PurchaseImport> {
  const res = await window.runway.purchases.find(sinceMs);
  const out: PurchaseImport = { found: res.files.length, imported: 0, linked: 0, differentCut: 0, unmatched: [], reason: res.reason };
  if (res.files.length === 0) return out;
  const spotify = allImportedSpotifySongs();
  for (const f of res.files) {
    let meta: Partial<Track> = {};
    try { meta = await window.runway.files.readMetadata(f); } catch { continue; }
    const title = meta.title || f.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, '');
    const st = useAppStore.getState();
    // Already in the Library (imported earlier)?
    let track = st.config.tracks.find(t => plain(t.title) === plain(title)
      && firstArtist(t.artist) === firstArtist(meta.artist)
      && Math.abs((t.durationSec ?? 0) - (meta.durationSec ?? 0)) <= 2);
    if (!track) {
      let managed = f;
      try { managed = await window.runway.files.importFile(f); } catch { /* keep original path */ }
      const t: Track = {
        id: generateId(), filePath: managed, title, artist: meta.artist, album: meta.album,
        durationSec: meta.durationSec ?? 0, key: meta.key, bpm: meta.bpm, addedAt: new Date().toISOString(),
      };
      const ids = useAppStore.getState().addTracks([t]);
      track = useAppStore.getState().config.tracks.find(x => x.id === (ids[managed] ?? t.id)) ?? t;
      out.imported++;
    }
    const links = useAppStore.getState().config.spotify?.ownedLinks ?? {};
    const matches = spotify.filter(sp => !links[sp.uri] && sameSong(track!.title, track!.artist, track!.durationSec, sp));
    if (matches.length === 0) { out.unmatched.push(title); continue; }
    for (const sp of matches) {
      out.linked++;
      if (!link(sp, track)) out.differentCut++;
    }
  }
  const latest = useAppStore.getState().config.spotify;
  useAppStore.getState().updateConfig({ spotify: { ...latest, purchaseScanAt: Date.now() } });
  console.log('[operator] purchases imported', { found: out.found, imported: out.imported, linked: out.linked });
  return out;
}

/** Link Library tracks that already match Spotify songs (bought earlier). */
export function linkExistingOwned(songs: SpotifyPlaylistTrack[]): number {
  let n = 0;
  const links = useAppStore.getState().config.spotify?.ownedLinks ?? {};
  for (const sp of songs) {
    if (links[sp.uri]) continue;
    const t = ownedTrackFor(sp);
    if (t) { link(sp, t); n++; }
  }
  return n;
}

/** A Runway playlist of the owned copies, in the Spotify playlist's order. */
export function makeRunwayPlaylist(name: string, songs: SpotifyPlaylistTrack[], kind: 'pre' | 'post'): { id: string; count: number } {
  const st = useAppStore.getState();
  const ids: string[] = [];
  for (const sp of songs) {
    const t = ownedTrackFor(sp);
    if (t && !ids.includes(t.id)) ids.push(t.id);
  }
  const id = st.createPlaylist(name, kind);
  st.updatePlaylist(id, { trackIds: ids });
  return { id, count: ids.length };
}
