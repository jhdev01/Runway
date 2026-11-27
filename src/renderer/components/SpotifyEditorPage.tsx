import React, { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../state/store';
import type { SpotifyKeyGuess, SpotifyPlaylistTrack, SpotifyTrackEdit } from '@shared/types';
import { SpotifyWaveformView } from './SpotifyWaveformView';
import { SpotifySongFields, spotifyLookupArtist, spotifyLookupTitle } from './SpotifySongList';
import { KeyAnalysisPanel } from './KeyAnalysis';
import { KeyTesterPiano } from './KeyTesterPiano';
import { saveSpotifyEdit } from '../lib/spotifyEdits';
import { effectiveGuess } from '../lib/keyLearning';

const VIEW_LABEL: Record<string, string> = { library: 'Library', playlists: 'Playlists', live: 'Live', schedule: 'Schedule', actions: 'Actions', settings: 'Settings' };

/**
 * The Editor page for a Spotify song: the same layout as the audio editor
 * for your own tracks (big waveform with handles, zoom, preview, fields),
 * plus the song's note map and key analysis. Edits save as you make them,
 * into the same Start / End / Fade / 0:00 / key fields as Library uses.
 */
export function SpotifyEditorPage({ uri, onPick, onExit }: {
  uri: string;
  onPick: (uri: string) => void;
  onExit: () => void;          // back to editing your own songs
}) {
  const cache = useAppStore(s => s.config.spotify?.playlistCache);
  const edits = useAppStore(s => s.config.spotify?.trackEdits);
  const artCache = useAppStore(s => s.config.spotify?.artCache);
  const returnView = useAppStore(s => s.editorReturnView);
  const setView = useAppStore(s => s.setView);

  // Imported playlists and their songs (for the picker).
  const groups = useMemo(() => Object.values(cache ?? {})
    .filter(pl => pl?.ok && (pl.tracks?.length ?? 0) > 0)
    .map(pl => ({ name: pl.name ?? 'Spotify playlist', tracks: pl.tracks ?? [] }))
    .sort((a, b) => a.name.localeCompare(b.name)), [cache]);
  const track: SpotifyPlaylistTrack | undefined = useMemo(() => {
    for (const g of groups) { const t = g.tracks.find(x => x.uri === uri); if (t) return t; }
    return undefined;
  }, [groups, uri]);
  const edit: SpotifyTrackEdit = edits?.[uri] ?? {};
  const onChange = (e: SpotifyTrackEdit) => saveSpotifyEdit(uri, e, track?.title);

  // What Runway heard (key analysis panel), refreshed while it plays.
  const [heard, setHeard] = useState<SpotifyKeyGuess | undefined>();
  const [noKeyWhy, setNoKeyWhy] = useState<string | undefined>();
  const [padOpen, setPadOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    const read = async () => {
      try {
        const w = await window.runway.spotify.waveform(uri);
        if (!alive) return;
        setHeard(effectiveGuess(w?.key));
        // Waveform but no key: say why, so a re-scan is the obvious fix.
        setNoKeyWhy(!w || w.key ? undefined
          : w.keyMiss?.why === 'no-sound'
            ? 'No key yet: Runway drew the waveform but no sound came through to listen for the key. Check Screen & System Audio Recording for Runway in System Settings, then press Re-scan this song.'
            : w.keyMiss?.why === 'too-short'
              ? `No key yet: Runway heard only ${w.keyMiss.heardSec} s of steady sound and needs 15 s. Press Re-scan this song.`
              : 'No key yet: this waveform was drawn before Runway listened for keys. Press Re-scan this song, or Scan all songs in Settings › Spotify.');
      } catch { /* ignore */ }
    };
    void read();
    const t = window.setInterval(() => void read(), 3000);
    return () => { alive = false; window.clearInterval(t); };
  }, [uri]);

  if (!track) {
    return (
      <div className="editor-view">
        <div className="editor-toolbar">
          <h2 className="editor-title">Audio Editor</h2>
          <span className="editor-subtitle">That Spotify song isn’t in an imported playlist any more.</span>
          <button className="btn-secondary" onClick={onExit}>Edit your own songs</button>
        </div>
      </div>
    );
  }
  const art = artCache?.[track.uri] ?? track.albumArtUrl;
  return (
    <div className="editor-view">
      <div className="editor-toolbar">
        <h2 className="editor-title">Audio Editor</h2>
        <span className="editor-subtitle">Spotify</span>
        <select
          className="editor-track-select"
          value={uri}
          onChange={e => onPick(e.target.value)}
          title="Spotify song to edit (from your imported playlists)"
        >
          {groups.map(g => (
            <optgroup key={g.name} label={g.name}>
              {g.tracks.map((t, i) => <option key={`${t.uri}-${i}`} value={t.uri}>{t.title}{t.artist ? ` — ${t.artist}` : ''}</option>)}
            </optgroup>
          ))}
        </select>
        {art && <img src={art} alt="" style={{ width: 34, height: 34, borderRadius: 4, objectFit: 'cover' }} />}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button
            className={padOpen ? 'btn-primary' : 'btn-secondary'}
            onClick={() => setPadOpen(o => !o)}
            title="Play pads to check the song's key by ear. The slider balances pad and Spotify."
          >
            Pad player
          </button>
          {returnView && returnView !== 'editor' && (
            <button className="btn-secondary" onClick={() => useAppStore.getState().backFromEditor()}>← Back to {VIEW_LABEL[returnView] ?? 'previous'}</button>
          )}
          <button className="btn-secondary" onClick={onExit} title="Edit tracks from your own library">Your songs</button>
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '16px 24px' }}>
        <SpotifyWaveformView track={track} edit={edit} onChange={onChange} full showNotes />
      </div>

      <div className="editor-footer" style={{ maxHeight: '42vh', overflowY: 'auto' }}>
        <SpotifySongFields track={track} edit={edit} onChange={onChange} wide />
        <KeyAnalysisPanel
          currentKey={edit.key}
          heard={heard ? {
            key: heard.key, confidence: heard.confidence, candidates: heard.candidates, endKey: heard.endKey,
            heardSec: heard.heardSec, profile: heard.profile, source: 'Runway heard',
          } : null}
          onSetKey={k => onChange({ ...edit, key: k })}
          emptyNote={noKeyWhy}
          lookupMultitracks={() => window.runway.files.multitracksLookup(
            spotifyLookupArtist(track.artist), spotifyLookupTitle(track.title), track.durationMs / 1000,
          )}
        />
      </div>
      {padOpen && <KeyTesterPiano controlSpotify songKey={edit.key} onClose={() => setPadOpen(false)} />}
    </div>
  );
}
