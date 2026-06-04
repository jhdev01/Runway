import React, { useEffect, useMemo, useState } from 'react';
import { useAppStore, generateId } from '../state/store';
import { formatDuration, formatTrackTech } from '../lib/format';
import { KeyPickerModal } from '../components/KeyPickerModal';
import type { KeyName, Playlist, PlaylistKind, Track } from '@shared/types';
import { keyColor } from '@shared/music';
import { effectiveDuration } from '@shared/types';

export function PlaylistsView() {
  const playlists = useAppStore(s => s.config.playlists);
  const tracks = useAppStore(s => s.config.tracks);
  const selectedId = useAppStore(s => s.selectedPlaylistId);
  const setSelectedId = useAppStore(s => s.setSelectedPlaylistId);
  const createPlaylist = useAppStore(s => s.createPlaylist);

  const selected = playlists.find(p => p.id === selectedId) ?? playlists[0];

  const grouped = useMemo(() => {
    return {
      pre: playlists.filter(p => p.kind === 'pre'),
      post: playlists.filter(p => p.kind === 'post'),
      special: playlists.filter(p => p.kind === 'special'),
    };
  }, [playlists]);

  const onNewPlaylist = () => {
    // Generate a unique name like "New Playlist", "New Playlist 2", etc.
    const existingNames = new Set(playlists.map(p => p.name));
    let name = 'New Playlist';
    let counter = 2;
    while (existingNames.has(name)) {
      name = `New Playlist ${counter}`;
      counter++;
    }
    const id = createPlaylist(name, 'pre');
    setSelectedId(id);
  };

  return (
    <div className="playlists-view">
      <aside className="pl-sidebar">
        <div className="pl-sidebar-header">
          <div className="pl-sidebar-title">Playlists</div>
          <button className="pl-new-btn" onClick={onNewPlaylist} title="New playlist">+</button>
        </div>
        <div className="pl-list">
          <PlaylistGroup label="Pre-Service" items={grouped.pre} selectedId={selected?.id} onSelect={setSelectedId} tracks={tracks} />
          <PlaylistGroup label="Post-Service" items={grouped.post} selectedId={selected?.id} onSelect={setSelectedId} tracks={tracks} />
          <PlaylistGroup label="Special" items={grouped.special} selectedId={selected?.id} onSelect={setSelectedId} tracks={tracks} />
          {playlists.length === 0 && (
            <div style={{ padding: 20, color: 'var(--text-faint)', fontSize: 13 }}>
              No playlists yet. Click + to create one.
            </div>
          )}
        </div>
      </aside>

      {selected ? (
        <PlaylistEditor playlist={selected} />
      ) : (
        <div className="empty-state">
          <p>Select a playlist or create a new one.</p>
        </div>
      )}
    </div>
  );
}

function PlaylistGroup(props: {
  label: string;
  items: Playlist[];
  selectedId?: string;
  onSelect: (id: string) => void;
  tracks: Track[];
}) {
  if (props.items.length === 0) return null;
  return (
    <>
      <div className="pl-group-label">{props.label}</div>
      {props.items.map(p => {
        const total = p.trackIds.reduce((acc, id) => {
          const t = props.tracks.find(t => t.id === id);
          return acc + (t ? effectiveDuration(t) : 0);
        }, 0);
        return (
          <button
            key={p.id}
            className={`pl-item ${props.selectedId === p.id ? 'active' : ''}`}
            onClick={() => props.onSelect(p.id)}
            style={{ background: 'none', border: 'none', width: '100%', textAlign: 'left' }}
          >
            <div className={`pl-item-icon ${p.kind}`} />
            <div className="pl-item-info">
              <div className="pl-item-name">{p.name}</div>
              <div className="pl-item-meta">{p.trackIds.length} tracks · {formatDuration(total)}</div>
            </div>
          </button>
        );
      })}
    </>
  );
}

