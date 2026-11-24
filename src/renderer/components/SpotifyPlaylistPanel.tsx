import React, { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../state/store';
import type { SpotifyPlaylistResult, SpotifyPlaylistSummary, SpotifyStatus } from '@shared/types';
import { formatDuration } from '../lib/format';
import { songBounds } from '../lib/spotifyTestRun';
import { SpotifySongList } from './SpotifySongList';
import { SpotifyTestRunPanel } from './SpotifyTestRunPanel';
import { SpotifyBadge } from './SpotifyBadge';

function saveCache(id: string, pl: SpotifyPlaylistResult | null) {
  const st = useAppStore.getState();
  const latest = st.config.spotify;
  const next = { ...(latest?.playlistCache ?? {}) };
  if (pl) next[id] = pl; else delete next[id];
  st.updateConfig({ spotify: { ...latest, playlistCache: next } });
}

/**
 * Playlists sidebar: "Import from Spotify". Lists the user's own and
 * collaborative Spotify playlists that aren't imported yet; picking one
 * reads its songs into Runway and selects it.
 */
export function SpotifyImportButton({ onImported }: { onImported: (id: string) => void }) {
  const cache = useAppStore(s => s.config.spotify?.playlistCache) ?? {};
  const openSettings = useAppStore(s => s.openSettings);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<SpotifyStatus | null>(null);
  const [mine, setMine] = useState<SpotifyPlaylistSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next) return;
    setNote(null);
    const st = await window.runway?.spotify?.status();
    setStatus(st ?? { connected: false });
    if (st?.connected) {
      const r = await window.runway.spotify.listPlaylists();
      setMine(r.ok ? (r.playlists ?? []) : []);
      if (!r.ok) setNote(r.reason ?? 'Couldn’t load your Spotify playlists.');
    }
  };
  const importOne = async (id: string) => {
    setBusy(true);
    try {
      const r = await window.runway.spotify.readPlaylist(`spotify:playlist:${id}`);
      if (r.ok && r.playlistId) {
        saveCache(r.playlistId, r);
        setOpen(false);
        onImported(r.playlistId);
      } else setNote(r.reason ?? 'Couldn’t read that playlist.');
    } finally { setBusy(false); }
  };
  const importable = (mine ?? []).filter(p => !cache[p.id]);

  return (
    <div style={{ position: 'relative', padding: '6px 12px 10px' }}>
      <button className="btn-secondary" onClick={() => void toggle()} style={{ width: '100%' }} disabled={busy}>
        {busy ? 'Importing…' : '+ Import from Spotify'}
      </button>
      {open && (
        <div className="post-pick-pop" style={{ left: 12, right: 12, top: '100%', minWidth: 0, bottom: 'auto' }}>
          {status && !status.connected && (
            <div className="post-pick-empty">
              Spotify isn’t connected.{' '}
              <button className="btn-secondary" onClick={() => openSettings('spotify')}>Connect in Settings</button>
            </div>
          )}
          {status?.connected && mine === null && <div className="post-pick-empty">Loading your playlists…</div>}
          {status?.connected && mine !== null && importable.length === 0 && !note && (
            <div className="post-pick-empty">All your playlists are imported.</div>
          )}
          {importable.map(p => (
            <button key={p.id} type="button" className="post-pick-row" onClick={() => void importOne(p.id)} disabled={busy}>
              <span className="post-pick-check" />
              <span className="post-pick-name">{p.name}{p.songCount !== undefined ? ` (${p.songCount})` : ''}</span>
            </button>
          ))}
          {note && <div className="post-pick-empty">{note}</div>}
          {status?.connected && (
            <div className="post-pick-empty" style={{ fontSize: 11 }}>Only playlists you made or collaborate on can be read.</div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Playlists › a Spotify playlist: its songs with album art, keys and trims,
 * plus Reload / Download artwork / Remove and a test run.
 */
export function SpotifyPlaylistPanel({ playlistId, onRemoved }: { playlistId: string; onRemoved: () => void }) {
  const playlist = useAppStore(s => s.config.spotify?.playlistCache?.[playlistId]);
  const edits = useAppStore(s => s.config.spotify?.trackEdits) ?? {};
  const artCache = useAppStore(s => s.config.spotify?.artCache) ?? {};
  const updateConfig = useAppStore(s => s.updateConfig);
  const [busy, setBusy] = useState<null | 'reload' | 'art'>(null);
  const [artProgress, setArtProgress] = useState<{ done: number; total: number } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => { setNote(null); setConfirmRemove(false); }, [playlistId]);

  const tracks = playlist?.tracks ?? [];
  const totalSec = useMemo(
    () => tracks.reduce((a, t) => { const b = songBounds(t.durationMs / 1000, edits[t.uri]); return a + (b.end - b.start); }, 0),
    [tracks, edits],
  );
  const keysCovered = new Set(tracks.map(t => edits[t.uri]?.key).filter(Boolean)).size;

  if (!playlist?.ok) return <div className="empty-state"><p>That Spotify playlist isn’t imported.</p></div>;

  const reload = async () => {
    setBusy('reload');
    try {
      const r = await window.runway.spotify.readPlaylist(`spotify:playlist:${playlistId}`);
      if (r.ok) { saveCache(playlistId, r); setNote(`Reloaded — ${r.tracks?.length ?? 0} songs.`); }
      else setNote(r.reason ?? 'Couldn’t reload from Spotify.');
    } finally { setBusy(null); }
  };
  const downloadArt = async () => {
    setBusy('art');
    const targets = tracks.filter(t => t.albumArtUrl && !artCache[t.uri]);
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
    setBusy(null);
    setNote(targets.length === 0
      ? 'All artwork for this playlist is already downloaded.'
      : `Downloaded artwork for ${done - failed} song${done - failed === 1 ? '' : 's'}${failed ? ` (${failed} failed)` : ''}.`);
  };

  return (
    <div className="pl-editor" style={{ overflowY: 'auto' }}>
      <div style={{ display: 'block', padding: '18px 32px', borderBottom: '1px solid var(--border)' }}>
        <div className="settings-field-sub" style={{ letterSpacing: '0.12em', textTransform: 'uppercase', fontSize: 11, display: 'flex', gap: 8, alignItems: 'center' }}>
          Spotify playlist <SpotifyBadge />
        </div>
        <div style={{ fontSize: 24, fontWeight: 700, margin: '4px 0 10px' }}>{playlist.name}</div>
        <div style={{ display: 'flex', gap: 28, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div><div className="settings-field-sub">TRACKS</div><strong>{tracks.length}</strong></div>
          <div><div className="settings-field-sub">TOTAL RUNTIME</div><strong>{formatDuration(totalSec)}</strong></div>
          <div><div className="settings-field-sub">KEYS COVERED</div><strong style={{ color: 'var(--accent-bright)' }}>{keysCovered} of 24</strong></div>
          <div style={{ flex: 1 }} />
          <button className="btn-secondary" onClick={() => void reload()} disabled={busy !== null}
            title="Pick up songs added or removed in Spotify">{busy === 'reload' ? 'Reloading…' : '↻ Reload from Spotify'}</button>
          <button className="btn-secondary" onClick={() => void downloadArt()} disabled={busy !== null}
            title="Save album art in Runway so it shows without internet">
            {artProgress ? `Artwork ${artProgress.done}/${artProgress.total}` : '⤓ Download artwork'}
          </button>
          <button className="btn-secondary"
            onClick={() => {
              if (!confirmRemove) { setConfirmRemove(true); window.setTimeout(() => setConfirmRemove(false), 3000); return; }
              saveCache(playlistId, null);
              onRemoved();
            }}
            title="Remove from Runway. The playlist stays in Spotify; keys and trims are kept.">
            {confirmRemove ? 'Click again to remove' : 'Remove'}
          </button>
        </div>
        {note && <div className="settings-field-sub" style={{ marginTop: 8 }}>{note}</div>}
        {playlist.skipped ? <div className="settings-field-sub">{playlist.skipped} item(s) skipped: podcasts or local files can’t be played by Runway.</div> : null}
      </div>
      <div style={{ padding: '12px 32px' }}>
        <SpotifySongList tracks={tracks} />
        {tracks.length > 0 && <SpotifyTestRunPanel playlist={playlist} />}
      </div>
    </div>
  );
}
