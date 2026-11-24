import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { SpotifyPlaylistTrack } from '@shared/types';
import { useAppStore } from '../state/store';
import { formatDuration } from '../lib/format';
import {
  appleSearchUrl, importPurchases, linkExistingOwned, makeRunwayPlaylist, ownedTrackFor, qobuzSearchUrl,
} from '../lib/purchases';

const CHECK_EVERY_MS = 15_000;

/**
 * Buy list for the songs shown (one Spotify playlist, or all): which ones
 * you already own as files, a store link for each of the rest (Qobuz has a
 * cart: add them all, pay once), and pick-up of what you bought. While this
 * panel is open Runway checks Downloads every 15 s, unzips Qobuz downloads,
 * adds the songs to the Library and links them to their Spotify songs
 * (key, trims, fades and 0:00 carried over).
 */
export function BuyListPanel({ songs, title, onClose }: {
  songs: SpotifyPlaylistTrack[];
  title: string;
  onClose: () => void;
}) {
  const artCache = useAppStore(s => s.config.spotify?.artCache);
  // Re-render as tracks / links change.
  useAppStore(s => s.config.tracks);
  useAppStore(s => s.config.spotify?.ownedLinks);
  const unique = useMemo(() => {
    const seen = new Set<string>();
    return songs.filter(s => (seen.has(s.uri) ? false : (seen.add(s.uri), true)));
  }, [songs]);
  const owned = unique.filter(s => ownedTrackFor(s));
  const toBuy = unique.filter(s => !ownedTrackFor(s));
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<'pre' | 'post'>('pre');
  const openedAt = useRef(Date.now());
  const running = useRef(false);

  // Link songs already in the Library on open.
  useEffect(() => { const n = linkExistingOwned(unique); if (n) setNote(`Linked ${n} song${n === 1 ? '' : 's'} you already had.`); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const check = async (sinceMs: number, quiet: boolean) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      const r = await importPurchases(sinceMs);
      if (r.reason) setNote(r.reason);
      else if (r.linked || r.imported || !quiet) {
        const parts = [`${r.linked} song${r.linked === 1 ? '' : 's'} linked`];
        if (r.imported) parts.unshift(`${r.imported} added to the Library`);
        if (r.differentCut) parts.push(`${r.differentCut} are a different length from Spotify's version, so only the key was copied (set their trims in the Editor)`);
        if (r.unmatched.length) parts.push(`not matched to a Spotify song: ${r.unmatched.slice(0, 3).join(', ')}${r.unmatched.length > 3 ? '…' : ''}`);
        setNote(r.found === 0 ? 'Nothing new in Downloads yet.' : parts.join(' · ') + '.');
      }
    } finally { running.current = false; setBusy(false); }
  };
  // Keep checking Downloads while the panel is open (buying happens in the browser).
  useEffect(() => {
    const t = window.setInterval(() => void check(openedAt.current - 10 * 60_000, true), CHECK_EVERY_MS);
    return () => window.clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const openAll = async (url: (s: SpotifyPlaylistTrack) => string, max = 10) => {
    const batch = toBuy.slice(0, max);
    for (const s of batch) {
      await window.runway.purchases.openStore(url(s));
      await new Promise(r => setTimeout(r, 400));
    }
    setNote(`Opened ${batch.length} in your browser.${toBuy.length > max ? ` ${toBuy.length - max} more after these.` : ''}`);
  };

  return (
    <div style={{ margin: '10px 0', padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-elev)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <strong>Buy list · {title}</strong>
        <span className="settings-field-sub">{owned.length} of {unique.length} owned · {toBuy.length} to buy</span>
        <button className="btn-secondary" style={{ marginLeft: 'auto' }} onClick={onClose}>Close</button>
      </div>
      <div className="settings-section-sub" style={{ marginTop: 4 }}>
        Stores only let you buy in the store, one click per song. Qobuz has a cart: add each song, then check out once
        and download the zip. While this panel is open, Runway checks Downloads, unzips it, adds the songs to your Library
        and links them to these Spotify songs (key, trims, fades and 0:00 carried over).
      </div>

      {toBuy.length > 0 && (
        <div className="pp-actions" style={{ flexWrap: 'wrap', marginTop: 8 }}>
          <button className="btn-secondary" onClick={() => void openAll(qobuzSearchUrl)}>Open {Math.min(10, toBuy.length)} on Qobuz</button>
          <button className="btn-secondary" onClick={() => void openAll(appleSearchUrl)}>Open {Math.min(10, toBuy.length)} in Apple Music</button>
        </div>
      )}
      <div className="pp-actions" style={{ flexWrap: 'wrap', marginTop: 6 }}>
        <button className="btn-secondary" disabled={busy} onClick={() => void check(Date.now() - 30 * 86400_000, false)}
          title="Look through the last 30 days of Downloads for bought songs">
          {busy ? 'Checking Downloads…' : 'Import purchases now'}
        </button>
        {owned.length > 0 && (
          <>
            <select value={kind} onChange={e => setKind(e.target.value as 'pre' | 'post')} title="Kind of Runway playlist to make">
              <option value="pre">as a Pre-service playlist</option>
              <option value="post">as a Post-service playlist</option>
            </select>
            <button
              className="btn-secondary"
              onClick={() => {
                const r = makeRunwayPlaylist(`${title} (owned)`, unique, kind);
                setNote(`Made Runway playlist “${title} (owned)” with ${r.count} songs. Find it in Playlists.`);
              }}
              title="A Runway playlist of the songs you own, in this playlist's order: real crossfades, full waveforms, no internet needed"
            >
              Make Runway playlist from owned songs
            </button>
          </>
        )}
      </div>
      {note && <div className="settings-field-sub" style={{ marginTop: 6 }}>{note}</div>}

      {toBuy.length > 0 && (
        <div style={{ marginTop: 8, maxHeight: 320, overflowY: 'auto' }}>
          {toBuy.map(s => {
            const art = artCache?.[s.uri] ?? s.albumArtUrl;
            return (
              <div key={s.uri} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '3px 0' }}>
                {art
                  ? <img src={art} alt="" style={{ width: 30, height: 30, borderRadius: 4, objectFit: 'cover' }} />
                  : <div style={{ width: 30, height: 30, borderRadius: 4, background: 'var(--bg-elev-2)' }} />}
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {s.title}{s.artist ? <span style={{ opacity: 0.6 }}> — {s.artist}</span> : null}
                </span>
                <span className="settings-field-sub" style={{ width: 44, textAlign: 'right' }}>{formatDuration(s.durationMs / 1000)}</span>
                <button className="btn-secondary" onClick={() => void window.runway.purchases.openStore(qobuzSearchUrl(s))}>Qobuz</button>
                <button className="btn-secondary" onClick={() => void window.runway.purchases.openStore(appleSearchUrl(s))}>Apple</button>
              </div>
            );
          })}
        </div>
      )}
      {toBuy.length === 0 && <div className="pp-status ok" style={{ marginTop: 8 }}>You own every song here.</div>}
    </div>
  );
}
