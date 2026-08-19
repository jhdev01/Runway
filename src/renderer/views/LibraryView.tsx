import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore, generateId } from '../state/store';
import { useEngines } from '../state/engines';
import { KeyTesterPiano } from '../components/KeyTesterPiano';
import { AlbumArtLightbox } from '../components/AlbumArtLightbox';
import {
  MultitracksKeyModal,
  makeProposal,
  type KeyProposal,
} from '../components/MultitracksKeyModal';
import { Tooltip } from '../components/Tooltip';
import { effectiveDuration, type Track, type KeyName } from '@shared/types';
import { keyColor } from '@shared/music';
import { formatDuration } from '../lib/format';

/**
 * Compact date string for the Added column. Shows "today", "Xd ago"
 * within the last week, then dates like "May 8" within the year, then
 * full year like "May 8 '25" for older.
 */
function formatDateAdded(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const now = new Date();
  const ms = now.getTime() - d.getTime();
  const days = Math.floor(ms / (24 * 3600 * 1000));
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  const sameYear = d.getFullYear() === now.getFullYear();
  const month = d.toLocaleString('en-US', { month: 'short' });
  return sameYear ? `${month} ${d.getDate()}` : `${month} ${d.getDate()} '${String(d.getFullYear()).slice(-2)}`;
}

/**
 * Library — central pool of every imported audio file. Tracks land here
 * automatically on import (the existing playlist upload flow already
 * inserts into config.tracks) and can be linked into any playlist from
 * here without re-uploading. Orphan tracks (not currently in any
 * playlist) are intentionally allowed: they let an operator phase songs
 * in and out across weeks without the library going stale.
 *
 * Two semantics worth distinguishing:
 *   - Remove (in playlists): unlinks a track from one playlist. Track
 *     stays in the library, possibly orphaned.
 *   - Delete (here in the library only): removes the track from the
 *     library AND cascades through every playlist that references it.
 */
