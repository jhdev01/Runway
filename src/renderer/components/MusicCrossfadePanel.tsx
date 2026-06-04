import React from 'react';
import { useAppStore } from '../state/store';

/**
 * Quick-access stepper for the song-to-song crossfade time.
 * Used by Quick Play and applied to new playlists' defaults. Existing playlists
 * keep their own per-playlist crossfadeSec.
 */
export function MusicCrossfadePanel() {
  const defaults = useAppStore(s => s.config.defaults);
  const updateConfig = useAppStore(s => s.updateConfig);

  const crossfadeSec = defaults.crossfadeSec ?? 6;
  const musicFadeToPadSec = defaults.musicFadeToPadSec ?? 5;
  const padLeadInSec = defaults.padLeadInSec ?? 5;

  const values: Record<'crossfadeSec' | 'musicFadeToPadSec' | 'padLeadInSec', number> = {
    crossfadeSec,
    musicFadeToPadSec,
    padLeadInSec,
  };

  const adjust = (key: 'crossfadeSec' | 'musicFadeToPadSec' | 'padLeadInSec', delta: number) => {
    const next = Math.max(0, Math.min(30, +(values[key] + delta).toFixed(1)));
    updateConfig({ defaults: { ...defaults, [key]: next } });
  };

  return (
    <div className="panel-section">
      <div className="panel-header">
        <div className="panel-title">Music transitions</div>
      </div>
      <div className="music-xfade-row">
        <span className="music-xfade-label">Song crossfade</span>
        <div className="pl-stepper">
          <button className="pl-stepper-btn" onClick={() => adjust('crossfadeSec', -0.5)}>−</button>
          <span className="pl-stepper-value">{crossfadeSec.toFixed(1)}s</span>
          <button className="pl-stepper-btn" onClick={() => adjust('crossfadeSec', 0.5)}>+</button>
        </div>
      </div>
      <div className="music-xfade-row">
        <span className="music-xfade-label">Pad lead-in</span>
        <div className="pl-stepper">
          <button className="pl-stepper-btn" onClick={() => adjust('padLeadInSec', -0.5)}>−</button>
          <span className="pl-stepper-value">{padLeadInSec.toFixed(1)}s</span>
          <button className="pl-stepper-btn" onClick={() => adjust('padLeadInSec', 0.5)}>+</button>
        </div>
      </div>
      <div className="music-xfade-row">
        <span className="music-xfade-label">Music fade</span>
        <div className="pl-stepper">
          <button className="pl-stepper-btn" onClick={() => adjust('musicFadeToPadSec', -0.5)}>−</button>
          <span className="pl-stepper-value">{musicFadeToPadSec.toFixed(1)}s</span>
          <button className="pl-stepper-btn" onClick={() => adjust('musicFadeToPadSec', 0.5)}>+</button>
        </div>
      </div>
      <div className="music-xfade-hint">
        Pad lead-in: pad fades up while music still plays.
        Music fade: starts after the lead-in, ending at music end (= service start).
      </div>
      <div
        className="music-xfade-hint"
        style={{ marginTop: 4, color: 'var(--accent-bright)', fontWeight: 600 }}
      >
        Pad fires {(padLeadInSec + musicFadeToPadSec).toFixed(1)}s before service start.
      </div>
    </div>
  );
}
