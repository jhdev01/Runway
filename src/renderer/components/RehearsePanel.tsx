import React, { useEffect, useState } from 'react';
import { useAppStore } from '../state/store';
import { useEngines } from '../state/engines';
import { ALL_KEYS } from '@shared/music';
import type { KeyName } from '@shared/types';

const PRESETS: { label: string; minutes: number }[] = [
  { label: '1m', minutes: 1 },
  { label: '2m', minutes: 2 },
  { label: '5m', minutes: 5 },
  { label: '15m', minutes: 15 },
  { label: '30m', minutes: 30 },
];

const fieldStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const labelStyle: React.CSSProperties = {
  color: 'var(--text-dim)',
  fontSize: 13,
  letterSpacing: 0.3,
  textTransform: 'uppercase',
};

const inputStyle: React.CSSProperties = {
  padding: '8px 10px',
  fontSize: 14,
  borderRadius: 4,
  background: 'var(--bg-elev, rgba(255,255,255,0.04))',
  border: '1px solid var(--border, rgba(255,255,255,0.12))',
  color: 'var(--text)',
  width: '100%',
  boxSizing: 'border-box',
};

export function RehearsePanel() {
  const playlists = useAppStore(s => s.config.playlists);
  const services = useAppStore(s => s.config.services);
  const currentRunway = useAppStore(s => s.currentRunway);
  const createRehearsalService = useAppStore(s => s.createRehearsalService);
  const armService = useAppStore(s => s.armService);
  const disarmService = useAppStore(s => s.disarmService);
  const deleteService = useAppStore(s => s.deleteService);
  const { audio, controller } = useEngines();

  const allPlaylists = playlists;
  const prePlaylists = playlists.filter(p => p.kind === 'pre');
  const postPlaylists = playlists.filter(p => p.kind === 'post');

  const [quickPlaylistId, setQuickPlaylistId] = useState(allPlaylists[0]?.id ?? '');
  const [quickLandInKey, setQuickLandInKey] = useState<KeyName | ''>('');
  const [quickError, setQuickError] = useState<string | null>(null);

  const [showQuick, setShowQuick] = useState(false);
  const [showScheduled, setShowScheduled] = useState(false);
  const [playlistId, setPlaylistId] = useState(prePlaylists[0]?.id ?? '');
  const [postPlaylistId, setPostPlaylistId] = useState(postPlaylists[0]?.id ?? '');
  const [firstSongKey, setFirstSongKey] = useState<KeyName | ''>('');
  const [leadMinutes, setLeadMinutes] = useState(1);
  const [secondsFromNow, setSecondsFromNow] = useState(120);
  const [scheduledError, setScheduledError] = useState<string | null>(null);

  const [activeRehearsalIds, setActiveRehearsalIds] = useState<string[]>([]);
  const myRehearsals = services.filter(s => s.isRehearsal && activeRehearsalIds.includes(s.id));

  // Quick Test is the only path that produces a runway with no
  // serviceId AND no isPostService flag — post-service runways also
  // null out serviceId so the "is it Quick Play?" check has to exclude
  // them, otherwise hitting Start Post-Service makes the Quick Test
  // button flip to "Stop" and disable the playlist picker.
  const isQuickPlaying = currentRunway?.serviceId === null
    && !currentRunway.isPostService
    && (currentRunway.phase === 'music' || currentRunway.phase === 'pad');

  useEffect(() => {
    const known = new Set(services.map(s => s.id));
    setActiveRehearsalIds(prev => prev.filter(id => known.has(id)));
  }, [services]);

  useEffect(() => {
    if (!quickPlaylistId && allPlaylists[0]) setQuickPlaylistId(allPlaylists[0].id);
    if (!playlistId && prePlaylists[0]) setPlaylistId(prePlaylists[0].id);
  }, [allPlaylists.length, prePlaylists.length]);

  const onQuickPlay = async () => {
    setQuickError(null);
    if (isQuickPlaying) {
      controller.stopQuickPlay();
      return;
    }
    if (!quickPlaylistId) {
      setQuickError('Pick a playlist first.');
      return;
    }
    const result = await controller.quickPlayPlaylist(quickPlaylistId, {
      landInKey: quickLandInKey || undefined,
    });
    if (!result.ok) setQuickError(result.reason ?? 'Failed to start');
    else if (result.warning) setQuickError(result.warning);
  };

  const onLaunchScheduled = async () => {
    setScheduledError(null);
    if (!playlistId) {
      setScheduledError('Pick a pre-service playlist first.');
      return;
    }
    // Note: when secondsFromNow < leadMinutes*60, the runway "should have started"
    // some seconds ago. The controller handles this by jumping into the runway
    // at the right track + offset so the music ends at the right moment. No reject.
    const id = createRehearsalService({
      preServicePlaylistId: playlistId,
      postServicePlaylistId: postPlaylistId || undefined,
      firstSongKey: firstSongKey || undefined,
      secondsFromNow,
      autoStartTargetSec: leadMinutes * 60,
    });
    setActiveRehearsalIds(prev => [...prev, id]);
    const result = await armService(id, (filePath) => audio.loadBuffer(filePath).then(() => undefined));
    if (!result.ok) {
      setScheduledError(result.reason ?? 'Failed to arm rehearsal');
      deleteService(id);
      setActiveRehearsalIds(prev => prev.filter(rid => rid !== id));
    } else if (result.warning) {
      setScheduledError(result.warning);
    }
  };

  const onCancelRehearsal = (id: string) => {
    const runway = useAppStore.getState().currentRunway;
    if (runway?.serviceId === id && runway.phase !== 'queued') {
      audio.panicFadeAll(useAppStore.getState().config.defaults.panicFadeSec);
    }
    disarmService(id);
    deleteService(id);
    setActiveRehearsalIds(prev => prev.filter(rid => rid !== id));
  };

  return (
    <div className="panel-section">
      <div className="panel-header">
        <div className="panel-title">Rehearse</div>
        <div className="pad-status">{isQuickPlaying ? 'PLAYING' : 'IDLE'}</div>
      </div>

      <div className="rehearse-content">

        {/* Quick Test — one click, no schedule, transitions only. Collapsible. */}
        <div style={fieldStyle}>
          <button
            onClick={() => setShowQuick(s => !s)}
            style={{
              background: 'none',
              border: 'none',
              padding: '4px 0',
              color: 'var(--text-dim)',
              fontSize: 13,
              letterSpacing: 0.3,
              textTransform: 'uppercase',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
            title="Plays a playlist immediately. No service, no pad bridge. Use to quickly check song-to-song transitions."
          >
            <span>Quick Test{isQuickPlaying ? ' · playing' : ''}</span>
            <span>{showQuick || isQuickPlaying ? '−' : '+'}</span>
          </button>

          {(showQuick || isQuickPlaying) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 4 }}>
              <select
                style={inputStyle}
                value={quickPlaylistId}
                onChange={e => setQuickPlaylistId(e.target.value)}
                disabled={isQuickPlaying}
              >
                <option value="">— pick a playlist —</option>
                {allPlaylists.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.kind === 'pre' ? 'Pre' : p.kind === 'post' ? 'Post' : 'Special'} · {p.trackIds.length} tracks)
                  </option>
                ))}
              </select>
              <select
                style={inputStyle}
                value={quickLandInKey}
                onChange={e => setQuickLandInKey(e.target.value as KeyName | '')}
                disabled={isQuickPlaying}
                title="Reorder the playlist so the last track is in this key"
              >
                <option value="">Land in any key (playlist order)</option>
                {ALL_KEYS.map(k => <option key={k} value={k}>Land in {k}</option>)}
              </select>
              <button
                onClick={onQuickPlay}
                style={{
                  ...inputStyle,
                  padding: '10px 12px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  background: isQuickPlaying ? 'var(--red, #ef4444)' : 'var(--accent-bright, #14b8a6)',
                  color: '#000',
                  border: 'none',
                }}
              >
                {isQuickPlaying ? 'Stop' : '▶ Play test'}
              </button>
              {quickError && <div style={{ color: 'var(--red, #ef4444)', fontSize: 11 }}>{quickError}</div>}
              <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>
                Plays the playlist immediately. Use the test controls above to fast-forward and check transitions.
              </div>
            </div>
          )}
        </div>

        {/* Divider */}
        <div style={{ borderTop: '1px solid var(--border, rgba(255,255,255,0.08))' }} />

        {/* Scheduled rehearsal — full firing chain (collapsed by default) */}
        <div style={fieldStyle}>
          <button
            onClick={() => setShowScheduled(s => !s)}
            style={{
              background: 'none',
              border: 'none',
              padding: '4px 0',
              color: 'var(--text-dim)',
              fontSize: 13,
              letterSpacing: 0.3,
              textTransform: 'uppercase',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
            title="Simulates the full firing chain — auto-start, runway, pad bridge, service start. Use this to verify timing end-to-end."
          >
            <span>Scheduled</span>
            <span>{showScheduled ? '−' : '+'}</span>
          </button>

          {showScheduled && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 4 }}>
              <label style={fieldStyle}>
                <span style={labelStyle}>Pre-service playlist</span>
                <select style={inputStyle} value={playlistId} onChange={e => setPlaylistId(e.target.value)}>
                  <option value="">— pick one —</option>
                  {prePlaylists.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>

              <label style={fieldStyle}>
                <span style={labelStyle}>Post-service (optional)</span>
                <select style={inputStyle} value={postPlaylistId} onChange={e => setPostPlaylistId(e.target.value)}>
                  <option value="">— none —</option>
                  {postPlaylists.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>

              <label style={fieldStyle}>
                <span style={labelStyle}>Land in key (optional)</span>
                <select style={inputStyle} value={firstSongKey} onChange={e => setFirstSongKey(e.target.value as KeyName | '')}>
                  <option value="">— any —</option>
                  {ALL_KEYS.map(k => <option key={k} value={k}>{k}</option>)}
                </select>
              </label>

              <label style={fieldStyle}>
                <span style={labelStyle}>Auto-start lead (minutes)</span>
                <input
                  style={inputStyle}
                  type="number"
                  min={0}
                  max={240}
                  step={1}
                  value={leadMinutes}
                  onChange={e => setLeadMinutes(Math.max(0, Math.min(240, +e.target.value)))}
                />
              </label>

              <div style={fieldStyle}>
                <span style={labelStyle}>Service start in…</span>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {PRESETS.map(p => {
                    const active = secondsFromNow === p.minutes * 60 && leadMinutes === p.minutes;
                    return (
                      <button
                        key={p.label}
                        // Each preset sets both the start offset AND the lead time so the
                        // arrange step fills the entire window with songs.
                        onClick={() => {
                          setSecondsFromNow(p.minutes * 60);
                          setLeadMinutes(p.minutes);
                        }}
                        title={`Service in ${p.minutes} min · auto-start ${p.minutes} min lead (whole window plays)`}
                        style={{
                          ...inputStyle,
                          width: 'auto',
                          padding: '6px 10px',
                          fontSize: 13,
                          cursor: 'pointer',
                          background: active ? 'var(--accent, #14b8a6)' : inputStyle.background,
                          color: active ? '#000' : 'var(--text)',
                        }}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input
                    style={{ ...inputStyle, width: 100 }}
                    type="number"
                    min={5}
                    max={3600 * 4}
                    step={5}
                    value={secondsFromNow}
                    onChange={e => setSecondsFromNow(Math.max(5, +e.target.value))}
                    title="Seconds from now"
                  />
                  <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>seconds from now</span>
                </div>
              </div>

              <button
                onClick={onLaunchScheduled}
                style={{
                  ...inputStyle,
                  padding: '10px 12px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  background: 'var(--amber, #f59e0b)',
                  color: '#000',
                  border: 'none',
                  marginTop: 4,
                }}
              >
                Launch scheduled rehearsal
              </button>

              {scheduledError && (
                <div style={{ color: 'var(--red, #ef4444)', fontSize: 11 }}>{scheduledError}</div>
              )}

              {myRehearsals.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
                  <span style={labelStyle}>Active rehearsals</span>
                  {myRehearsals.map(svc => (
                    <div key={svc.id} style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      fontSize: 13,
                      padding: '6px 8px',
                      border: '1px solid var(--border, rgba(255,255,255,0.1))',
                      borderRadius: 4,
                    }}>
                      <span>{svc.startTime} · {svc.status}</span>
                      <button
                        onClick={() => onCancelRehearsal(svc.id)}
                        style={{
                          background: 'transparent',
                          border: '1px solid var(--border, rgba(255,255,255,0.15))',
                          color: 'var(--text-dim)',
                          fontSize: 12,
                          padding: '4px 10px',
                          borderRadius: 3,
                          cursor: 'pointer',
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
