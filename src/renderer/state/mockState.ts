/**
 * Mock state injector for `?mock=1` Live-view preview.
 *
 * Populates the Zustand store with a representative scene — service
 * armed and music playing, post-service playlist queued, schedule has
 * two services back-to-back, a few tracks with album art. Designed so
 * the operator (or designer) can iterate on Live-view layout in a
 * browser tab without arming a real service.
 *
 * Engines stay live but we don't trigger any real audio or MIDI —
 * the snapshot fields just visualize what the controller WOULD show.
 */

import { useAppStore } from './store';
import type { Track, Playlist, ServiceInstance } from '@shared/types';

export function installMockState(): void {
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);

  // --- Mock library (5 tracks) ---
  const tracks: Track[] = [
    {
      id: 'mock-t1', filePath: '/mock/song-of-the-saints.mp3',
      title: 'Song of the Saints', artist: 'Phil Wickham', album: 'I Believe',
      durationSec: 263, key: 'G', bpm: 78,
      addedAt: new Date(now - 7 * 86400_000).toISOString(),
      sampleRate: 44100, channels: 2, bitrateBps: 320000, container: 'MPEG', codec: 'MPEG 1 Layer 3',
    },
    {
      id: 'mock-t2', filePath: '/mock/yet.flac',
      title: 'Yet', artist: 'Hillside Recording', album: 'Singles',
      durationSec: 269, key: 'D', bpm: 84,
      addedAt: new Date(now - 14 * 86400_000).toISOString(),
      sampleRate: 44100, channels: 2, bitrateBps: 690000, container: 'FLAC', codec: 'FLAC', lossless: true,
    },
    {
      id: 'mock-t3', filePath: '/mock/be-glad.mp3',
      title: 'Be Glad', artist: 'Cody Carnes', album: 'Live',
      durationSec: 295, key: 'D', bpm: 92,
      addedAt: new Date(now - 21 * 86400_000).toISOString(),
      sampleRate: 44100, channels: 2, bitrateBps: 192000, container: 'MPEG', codec: 'MPEG 1 Layer 3',
    },
    {
      id: 'mock-t4', filePath: '/mock/where-you-are.mp3',
      title: 'Where You Are', artist: 'Hillsong Young & Free', album: 'III',
      durationSec: 206, key: 'B', bpm: 128,
      addedAt: new Date(now - 30 * 86400_000).toISOString(),
      sampleRate: 44100, channels: 2, bitrateBps: 192000, container: 'MPEG', codec: 'MPEG 1 Layer 3',
    },
    {
      id: 'mock-t5', filePath: '/mock/echo.mp3',
      title: 'Echo', artist: 'Elevation Worship', album: 'Singles',
      durationSec: 224, key: 'D', bpm: 96,
      addedAt: new Date(now - 45 * 86400_000).toISOString(),
      sampleRate: 44100, channels: 2, bitrateBps: 192000, container: 'MPEG', codec: 'MPEG 1 Layer 3',
    },
  ];

  // --- Mock playlists ---
  const playlists: Playlist[] = [
    {
      id: 'mock-pl-pre', name: 'Sunday Preservice', kind: 'pre',
      trackIds: tracks.slice(0, 4).map(t => t.id),
      playbackOrder: 'smart', transitionMode: 'crossfade', crossfadeSec: 5,
      autoArrangeToKey: true, padBridgeSec: 10, padFadeOutSec: 5,
      createdAt: new Date(now - 30 * 86400_000).toISOString(),
      updatedAt: new Date(now - 86400_000).toISOString(),
    },
    {
      id: 'mock-pl-post', name: 'Sunday Postservice', kind: 'post',
      trackIds: tracks.slice(2).map(t => t.id),
      playbackOrder: 'sequential', transitionMode: 'crossfade', crossfadeSec: 4,
      autoArrangeToKey: false, padBridgeSec: 0, padFadeOutSec: 0,
      createdAt: new Date(now - 30 * 86400_000).toISOString(),
      updatedAt: new Date(now - 86400_000).toISOString(),
    },
  ];

  // --- Mock services (one in progress, one upcoming) ---
  const services: ServiceInstance[] = [
    {
      id: 'mock-svc-1', name: 'Sunday 9am', date: today, startTime: '09:00',
      preServicePlaylistId: 'mock-pl-pre', postServicePlaylistId: 'mock-pl-post',
      autoStartTargetSec: 1800, status: 'live', firstSongKey: 'G', setlist: [],
    },
    {
      id: 'mock-svc-2', name: 'Sunday 11am', date: today, startTime: '11:00',
      preServicePlaylistId: 'mock-pl-pre', postServicePlaylistId: 'mock-pl-post',
      autoStartTargetSec: 1800, status: 'scheduled', firstSongKey: 'D', setlist: [],
    },
  ];

  // Drop everything into the store. We bypass the persistence path —
  // mock mode never writes to config.json.
  const store = useAppStore.getState();
  store.setView('live');
  // Direct-set pattern — avoids the store's individual setters which
  // would each write to disk via saveConfig.
  useAppStore.setState({
    configLoaded: true,
    config: {
      ...store.config,
      tracks,
      playlists,
      services,
    },
    // Pretend the 9am service is armed + playing track 2.
    musicPlayback: {
      bus: 'music',
      isPlaying: true,
      trackId: 'mock-t2',
      filePath: tracks[1].filePath,
      positionSec: 47,
      durationSec: 269,
    },
    currentRunway: {
      serviceId: 'mock-svc-1',
      trackIds: tracks.slice(0, 4).map(t => t.id),
      totalSec: tracks.slice(0, 4).reduce((a, t) => a + t.durationSec, 0),
      landInKey: 'G',
      startOffsetSec: 0,
      targetMs: now + 22 * 60 * 1000,        // 22 min until service
      musicStartMs: now - 47_000,             // music started 47 sec ago
      padStartMs: now + 22 * 60 * 1000 - 5000,
      transitionMode: 'crossfade',
      crossfadeSec: 5,
      padBridgeSec: 10,
      padFadeOutSec: 5,
      tailSec: 0,
      phase: 'music',
      currentTrackIndex: 1,
      sourcePlaylistId: 'mock-pl-pre',
      armEpoch: 1,
    },
    padArmedKey: 'D',
  });

  console.log('[mock] Live preview state installed. ?mock=1');
}
