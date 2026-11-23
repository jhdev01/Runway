import React, { useState } from 'react';
import { useAppStore } from '../state/store';
import type { SpotifyPlaylistTrack, SpotifyTrackEdit } from '@shared/types';
import { formatDuration } from '../lib/format';
import { songBounds } from '../lib/spotifyTestRun';

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
  { key: 'landSec', label: '0:00 at', kind: 'pos', mark: true, hint: 'When this song is last, the countdown hits 0:00 here and the song plays on to its end. Blank = at the end.' },
  { key: 'fadeInSec', label: 'Fade in', kind: 'fade', mark: false, hint: 'Seconds. Blank = Runway’s default.' },
  { key: 'fadeOutSec', label: 'Fade out', kind: 'fade', mark: false, hint: 'Seconds. Blank = Runway’s default.' },
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
        <button className="btn-secondary" onClick={() => { setDrafts({}); setNote(null); onChange({}); }}>Clear edits</button>
        <span className="settings-field-sub">
          Plays {fmtPos(b.start)} to {fmtPos(b.end)} ({formatDuration(b.end - b.start)})
          {b.land < b.end ? `, 0:00 at ${fmtPos(b.land)} when last` : ''}
        </span>
      </div>
      {note && <div className="pp-status err">{note}</div>}
    </div>
  );
}

/**
 * The songs of a Spotify playlist, each with optional trims, fades and a
 * landing marker (saved per song, so they apply in every playlist).
 */
export function SpotifySongList({ tracks }: { tracks: SpotifyPlaylistTrack[] }) {
  const config = useAppStore(s => s.config);
  const updateConfig = useAppStore(s => s.updateConfig);
  const edits = config.spotify?.trackEdits ?? {};
  const [open, setOpen] = useState<string | null>(null);

  const save = (uri: string, e: SpotifyTrackEdit) => {
    const clean = Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined)) as SpotifyTrackEdit;
    const next = { ...edits };
    if (Object.keys(clean).length) next[uri] = clean; else delete next[uri];
    updateConfig({ spotify: { ...config.spotify, trackEdits: next } });
  };

  return (
    <div style={{ maxHeight: 420, overflowY: 'auto', marginTop: 6 }}>
      {tracks.map((t, i) => {
        const e = edits[t.uri] ?? {};
        const edited = Object.keys(e).length > 0;
        const b = songBounds(t.durationMs / 1000, e);
        const rowKey = `${t.uri}-${i}`;
        return (
          <div key={rowKey}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ width: 24, textAlign: 'right', opacity: 0.6 }}>{i + 1}</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {t.title}{t.artist ? ` — ${t.artist}` : ''}
              </span>
              {edited && <span className="pp-status ok" title="This song has trims or fades">edited</span>}
              <span>{formatDuration(b.end - b.start)}</span>
              <button className="btn-secondary" onClick={() => setOpen(open === rowKey ? null : rowKey)}>
                {open === rowKey ? 'Done' : 'Edit'}
              </button>
            </div>
            {open === rowKey && <SongEditor track={t} edit={e} onChange={ne => save(t.uri, ne)} />}
          </div>
        );
      })}
    </div>
  );
}