function PlaylistEditor({ playlist }: { playlist: Playlist }) {
  const tracks = useAppStore(s => s.config.tracks);
  const services = useAppStore(s => s.config.services);
  const defaults = useAppStore(s => s.config.defaults);
  const updatePlaylist = useAppStore(s => s.updatePlaylist);
  const deletePlaylist = useAppStore(s => s.deletePlaylist);
  const duplicatePlaylist = useAppStore(s => s.duplicatePlaylist);
  const setSelectedPlaylistId = useAppStore(s => s.setSelectedPlaylistId);
  const removeTrackFromPlaylist = useAppStore(s => s.removeTrackFromPlaylist);
  const addTracks = useAppStore(s => s.addTracks);
  const addTrackToPlaylist = useAppStore(s => s.addTrackToPlaylist);
  const updateTrack = useAppStore(s => s.updateTrack);
  const reorderPlaylistTracks = useAppStore(s => s.reorderPlaylistTracks);

  const [keyEditingTrackId, setKeyEditingTrackId] = useState<string | null>(null);
  const [libraryPickerOpen, setLibraryPickerOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dragFromIndex, setDragFromIndex] = useState<number | null>(null);
  const [dragHoverIndex, setDragHoverIndex] = useState<number | null>(null);

  const openEditor = useAppStore(s => s.openEditor);

  // Resolve every trackId, keeping nulls in place so the user sees stale
  // (missing-from-library) entries and can remove them. The runway also
  // walks raw trackIds, so leaving them invisible here would diverge.
  const playlistEntries: Array<{ id: string; track: Track | null }> =
    playlist.trackIds.map(id => ({ id, track: tracks.find(t => t.id === id) ?? null }));
  const playlistTracks = playlistEntries
    .map(e => e.track)
    .filter(Boolean) as Track[];
  const missingCount = playlistEntries.filter(e => !e.track).length;

  const totalSec = playlistTracks.reduce((acc, t) => acc + effectiveDuration(t), 0);
  const keysCovered = new Set(playlistTracks.map(t => t.key).filter(Boolean));

  // Find a target lead time to compare against. Priority:
  //   1. The playlist's own `targetLeadSec` (set in the settings strip)
  //   2. The longest auto-start target of any service using this playlist
  //   3. The global default
  // Only meaningful for pre-service playlists.
  const targetSec = (() => {
    if (playlist.kind !== 'pre') return 0;
    if (playlist.targetLeadSec && playlist.targetLeadSec > 0) {
      return playlist.targetLeadSec;
    }
    const svcTargets = services
      .filter(s => s.preServicePlaylistId === playlist.id)
      .map(s => s.autoStartTargetSec);
    if (svcTargets.length > 0) return Math.max(...svcTargets);
    return defaults.autoStartTargetSec ?? 0;
  })();
  const gapSec = Math.max(0, targetSec - totalSec);
  const fillsTarget = totalSec >= targetSec && targetSec > 0;
  const avgTrackSec = playlistTracks.length > 0 ? totalSec / playlistTracks.length : 240;
  const songsNeeded = gapSec > 0 && avgTrackSec > 0
    ? Math.max(1, Math.ceil(gapSec / avgTrackSec))
    : 0;
  const repeatToFill = defaults.repeatToFill ?? true;

  const onAddFiles = async () => {
    if (!window.runway) return;
    const paths = await window.runway.files.pickAudio(true);
    if (paths.length === 0) return;
    const newTracks: Track[] = [];
    for (const p of paths) {
      // Copy into the managed library, then read metadata from the copy.
      let managedPath = p;
      try {
        managedPath = await window.runway.files.importFile(p);
      } catch (err) {
        console.warn('[import] failed to copy', p, err);
      }
      const meta = await window.runway.files.readMetadata(managedPath);
      const newTrack: Track = {
        id: generateId(),
        filePath: managedPath,
        title: meta.title || managedPath.split('/').pop() || 'Untitled',
        artist: meta.artist,
        album: meta.album,
        durationSec: meta.durationSec ?? 0,
        key: meta.key,
        bpm: meta.bpm,
        addedAt: new Date().toISOString(),
      };
      newTracks.push(newTrack);
    }
    const idsByPath = addTracks(newTracks);
    newTracks.forEach(t => {
      const id = idsByPath[t.filePath] ?? t.id;
      addTrackToPlaylist(playlist.id, id);
    });
  };

  const onScanFolder = async () => {
    if (!window.runway) return;
    const folder = await window.runway.files.pickFolder();
    if (!folder) return;
    const scanned = await window.runway.files.scanFolder(folder);
    if (scanned.length === 0) return;
    const newTracks: Track[] = [];
    for (const s of scanned) {
      let managedPath = s.filePath;
      try {
        managedPath = await window.runway.files.importFile(s.filePath);
      } catch (err) {
        console.warn('[import] failed to copy', s.filePath, err);
      }
      newTracks.push({
        id: generateId(),
        filePath: managedPath,
        title: s.metadata.title || managedPath.split('/').pop() || 'Untitled',
        artist: s.metadata.artist,
        album: s.metadata.album,
        durationSec: s.metadata.durationSec ?? 0,
        key: s.metadata.key,
        bpm: s.metadata.bpm,
        addedAt: new Date().toISOString(),
      });
    }
    const idsByPath = addTracks(newTracks);
    newTracks.forEach(t => {
      const id = idsByPath[t.filePath] ?? t.id;
      addTrackToPlaylist(playlist.id, id);
    });
    updatePlaylist(playlist.id, { sourceFolder: folder });
  };

  const onDelete = () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      // Auto-revert after 3 seconds if not confirmed
      setTimeout(() => setConfirmDelete(false), 3000);
      return;
    }
    deletePlaylist(playlist.id);
    setConfirmDelete(false);
  };

  // Reset confirmation state when switching playlists
  useEffect(() => {
    setConfirmDelete(false);
  }, [playlist.id]);

  const onRename = () => {
    // Focus the title input — the user can rename inline
    const input = document.querySelector<HTMLInputElement>('.pl-editor-title');
    input?.focus();
    input?.select();
  };

  const onKeyChange = (trackId: string, key: KeyName | null) => {
    updateTrack(trackId, { key: key ?? undefined });
  };

  const onMoveTrack = (trackId: string, dir: -1 | 1) => {
    const idx = playlist.trackIds.indexOf(trackId);
    if (idx < 0) return;
    const next = [...playlist.trackIds];
    const swapWith = idx + dir;
    if (swapWith < 0 || swapWith >= next.length) return;
    [next[idx], next[swapWith]] = [next[swapWith], next[idx]];
    reorderPlaylistTracks(playlist.id, next);
  };

  return (
    <main className="pl-editor">
      <header className="pl-editor-header">
        <div className="pl-editor-title-block">
          <div className="pl-editor-eyebrow">Editing playlist</div>
          <input
            className="pl-editor-title"
            value={playlist.name}
            onChange={e => updatePlaylist(playlist.id, { name: e.target.value })}
          />
          <div className="pl-editor-stats">
            <div className="pl-editor-stat">
              <span className="pl-stat-label">Tracks</span>
              <span className="pl-stat-value">{playlistTracks.length}</span>
            </div>
            <div className="pl-editor-stat">
              <span className="pl-stat-label">Total runtime</span>
              <span className="pl-stat-value">{formatDuration(totalSec)}</span>
            </div>
            <div className="pl-editor-stat">
              <span className="pl-stat-label">Keys covered</span>
              <span className="pl-stat-value key">{keysCovered.size} of 24</span>
            </div>
            {targetSec > 0 && (
              <div className="pl-editor-stat">
                <span className="pl-stat-label">vs. {Math.round(targetSec / 60)}m target</span>
                <span
                  className="pl-stat-value"
                  style={{
                    color: fillsTarget
                      ? 'var(--accent-bright, #14b8a6)'
                      : repeatToFill
                        ? 'var(--text-dim)'
                        : 'var(--amber, #f59e0b)',
                  }}
                >
                  {fillsTarget
                    ? '✓ fills'
                    : repeatToFill
                      ? `loops to fill (+${formatDuration(gapSec)})`
                      : `~${songsNeeded} more song${songsNeeded === 1 ? '' : 's'} (+${formatDuration(gapSec)})`}
                </span>
              </div>
            )}
          </div>
        </div>
        <div className="pl-editor-actions">
          <button className="btn" onClick={onRename}>Rename</button>
          <button
            className="btn"
            onClick={() => {
              const id = duplicatePlaylist(playlist.id);
              if (id) setSelectedPlaylistId(id);
            }}
          >
            Duplicate
          </button>
          <button
            className="btn-danger"
            onClick={onDelete}
            style={confirmDelete ? { borderColor: 'var(--red)', color: 'var(--red-bright)' } : undefined}
          >
            {confirmDelete ? 'Click to confirm' : 'Delete'}
          </button>
        </div>
      </header>

      <div className="pl-add-row">
        <button className="pl-add-btn" onClick={onAddFiles} title="Upload audio files from disk">
          <svg className="pl-add-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          <span>Upload audio files</span>
        </button>
        <button className="pl-add-btn" onClick={() => setLibraryPickerOpen(true)} title="Pick existing tracks from the library">
          <svg className="pl-add-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
          </svg>
          <span>Add from library</span>
        </button>
      </div>

      {libraryPickerOpen && (
        <LibraryPicker
          excludeIds={new Set(playlist.trackIds)}
          onClose={() => setLibraryPickerOpen(false)}
          onPick={(ids) => {
            for (const id of ids) addTrackToPlaylist(playlist.id, id);
            setLibraryPickerOpen(false);
          }}
        />
      )}

      <div className="pl-tracks">
        {playlistEntries.length === 0 ? (
          <div className="pl-empty">No tracks yet. Add some via the area above.</div>
        ) : (
          <>
            {missingCount > 0 && (
              <div className="pl-missing-banner">
                <span>
                  {missingCount} track{missingCount === 1 ? '' : 's'} missing from the
                  library — remove the broken row{missingCount === 1 ? '' : 's'} below or re-import the file{missingCount === 1 ? '' : 's'}.
                </span>
                <button
                  className="btn-secondary"
                  onClick={() => {
                    const cleaned = playlistEntries.filter(e => e.track).map(e => e.id);
                    reorderPlaylistTracks(playlist.id, cleaned);
                  }}
                  title="Drop every missing-track entry from this playlist"
                >
                  Remove all missing
                </button>
              </div>
            )}
            <div className="pl-tracks-header">
              <div></div><div></div><div>Track</div><div>Key</div><div>BPM</div><div>Type</div><div>Length</div><div></div>
            </div>
            {playlistEntries.map((entry, idx) => {
              if (!entry.track) {
                return (
                  <div key={`missing-${entry.id}-${idx}`} className="pl-track pl-track-missing">
                    <div className="pl-track-num">{idx + 1}</div>
                    <div className="pl-track-handle" />
                    <div className="pl-track-info">
                      <div className="pl-track-name">— missing track —</div>
                      <div className="pl-track-artist" style={{ fontFamily: 'IBM Plex Mono, monospace' }}>
                        id: {entry.id}
                      </div>
                    </div>
                    <div className="pl-track-key untagged">—</div>
                    <div className="pl-track-bpm">—</div>
                    <div className="pl-track-format">—</div>
                    <div className="pl-track-time">—</div>
                    <div className="pl-track-actions">
                      <button
                        className="pl-track-action danger"
                        title="Remove this stale entry"
                        onClick={() => {
                          const next = playlist.trackIds.filter((_, i) => i !== idx);
                          reorderPlaylistTracks(playlist.id, next);
                        }}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                        </svg>
                      </button>
                    </div>
                  </div>
                );
              }
              const t = entry.track;
              return (
              <div
                key={t.id}
                className={`pl-track ${dragHoverIndex === idx && dragFromIndex !== null && dragFromIndex !== idx ? 'drop-target' : ''} ${dragFromIndex === idx ? 'dragging' : ''}`}
                onDragOver={(e) => {
                  if (dragFromIndex === null) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  if (dragHoverIndex !== idx) setDragHoverIndex(idx);
                }}
                onDragLeave={() => {
                  if (dragHoverIndex === idx) setDragHoverIndex(null);
                }}
                onDrop={(e) => {
                  if (dragFromIndex === null || dragFromIndex === idx) {
                    setDragFromIndex(null);
                    setDragHoverIndex(null);
                    return;
                  }
                  e.preventDefault();
                  const next = [...playlist.trackIds];
                  const [moved] = next.splice(dragFromIndex, 1);
                  next.splice(idx, 0, moved);
                  reorderPlaylistTracks(playlist.id, next);
                  setDragFromIndex(null);
                  setDragHoverIndex(null);
                }}
              >
                <div
                  className="pl-track-handle"
                  draggable
                  onDragStart={(e) => {
                    setDragFromIndex(idx);
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', String(idx));
                    // Use the whole row as the drag preview so the user
                    // sees the actual track they're moving.
                    const row = (e.currentTarget as HTMLElement).closest('.pl-track');
                    if (row) {
                      const rect = row.getBoundingClientRect();
                      e.dataTransfer.setDragImage(
                        row as Element,
                        e.clientX - rect.left,
                        e.clientY - rect.top,
                      );
                    }
                  }}
                  onDragEnd={() => {
                    setDragFromIndex(null);
                    setDragHoverIndex(null);
                  }}
                  title="Drag to reorder"
                >
                  <svg className="pl-track-grip" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <line x1="5" y1="7" x2="19" y2="7" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                    <line x1="5" y1="17" x2="19" y2="17" />
                  </svg>
                </div>
                <div className="pl-track-num">{idx + 1}</div>
                <div className="pl-track-info">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <EditableText
                      className="pl-track-name"
                      value={t.title}
                      onChange={v => updateTrack(t.id, { title: v.trim() || t.title })}
                      placeholder="Untitled"
                    />
                    {effectiveDuration(t) < t.durationSec && (
                      <span
                        style={{
                          fontSize: 10,
                          fontFamily: 'IBM Plex Mono, monospace',
                          fontWeight: 700,
                          letterSpacing: 0.06,
                          textTransform: 'uppercase',
                          background: 'transparent',
                          color: 'var(--accent-bright, #14b8a6)',
                          border: '1px solid var(--accent-bright, #14b8a6)',
                          padding: '2px 6px',
                          borderRadius: 3,
                        }}
                        title={`Trimmed: ${formatDuration(t.durationSec - effectiveDuration(t))} cut from original ${formatDuration(t.durationSec)}`}
                      >
                        Trimmed
                      </span>
                    )}
                    {/* Purple "Timer" pill — surfaces tracks that have a
                        timer-end marker placed in the Editor. The marker
                        is what tells the runway "land the service-start
                        countdown here, not at trim end." Useful to scan
                        a playlist and see which tracks have one set. */}
                    {typeof t.editServiceLandSec === 'number' && (
                      <span
                        style={{
                          fontSize: 10,
                          fontFamily: 'IBM Plex Mono, monospace',
                          fontWeight: 700,
                          letterSpacing: 0.06,
                          textTransform: 'uppercase',
                          background: 'transparent',
                          color: 'hsl(280, 80%, 75%)',
                          border: '1px solid hsl(280, 80%, 75%)',
                          padding: '2px 6px',
                          borderRadius: 3,
                        }}
                        title={`Timer marker at ${t.editServiceLandSec.toFixed(2)}s — service-start countdown lands on this point instead of the track's trim end.`}
                      >
                        Timer
                      </span>
                    )}
                  </div>
                  <EditableText
                    className="pl-track-artist"
                    value={t.artist || ''}
                    onChange={v => updateTrack(t.id, { artist: v.trim() || undefined })}
                    placeholder="Add artist"
                  />
                </div>
                {(() => {
                  const c = t.key ? keyColor(t.key) : null;
                  return (
                    <button
                      className={`pl-track-key ${t.key ? '' : 'untagged'}`}
                      onClick={() => setKeyEditingTrackId(t.id)}
                      style={c ? { background: c.bg, color: c.fg, borderColor: c.fg } : undefined}
                    >
                      {t.key || '— —'}
                    </button>
                  );
                })()}
                <EditableText
                  className="pl-track-bpm"
                  value={t.bpm != null ? String(t.bpm) : ''}
                  placeholder="—"
                  onChange={v => {
                    const s = v.trim();
                    if (s === '' || s === '0' || s === '—') {
                      updateTrack(t.id, { bpm: undefined });
                      return;
                    }
                    const n = parseInt(s, 10);
                    if (!Number.isNaN(n) && n > 0 && n < 1000) {
                      updateTrack(t.id, { bpm: n });
                    }
                  }}
                />
                <div className="pl-track-format" title={t.filePath}>
                  {formatTrackTech(t.filePath, t.sampleRate) || '—'}
                </div>
                <div className="pl-track-time" title={effectiveDuration(t) < t.durationSec ? `Trimmed from ${formatDuration(t.durationSec)}` : undefined}>
                  {formatDuration(effectiveDuration(t))}
                  {effectiveDuration(t) < t.durationSec && (
                    <span style={{ color: 'var(--text-faint)', fontSize: 10, marginLeft: 4 }}>✂︎</span>
                  )}
                </div>
                <div className="pl-track-actions">
                  <button className="pl-track-action" onClick={() => onMoveTrack(t.id, -1)} title="Move up">↑</button>
                  <button className="pl-track-action" onClick={() => onMoveTrack(t.id, 1)} title="Move down">↓</button>
                  <button
                    className="pl-track-action"
                    onClick={() => openEditor(t.id)}
                    title="Edit (trim, fades)"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                  </button>
                  <button className="pl-track-action danger" onClick={() => removeTrackFromPlaylist(playlist.id, t.id)} title="Remove">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              </div>
              );
            })}
          </>
        )}
      </div>

      <PlaylistSettingsStrip playlist={playlist} />

      <KeyPickerModal
        open={keyEditingTrackId !== null}
        selected={playlistTracks.find(t => t.id === keyEditingTrackId)?.key}
        onSelect={(k) => keyEditingTrackId && onKeyChange(keyEditingTrackId, k)}
        onClose={() => setKeyEditingTrackId(null)}
      />
    </main>
  );
}

