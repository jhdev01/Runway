import React, { useEffect, useState } from 'react';
import { useAppStore } from '../state/store';
import type { SpotifyPlaylistSummary } from '@shared/types';

// Shared across every open menu so the Spotify list is fetched once per session.
let spotifyListCache: SpotifyPlaylistSummary[] | null = null;
let spotifyListPromise: Promise<SpotifyPlaylistSummary[]> | null = null;
function loadSpotifyPlaylists(): Promise<SpotifyPlaylistSummary[]> {
  if (spotifyListCache) return Promise.resolve(spotifyListCache);
  if (!spotifyListPromise) {
    spotifyListPromise = (async () => {
      try {
        const st = await window.runway?.spotify?.status();
        if (!st?.connected) return [];
        const r = await window.runway.spotify.listPlaylists();
        spotifyListCache = r.ok ? (r.playlists ?? []) : [];
        return spotifyListCache;
      } catch { return []; } finally { spotifyListPromise = null; }
    })();
  }
  return spotifyListPromise;
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
  const cached = useAppStore(s => s.config.spotify?.playlistCache);
  const [spotify, setSpotify] = useState<SpotifyPlaylistSummary[]>(spotifyListCache ?? []);
  useEffect(() => { void loadSpotifyPlaylists().then(setSpotify); }, []);

  // Offer saved (previously read) Spotify playlists too, so the menu still
  // shows the current choice when Spotify isn't reachable.
  const spotifyOptions = [...spotify];
  for (const [id, pl] of Object.entries(cached ?? {})) {
    if (!spotifyOptions.some(p => p.id === id)) spotifyOptions.push({ id, name: pl.name ?? 'Spotify playlist' });
  }
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
