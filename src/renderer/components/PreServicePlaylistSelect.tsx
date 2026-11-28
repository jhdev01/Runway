import React from 'react';
import { useAppStore } from '../state/store';
import type { SpotifyPlaylistSummary } from '@shared/types';

/**
 * The Spotify playlists to offer in service, post-service and Action menus:
 * only the ones imported in Playlists › Spotify (or Library › Spotify), not
 * the whole account. Read fresh each time, so a playlist imported or
 * removed shows up straight away.
 */
export function importedSpotifyPlaylists(kind?: 'pre' | 'post'): SpotifyPlaylistSummary[] {
  const sp = useAppStore.getState().config.spotify;
  const cache = sp?.playlistCache ?? {};
  return Object.entries(cache)
    .filter(([, pl]) => pl?.ok)
    // Its Playlist type (Playlists › Spotify): none set = offered in both menus.
    .filter(([id]) => { const k = sp?.playlistSettings?.[id]?.kind; return !kind || !k || k === kind; })
    .map(([id, pl]) => ({ id, name: pl.name ?? 'Spotify playlist' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
/** Kept for callers that load asynchronously. Imported playlists only. */
export function loadSpotifyPlaylists(): Promise<SpotifyPlaylistSummary[]> {
  return Promise.resolve(importedSpotifyPlaylists());
}

export interface PreServiceMusicValue {
  preServicePlaylistId?: string;
  spotifyPlaylistId?: string;
  spotifyPlaylistName?: string;
}

/**
 * Pre-service music picker: the operator's Runway "pre" playlists, plus
 * (when Spotify is connected) their Spotify playlists. Picking one source
 * clears the other, so a service always has exactly one.
 */
export function PreServicePlaylistSelect({ value, onChange }: {
  value: PreServiceMusicValue;
  onChange: (patch: PreServiceMusicValue) => void;
}) {
  const playlists = useAppStore(s => s.config.playlists);
  // Re-render when playlists are imported / removed.
  useAppStore(s => s.config.spotify?.playlistCache);
  useAppStore(s => s.config.spotify?.playlistSettings);
  // Imported Spotify playlists only (plus the current choice, if it was removed).
  const spotifyOptions = importedSpotifyPlaylists('pre');
  if (value.spotifyPlaylistId && !spotifyOptions.some(p => p.id === value.spotifyPlaylistId)) {
    spotifyOptions.push({ id: value.spotifyPlaylistId, name: value.spotifyPlaylistName ?? 'Spotify playlist' });
  }

  const current = value.spotifyPlaylistId ? `spotify:${value.spotifyPlaylistId}` : (value.preServicePlaylistId ?? '');
  return (
    <select
      className="select"
      value={current}
      onChange={e => {
        const v = e.target.value;
        if (v.startsWith('spotify:')) {
          const id = v.slice('spotify:'.length);
          const name = spotifyOptions.find(p => p.id === id)?.name;
          onChange({ spotifyPlaylistId: id, spotifyPlaylistName: name });
        } else {
          onChange({ preServicePlaylistId: v || undefined, spotifyPlaylistId: undefined, spotifyPlaylistName: undefined });
        }
      }}
    >
      <option value="">— none —</option>
      {playlists.filter(p => p.kind === 'pre').map(p => (
        <option key={p.id} value={p.id}>{p.name}</option>
      ))}
      {spotifyOptions.length > 0 && (
        <optgroup label="Spotify (experimental, Mac only)">
          {spotifyOptions.map(p => (
            <option key={p.id} value={`spotify:${p.id}`}>{p.name}</option>
          ))}
        </optgroup>
      )}
    </select>
  );
}

/**
 * Post-service music picker. Value is a Runway playlist id, or
 * "spotify:<playlist id>" for a Spotify playlist (played in order by the
 * Spotify app after the service).
 */
export function PostServicePlaylistSelect({ value, onChange }: {
  value: string | undefined;
  onChange: (postServicePlaylistId: string | undefined) => void;
}) {
  const playlists = useAppStore(s => s.config.playlists);
  useAppStore(s => s.config.spotify?.playlistCache);
  useAppStore(s => s.config.spotify?.playlistSettings);
  const spotifyOptions = importedSpotifyPlaylists('post');
  const cur = value ?? '';
  if (cur.startsWith('spotify:') && !spotifyOptions.some(p => `spotify:${p.id}` === cur)) {
    spotifyOptions.push({ id: cur.slice(8), name: 'Spotify playlist' });
  }
  return (
    <select className="select" value={cur} onChange={e => onChange(e.target.value || undefined)}>
      <option value="">— none —</option>
      {playlists.filter(p => p.kind === 'post').map(p => (
        <option key={p.id} value={p.id}>{p.name}</option>
      ))}
      {spotifyOptions.length > 0 && (
        <optgroup label="Spotify (experimental, Mac only)">
          {spotifyOptions.map(p => <option key={p.id} value={`spotify:${p.id}`}>{p.name}</option>)}
        </optgroup>
      )}
    </select>
  );
}