function PlaylistSettingsStrip({ playlist }: { playlist: Playlist }) {
  const updatePlaylist = useAppStore(s => s.updatePlaylist);
  const stepperKey = (current: number, delta: number, min = 0, max = 60) =>
    Math.max(min, Math.min(max, +(current + delta).toFixed(1)));

  return (
    <div className="pl-settings">
      <div className="pl-settings-grid">
        <div className="pl-setting">
          <span className="pl-setting-label">Playlist Kind</span>
          <div className="pl-toggle">
            {(['pre', 'post', 'special'] as const).map(k => (
              <button key={k}
                className={`pl-toggle-btn ${playlist.kind === k ? 'active' : ''}`}
                onClick={() => updatePlaylist(playlist.id, { kind: k })}>
                {k === 'pre' ? 'Pre-Service' : k === 'post' ? 'Post-Service' : 'Special'}
              </button>
            ))}
          </div>
        </div>

        <div className="pl-setting">
          <span className="pl-setting-label">Playback Order</span>
          <div className="pl-toggle">
            {(['smart', 'sequential', 'shuffle'] as const).map(o => (
              <button key={o}
                className={`pl-toggle-btn ${playlist.playbackOrder === o ? 'active' : ''}`}
                onClick={() => updatePlaylist(playlist.id, { playbackOrder: o })}>
                {o === 'smart' ? 'Smart' : o === 'sequential' ? 'Sequential' : 'Shuffle'}
              </button>
            ))}
          </div>
        </div>

        <div className="pl-setting">
          <span className="pl-setting-label">Track Transitions</span>
          <div className="pl-toggle">
            {(['crossfade', 'gapless'] as const).map(m => (
              <button key={m}
                className={`pl-toggle-btn ${playlist.transitionMode === m ? 'active' : ''}`}
                onClick={() => updatePlaylist(playlist.id, { transitionMode: m })}>
                {m === 'crossfade' ? 'Crossfade' : 'Gapless'}
              </button>
            ))}
          </div>
        </div>

        <div className={`pl-setting ${playlist.transitionMode === 'gapless' ? 'disabled' : ''}`}>
          <span className="pl-setting-label">Crossfade Length</span>
          <Stepper
            value={playlist.crossfadeSec}
            onChange={v => updatePlaylist(playlist.id, { crossfadeSec: v })}
          />
        </div>

        <div className="pl-setting">
          <span className="pl-setting-label">Auto-arrange to land in key</span>
          <div className="pl-toggle">
            {[true, false].map(v => (
              <button key={String(v)}
                className={`pl-toggle-btn ${playlist.autoArrangeToKey === v ? 'active' : ''}`}
                onClick={() => updatePlaylist(playlist.id, { autoArrangeToKey: v })}>
                {v ? 'On' : 'Off'}
              </button>
            ))}
          </div>
        </div>

        <div
          className="pl-setting"
          title="ON: music begins earlier so the opening track plays from its very start (intro intact). OFF: head-trims the first track to start mid-song, so the runway begins exactly at the lead-time mark."
        >
          <span className="pl-setting-label">
            Don't trim opening song
            <span className="pl-setting-help">
              ON: music starts earlier so the first song plays from the beginning. OFF: starts mid-song to fit the lead window.
            </span>
          </span>
          <div className="pl-toggle">
            {[true, false].map(v => (
              <button key={String(v)}
                className={`pl-toggle-btn ${(playlist.playFirstSongFromStart ?? false) === v ? 'active' : ''}`}
                onClick={() => updatePlaylist(playlist.id, { playFirstSongFromStart: v })}>
                {v ? 'On' : 'Off'}
              </button>
            ))}
          </div>
        </div>

        {playlist.kind === 'pre' && (
          <div className="pl-setting">
            <span className="pl-setting-label">Editor target (min)</span>
            <EditorTargetInput
              valueSec={playlist.targetLeadSec}
              onChange={(secOrUndefined) =>
                updatePlaylist(playlist.id, { targetLeadSec: secOrUndefined })
              }
            />
          </div>
        )}

        <div className="pl-setting">
          <span className="pl-setting-label" title="How long the pad keeps playing after service start, before fading out.">
            Pad Hold
          </span>
          <Stepper
            value={playlist.padBridgeSec}
            onChange={v => updatePlaylist(playlist.id, { padBridgeSec: v })}
          />
        </div>

        <div className="pl-setting">
          <span className="pl-setting-label">Pad Fade Out</span>
          <Stepper
            value={playlist.padFadeOutSec}
            onChange={v => updatePlaylist(playlist.id, { padFadeOutSec: v })}
          />
        </div>

        <div className="pl-setting" style={{ gridColumn: 'span 2' }}>
          <span className="pl-setting-label" title="Optional Action Sequence that fires alongside this playlist's runway. Edit sequences in the Actions tab.">
            Action sequence
          </span>
          <ActionSequencePicker
            value={playlist.actionSequenceId}
            onChange={(id) => updatePlaylist(playlist.id, { actionSequenceId: id })}
          />
        </div>

      </div>
    </div>
  );
}

