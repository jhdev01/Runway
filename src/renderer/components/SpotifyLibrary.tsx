import React, { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../state/store';
import type { SpotifyPlaylistResult, SpotifyPlaylistSummary, SpotifyPlaylistTrack, SpotifyStatus } from '@shared/types';
import { formatDuration } from '../lib/format';
import { SpotifySongList } from './SpotifySongList';
import { SpotifyTestRunPanel } from './SpotifyTestRunPanel';
import { SpotifyBadge } from './SpotifyBadge';

/**
 * Library › Spotify: import Spotify playlists, then work on their songs the
 * way the Library works on imported tracks — album art, keys, trims — and
 * try a test run. Imported playlists are what services, post-service and
 * Actions can pick from.
 */
export function SpotifyLibrary() {
  const config = useAppStore(s => s.config);
  const updateConfig = useAppStore(s => s.updateConfig);
  const openSettings = useAppStore(s => s.openSettings);
  const cache = config.spotify?.playlistCache ?? {};
  const artCache = config.spotify?.artCache ?? {};
  const imported = Object.entries(cache)
    .filter(([, pl]) => pl.ok)
    .sort((a, b) => (a[1].name ?? '').localeCompare(b[1].name ?? ''));

  const [status, setStatus] = useState<SpotifyStatus | null>(null);
  const [mine, setMine] = useState<SpotifyPlaylistSummary[] | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('all');
  const [artProgress, setArtProgress] = useState<{ done: number; total: number } | null>(null);

  useEffect(() => { void window.runway?.spotify?.status().then(setStatus); }, []);
  const loadMine = async () => {
    setMine(null);
    const r = await window.runway.spotify.listPlaylists();
    setMine(r.ok ? (r.playlists ?? []) : []);
    if (!r.ok) setNote(r.reason ?? 'Couldn’t load your Spotify playlists.');
  };

  const saveCache = (id: string, pl: SpotifyPlaylistResult | null) => {
    const latest = useAppStore.getState().config.spotify;
    const next = { ...(latest?.playlistCache ?? {}) };
    if (pl) next[id] = pl; else delete next[id];
    updateConfig({ spotify: { ...latest, playlistCache: next } });
  };

  const importPlaylist = async (id: string) => {
    setPicking(false);
    setBusy(id);
    setNote(null);
    try {
      const r = await window.runway.spotify.readPlaylist(`spotify:playlist:${id}`);
      if (r.ok && r.playlistId) {
        saveCache(r.playlistId, r);
        setFilter(r.playlistId);
        setNote(`Imported “${r.name}” — ${r.tracks?.length ?? 0} songs${r.skipped ? ` (${r.skipped} skipped: podcasts or local files)` : ''}.`);
      } else setNote(r.reason ?? 'Couldn’t read that playlist.');
    } finally { setBusy(null); }
  };

  const reloadAll = async () => {
    setBusy('all');
    setNote(null);
    let ok = 0;
    try {
      for (const [id] of imported) {
        const r = await window.runway.spotify.readPlaylist(`spotify:playlist:${id}`);
        if (r.ok) { saveCache(id, r); ok++; }
      }
      setNote(`Reloaded ${ok} of ${imported.length} playlist${imported.length === 1 ? '' : 's'} from Spotify.`);
    } finally { setBusy(null); }
  };

  // Songs across the shown playlist(s), one row per song.
  const songs: SpotifyPlaylistTrack[] = useMemo(() => {
    const lists = filter === 'all' ? imported.map(([, pl]) => pl) : [cache[filter]].filter(Boolean);
    const seen = new Set<string>();
    const out: SpotifyPlaylistTrack[] = [];
    for (const pl of lists) for (const t of pl?.tracks ?? []) {
      if (seen.has(t.uri)) continue;
      seen.add(t.uri);
      out.push(t);
    }
    return out;
  }, [filter, cache]); // eslint-disable-line react-hooks/exhaustive-deps

  const downloadArt = async () => {
    const targets = songs.filter(t => t.albumArtUrl && !artCache[t.uri]);
    setArtProgress({ done: 0, total: targets.length });
    let done = 0, failed = 0;
    for (const t of targets) {
      const r = await window.runway.spotify.fetchArt(t.albumArtUrl!);
      if (r.ok && r.dataUrl) {
        const latest = useAppStore.getState().config.spotify;
        updateConfig({ spotify: { ...latest, artCache: { ...(latest?.artCache ?? {}), [t.uri]: r.dataUrl } } });
      } else failed++;
      done++;
      setArtProgress({ done, total: targets.length });
    }
    setArtProgress(null);
    setNote(targets.length === 0
      ? 'All artwork here is already downloaded.'
      : `Downloaded artwork for ${done - failed} song${done - failed === 1 ? '' : 's'}${failed ? ` (${failed} failed)` : ''}.`);
  };

  const shown = filter !== 'all' ? cache[filter] : null;
  const totalSec = songs.reduce((a, t) => a + t.durationMs / 1000, 0);
  const importable = (mine ?? []).filter(p => !cache[p.id]);

  if (status && !status.connected) {
    return (
      <div className="library-view" style={{ padding: 24 }}>
        <div className="settings-section-title">Spotify isn’t connected</div>
        <div className="settings-section-sub">Connect your Spotify account once in Settings › Engine, then import playlists here.</div>
        <button className="btn-secondary" onClick={() => openSettings('engine')}>Open Spotify settings</button>
      </div>
    );
  }

  return (
    <div className="library-view">
      <header className="library-toolbar">
        <div className="library-title">
          <strong>Spotify</strong> <SpotifyBadge title="Songs here play through the Spotify app" />
          <span className="library-count">
            {imported.length} playlist{imported.length === 1 ? '' : 's'} · {songs.length} song{songs.length === 1 ? '' : 's'}{songs.length ? ` · ${formatDuration(totalSec)}` : ''}
          </span>
        </div>
        <div style={{ position: 'relative' }}>
          <button
            className="library-upload"
            onClick={() => { setPicking(p => !p); if (mine === null) void loadMine(); }}
            disabled={busy !== null}
          >
            {busy && busy !== 'all' ? 'Importing…' : '+ Import playlist'}
          </button>
          {picking && (
            <div className="post-pick-pop" style={{ right: 'auto', left: 0, minWidth: 280 }}>
              {mine === null && <div className="post-pick-empty">Loading your playlists…</div>}
              {mine !== null && importable.length === 0 && <div className="post-pick-empty">All your playlists are imported.</div>}
              {importable.map(p => (
                <button key={p.id} type="button" className="post-pick-row" onClick={() => void importPlaylist(p.id)}>
                  <span className="post-pick-check" />
                  <span className="post-pick-name">{p.name}{p.songCount !== undefined ? ` (${p.songCount})` : ''}</span>
                </button>
              ))}
              <div className="post-pick-empty" style={{ fontSize: 11 }}>Only playlists you made or collaborate on can be read.</div>
            </div>
          )}
        </div>
        <button className="library-refresh" onClick={() => void reloadAll()} disabled={busy !== null || imported.length === 0}
          title="Pick up songs added or removed in Spotify">
          {busy === 'all' ? 'Reloading…' : '↻ Reload from Spotify'}
        </button>
        <button className="library-refresh" onClick={() => void downloadArt()} disabled={artProgress !== null || songs.length === 0}
          title="Save album art in Runway so it shows without internet">
          {artProgress ? `Artwork ${artProgress.done}/${artProgress.total}` : '⤓ Download artwork'}
        </button>
      </header>

      <div style={{ padding: '10px 16px', overflowY: 'auto' }}>
        <div className="pp-actions" style={{ flexWrap: 'wrap', gap: 6 }}>
          <button className={`btn-secondary ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}
            style={filter === 'all' ? { borderColor: 'var(--accent)' } : undefined}>
            All songs
          </button>
          {imported.map(([id, pl]) => (
            <span key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
              <button className="btn-secondary" onClick={() => setFilter(id)}
                style={filter === id ? { borderColor: '#1ed760' } : undefined}>
                <span style={{ color: '#1ed760' }}>●</span> {pl.name} <span style={{ opacity: 0.6 }}>({pl.tracks?.length ?? 0})</span>
              </button>
              <button className="btn-secondary" title={`Remove “${pl.name}” from Runway (it stays in Spotify)`}
                onClick={() => { saveCache(id, null); if (filter === id) setFilter('all'); }}
                style={{ padding: '2px 8px' }}>×</button>
            </span>
          ))}
        </div>
        {note && <div className="settings-field-sub" style={{ marginTop: 6 }}>{note}</div>}
        {imported.length === 0 ? (
          <div className="settings-section-sub" style={{ marginTop: 16 }}>
            No Spotify playlists yet. Press <strong>+ Import playlist</strong> to bring one in. Imported playlists show up in
            service settings, post-service and Actions, marked <SpotifyBadge />.
          </div>
        ) : (
          <>
            <SpotifySongList tracks={songs} />
            {shown?.ok && shown.tracks && shown.tracks.length > 0 && <SpotifyTestRunPanel playlist={shown} />}
            {!shown && <div className="settings-field-sub" style={{ marginTop: 10 }}>Pick one playlist above to try a test run with it.</div>}
          </>
        )}
      </div>
    </div>
  );
}
