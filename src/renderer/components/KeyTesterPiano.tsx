import React, { useEffect, useState } from 'react';
import { useAppStore } from '../state/store';
import { useEngines } from '../state/engines';
import { MAJOR_KEYS, keyColor } from '@shared/music';
import type { KeyName } from '@shared/types';

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
}

export function KeyTesterPiano({ onClose }: Props) {
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

  const onStop = () => {
    audio.fadeOutPad(1.5);
  };

  const isPlaying = !!padPlayback?.isPlaying;
  const mapped = new Set(pads.map(p => p.key));

  return (
    <div className="key-tester-drawer" role="dialog" aria-label="Pad player">
      <header className="key-tester-head">
        <div className="key-tester-titlewrap">
          <h2>Pad Player</h2>
          <p>Click any key to fire its pad on the pad bus. Use this to audition pads against tracks playing in the list above.</p>
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
          return (
            <button
              key={k}
              type="button"
              className={`key-tester-pad ${isCurrent ? 'playing' : ''} ${isArmed ? 'armed' : ''}`}
              style={has ? { background: c.bg, color: c.fg, borderColor: c.fg } : undefined}
              onClick={() => onPadClick(k)}
              disabled={!has}
              title={has ? `Play ${k} pad` : `No pad mapped for ${k} — assign one in Settings → Pad Library`}
            >
              <span className="key-tester-pad-letter">{k}</span>
              <span className="key-tester-pad-state">
                {!has ? 'no pad' : isCurrent ? 'playing' : 'ready'}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