function ActionSequencePicker({
  value, onChange,
}: { value: string | undefined; onChange: (id: string | undefined) => void }) {
  const sequences = useAppStore(s => s.config.actionSequences ?? []);
  const setView = useAppStore(s => s.setView);
  return (
    <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <select
        value={value ?? ''}
        onChange={e => onChange(e.target.value || undefined)}
        style={{
          flex: 1,
          padding: '6px 8px',
          fontSize: 13,
          background: 'var(--bg-elev)',
          border: '1px solid var(--border)',
          borderRadius: 4,
          color: 'var(--text)',
        }}
      >
        <option value="">— none —</option>
        {sequences.map(s => (
          <option key={s.id} value={s.id}>{s.name}</option>
        ))}
        {value && !sequences.some(s => s.id === value) && (
          <option value={value}>(missing) {value}</option>
        )}
      </select>
      <button
        type="button"
        onClick={() => setView('actions')}
        style={{
          fontSize: 11,
          padding: '5px 10px',
          background: 'transparent',
          border: '1px solid var(--border)',
          borderRadius: 4,
          color: 'var(--text-dim)',
          cursor: 'pointer',
        }}
        title="Open the Actions tab to edit sequences"
      >Edit</button>
    </span>
  );
}

function Stepper({ value, onChange, step = 0.5, min = 0, max = 60 }: {
  value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number;
}) {
  return (
    <div className="pl-stepper">
      <button className="pl-stepper-btn" onClick={() => onChange(Math.max(min, +(value - step).toFixed(1)))}>−</button>
      <span className="pl-stepper-value">{value.toFixed(1)}s</span>
      <button className="pl-stepper-btn" onClick={() => onChange(Math.min(max, +(value + step).toFixed(1)))}>+</button>
    </div>
  );
}

