import React, { useEffect, useState } from 'react';
import { spotifyServiceRun } from '../lib/spotifyTestRun';
import { spotifyFreePlay } from '../lib/spotifyPost';
import { useAppStore } from '../state/store';
import { useEngines } from '../state/engines';
import { MAJOR_KEYS, altKeyName, displayKey, keyColor, relativeMajor } from '@shared/music';
import type { KeyName } from '@shared/types';
import { InfoTip } from './InfoTip';

/**
 * Library Pad Player — slides up from the bottom of the Library so
 * you can play any of your mapped pads while previewing tracks above.
 * Same audio path as the Live-view Pad Player panel: writes to the
 * pad bus, loops the buffer, fades in/out via the engine. The Music
 * slider here ducks the music bus while the drawer is open and
 * restores it on close.
 *
 * Keys without a mapped pad are disabled and labeled "no pad" so the
 * operator immediately sees what's available without having to open
 * Settings → Pad Library.
 */

const KEYS: KeyName[] = MAJOR_KEYS;

interface Props {
  onClose: () => void;
  /** Library › Spotify: the Music side of the slider also sets Spotify's volume. */
  controlSpotify?: boolean;
  /**
   * Key set for the song being edited. Its pad is marked "song key", and
   * when the key changes it's selected (and swapped in if a pad is
   * already playing). Minor keys use the major pad with the same notes.
   */
  songKey?: KeyName;
}