export function LibraryView() {
  const tracks = useAppStore(s => s.config.tracks);
  const playlists = useAppStore(s => s.config.playlists);
  const deleteTrack = useAppStore(s => s.deleteTrack);
  const setView = useAppStore(s => s.setView);
  const setSelectedPlaylistId = useAppStore(s => s.setSelectedPlaylistId);
  const openEditor = useAppStore(s => s.openEditor);
  const addTracks = useAppStore(s => s.addTracks);
  const addTrackToPlaylist = useAppStore(s => s.addTrackToPlaylist);
  const removeTrackFromPlaylist = useAppStore(s => s.removeTrackFromPlaylist);
  const updateTrack = useAppStore(s => s.updateTrack);
  const { audio } = useEngines();
  const [uploading, setUploading] = useState(false);
  const [playlistMenuTrackId, setPlaylistMenuTrackId] = useState<string | null>(null);
  const [artPickerTrackId, setArtPickerTrackId] = useState<string | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  const onUpload = async () => {
    if (!window.runway || uploading) return;
    const paths = await window.runway.files.pickAudio(true);
    if (paths.length === 0) return;
    setUploading(true);
    try {
      const newTracks: Track[] = [];
      for (const p of paths) {
        let managedPath = p;
        try {
          managedPath = await window.runway.files.importFile(p);
        } catch (err) {
          console.warn('[library import] failed to copy', p, err);
        }
        const meta = await window.runway.files.readMetadata(managedPath);
        newTracks.push({
          id: generateId(),
          filePath: managedPath,
          title: meta.title || managedPath.split('/').pop() || 'Untitled',
          artist: meta.artist,
          album: meta.album,
          durationSec: meta.durationSec ?? 0,
          key: meta.key,
          bpm: meta.bpm,
          addedAt: new Date().toISOString(),
        });
      }
      addTracks(newTracks);
    } finally {
      setUploading(false);
    }
  };

  type SortKey = 'title' | 'artist' | 'key' | 'bpm' | 'duration' | 'added';
  const [sortKey, setSortKey] = useState<SortKey>('title');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [search, setSearch] = useState('');
  const [orphansOnly, setOrphansOnly] = useState(false);
  // Key filter — 'all' shows everything, '_none' shows untagged tracks,
  // otherwise filters by exact key match.
  const [keyFilter, setKeyFilter] = useState<string>('all');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [confirmAllOrphans, setConfirmAllOrphans] = useState(false);
  const [previewingId, setPreviewingId] = useState<string | null>(null);

  // Single global preview source — only one library row plays at a time.
  // Refs (not state) so async start/stop callbacks don't race React re-renders.
  const previewSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const previewGainRef = useRef<GainNode | null>(null);
  // Position tracking for the row's progress bar. Updated via RAF
  // while playing; cleared on stop. Stored in seconds within the
  // trimmed segment (0 .. effectiveDuration), so the UI can map it
  // straight to a 0..100% bar fill against `effectiveDuration(track)`.
  const [previewPos, setPreviewPos] = useState(0);
  const previewMetaRef = useRef<{
    trackId: string;
    startedAt: number;       // ctx.currentTime when src.start() was called
    seekFromSec: number;     // offset within the trimmed segment we started from
    effectiveDur: number;    // total trimmed duration
    ctx: AudioContext;
  } | null>(null);
  const previewRafRef = useRef<number | null>(null);

  const tickPreviewPos = () => {
    const meta = previewMetaRef.current;
    if (!meta) return;
    const elapsed = meta.ctx.currentTime - meta.startedAt;
    const pos = Math.max(0, Math.min(meta.effectiveDur, meta.seekFromSec + elapsed));
    setPreviewPos(pos);
    if (pos < meta.effectiveDur) {
      previewRafRef.current = requestAnimationFrame(tickPreviewPos);
    }
  };

  const stopPreview = () => {
    if (previewSourceRef.current) {
      try { previewSourceRef.current.stop(); } catch {}
      previewSourceRef.current = null;
    }
    previewGainRef.current = null;
    if (previewRafRef.current != null) {
      cancelAnimationFrame(previewRafRef.current);
      previewRafRef.current = null;
    }
    previewMetaRef.current = null;
    setPreviewPos(0);
    setPreviewingId(null);
  };

  // Stop preview on unmount.
  useEffect(() => () => stopPreview(), []);

  // Clear the refresh-hint timer on unmount so a stale callback
  // can't try to setState on an unmounted component.
  useEffect(() => () => {
    if (refreshHintTimerRef.current) window.clearTimeout(refreshHintTimerRef.current);
  }, []);

  // Lazy backfill of tech metadata (codec/bitrate/channels) for tracks
  // imported before those fields existed. Runs once per Library mount,
  // throttled to one file at a time so a 900-track library doesn't stall
  // the renderer. Tracks missing the file on disk are skipped silently.
  // Status for the manual "refresh metadata" button: idle / running.
  // Number tracked separately so the button can show "Refreshed 7/12".
  const [refreshing, setRefreshing] = useState(false);
  const [refreshProgress, setRefreshProgress] = useState({ done: 0, total: 0 });
  const [keyTesterOpen, setKeyTesterOpen] = useState(false);
  const refreshCancelRef = useRef<{ cancelled: boolean } | null>(null);
  // "Show file locations" toggle — expands each row to expose the
  // on-disk path plus a folder indicator showing whether the file
  // already lives inside the internal library directory or is still
  // referenced externally (e.g., from Downloads).
  const [showLocations, setShowLocations] = useState(false);
  const [internalAudioDir, setInternalAudioDir] = useState<string>('');
  // Transient hint shown when the operator clicks "Refresh metadata"
  // with nothing selected — clears itself after a few seconds.
  const [refreshHint, setRefreshHint] = useState(false);
  const refreshHintTimerRef = useRef<number | null>(null);
  // "Consolidate library" — copy every external file into the internal
  // audio dir so the library is self-contained (e.g., before backing
  // up the app or moving to another machine). Status mirrors the
  // refresh-metadata UX: progress chip + cancel button.
  const [consolidating, setConsolidating] = useState(false);
  const [consolidateProgress, setConsolidateProgress] = useState({ done: 0, total: 0 });
  const consolidateCancelRef = useRef<{ cancelled: boolean } | null>(null);
  // "Keys from MultiTracks" — batch lookup of the published original
  // master key, reviewed before anything is written. Same progress +
  // cancel UX as the metadata refresh.
  const [mtScanning, setMtScanning] = useState(false);
  const [mtProgress, setMtProgress] = useState({ done: 0, total: 0 });
  const mtCancelRef = useRef<{ cancelled: boolean } | null>(null);
  const [mtProposals, setMtProposals] = useState<KeyProposal[]>([]);
  const [mtReviewOpen, setMtReviewOpen] = useState(false);
  const [mtHint, setMtHint] = useState<string | null>(null);
  const mtHintTimerRef = useRef<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.runway?.files.libraryPaths().then((p) => {
      if (!cancelled) setInternalAudioDir(p.audioDir);
    });
    return () => { cancelled = true; };
  }, []);

  /**
   * Refresh metadata + album art for some subset of tracks. Two modes:
   *  - 'stale' (default): only tracks missing tech info or art —
   *    used by the auto-backfill on Library mount.
   *  - 'all': force-refetch even tracks that already have art —
   *    triggered by the manual button when iTunes lookups failed
   *    earlier (network was off, rate limit, whatever).
   */
  const runRefresh = async (mode: 'stale' | 'all' | 'selected'): Promise<void> => {
    const targets = mode === 'selected'
      ? tracks.filter(t => selectedIds.has(t.id))
      : mode === 'all'
        ? [...tracks]
        : tracks.filter(t => (!t.codec && !t.bitrateBps) || t.albumArtUrl === undefined);
    if (targets.length === 0) return;
    const cancel = { cancelled: false };
    refreshCancelRef.current = cancel;
    setRefreshing(true);
    setRefreshProgress({ done: 0, total: targets.length });
    try {
      let done = 0;
      for (const t of targets) {
        if (cancel.cancelled) break;
        try {
          const meta = await window.runway?.files.readMetadata(t.filePath);
          if (!cancel.cancelled && meta) {
            // Lookup chain for album art:
            //   1. Embedded ID3 (already in `meta`)
            //   2. iTunes Search API
            // Key + BPM come from ID3 only — manual entry via the
            // inline editor is the source of truth for those.
            // Try to upgrade the track's art: prefer freshly-read
            // embedded art, else iTunes lookup. Critically, if we
            // come up empty we KEEP whatever the track already has —
            // a refresh must never destroy art that was successfully
            // set on a previous run (e.g., transient network failure
            // shouldn't wipe out hours of correct lookups).
            let candidateArt: string | undefined = meta.albumArtUrl;
            let scrapedAlbum: string | undefined;
            const lookupArtist = meta.artist ?? t.artist ?? '';
            const lookupTitle = meta.title ?? t.title ?? '';

            if (lookupArtist && lookupTitle && (!candidateArt || !(t.album || meta.album))) {
              try {
                const itunes = await window.runway?.files.iTunesArtLookup(lookupArtist, lookupTitle);
                if (itunes) {
                  if (!candidateArt) candidateArt = itunes.artworkUrl;
                  if (itunes.albumName) scrapedAlbum = itunes.albumName;
                }
              } catch { /* offline / blocked — fall through */ }
            }
            // Key + BPM source-of-truth = the user. ID3 fills in if
            // present, but we never overwrite a manually-set value.
            const finalKey = t.key ?? meta.key;
            const finalBpm = t.bpm ?? meta.bpm;
            const finalArt = candidateArt || t.albumArtUrl || '';
            updateTrack(t.id, {
              title: t.title || meta.title,
              artist: t.artist || meta.artist,
              album: t.album || meta.album || scrapedAlbum,
              bpm: finalBpm,
              key: finalKey,
              bitrateBps: meta.bitrateBps,
              codec: meta.codec,
              container: meta.container,
              channels: meta.channels,
              lossless: meta.lossless,
              sampleRate: meta.sampleRate ?? t.sampleRate,
              albumArtUrl: finalArt,
            });
          }
        } catch {
          // file moved / vanished — skip
        }
        done += 1;
        if (!cancel.cancelled) setRefreshProgress({ done, total: targets.length });
      }
    } finally {
      setRefreshing(false);
      refreshCancelRef.current = null;
    }
  };

  const flashMtHint = (msg: string) => {
    setMtHint(msg);
    if (mtHintTimerRef.current) window.clearTimeout(mtHintTimerRef.current);
    mtHintTimerRef.current = window.setTimeout(() => setMtHint(null), 4000);
  };

  /**
   * Look up the published original master key on MultiTracks.com for a
   * batch of tracks and open the review sheet.
   *
   * Targets: the checked tracks when there's a selection, otherwise
   * every track that has no key yet. Nothing is written here — the
   * modal collects the operator's decisions and applyMtProposals()
   * does the writing.
   *
   * Title and artist come off the track; duration is passed along
   * because it's the best way to tell an album cut from a radio edit,
   * and those two are frequently in different keys.
   */
  const runMultitracksScan = async (): Promise<void> => {
    const targets = selectedIds.size > 0
      ? tracks.filter(t => selectedIds.has(t.id))
      : tracks.filter(t => !t.key);
    if (targets.length === 0) {
      flashMtHint(
        selectedIds.size > 0
          ? 'No tracks selected'
          : 'Every track already has a key — select the ones you want re-checked.',
      );
      return;
    }
    const cancel = { cancelled: false };
    mtCancelRef.current = cancel;
    setMtScanning(true);
    setMtProgress({ done: 0, total: targets.length });
    const proposals: KeyProposal[] = [];
    try {
      let done = 0;
      for (const t of targets) {
        if (cancel.cancelled) break;
        try {
          const res = await window.runway?.files.multitracksLookup(
            t.artist ?? '',
            t.title,
            t.durationSec || undefined,
          );
          if (res) {
            proposals.push(
              makeProposal(t.id, t.title, t.artist ?? '', t.key, res),
            );
          }
        } catch (err) {
          // Offline, endpoint moved, whatever — record it as a miss so
          // the operator sees the track in the "no match" group rather
          // than silently losing it from the report.
          console.warn('[multitracks] lookup failed for', t.title, err);
          proposals.push(makeProposal(t.id, t.title, t.artist ?? '', t.key, {
            alternates: [],
            reason: 'Lookup failed — check your network connection',
          }));
        }
        done += 1;
        if (!cancel.cancelled) setMtProgress({ done, total: targets.length });
      }
    } finally {
      setMtScanning(false);
      mtCancelRef.current = null;
    }
    if (cancel.cancelled) return;
    if (proposals.length === 0) {
      flashMtHint('No results came back from MultiTracks.');
      return;
    }
    setMtProposals(proposals);
    setMtReviewOpen(true);
  };

  /** Write the checked proposals. Only `key` is touched. */
  const applyMtProposals = () => {
    let applied = 0;
    for (const p of mtProposals) {
      if (!p.include || !p.chosenKey) continue;
      updateTrack(p.trackId, { key: p.chosenKey });
      applied += 1;
    }
    setMtReviewOpen(false);
    setMtProposals([]);
    flashMtHint(`Set ${applied} key${applied === 1 ? '' : 's'} from MultiTracks.`);
  };

  /**
   * Copy every external track's file into the internal audio dir
   * and update the track's filePath. Tracks already inside the
   * library directory are skipped (no-op). Cancellable mid-flight
   * via the toolbar button. Files that fail to copy (missing on
   * disk, permission denied, etc.) leave the track's filePath
   * unchanged — operator can review the warnings in dev console.
   */
  const runConsolidate = async (): Promise<void> => {
    if (!internalAudioDir) return;
    const targets = tracks.filter(t => !t.filePath.startsWith(internalAudioDir));
    if (targets.length === 0) return;
    const cancel = { cancelled: false };
    consolidateCancelRef.current = cancel;
    setConsolidating(true);
    setConsolidateProgress({ done: 0, total: targets.length });
    try {
      let done = 0;
      for (const t of targets) {
        if (cancel.cancelled) break;
        try {
          const newPath = await window.runway?.files.importFile(t.filePath);
          if (!cancel.cancelled && newPath && newPath !== t.filePath) {
            updateTrack(t.id, { filePath: newPath });
          }
        } catch (err) {
          console.warn('[consolidate] failed to copy', t.filePath, err);
        }
        done += 1;
        if (!cancel.cancelled) setConsolidateProgress({ done, total: targets.length });
      }
    } finally {
      setConsolidating(false);
      consolidateCancelRef.current = null;
    }
  };

  // Auto-backfill on first Library mount.
  useEffect(() => {
    void runRefresh('stale');
    return () => {
      if (refreshCancelRef.current) refreshCancelRef.current.cancelled = true;
    };
    // Run once per mount, not on every tracks change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Start preview playback. `seekFromSec` is an offset within the
   * trimmed segment (0 = beginning of trim). Used both for fresh
   * starts (default 0, with fades) and for seek operations triggered
   * from the row's progress bar (skip the fades — operator wants to
   * hear the new position immediately).
   */
  const startPreview = async (track: Track, seekFromSec = 0) => {
    if (previewSourceRef.current) {
      try { previewSourceRef.current.stop(); } catch {}
      previewSourceRef.current = null;
    }
    if (previewRafRef.current != null) {
      cancelAnimationFrame(previewRafRef.current);
      previewRafRef.current = null;
    }
    const buffer = await audio.loadBuffer(track.filePath);
    const ctx = audio.getContextForEditor();
    if (ctx.state === 'suspended') await ctx.resume();

    const trimStart = Math.max(0, track.trimStartSec ?? 0);
    const trimEnd = Math.min(buffer.duration, track.trimEndSec ?? buffer.duration);
    const effectiveDur = Math.max(0, trimEnd - trimStart);
    if (effectiveDur < 0.05) return;
    const seek = Math.max(0, Math.min(effectiveDur - 0.05, seekFromSec));
    const startSec = trimStart + seek;
    const playDur = trimEnd - startSec;
    const fIn = Math.min(track.editFadeInSec ?? 0, effectiveDur / 2);
    const fOut = Math.min(track.editFadeOutSec ?? 0, effectiveDur / 2);

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    src.connect(gain).connect(audio.getCueOutputNode());

    const now = ctx.currentTime;
    // Fades are only applied on a fresh start (seek === 0). Mid-track
    // seeks skip the fade-in for instant audio, and skip the fade-out
    // since the operator's already auditioning a specific spot.
    if (seek === 0 && fIn > 0) {
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(1, now + fIn);
    } else {
      gain.gain.setValueAtTime(1, now);
    }
    if (seek === 0 && fOut > 0) {
      gain.gain.setValueAtTime(1, now + Math.max(0, playDur - fOut));
      gain.gain.linearRampToValueAtTime(0, now + playDur);
    }

    src.start(now, startSec, playDur);
    src.stop(now + playDur + 0.05);
    src.onended = () => {
      if (previewSourceRef.current === src) {
        previewSourceRef.current = null;
        previewGainRef.current = null;
        previewMetaRef.current = null;
        if (previewRafRef.current != null) {
          cancelAnimationFrame(previewRafRef.current);
          previewRafRef.current = null;
        }
        setPreviewPos(0);
        setPreviewingId(curr => (curr === track.id ? null : curr));
      }
    };

    previewSourceRef.current = src;
    previewGainRef.current = gain;
    previewMetaRef.current = {
      trackId: track.id,
      startedAt: now,
      seekFromSec: seek,
      effectiveDur,
      ctx,
    };
    setPreviewPos(seek);
    previewRafRef.current = requestAnimationFrame(tickPreviewPos);
    setPreviewingId(track.id);
  };

  const seekPreview = (track: Track, posInSegmentSec: number) => {
    void startPreview(track, posInSegmentSec);
  };

  const onPreviewToggle = (track: Track) => {
    if (previewingId === track.id) {
      stopPreview();
    } else {
      void startPreview(track);
    }
  };

  // Lookup: trackId → list of playlists referencing it. Computed once per
  // (tracks, playlists) change so each row's pill list is O(1).
  // Distinct keys present in the library, sorted in canonical Camelot
  // order (sharp/flat groups paired) so the dropdown is musically
  // navigable rather than alphabetical.
  const availableKeys = useMemo(() => {
    const set = new Set<string>();
    for (const t of tracks) if (t.key) set.add(t.key);
    return Array.from(set).sort();
  }, [tracks]);

  const playlistsByTrackId = useMemo(() => {
    const map = new Map<string, { id: string; name: string; kind: string }[]>();
    for (const t of tracks) map.set(t.id, []);
    for (const p of playlists) {
      for (const tid of p.trackIds) {
        const list = map.get(tid);
        if (list) list.push({ id: p.id, name: p.name, kind: p.kind });
      }
    }
    return map;
  }, [tracks, playlists]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tracks.filter(t => {
      if (orphansOnly) {
        const refs = playlistsByTrackId.get(t.id);
        if (refs && refs.length > 0) return false;
      }
      if (keyFilter !== 'all') {
        if (keyFilter === '_none') {
          if (t.key) return false;
        } else if (t.key !== keyFilter) {
          return false;
        }
      }
      if (!q) return true;
      return (
        t.title.toLowerCase().includes(q)
        || (t.artist ?? '').toLowerCase().includes(q)
        || (t.album ?? '').toLowerCase().includes(q)
        || (t.key ?? '').toLowerCase().includes(q)
      );
    });
  }, [tracks, search, orphansOnly, keyFilter, playlistsByTrackId]);

  const sorted = useMemo(() => {
    const out = [...filtered];
    const dir = sortDir === 'asc' ? 1 : -1;
    out.sort((a, b) => {
      switch (sortKey) {
        case 'title':    return dir * a.title.localeCompare(b.title);
        case 'artist':   return dir * (a.artist ?? '').localeCompare(b.artist ?? '');
        case 'key':      return dir * (a.key ?? '').localeCompare(b.key ?? '');
        case 'bpm':      return dir * ((a.bpm ?? 0) - (b.bpm ?? 0));
        case 'duration': return dir * (effectiveDuration(a) - effectiveDuration(b));
        case 'added':    return dir * a.addedAt.localeCompare(b.addedAt);
      }
    });
    return out;
  }, [filtered, sortKey, sortDir]);

  const onClickHeader = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
  };

  const onJumpToPlaylist = (playlistId: string) => {
    setSelectedPlaylistId(playlistId);
    setView('playlists');
  };

  const onDelete = (track: Track) => {
    if (confirmDeleteId !== track.id) {
      setConfirmDeleteId(track.id);
      window.setTimeout(() => {
        setConfirmDeleteId(curr => (curr === track.id ? null : curr));
      }, 3000);
      return;
    }
    if (previewingId === track.id) stopPreview();
    deleteTrack(track.id);
    setConfirmDeleteId(null);
    setSelectedIds(prev => {
      if (!prev.has(track.id)) return prev;
      const next = new Set(prev);
      next.delete(track.id);
      return next;
    });
  };

  const toggleSelected = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setConfirmBulk(false);
  };

  // "Visible" = currently filtered + sorted rows. Header checkbox toggles
  // these only — keeps any out-of-view selections untouched so the user
  // can refine the filter, add to selection, refine again, etc.
  const visibleSelectedCount = useMemo(
    () => sorted.reduce((n, t) => n + (selectedIds.has(t.id) ? 1 : 0), 0),
    [sorted, selectedIds],
  );
  const allVisibleSelected = sorted.length > 0 && visibleSelectedCount === sorted.length;
  const someVisibleSelected = visibleSelectedCount > 0 && !allVisibleSelected;

  const toggleAllVisible = () => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const t of sorted) next.delete(t.id);
      } else {
        for (const t of sorted) next.add(t.id);
      }
      return next;
    });
    setConfirmBulk(false);
  };

  const selectAllOrphansVisible = () => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      for (const t of sorted) {
        const refs = playlistsByTrackId.get(t.id);
        if (!refs || refs.length === 0) next.add(t.id);
      }
      return next;
    });
    setConfirmBulk(false);
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
    setConfirmBulk(false);
  };

  const onBulkDelete = () => {
    if (selectedIds.size === 0) return;
    if (!confirmBulk) {
      setConfirmBulk(true);
      window.setTimeout(() => setConfirmBulk(false), 4000);
      return;
    }
    if (previewingId && selectedIds.has(previewingId)) stopPreview();
    for (const id of selectedIds) deleteTrack(id);
    setSelectedIds(new Set());
    setConfirmBulk(false);
  };

  const orphanCount = useMemo(() => tracks.filter(t => {
    const refs = playlistsByTrackId.get(t.id);
    return !refs || refs.length === 0;
  }).length, [tracks, playlistsByTrackId]);

  const onDeleteAllOrphans = () => {
    if (orphanCount === 0) return;
    if (!confirmAllOrphans) {
      setConfirmAllOrphans(true);
      window.setTimeout(() => setConfirmAllOrphans(false), 5000);
      return;
    }
    const orphanIds: string[] = [];
    for (const t of tracks) {
      const refs = playlistsByTrackId.get(t.id);
      if (!refs || refs.length === 0) orphanIds.push(t.id);
    }
    if (previewingId && orphanIds.includes(previewingId)) stopPreview();
    for (const id of orphanIds) deleteTrack(id);
    setSelectedIds(prev => {
      if (prev.size === 0) return prev;
      const next = new Set(prev);
      for (const id of orphanIds) next.delete(id);
      return next;
    });
    setConfirmAllOrphans(false);
  };

  const headerCheckRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (headerCheckRef.current) headerCheckRef.current.indeterminate = someVisibleSelected;
  }, [someVisibleSelected]);

  return (
    <div className="library-view">
      <header className="library-toolbar">
        <div className="library-title">
          <strong>Library</strong>
          <span className="library-count">
            {tracks.length} track{tracks.length === 1 ? '' : 's'}
            {orphanCount > 0 && <> · {orphanCount} orphan{orphanCount === 1 ? '' : 's'}</>}
          </span>
        </div>
        <button
          className="library-upload"
          onClick={onUpload}
          disabled={uploading}
          title="Add audio files to the library"
        >
          {uploading ? 'Uploading…' : '+ Upload'}
        </button>
        <div className="library-refresh-wrap">
          <button
            className="library-refresh"
            onClick={() => {
              if (refreshing) {
                if (refreshCancelRef.current) refreshCancelRef.current.cancelled = true;
                return;
              }
              if (selectedIds.size === 0) {
                setRefreshHint(true);
                if (refreshHintTimerRef.current) window.clearTimeout(refreshHintTimerRef.current);
                refreshHintTimerRef.current = window.setTimeout(() => setRefreshHint(false), 3500);
                return;
              }
              void runRefresh('selected');
            }}
            title={
              refreshing
                ? 'Cancel the in-flight refresh'
                : selectedIds.size > 0
                  ? `Re-read metadata + iTunes for ${selectedIds.size} selected track${selectedIds.size === 1 ? '' : 's'}`
                  : 'Check the tracks you want to refresh first'
            }
          >
            {refreshing
              ? `Cancel · ${refreshProgress.done}/${refreshProgress.total}`
              : selectedIds.size > 0
                ? `↻ Refresh ${selectedIds.size}`
                : '↻ Refresh metadata'}
          </button>
          {refreshHint && (
            <div className="library-refresh-hint">
              Check the tracks you want to refresh first
            </div>
          )}
        </div>
        <div className="library-refresh-wrap">
          <button
            className="library-refresh"
            onClick={() => {
              if (mtScanning) {
                if (mtCancelRef.current) mtCancelRef.current.cancelled = true;
                return;
              }
              void runMultitracksScan();
            }}
            title={
              mtScanning
                ? 'Cancel the in-flight lookup'
                : selectedIds.size > 0
                  ? `Look up the original master key on MultiTracks.com for ${selectedIds.size} selected track${selectedIds.size === 1 ? '' : 's'}`
                  : 'Look up the original master key on MultiTracks.com for every track that has no key yet. You review every match before anything changes.'
            }
          >
            {mtScanning
              ? `Cancel · ${mtProgress.done}/${mtProgress.total}`
              : selectedIds.size > 0
                ? `♪ Keys from MultiTracks (${selectedIds.size})`
                : '♪ Keys from MultiTracks'}
          </button>
          {mtHint && <div className="library-refresh-hint">{mtHint}</div>}
        </div>
        <button
          className={`library-refresh ${keyTesterOpen ? 'active' : ''}`}
          onClick={() => setKeyTesterOpen(o => !o)}
          title={keyTesterOpen ? 'Close the pad player' : 'Open the pad player — fire any mapped pad to audition against tracks in the library.'}
        >
          {keyTesterOpen ? 'Close pad player' : 'Pad player'}
        </button>
        <button
          className={`library-refresh ${showLocations ? 'active' : ''}`}
          onClick={() => setShowLocations(s => !s)}
          title={showLocations
            ? 'Hide file paths'
            : 'Show each track\'s on-disk location + whether it\'s in the internal library or referenced externally'}
        >
          {showLocations ? 'Hide locations' : 'Show locations'}
        </button>
        {(() => {
          const externalCount = internalAudioDir
            ? tracks.filter(t => !t.filePath.startsWith(internalAudioDir)).length
            : 0;
          const disabled = !consolidating && externalCount === 0;
          return (
            <button
              className="library-refresh"
              onClick={() => {
                if (consolidating) {
                  if (consolidateCancelRef.current) consolidateCancelRef.current.cancelled = true;
                  return;
                }
                if (externalCount === 0) return;
                void runConsolidate();
              }}
              disabled={disabled}
              title={consolidating
                ? 'Cancel the in-flight copy'
                : externalCount > 0
                  ? `Copy ${externalCount} external file${externalCount === 1 ? '' : 's'} into the internal library so the library is self-contained`
                  : 'Every track already lives inside the internal library'}
            >
              {consolidating
                ? `Cancel · ${consolidateProgress.done}/${consolidateProgress.total}`
                : externalCount > 0
                  ? `↳ Consolidate library (${externalCount})`
                  : '↳ Consolidate library'}
            </button>
          );
        })()}
        <input
          className="library-search"
          type="text"
          placeholder="Search title, artist, key…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <label className="library-orphans-toggle">
          <input
            type="checkbox"
            checked={orphansOnly}
            onChange={e => setOrphansOnly(e.target.checked)}
          />
          Orphans only
        </label>
        <select
          className="library-key-filter"
          value={keyFilter}
          onChange={e => setKeyFilter(e.target.value)}
          title="Filter library by song key"
        >
          <option value="all">All keys</option>
          <option value="_none">— untagged —</option>
          {availableKeys.map(k => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
        {orphanCount > 0 && (
          <button
            className={`library-purge ${confirmAllOrphans ? 'confirm' : ''}`}
            onClick={onDeleteAllOrphans}
            title="Delete every track not referenced by any playlist"
          >
            {confirmAllOrphans
              ? `Click again to delete ${orphanCount}`
              : `Delete all ${orphanCount} orphans`}
          </button>
        )}
      </header>

      {selectedIds.size > 0 && (
        <div className="library-bulkbar">
          <span className="library-bulkbar-count">
            {selectedIds.size} selected
          </span>
          <button className="library-bulkbar-link" onClick={selectAllOrphansVisible} title="Add all visible orphans to selection">
            + orphans
          </button>
          <button className="library-bulkbar-link" onClick={clearSelection}>
            Clear
          </button>
          <div className="library-bulkbar-spacer" />
          <button
            className={`library-bulkbar-delete ${confirmBulk ? 'confirm' : ''}`}
            onClick={onBulkDelete}
          >
            {confirmBulk ? `Click again to delete ${selectedIds.size}` : `Delete ${selectedIds.size}`}
          </button>
        </div>
      )}

      <div className="library-table">
        <div className="library-row library-head">
          <div className="library-cell-check">
            <input
              ref={headerCheckRef}
              type="checkbox"
              checked={allVisibleSelected}
              onChange={toggleAllVisible}
              disabled={sorted.length === 0}
              title={allVisibleSelected ? 'Clear visible selection' : 'Select all visible'}
            />
          </div>
          <div className="library-cell-num">#</div>
          <div className="library-cell-preview" />
          <button className="library-cell-title" onClick={() => onClickHeader('title')}>
            Title{sortKey === 'title' ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
          </button>
          <button className="library-cell-artist" onClick={() => onClickHeader('artist')}>
            Artist{sortKey === 'artist' ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
          </button>
          <button className="library-cell-key" onClick={() => onClickHeader('key')}>
            Key{sortKey === 'key' ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
          </button>
          <button className="library-cell-bpm" onClick={() => onClickHeader('bpm')}>
            BPM{sortKey === 'bpm' ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
          </button>
          <button className="library-cell-time" onClick={() => onClickHeader('duration')}>
            Length{sortKey === 'duration' ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
          </button>
          <button className="library-cell-added" onClick={() => onClickHeader('added')}>
            Added{sortKey === 'added' ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
          </button>
          <div className="library-cell-tags">In playlists</div>
          <div className="library-cell-actions" />
        </div>

        {sorted.length === 0 ? (
          <div className="library-empty">
            {tracks.length === 0
              ? 'Library is empty. Tracks added to any playlist will appear here automatically.'
              : 'No tracks match the current filter.'}
          </div>
        ) : (
          sorted.map((t, rowIdx) => {
            const refs = playlistsByTrackId.get(t.id) ?? [];
            const isOrphan = refs.length === 0;
            const c = t.key ? keyColor(t.key as KeyName) : null;
            const eff = effectiveDuration(t);
            const isTrimmed = eff < t.durationSec;
            const hasTimer = typeof t.editServiceLandSec === 'number';
            const isConfirm = confirmDeleteId === t.id;
            const isSelected = selectedIds.has(t.id);
            const isPlaying = previewingId === t.id;
            return (
              <div key={t.id} className={`library-row ${isOrphan ? 'orphan' : ''} ${isSelected ? 'selected' : ''} ${previewingId === t.id ? 'previewing' : ''}`}>
                <div className="library-cell-check">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleSelected(t.id)}
                  />
                </div>
                <div className="library-cell-num">{rowIdx + 1}</div>
                <div className="library-cell-preview">
                  <button
                    className={`library-preview-btn ${isPlaying ? 'playing' : ''}`}
                    onClick={() => onPreviewToggle(t)}
                    title={isPlaying ? 'Stop preview (cue bus)' : 'Preview on cue bus'}
                  >
                    {isPlaying ? (
                      <svg viewBox="0 0 14 14" width="13" height="13">
                        <rect x="3" y="3" width="8" height="8" fill="currentColor" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 14 14" width="13" height="13">
                        <polygon points="4,2.5 12,7 4,11.5" fill="currentColor" />
                      </svg>
                    )}
                  </button>
                </div>
                <div className="library-cell-title">
                  <div className="library-art-wrap">
                    <button
                      type="button"
                      className="library-art-trigger"
                      onClick={() => setArtPickerTrackId(curr => curr === t.id ? null : t.id)}
                      title="Click to change artwork"
                    >
                      {t.albumArtUrl ? (
                        <img className="library-art" src={t.albumArtUrl} alt="" loading="lazy" />
                      ) : (
                        <div className="library-art library-art-placeholder" aria-hidden>♪</div>
                      )}
                    </button>
                    {artPickerTrackId === t.id && (
                      <ArtworkPicker
                        track={t}
                        onPick={(art, album) => {
                          updateTrack(t.id, {
                            albumArtUrl: art,
                            ...(album && !t.album ? { album } : {}),
                          });
                          setArtPickerTrackId(null);
                        }}
                        onClear={() => {
                          updateTrack(t.id, { albumArtUrl: '' });
                          setArtPickerTrackId(null);
                        }}
                        onClose={() => setArtPickerTrackId(null)}
                      />
                    )}
                  </div>
                  <div className="library-track-name-block">
                    <div className="library-track-name">
                      <TitleCell
                        track={t}
                        onChange={(title) => updateTrack(t.id, { title })}
                      />
                      {isTrimmed && <span className="library-pill trimmed" title={`Trimmed from ${formatDuration(t.durationSec)}`}>Trim</span>}
                      {hasTimer && <span className="library-pill timer" title="Has timer-end marker">Timer</span>}
                    </div>
                    <div className="library-track-tech">
                      {formatTechInfo(t)}
                      <FolderIndicator
                        filePath={t.filePath}
                        internalRoot={internalAudioDir}
                      />
                    </div>
                    {showLocations && (
                      <LocationLine filePath={t.filePath} />
                    )}
                  </div>
                </div>
                <div className="library-cell-artist">
                  <ArtistAlbumCell
                    track={t}
                    onChangeArtist={(artist) => updateTrack(t.id, { artist })}
                    onChangeAlbum={(album) => updateTrack(t.id, { album })}
                  />
                </div>
                <div className="library-cell-key">
                  <KeyCell track={t} onChange={(key) => updateTrack(t.id, { key })} />
                </div>
                <div className="library-cell-bpm">
                  <BpmCell track={t} onChange={(bpm) => updateTrack(t.id, { bpm })} />
                </div>
                <div className="library-cell-time">{formatDuration(eff)}</div>
                <div className="library-cell-added" title={t.addedAt}>
                  {formatDateAdded(t.addedAt)}
                </div>
                <div className="library-cell-tags">
                  {refs.length === 0 ? (
                    <span className="library-orphan-label">orphan</span>
                  ) : (
                    refs.map(p => (
                      <button
                        key={p.id}
                        className={`library-playlist-pill kind-${p.kind}`}
                        onClick={() => onJumpToPlaylist(p.id)}
                        title={`Jump to playlist "${p.name}"`}
                      >{p.name}</button>
                    ))
                  )}
                </div>
                <div className="library-cell-actions">
                  <div className="library-action-pop">
                    <button
                      className={`library-action ${playlistMenuTrackId === t.id ? 'active' : ''}`}
                      onClick={() => setPlaylistMenuTrackId(curr => curr === t.id ? null : t.id)}
                      title="Add or remove this track from playlists"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                        <line x1="8" y1="6" x2="21" y2="6" />
                        <line x1="8" y1="12" x2="21" y2="12" />
                        <line x1="8" y1="18" x2="21" y2="18" />
                        <circle cx="3" cy="6" r="1" fill="currentColor" />
                        <circle cx="3" cy="12" r="1" fill="currentColor" />
                        <circle cx="3" cy="18" r="1" fill="currentColor" />
                      </svg>
                    </button>
                    {playlistMenuTrackId === t.id && (
                      <PlaylistChecklist
                        trackId={t.id}
                        playlists={playlists}
                        memberPlaylistIds={new Set(refs.map(r => r.id))}
                        onToggle={(pid, checked) => {
                          if (checked) addTrackToPlaylist(pid, t.id);
                          else removeTrackFromPlaylist(pid, t.id);
                        }}
                        onClose={() => setPlaylistMenuTrackId(null)}
                      />
                    )}
                  </div>
                  <button
                    className="library-action"
                    onClick={() => openEditor(t.id)}
                    title="Open in audio editor"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                  </button>
                  <button
                    className={`library-action danger ${isConfirm ? 'confirm' : ''}`}
                    onClick={() => onDelete(t)}
                    title={
                      isConfirm
                        ? `Click again to delete (will remove from ${refs.length} playlist${refs.length === 1 ? '' : 's'})`
                        : refs.length > 0
                          ? `Delete from library (also removes from ${refs.length} playlist${refs.length === 1 ? '' : 's'})`
                          : 'Delete from library'
                    }
                  >
                    {isConfirm ? '✓' : '✕'}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
      {(() => {
        if (!previewingId) return null;
        const pt = tracks.find(x => x.id === previewingId);
        if (!pt) return null;
        const peff = effectiveDuration(pt);
        const meta = [pt.artist, pt.album].filter(Boolean).join(' · ');
        return (
          <div className="library-miniplayer">
            {pt.albumArtUrl ? (
              <button
                type="button"
                className="library-miniplayer-art-button"
                onClick={() => setLightboxOpen(true)}
                title="Click to view full size"
              >
                <img className="library-miniplayer-art" src={pt.albumArtUrl} alt="" />
              </button>
            ) : (
              <div className="library-miniplayer-art library-miniplayer-art-placeholder" aria-hidden>♪</div>
            )}
            <div className="library-miniplayer-info">
              <div className="library-miniplayer-title">{pt.title}</div>
              <div className="library-miniplayer-meta">{meta || '—'}</div>
              <div className="library-miniplayer-progress">
                <span className="library-miniplayer-time">{formatDuration(previewPos)}</span>
                <div
                  className="library-miniplayer-track"
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                    seekPreview(pt, pct * peff);
                  }}
                  title="Click to seek"
                >
                  <div
                    className="library-miniplayer-fill"
                    style={{ width: `${peff > 0 ? Math.min(100, (previewPos / peff) * 100) : 0}%` }}
                  />
                </div>
                <span className="library-miniplayer-time">{formatDuration(peff)}</span>
              </div>
            </div>
            <button
              type="button"
              className="library-miniplayer-stop"
              onClick={stopPreview}
              title="Stop preview"
              aria-label="Stop preview"
            >
              <svg viewBox="0 0 14 14" width="13" height="13">
                <rect x="3" y="3" width="8" height="8" fill="currentColor" />
              </svg>
            </button>
          </div>
        );
      })()}
      {keyTesterOpen && <KeyTesterPiano onClose={() => setKeyTesterOpen(false)} />}
      {lightboxOpen && previewingId && (() => {
        const pt = tracks.find(x => x.id === previewingId);
        if (!pt?.albumArtUrl) return null;
        const meta = [pt.artist, pt.album].filter(Boolean).join(' · ');
        return (
          <AlbumArtLightbox
            artUrl={pt.albumArtUrl}
            title={pt.title}
            meta={meta || undefined}
            onClose={() => setLightboxOpen(false)}
          />
        );
      })()}
      <MultitracksKeyModal
        open={mtReviewOpen}
        proposals={mtProposals}
        onChange={setMtProposals}
        onApply={applyMtProposals}
        onClose={() => { setMtReviewOpen(false); setMtProposals([]); }}
      />
    </div>
  );
}

/**
 * Always-visible tiny folder glyph after the tech-info line. Filled
 * means "in the internal library", outlined means "referenced
 * externally" (still sitting wherever the operator imported from).
 * Both stay grey so the indicator reads as informational rather than
 * status-y. Hovering reveals which kind it is + the full path.
 */
function FolderIndicator({ filePath, internalRoot }: { filePath: string; internalRoot: string }) {
  const isInternal = !!internalRoot && filePath.startsWith(internalRoot);
  const tipText = `${isInternal ? 'Internal library' : 'External reference'} · ${filePath}`;
  return (
    <Tooltip text={tipText}>
      <span
        className={`library-track-folder ${isInternal ? 'internal' : 'external'}`}
        aria-label={isInternal ? 'Internal library file' : 'External file'}
      >
        <svg
          viewBox="0 0 24 24"
          fill={isInternal ? 'currentColor' : 'none'}
          stroke="currentColor"
          strokeWidth="1.6"
          aria-hidden
        >
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
        </svg>
      </span>
    </Tooltip>
  );
}

/**
 * Expanded file path row, visible only when "Show locations" is
 * toggled on. Path truncates from the LEFT so the filename stays
 * visible; hovering the path shows the full string in our custom
 * tooltip (Electron's native title-attribute tooltip is unreliable).
 */
function LocationLine({ filePath }: { filePath: string }) {
  return (
    <Tooltip text={filePath} display="block">
      <div className="library-track-loc">
        <span className="library-track-loc-path">{filePath}</span>
      </div>
    </Tooltip>
  );
}

/**
 * Render a single-line summary of a track's tech metadata for the
 * Library row's subtitle. Skips fields we don't have rather than
 * showing "—" for each one — old imports may only have a sample rate
 * until the lazy backfill catches up.
 */
function formatTechInfo(t: Track): string {
  const parts: string[] = [];
  // Filetype label: prefer file extension (always present and the most
  // human-recognizable), fall back to the metadata container.
  const ext = (t.filePath.split('.').pop() ?? '').toLowerCase();
  if (ext) parts.push(ext.toUpperCase());
  else if (t.container) parts.push(t.container.toUpperCase());

  if (typeof t.sampleRate === 'number' && t.sampleRate > 0) {
    parts.push(`${(t.sampleRate / 1000).toFixed(t.sampleRate % 1000 === 0 ? 0 : 1)} kHz`);
  }
  if (typeof t.bitrateBps === 'number' && t.bitrateBps > 0) {
    parts.push(`${Math.round(t.bitrateBps / 1000)} kbps`);
  }
  if (typeof t.channels === 'number' && t.channels > 0) {
    parts.push(t.channels === 1 ? 'mono' : t.channels === 2 ? 'stereo' : `${t.channels}ch`);
  }
  if (t.lossless) parts.push('lossless');
  return parts.join(' · ');
}

interface PlaylistChecklistProps {
  trackId: string;
  playlists: { id: string; name: string; kind: string }[];
  memberPlaylistIds: Set<string>;
  onToggle: (playlistId: string, checked: boolean) => void;
  onClose: () => void;
}

function PlaylistChecklist({ trackId, playlists, memberPlaylistIds, onToggle, onClose }: PlaylistChecklistProps) {
  const popRef = useRef<HTMLDivElement | null>(null);

  // Click-outside + Escape close. Mousedown rather than click so the popover
  // closes before the next button's onClick fires (avoids re-opening it).
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Group by kind so the "Pre / Post / Special" hierarchy stays visible.
  const groups = useMemo(() => {
    const order: { key: string; label: string }[] = [
      { key: 'pre', label: 'Pre-service' },
      { key: 'post', label: 'Post-service' },
      { key: 'special', label: 'Special' },
    ];
    return order
      .map(g => ({ ...g, items: playlists.filter(p => p.kind === g.key) }))
      .filter(g => g.items.length > 0);
  }, [playlists]);

  return (
    <div className="library-checklist" ref={popRef} onClick={e => e.stopPropagation()}>
      {playlists.length === 0 ? (
        <div className="library-checklist-empty">No playlists yet.</div>
      ) : (
        groups.map(g => (
          <div key={g.key}>
            <div className="library-checklist-section">{g.label}</div>
            {g.items.map(p => {
              const checked = memberPlaylistIds.has(p.id);
              return (
                <label key={p.id} className="library-checklist-row">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={e => onToggle(p.id, e.target.checked)}
                  />
                  <span className="pl-name">{p.name}</span>
                </label>
              );
            })}
          </div>
        ))
      )}
    </div>
  );
}

// All KeyName values, ordered by Camelot wheel for the dropdown so
// keys cluster by their musical relatives instead of alphabetically.
const ALL_KEYS: KeyName[] = [
  'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'Db', 'Ab', 'Eb', 'Bb', 'F',
  'Am', 'Em', 'Bm', 'F#m', 'C#m', 'G#m', 'D#m', 'Bbm', 'Fm', 'Cm', 'Gm', 'Dm',
];

/**
 * Inline-editable key cell. Click the colored pill to open a dropdown
 * with all 24 keys; clicking outside or picking a key commits. The
 * displayed pill keeps the same visual treatment as the read-only
 * version so the row layout doesn't shift when toggling between
 * states.
 */
function KeyCell({ track, onChange }: { track: Track; onChange: (key?: KeyName) => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const c = track.key ? keyColor(track.key as KeyName) : null;
  return (
    <div className="library-key-edit-wrap" ref={wrapRef}>
      <button
        className="library-key-edit-trigger"
        onClick={() => setOpen(o => !o)}
        title={track.key ? `Click to change · ${track.key}` : 'Click to set key'}
      >
        {track.key ? (
          <span
            className="library-key-tag"
            style={c ? { background: c.bg, color: c.fg, borderColor: c.fg } : undefined}
          >{track.key}</span>
        ) : (
          <span className="library-key-empty">—</span>
        )}
      </button>
      {open && (
        <div className="library-key-dropdown" onClick={e => e.stopPropagation()}>
          <button
            className="library-key-option library-key-option-clear"
            onClick={() => { onChange(undefined); setOpen(false); }}
          >Clear</button>
          {ALL_KEYS.map(k => {
            const cc = keyColor(k);
            return (
              <button
                key={k}
                className={`library-key-option ${track.key === k ? 'active' : ''}`}
                style={{ color: cc.fg, borderColor: cc.fg, background: cc.bg }}
                onClick={() => { onChange(k); setOpen(false); }}
              >{k}</button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Inline-editable track title. Click to focus an input that fills the
 * available width; Enter or blur commits, Escape cancels. Empty value
 * is rejected (silently reverts) — every track must have a title for
 * the rest of the UI to render meaningfully.
 */
function TitleCell({ track, onChange }: { track: Track; onChange: (title: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(track.title);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (editing) {
      setDraft(track.title);
      window.setTimeout(() => inputRef.current?.select(), 0);
    }
  }, [editing, track.title]);
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== track.title) onChange(trimmed);
    setEditing(false);
  };
  if (editing) {
    return (
      <input
        ref={inputRef}
        className="library-title-input"
        type="text"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') setEditing(false);
        }}
      />
    );
  }
  return (
    <span
      className="library-title-trigger"
      onClick={() => setEditing(true)}
      title={`Click to rename · ${track.title}`}
    >
      {track.title}
    </span>
  );
}

/**
 * Inline-editable Artist + Album in a single cell. Stacks vertically:
 * artist on top (editable, shown bigger), album below as a smaller
 * subtitle (also editable). Empty values are allowed — clearing
 * artist or album just renders "—" / nothing in their place.
 */
function ArtistAlbumCell({ track, onChangeArtist, onChangeAlbum }: {
  track: Track;
  onChangeArtist: (artist?: string) => void;
  onChangeAlbum: (album?: string) => void;
}) {
  return (
    <div className="library-artistalbum">
      <InlineText
        value={track.artist ?? ''}
        placeholder="—"
        ariaLabel="Artist"
        className="library-artist-line"
        onCommit={(v) => onChangeArtist(v.trim() || undefined)}
      />
      <InlineText
        value={track.album ?? ''}
        placeholder="add album…"
        ariaLabel="Album"
        className="library-album-line"
        onCommit={(v) => onChangeAlbum(v.trim() || undefined)}
      />
    </div>
  );
}

/**
 * Reusable inline-text editor. Click to edit; Enter or blur commits;
 * Escape cancels. Used by both the artist and album cells.
 */
function InlineText({ value, placeholder, ariaLabel, className, onCommit }: {
  value: string;
  placeholder: string;
  ariaLabel: string;
  className: string;
  onCommit: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (editing) {
      setDraft(value);
      window.setTimeout(() => inputRef.current?.select(), 0);
    }
  }, [editing, value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
    setEditing(false);
  };
  if (editing) {
    return (
      <input
        ref={inputRef}
        className={`${className} library-inlinetext-input`}
        type="text"
        value={draft}
        aria-label={ariaLabel}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') setEditing(false);
        }}
      />
    );
  }
  return (
    <span
      className={`${className} library-inlinetext-trigger`}
      onClick={() => setEditing(true)}
      title={value ? `Click to edit · ${value}` : `Click to set ${ariaLabel.toLowerCase()}`}
    >
      {value || <span className="library-inlinetext-placeholder">{placeholder}</span>}
    </span>
  );
}

/**
 * Inline-editable BPM. Click to focus a small numeric input; Enter
 * or blur commits. Empty value clears the BPM. Constrained 30..300
 * to catch fat-finger typos before they save.
 */
function BpmCell({ track, onChange }: { track: Track; onChange: (bpm?: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>(track.bpm != null ? String(track.bpm) : '');
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (editing) {
      setDraft(track.bpm != null ? String(track.bpm) : '');
      window.setTimeout(() => inputRef.current?.select(), 0);
    }
  }, [editing, track.bpm]);
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === '') {
      onChange(undefined);
    } else {
      const n = Math.round(Number(trimmed));
      if (!isNaN(n) && n >= 30 && n <= 300) onChange(n);
    }
    setEditing(false);
  };
  if (editing) {
    return (
      <input
        ref={inputRef}
        className="library-bpm-input"
        type="number"
        min={30}
        max={300}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') setEditing(false);
        }}
      />
    );
  }
  return (
    <button
      className="library-bpm-trigger"
      onClick={() => setEditing(true)}
      title={track.bpm != null ? `Click to change · ${track.bpm} BPM` : 'Click to set BPM'}
    >
      {track.bpm ?? '—'}
    </button>
  );
}

/**
 * Artwork picker — pops up beside the album-art thumbnail when the
 * operator clicks it. Loads candidates from iTunes Search on open
 * (best-effort; ignores network failures), and offers:
 *   - Current art
 *   - Each candidate album cover with album/artist label
 *   - Clear button to revoke art entirely
 *
 * Picking a candidate also auto-fills `album` if the track has none.
 */
function ArtworkPicker({ track, onPick, onClear, onClose }: {
  track: Track;
  onPick: (artworkUrl: string, albumName?: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [candidates, setCandidates] = useState<{
    artworkUrl: string;
    albumName: string;
    artistName: string;
    trackName: string;
  }[]>([]);
  const popRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await window.runway?.files.iTunesCandidatesLookup(
          track.artist ?? '',
          track.title,
        );
        if (!cancelled) setCandidates(list ?? []);
      } catch {
        if (!cancelled) setCandidates([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [track.id, track.title, track.artist]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div className="library-art-picker" ref={popRef} onClick={e => e.stopPropagation()}>
      <div className="library-art-picker-head">
        <span>Choose artwork</span>
        <button className="library-art-picker-close" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="library-art-picker-grid">
        {track.albumArtUrl && (
          <button
            type="button"
            className="library-art-picker-tile current"
            onClick={() => onClose()}
            title="Current artwork"
          >
            <img src={track.albumArtUrl} alt="" />
            <div className="library-art-picker-meta">
              <strong>Current</strong>
              <span>{track.album ?? ''}</span>
            </div>
          </button>
        )}
        {loading && (
          <div className="library-art-picker-loading">Loading candidates…</div>
        )}
        {!loading && candidates.length === 0 && !track.albumArtUrl && (
          <div className="library-art-picker-empty">No matches found.</div>
        )}
        {candidates.map((c, i) => (
          <button
            key={i}
            type="button"
            className="library-art-picker-tile"
            onClick={() => onPick(c.artworkUrl, c.albumName)}
            title={`${c.albumName} — ${c.artistName}`}
          >
            <img src={c.artworkUrl} alt="" />
            <div className="library-art-picker-meta">
              <strong>{c.albumName || '—'}</strong>
              <span>{c.artistName}</span>
            </div>
          </button>
        ))}
      </div>
      {track.albumArtUrl && (
        <button
          type="button"
          className="library-art-picker-clear"
          onClick={onClear}
        >
          Remove artwork
        </button>
      )}
    </div>
  );
}