/**
 * Click-to-edit text. Renders as a span by default; on click swaps to an input
 * that commits on blur or Enter and reverts on Escape.
 */
function EditableText({ value, onChange, className, placeholder }: {
  value: string;
  onChange: (next: string) => void;
  className?: string;
  placeholder?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);

  if (editing) {
    return (
      <input
        autoFocus
        className={className}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== value) onChange(draft);
          setEditing(false);
        }}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
            setDraft(value);
            setEditing(false);
          }
        }}
        placeholder={placeholder}
        style={{
          background: 'rgba(20,184,166,0.08)',
          border: '1px solid var(--accent)',
          color: 'inherit',
          font: 'inherit',
          padding: '1px 4px',
          borderRadius: 3,
          width: '100%',
          outline: 'none',
        }}
      />
    );
  }

  return (
    <span
      className={className}
      onClick={() => setEditing(true)}
      title="Click to edit"
      style={{ cursor: 'text', display: 'block' }}
    >
      {value || <span style={{ color: 'var(--text-faint)', fontStyle: 'italic' }}>{placeholder}</span>}
    </span>
  );
}

function EditorTargetInput({ valueSec, onChange }: {
  valueSec?: number;
  onChange: (secOrUndefined: number | undefined) => void;
}) {
  const initial = valueSec && valueSec > 0 ? String(Math.round(valueSec / 60)) : '';
  const [draft, setDraft] = useState<string>(initial);
  const [focused, setFocused] = useState(false);

  // Resync when the underlying value changes (e.g., switching playlists).
  useEffect(() => {
    if (!focused) {
      setDraft(valueSec && valueSec > 0 ? String(Math.round(valueSec / 60)) : '');
    }
  }, [valueSec, focused]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === '' || trimmed === '0') {
      onChange(undefined);
      setDraft('');
      return;
    }
    const n = parseInt(trimmed, 10);
    if (isNaN(n) || n <= 0) {
      onChange(undefined);
      setDraft('');
    } else {
      const clamped = Math.max(1, Math.min(240, n));
      onChange(clamped * 60);
      setDraft(String(clamped));
    }
  };

  const adjust = (delta: number) => {
    const cur = valueSec && valueSec > 0 ? Math.round(valueSec / 60) : 0;
    const next = Math.max(0, Math.min(240, cur + delta));
    if (next === 0) {
      onChange(undefined);
      setDraft('');
    } else {
      onChange(next * 60);
      setDraft(String(next));
    }
  };

  return (
    <div className="pl-stepper">
      <button className="pl-stepper-btn" onClick={() => adjust(-1)}>−</button>
      <input
        type="text"
        inputMode="numeric"
        value={draft}
        placeholder="auto"
        onChange={e => setDraft(e.target.value.replace(/[^\d]/g, '').slice(0, 3))}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); commit(); }}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            commit();
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
            setDraft(valueSec && valueSec > 0 ? String(Math.round(valueSec / 60)) : '');
            (e.target as HTMLInputElement).blur();
          }
        }}
        title="Editor target in minutes — leave blank for auto (uses scheduled service or the global default)"
        className="pl-stepper-text"
      />
      <button className="pl-stepper-btn" onClick={() => adjust(1)}>+</button>
    </div>
  );
}