export function KeyTesterPiano({ onClose, controlSpotify = false, songKey }: Props) {
  const { audio } = useEngines();
  const pads = useAppStore(s => s.config.pads);
  const padArmedKey = useAppStore(s => s.padArmedKey);
  const setPadArmedKey = useAppStore(s => s.setPadArmedKey);
  const padPlayback = useAppStore(s => s.padPlayback);
  // Crossfade slider: -100..+100, 0 = center.
  //   Left  (-100) → music 0%, pad 100%
  //   Center (0)   → music 100%, pad 100% (both full)
  //   Right (+100) → music 100%, pad 0%
  // Each side scales linearly between the center plateau and the edge.
  const [crossfade, setCrossfade] = useState(0);

  function levelsFor(x: number): { music: number; pad: number } {
    if (x <= 0) return { music: 1 + x / 100, pad: 1 }; // x in [-100,0]: music 0..1, pad full
    return { music: 1, pad: 1 - x / 100 };              // x in (0,100]: music full, pad 1..0
  }

  // The "Music" side of the crossfade ducks BOTH the music bus AND
  // the cue bus. That's because Library row previews play through
  // the cue bus (so the operator can audition without disturbing live
  // service music), while service-time playback is on the music bus.
  // Treating them as one logical "music" target makes the slider feel
  // right in either context — operator doesn't need to think about
  // which bus their audio is on.
  useEffect(() => {
    const { music, pad } = levelsFor(0);
    audio.setMusicLevel(music);
    audio.setCueLevel(music);
    audio.setPadLevel(pad);
    setCrossfade(0);
    return () => {
      audio.setMusicLevel(1.0);
      audio.setCueLevel(1.0);
      audio.setPadLevel(1.0);
      // Don't auto-stop the pad on close — operator might want it to
      // keep ringing while they fiddle with the library. They can
      // press Stop here, or use the main Pad Player panel.
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const { music, pad } = levelsFor(crossfade);
    audio.setMusicLevel(music);
    audio.setCueLevel(music);
    audio.setPadLevel(pad);
  }, [crossfade, audio]);

  // Spotify plays outside Runway, so for Spotify auditions the "Music" side
  // sets Spotify's own volume (scaled from where it was when the drawer
  // opened) and puts it back on close. Hands off while a service or post-
  // service is driving Spotify, so the slider can't disturb them.
  const spotifyBase = React.useRef<number | null>(null);
  const spotifyBusy = () => spotifyServiceRun.isActive() || spotifyFreePlay.isActive();
  useEffect(() => {
    if (!controlSpotify) return;
    void window.runway?.spotify?.player({ op: 'check' }).then(r => {
      if (r.ok && r.volume !== undefined) spotifyBase.current = r.volume > 0 ? r.volume : 70;
    });
    return () => {
      const base = spotifyBase.current;
      if (base !== null && !spotifyBusy()) void window.runway?.spotify?.player({ op: 'volume', volume: base });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controlSpotify]);
  useEffect(() => {
    if (!controlSpotify) return;
    const t = window.setTimeout(() => {
      const base = spotifyBase.current;
      if (base === null || spotifyBusy()) return;
      void window.runway?.spotify?.player({ op: 'volume', volume: Math.round(base * levelsFor(crossfade).music) });
    }, 60);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crossfade, controlSpotify]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const onPadClick = (k: KeyName) => {
    const padFile = pads.find(p => p.key === k);
    if (!padFile) return;
    setPadArmedKey(k);
    void audio.playPad(padFile.filePath, { fadeInSec: 1.5, loop: true });
  };

  // Follow the song's key: select its pad, and swap to it if a pad is
  // already ringing. Hands off while a service's music or pad is playing.
  const keyMode = useAppStore(s => s.config.defaults.keyDisplayMode ?? 'sharp');
  const songPad = songKey ? relativeMajor(songKey) : undefined;
  const lastSongPad = React.useRef<KeyName | undefined>(undefined);
  useEffect(() => {
    if (!songPad || songPad === lastSongPad.current) { lastSongPad.current = songPad; return; }
    lastSongPad.current = songPad;
    const r = useAppStore.getState().currentRunway;
    if (r && (r.phase === 'music' || r.phase === 'pad')) return;
    const padFile = pads.find(p => p.key === songPad);
    if (!padFile) return;
    setPadArmedKey(songPad);
    if (useAppStore.getState().padPlayback?.isPlaying) {
      void audio.playPad(padFile.filePath, { fadeInSec: 1.5, loop: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songPad]);

  const onStop = () => {
    audio.fadeOutPad(1.5);
  };

  const isPlaying = !!padPlayback?.isPlaying;
  const mapped = new Set(pads.map(p => p.key));

  return (
    <div className="key-tester-drawer" role="dialog" aria-label="Pad player">
      <header className="key-tester-head">
        <div className="key-tester-titlewrap">
          <h2 style={{ display: 'flex', alignItems: 'center' }}>Pad Player<InfoTip>Click a key to play its pad. Use this to check pads against songs playing in the list above.</InfoTip></h2>
        </div>
        <button
          type="button"
          className={`key-tester-stop ${isPlaying ? 'active' : ''}`}
          onClick={onStop}
          disabled={!isPlaying}
          title="Fade out the currently-playing pad"
        >
          ■ Stop pad
        </button>
        <div className="key-tester-crossfade">
          <span className="key-tester-crossfade-end">Pad</span>
          <input
            type="range"
            min={-100}
            max={100}
            step={1}
            value={crossfade}
            onChange={e => setCrossfade(Number(e.target.value))}
            onDoubleClick={() => setCrossfade(0)}
            title="Drag to crossfade between pad and music. Double-click to recenter (both full)."
          />
          <span className="key-tester-crossfade-end">Music</span>
        </div>
        <button type="button" className="key-tester-close" onClick={onClose} aria-label="Close pad player">✕</button>
      </header>

      <div className="key-tester-padgrid">
        {KEYS.map(k => {
          const c = keyColor(k);
          const has = mapped.has(k);
          const isArmed = padArmedKey === k;
          const isCurrent = isArmed && isPlaying;
          const isSong = songPad === k;
          const alt = altKeyName(k, keyMode);
          return (
            <button
              key={k}
              type="button"
              className={`key-tester-pad ${isCurrent ? 'playing' : ''} ${isArmed ? 'armed' : ''} ${isSong ? 'song-key' : ''}`}
              style={has ? { background: c.bg, color: c.fg, borderColor: c.fg } : undefined}
              onClick={() => onPadClick(k)}
              disabled={!has}
              title={has ? `Play ${displayKey(k, keyMode)}${alt ? ` (${alt})` : ''} pad` : `No pad for ${displayKey(k, keyMode)}. Assign one in Settings › Pads.`}
            >
              <span className="key-tester-pad-letter">
                {displayKey(k, keyMode)}
                {alt && <span className="key-tester-pad-alt">{alt}</span>}
              </span>
              <span className="key-tester-pad-state">
                {!has ? 'no pad' : isCurrent ? 'playing' : isSong ? 'song key' : 'ready'}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
