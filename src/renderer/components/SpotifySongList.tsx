import React, { useEffect, useState } from 'react';
import { useAppStore } from '../state/store';
import type { KeyName, SpotifyPlaylistTrack, SpotifyTrackEdit } from '@shared/types';
import { formatDuration } from '../lib/format';
import { songBounds } from '../lib/spotifyTestRun';
import { KeyPickerModal } from './KeyPickerModal';
import { SpotifyWaveformView } from './SpotifyWaveformView';
import { waveformScanner, useWaveformScan, scanEdgesSec } from '../lib/spotifyWaveformScan';
import { keyColor, displayKey } from '@shared/music';

type Field = 'trimStartSec' | 'trimEndSec' | 'landSec' | 'fadeInSec' | 'fadeOutSec';

/** m:ss.s for song positions; plain seconds for fades. */
function fmtPos(sec: number | undefined): string {
  if (sec === undefined) return '';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}
/** Accepts "4:12", "4:12.5", "252", "252.5". Empty = cleared. */
function parsePos(text: string): number | undefined | null {
  const t = text.trim();
  if (!t) return undefined;
  const m = t.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const FIELDS: Array<{ key: Field; label: string; kind: 'pos' | 'fade'; mark: boolean; hint: string }> = [
  { key: 'trimStartSec', label: 'Start', kind: 'pos', mark: true, hint: 'Song starts here.' },
  { key: 'trimEndSec', label: 'End', kind: 'pos', mark: true, hint: 'Song stops here.' },
  { key: 'landSec', label: '0:00 at', kind: 'pos', mark: true, hint: 'When this song is last, the countdown hits 0:00 here. The song plays at full volume up to it, then fades out (Fade out, or Runway’s Music fade) as the pad takes over. Set an End later than this to let it play on longer.' },
  { key: 'fadeInSec', label: 'Fade in', kind: 'fade', mark: false, hint: 'Seconds. Blank = Runway’s default.' },
  { key: 'fadeOutSec', label: 'Fade out', kind: 'fade', mark: false, hint: 'Seconds. Blank = Runway’s default (Music fade, for the last song).' },
];

function SongEditor({ track, edit, onChange }: {
  track: SpotifyPlaylistTrack;
  edit: SpotifyTrackEdit;
  onChange: (e: SpotifyTrackEdit) => void;
}) {
  const [drafts, setDrafts] = useState<Partial<Record<Field, string>>>({});
  const [note, setNote] = useState<string | null>(null);
  const dur = track.durationMs / 1000;

  const commit = (key: Field, text: string) => {
    const v = parsePos(text);
    setDrafts(d => ({ ...d, [key]: undefined }));
    if (v === null) { setNote('Use minutes:seconds, like 4:12 or 4:12.5.'); return; }
    if (v !== undefined && key !== 'fadeInSec' && key !== 'fadeOutSec' && v > dur) {
      setNote(`That’s past the end of the song (${formatDuration(dur)}).`);
      return;
    }
    setNote(null);
    onChange({ ...edit, [key]: v });
  };

  const mark = async (key: Field) => {
    const r = await window.runway.spotify.player({ op: 'state' });
    if (!r.ok) { setNote(r.reason ?? 'Couldn’t reach Spotify.'); return; }
    if (r.trackUri !== track.uri || r.positionSec === undefined) {
      setNote('Spotify isn’t playing this song. Press “Play in Spotify”, then mark.');
      return;
    }
    setNote(null);
    onChange({ ...edit, [key]: Math.round(r.positionSec * 10) / 10 });
  };

  const b = songBounds(dur, edit);
  return (
    <div style={{ margin: '6px 0 10px 32px', padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 6 }}>
      <SpotifyWaveformView track={track} edit={edit} onChange={onChange} />
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 110px auto', gap: '6px 10px', alignItems: 'center' }}>
        {FIELDS.map(f => (
          <React.Fragment key={f.key}>
            <label htmlFor={`sp-edit-${track.uri}-${f.key}`} title={f.hint}>{f.label}</label>
            <input
              id={`sp-edit-${track.uri}-${f.key}`}
              type="text"
              value={drafts[f.key] ?? (f.kind === 'pos' ? fmtPos(edit[f.key]) : (edit[f.key]?.toString() ?? ''))}
              placeholder={f.key === 'trimEndSec' ? fmtPos(dur) : f.kind === 'pos' ? (f.key === 'trimStartSec' ? '0:00.0' : 'end') : 'default'}
              onChange={e => setDrafts(d => ({ ...d, [f.key]: e.target.value }))}
              onBlur={e => commit(f.key, e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              title={f.hint}
            />
            <span>
              {f.mark && <button className="btn-secondary" onClick={() => void mark(f.key)}>Mark here</button>}
            </span>
          </React.Fragment>
        ))}
      </div>
      <div className="pp-actions" style={{ marginTop: 8 }}>
        <button className="btn-secondary" onClick={() => void window.runway.spotify.player({ op: 'play', uri: track.uri })}>
          Play in Spotify
        </button>
        <button className="btn-secondary" onClick={() => { setDrafts({}); setNote(null); onChange({ key: edit.key }); }}>Clear edits</button>
        <span className="settings-field-sub">
          Plays {fmtPos(b.start)} to {fmtPos(b.end)} ({formatDuration(b.end - b.start)})
          {edit.landSec !== undefined
            ? (b.land < b.end
              ? `. When last: 0:00 at ${fmtPos(b.land)}, plays on to ${fmtPos(b.end)}`
              : `. When last: 0:00 at ${fmtPos(b.land)}, then fades out`)
            : ''}
        </span>
      </div>
      {note && <div className="pp-status err">{note}</div>}
    </div>
  );
}

// Spotify titles carry release extras MultiTracks doesn't use ("Praise -
// Live", "Way Maker (Live at …)", "(feat. …)", "- Radio Version"), and
// Spotify lists every credited artist. Search on the plain title and the
// first artist; the lookup still uses the song length to pick the right cut.
function spotifyLookupTitle(title: string): string {
  const plain = title
    .replace(/\s+-\s+.*$/, '')
    .replace(/\s*[([](?:feat|ft|with|live|radio|single|acoustic|remaster|edit|version|studio|deluxe)\b[^)\]]*[)\]]/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return plain || title;
}
function spotifyLookupArtist(artist: string): string {
  return (artist ?? '').split(/,\s*/)[0]?.trim() ?? '';
}
/** How far ahead (0..1 match score) the best match must be to apply it without asking. */
const CLEAR_WIN = 0.1;

/**
 * The songs of a Spotify playlist with album art, a key per song, and
 * optional trims, fades and a landing marker. Keys and edits are saved per
 * song, so they apply in every playlist (and in services using Spotify).
 */
export function SpotifySongList({ tracks }: { tracks: SpotifyPlaylistTrack[] }) {
  const config = useAppStore(s => s.config);
  const updateConfig = useAppStore(s => s.updateConfig);
  const keyMode = config.defaults.keyDisplayMode ?? 'sharp';
  const edits = config.spotify?.trackEdits ?? {};
  const artCache = config.spotify?.artCache ?? {};
  const [open, setOpen] = useState<string | null>(null);
  const [keyFor, setKeyFor] = useState<string | null>(null);
  const [lookup, setLookup] = useState<{ busy: boolean; done: number; total: number; note: string | null }>(
    { busy: false, done: 0, total: 0, note: null },
  );

  const saveAll = (next: Record<string, SpotifyTrackEdit>) => {
    const latest = useAppStore.getState().config.spotify;
    updateConfig({ spotify: { ...latest, trackEdits: next } });
  };
  const save = (uri: string, e: SpotifyTrackEdit) => {
    const clean = Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined)) as SpotifyTrackEdit;
    const next = { ...(useAppStore.getState().config.spotify?.trackEdits ?? {}) };
    if (Object.keys(clean).length) next[uri] = clean; else delete next[uri];
    saveAll(next);
  };

  // Fills in keys for songs that don't have one, from the MultiTracks.com
  // catalog (the same source as Library › Keys from MultiTracks). A clear
  // winner is applied; when the catalog lists the song in more than one key
  // (often a live cut vs the studio cut), the choices are shown on the row
  // to click.
  const [suggest, setSuggest] = useState<Record<string, Array<{ key: KeyName; label: string }>>>({});
  const lookUpKeys = async () => {
    const targets = tracks.filter(t => !edits[t.uri]?.key);
    setLookup({ busy: true, done: 0, total: targets.length, note: null });
    let set = 0, unsure = 0, missing = 0, done = 0;
    const nextSuggest: typeof suggest = {};
    for (const t of targets) {
      try {
        const res = await window.runway.files.multitracksLookup(
          spotifyLookupArtist(t.artist), spotifyLookupTitle(t.title), t.durationMs / 1000,
        );
        const best = res?.best;
        const alts = res?.alternates ?? [];
        const runnerUp = alts[0]?.score ?? 0;
        if (best && (alts.length === 0 || best.score - runnerUp >= CLEAR_WIN)) {
          const cur = useAppStore.getState().config.spotify?.trackEdits ?? {};
          saveAll({ ...cur, [t.uri]: { ...(cur[t.uri] ?? {}), key: best.key } });
          set++;
        } else if (best) {
          unsure++;
          nextSuggest[t.uri] = [best, ...alts].map(c => ({
            key: c.key,
            label: `${c.title}${c.artist ? ` — ${c.artist}` : ''}${c.album ? ` (${c.album})` : ''}`,
          }));
        } else missing++;
      } catch { missing++; }
      done++;
      setLookup(l => ({ ...l, done }));
      setSuggest({ ...nextSuggest });
    }
    const parts = [`Set ${set} key${set === 1 ? '' : 's'}`];
    if (unsure) parts.push(`${unsure} could be more than one key (pick on the row)`);
    if (missing) parts.push(`${missing} not on MultiTracks (set those yourself)`);
    setLookup({ busy: false, done, total: targets.length, note: targets.length ? parts.join(', ') + '.' : 'Every song already has a key.' });
  };

  // Scan waveforms for this playlist (runs in the background; see spotifyWaveformScan).
  const waveformsOn = !!config.spotify?.waveforms;
  const scan = useWaveformScan();
  // How much of each song has a waveform; refreshed live while anything plays.
  const [cov, setCov] = useState<Record<string, number>>({});
  const uriKey = tracks.map(t => t.uri).join('|');
  useEffect(() => {
    if (!waveformsOn) return;
    let alive = true;
    const read = async () => {
      try {
        const c = await window.runway.spotify.waveformCoverage(tracks.map(t => t.uri), scanEdgesSec());
        if (alive) setCov(c);
      } catch { /* ignore */ }
    };
    void read();
    const t = window.setInterval(() => void read(), 1500);
    return () => { alive = false; window.clearInterval(t); };
  }, [waveformsOn, uriKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Audition a song in Spotify (no fades, no timing — just play / pause).
  const [playingUri, setPlayingUri] = useState<string | null>(null);
  const togglePlay = async (uri: string) => {
    if (playingUri === uri) {
      await window.runway.spotify.player({ op: 'pause' });
      setPlayingUri(null);
      return;
    }
    const r = await window.runway.spotify.player({ op: 'play', uri });
    if (r.ok) {
      setPlayingUri(uri);
      if (!r.wasFrontmost) window.setTimeout(() => { void window.runway.spotify.player({ op: 'background' }); }, 800);
    } else setLookup(l => ({ ...l, note: r.reason ?? 'Couldn’t play in Spotify.' }));
  };

  const keyTrack = keyFor ? tracks.find(t => t.uri === keyFor) : undefined;
  return (
    <div style={{ marginTop: 6 }}>
      <div className="pp-actions" style={{ marginBottom: 6 }}>
        <button className="btn-secondary" onClick={() => void lookUpKeys()} disabled={lookup.busy}>
          {lookup.busy ? `Looking up keys… ${lookup.done}/${lookup.total}` : 'Look up keys'}
        </button>
        {waveformsOn && (scan.running
          ? (
            <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button className="btn-secondary" onClick={() => waveformScanner.stop()}>Stop scan</button>
              <span className="settings-field-sub" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                Scanning {scan.idx} of {scan.total}: {scan.title}
                <span style={{ width: 120, height: 6, borderRadius: 3, background: 'var(--border)', overflow: 'hidden', display: 'inline-block' }}>
                  <span style={{ display: 'block', height: '100%', width: `${scan.durSec ? Math.min(100, (scan.posSec / scan.durSec) * 100) : 0}%`, background: 'var(--accent-bright)' }} />
                </span>
                {formatDuration(scan.posSec)} / {formatDuration(scan.durSec)}
              </span>
            </span>
          )
          : <button className="btn-secondary" onClick={() => void waveformScanner.start(tracks)} title="Draws waveforms for this playlist: plays its songs that don’t have one yet straight through, in the background. You can mute your Mac and walk away.">Scan this playlist</button>)}
        {lookup.note && <span className="settings-field-sub">{lookup.note}</span>}
        {scan.note && <span className="settings-field-sub">{scan.note}</span>}
      </div>
      <div style={open ? undefined : { maxHeight: 460, overflowY: 'auto' }}>
        {tracks.map((t, i) => {
          const e = edits[t.uri] ?? {};
          const { key, ...trimEdits } = e;
          const edited = Object.keys(trimEdits).length > 0;
          const b = songBounds(t.durationMs / 1000, e);
          const rowKey = `${t.uri}-${i}`;
          const kc = keyColor(key);
          return (
            <div key={rowKey}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '3px 0' }}>
                <span style={{ width: 20, textAlign: 'right', opacity: 0.6 }}>{i + 1}</span>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => void togglePlay(t.uri)}
                  title={playingUri === t.uri ? 'Pause in Spotify' : 'Play in Spotify (e.g. to find its key with the pad player)'}
                  style={{ width: 30, height: 30, padding: 0, borderRadius: 999, flex: 'none' }}
                >
                  {playingUri === t.uri ? '❚❚' : '▶'}
                </button>
                {(artCache[t.uri] ?? t.albumArtUrl)
                  ? <img src={artCache[t.uri] ?? t.albumArtUrl} alt="" loading="lazy" style={{ width: 36, height: 36, borderRadius: 4, objectFit: 'cover', flex: 'none' }} />
                  : <div aria-hidden style={{ width: 36, height: 36, borderRadius: 4, background: 'var(--bg-elev-2)', display: 'grid', placeItems: 'center', flex: 'none' }}>♪</div>}
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t.title}{t.artist ? <span style={{ opacity: 0.6 }}> — {t.artist}</span> : null}
                </span>
                {waveformsOn && (() => {
                  const c = cov[t.uri] ?? 0;
                  const live = scan.running && scan.uri === t.uri;
                  const done = c >= 0.95;
                  return (
                    <span
                      title={(scanEdgesSec() ? `Start and end (${scanEdgesSec()} s each): ` : '') + (done ? 'waveform ready' : c > 0 ? `${Math.round(c * 100)}% heard` : 'no waveform yet')}
                      style={{ display: 'flex', alignItems: 'center', gap: 6, width: 86, flex: 'none' }}
                    >
                      <span style={{ flex: 1, height: 5, borderRadius: 3, background: 'var(--border)', overflow: 'hidden' }}>
                        <span style={{
                          display: 'block', height: '100%', width: `${Math.round(c * 100)}%`,
                          background: done ? 'var(--accent-bright)' : live ? '#f5a524' : 'var(--text-faint)',
                          transition: 'width 0.8s linear',
                        }} />
                      </span>
                      <span style={{ fontSize: 11, width: 30, textAlign: 'right', opacity: c > 0 ? 0.9 : 0.4 }}>
                        {done ? '✓' : `${Math.round(c * 100)}%`}
                      </span>
                    </span>
                  );
                })()}
                <button
                  type="button"
                  onClick={() => setKeyFor(t.uri)}
                  title={key ? 'Change key' : 'Set key'}
                  style={{
                    minWidth: 44, padding: '3px 8px', borderRadius: 4, cursor: 'pointer',
                    fontFamily: 'IBM Plex Mono, monospace', fontWeight: 600, fontSize: 12,
                    background: kc.bg, color: kc.fg, border: key ? '1px solid transparent' : '1px dashed var(--border-bright)',
                  }}
                >
                  {key ? displayKey(key, keyMode) : 'Key'}
                </button>
                {!key && suggest[t.uri] && (
                  <span style={{ display: 'flex', gap: 4, alignItems: 'center' }} title="MultiTracks lists this song in more than one key. Click the one you play.">
                    <span className="settings-field-sub">or</span>
                    {suggest[t.uri].map(c => {
                      const sc = keyColor(c.key);
                      return (
                        <button
                          key={c.key}
                          type="button"
                          onClick={() => { save(t.uri, { ...(edits[t.uri] ?? {}), key: c.key }); setSuggest(m => { const n = { ...m }; delete n[t.uri]; return n; }); }}
                          title={`${displayKey(c.key, keyMode)}: ${c.label}`}
                          style={{
                            minWidth: 36, padding: '2px 6px', borderRadius: 4, cursor: 'pointer',
                            fontFamily: 'IBM Plex Mono, monospace', fontWeight: 600, fontSize: 11,
                            background: sc.bg, color: sc.fg, border: '1px dashed var(--border-bright)', opacity: 0.85,
                          }}
                        >
                          {displayKey(c.key, keyMode)}?
                        </button>
                      );
                    })}
                  </span>
                )}
                {edited && <span className="pp-status ok" title="This song has trims or fades">edited</span>}
                <span style={{ width: 40, textAlign: 'right' }}>{formatDuration(b.end - b.start)}</span>
                <button className="btn-secondary" onClick={() => setOpen(open === rowKey ? null : rowKey)}>
                  {open === rowKey ? 'Done' : 'Edit'}
                </button>
              </div>
              {open === rowKey && <SongEditor track={t} edit={e} onChange={ne => save(t.uri, ne)} />}
            </div>
          );
        })}
      </div>
      <KeyPickerModal
        open={!!keyTrack}
        selected={keyTrack ? edits[keyTrack.uri]?.key : undefined}
        onSelect={k => { if (keyTrack) save(keyTrack.uri, { ...(edits[keyTrack.uri] ?? {}), key: k ?? undefined }); }}
        onClose={() => setKeyFor(null)}
      />
    </div>
  );
}