/**
 * Multi-select picker that lets the operator link existing library
 * tracks into the current playlist without re-importing the file.
 * Tracks already in this playlist are excluded so duplicates can't
 * sneak in via the picker.
 */
function LibraryPicker({
  excludeIds,
  onClose,
  onPick,
}: {
  excludeIds: Set<string>;
  onClose: () => void;
  onPick: (ids: string[]) => void;
}) {
  const tracks = useAppStore(s => s.config.tracks);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tracks
      .filter(t => !excludeIds.has(t.id))
      .filter(t => {
        if (!q) return true;
        return (
          t.title.toLowerCase().includes(q)
          || (t.artist ?? '').toLowerCase().includes(q)
          || (t.key ?? '').toLowerCase().includes(q)
        );
      })
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [tracks, excludeIds, search]);

  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const onAdd = () => {
    if (selected.size === 0) return;
    // Preserve the on-screen sort order so the operator's selection
    // intent (which they probably built top-to-bottom) lands the same
    // way in the playlist's append order.
    const inOrder = filtered.filter(t => selected.has(t.id)).map(t => t.id);
    onPick(inOrder);
  };

  return (
    <div className="pl-picker-backdrop" onClick={onClose}>
      <div className="pl-picker" onClick={e => e.stopPropagation()}>
        <header className="pl-picker-head">
          <div>
            <div className="pl-picker-title">Add from library</div>
            <div className="pl-picker-sub">
              {tracks.length === 0
                ? 'Library is empty — upload a file first.'
                : `${filtered.length} of ${tracks.length} track${tracks.length === 1 ? '' : 's'} available`}
            </div>
          </div>
          <button className="pl-picker-close" onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className="pl-picker-search">
          <input
            type="text"
            placeholder="Search title, artist, key…"
            value={search}
            autoFocus
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        <div className="pl-picker-list">
          {filtered.length === 0 ? (
            <div className="pl-picker-empty">
              {tracks.length === 0
                ? 'Nothing in the library yet.'
                : excludeIds.size > 0 && filtered.length === 0 && search === ''
                  ? 'Every library track is already in this playlist.'
                  : 'No matches.'}
            </div>
          ) : (
            filtered.map(t => {
              const c = t.key ? keyColor(t.key) : null;
              const isSel = selected.has(t.id);
              return (
                <button
                  key={t.id}
                  className={`pl-picker-row ${isSel ? 'selected' : ''}`}
                  onClick={() => toggle(t.id)}
                >
                  <span className={`pl-picker-check ${isSel ? 'on' : ''}`} aria-hidden>
                    {isSel ? '✓' : ''}
                  </span>
                  <span className="pl-picker-name">
                    <span>{t.title}</span>
                    {t.artist && <span className="pl-picker-artist"> — {t.artist}</span>}
                  </span>
                  {t.key && (
                    <span
                      className="pl-picker-key"
                      style={c ? { background: c.bg, color: c.fg, borderColor: c.fg } : undefined}
                    >{t.key}</span>
                  )}
                  <span className="pl-picker-time">{formatDuration(effectiveDuration(t))}</span>
                </button>
              );
            })
          )}
        </div>

        <footer className="pl-picker-foot">
          <span className="pl-picker-count">
            {selected.size} selected
          </span>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn-secondary" onClick={onClose}>Cancel</button>
            <button
              className="btn-primary"
              disabled={selected.size === 0}
              onClick={onAdd}
            >
              Add {selected.size > 0 ? selected.size : ''} to playlist
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
