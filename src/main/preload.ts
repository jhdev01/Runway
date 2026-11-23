import { contextBridge, ipcRenderer } from 'electron';

// Inlined IPC channel names. Must match src/shared/types.ts exactly.
// Inlined here because Electron's sandboxed preload context cannot resolve
// relative imports the way regular Node modules can.
const IPC = {
  CONFIG_GET: 'config:get',
  CONFIG_SET: 'config:set',
  CONFIG_EXPORT: 'config:export',
  CONFIG_IMPORT: 'config:import',
  CONFIG_RELINK: 'config:relink',
  LIBRARY_EXPORT: 'library:export',
  LIBRARY_PREVIEW: 'library:preview',
  LIBRARY_IMPORT: 'library:import',
  FILE_PICK: 'file:pick',
  FOLDER_PICK: 'folder:pick',
  FOLDER_SCAN: 'folder:scan',
  TRACK_METADATA: 'track:metadata',
  FILE_IMPORT: 'file:import',
  PAD_IMPORT: 'pad:import',
  LIBRARY_PATHS: 'library:paths',
  REVEAL_FOLDER: 'shell:revealFolder',
  TRAY_UPDATE: 'tray:update',
  TRAY_SHOW_WINDOW: 'tray:showWindow',
  AUDIO_DEVICES_LIST: 'audio:devicesList',
  AUDIO_WRITE_WAV: 'audio:writeWav',
  PP_REQUEST: 'pp:request',
  PAD_FOLDER_SCAN: 'pad:folderScan',
  REMOTE_SNAPSHOT: 'remote:snapshot',
  REMOTE_LAN_URLS: 'remote:lanUrls',
  REMOTE_COMMAND: 'remote:command',
  REMOTE_NETWORK_INTERFACES: 'remote:networkInterfaces',
  OPEN_CHANGELOG: 'app:openChangelog',
  // Look up album art for a track via the iTunes Search API. No auth,
  // no rate limit beyond loose throttling. Used as a fallback when the
  // file has no embedded artwork.
  ITUNES_ART_LOOKUP: 'track:itunesArt',
  // Multi-candidate iTunes lookup — used by the artwork picker so the
  // operator can choose which release's cover to attach when several
  // are available.
  ITUNES_CANDIDATES_LOOKUP: 'track:itunesCandidates',
  // Spotify Web API track lookup — returns { key, mode, tempo,
  // albumArtUrl } when the track exists in their catalog.
  SPOTIFY_LOOKUP: 'track:spotify',
  // GetSongBPM API track lookup — free tier (5k/day) returns key + tempo.
  GETSONGBPM_LOOKUP: 'track:getsongbpm',
  TIMING_LOG_APPEND: 'timing:logAppend',
  TIMING_LOG_REVEAL: 'timing:logReveal',
  PCO_REQUEST: 'pco:request',
  SPOTIFY_TIMING_TEST: 'spotify:timingTest',
  SPOTIFY_CONNECT: 'spotify:connect',
  SPOTIFY_STATUS: 'spotify:status',
  SPOTIFY_DISCONNECT: 'spotify:disconnect',
  SPOTIFY_PLAYLIST_READ: 'spotify:playlistRead',
  SPOTIFY_PLAYER: 'spotify:player',
  SPOTIFY_PLAYLISTS_LIST: 'spotify:playlistsList',
  // MultiTracks.com song lookup — returns the published original master
  // key for worship songs, plus alternates when the catalog disagrees.
  MULTITRACKS_LOOKUP: 'track:multitracks',
} as const;

interface MtCandidate {
  key: string;
  title: string;
  artist: string;
  album: string;
  url: string;
  durationSec?: number;
  score: number;
}

contextBridge.exposeInMainWorld('runway', {
  config: {
    get: () => ipcRenderer.invoke(IPC.CONFIG_GET),
    set: (config: unknown) => ipcRenderer.invoke(IPC.CONFIG_SET, config),
    export: () => ipcRenderer.invoke(IPC.CONFIG_EXPORT),
    import: () => ipcRenderer.invoke(IPC.CONFIG_IMPORT),
    relink: (opts?: { extraFolders?: string[] }) => ipcRenderer.invoke(IPC.CONFIG_RELINK, opts),
    exportLibrary: () => ipcRenderer.invoke(IPC.LIBRARY_EXPORT),
    previewLibrary: () => ipcRenderer.invoke(IPC.LIBRARY_PREVIEW),
    importLibrary: (bundleDir: string, mode: string) =>
      ipcRenderer.invoke(IPC.LIBRARY_IMPORT, { bundleDir, mode }),
  },
  files: {
    pickAudio: (multi = true) => ipcRenderer.invoke(IPC.FILE_PICK, { multi }),
    pickFolder: () => ipcRenderer.invoke(IPC.FOLDER_PICK),
    scanFolder: (folderPath: string) => ipcRenderer.invoke(IPC.FOLDER_SCAN, folderPath),
    readMetadata: (filePath: string) => ipcRenderer.invoke(IPC.TRACK_METADATA, filePath),
    importFile: (srcPath: string) => ipcRenderer.invoke(IPC.FILE_IMPORT, srcPath),
    importPad: (srcPath: string) => ipcRenderer.invoke(IPC.PAD_IMPORT, srcPath),
    scanPadFolder: (folderPath: string, mode?: 'major' | 'minor' | null) =>
      ipcRenderer.invoke(IPC.PAD_FOLDER_SCAN, { folderPath, mode: mode ?? null }),
    iTunesArtLookup: (
      artist: string,
      title: string,
    ): Promise<{ artworkUrl: string; albumName: string } | null> =>
      ipcRenderer.invoke(IPC.ITUNES_ART_LOOKUP, { artist, title }),
    iTunesCandidatesLookup: (
      artist: string,
      title: string,
    ): Promise<{ artworkUrl: string; albumName: string; artistName: string; trackName: string }[]> =>
      ipcRenderer.invoke(IPC.ITUNES_CANDIDATES_LOOKUP, { artist, title }),
    spotifyLookup: (
      artist: string,
      title: string,
      creds: { clientId: string; clientSecret: string },
    ): Promise<{ key?: string; bpm?: number; albumArtUrl?: string; reason?: string } | null> =>
      ipcRenderer.invoke(IPC.SPOTIFY_LOOKUP, { artist, title, creds }),
    getsongbpmLookup: (
      artist: string,
      title: string,
      apiKey: string,
    ): Promise<{ key?: string; bpm?: number; reason?: string } | null> =>
      ipcRenderer.invoke(IPC.GETSONGBPM_LOOKUP, { artist, title, apiKey }),
    // Return shape mirrors MultitracksResult in main/multitracksLookup.ts.
    // Spelled out rather than imported: this file deliberately carries no
    // relative imports (see the IPC note above).
    multitracksLookup: (
      artist: string,
      title: string,
      durationSec?: number,
    ): Promise<{
      best?: MtCandidate;
      alternates: MtCandidate[];
      reason?: string;
    }> =>
      ipcRenderer.invoke(IPC.MULTITRACKS_LOOKUP, { artist, title, durationSec }),
    libraryPaths: () => ipcRenderer.invoke(IPC.LIBRARY_PATHS),
    revealFolder: (folderPath: string): Promise<void> =>
      ipcRenderer.invoke(IPC.REVEAL_FOLDER, folderPath),
    writeWav: (req: { suggestedName: string; bytes: ArrayBuffer }) =>
      ipcRenderer.invoke(IPC.AUDIO_WRITE_WAV, req),
  },
  audio: {
    listDevices: () => ipcRenderer.invoke(IPC.AUDIO_DEVICES_LIST),
  },
  // Experimental Spotify account link + playlist reader (read-only).
  spotify: {
    connect: (clientId: string) => ipcRenderer.invoke(IPC.SPOTIFY_CONNECT, clientId),
    status: () => ipcRenderer.invoke(IPC.SPOTIFY_STATUS),
    disconnect: () => ipcRenderer.invoke(IPC.SPOTIFY_DISCONNECT),
    readPlaylist: (link: string) => ipcRenderer.invoke(IPC.SPOTIFY_PLAYLIST_READ, link),
    player: (cmd: unknown) => ipcRenderer.invoke(IPC.SPOTIFY_PLAYER, cmd),
    listPlaylists: () => ipcRenderer.invoke(IPC.SPOTIFY_PLAYLISTS_LIST),
  },
  planningCenter: {
    request: (req: unknown) => ipcRenderer.invoke(IPC.PCO_REQUEST, req),
  },
  proPresenter: {
    request: (req: unknown) => ipcRenderer.invoke(IPC.PP_REQUEST, req),
  },
  remote: {
    pushSnapshot: (snap: unknown) => ipcRenderer.invoke(IPC.REMOTE_SNAPSHOT, snap),
    lanUrls: () => ipcRenderer.invoke(IPC.REMOTE_LAN_URLS),
    networkInterfaces: () => ipcRenderer.invoke(IPC.REMOTE_NETWORK_INTERFACES),
    onCommand: (callback: (cmd: { type: string; pct?: number; muted?: boolean; key?: string }) => void) => {
      const wrapped = (_e: unknown, cmd: { type: string; pct?: number; muted?: boolean; key?: string }) => callback(cmd);
      ipcRenderer.on(IPC.REMOTE_COMMAND, wrapped);
      return () => ipcRenderer.removeListener(IPC.REMOTE_COMMAND, wrapped);
    },
  },
  app: {
    openChangelog: () => ipcRenderer.invoke(IPC.OPEN_CHANGELOG),
    onMenuNavigate: (callback: (path: string) => void) => {
      const wrapped = (_e: unknown, path: string) => callback(path);
      ipcRenderer.on('menu:navigate', wrapped);
      return () => ipcRenderer.removeListener('menu:navigate', wrapped);
    },
    onMenuOpenChangelog: (callback: () => void) => {
      const wrapped = () => callback();
      ipcRenderer.on('menu:openChangelog', wrapped);
      return () => ipcRenderer.removeListener('menu:openChangelog', wrapped);
    },
    onMenuSyncNow: (callback: () => void) => {
      const wrapped = () => callback();
      ipcRenderer.on('menu:syncNow', wrapped);
      return () => ipcRenderer.removeListener('menu:syncNow', wrapped);
    },
  },
  tray: {
    update: (snapshot: unknown) => ipcRenderer.send(IPC.TRAY_UPDATE, snapshot),
    onShowWindow: (callback: () => void) => {
      const wrapped = () => callback();
      ipcRenderer.on(IPC.TRAY_SHOW_WINDOW, wrapped);
      return () => ipcRenderer.removeListener(IPC.TRAY_SHOW_WINDOW, wrapped);
    },
  },
  diagnostics: {
    // Fire-and-forget append of one timing line to timing.log (main owns
    // the file + rotation). One-way send so the hot path never awaits.
    appendTimingLog: (line: string) => ipcRenderer.send(IPC.TIMING_LOG_APPEND, line),
    // Open timing.log in the OS file browser for after-service review.
    revealTimingLog: () => ipcRenderer.invoke(IPC.TIMING_LOG_REVEAL),
    // Experimental Spotify landing-precision test (macOS only).
    spotifyTimingTest: (track?: string) => ipcRenderer.invoke(IPC.SPOTIFY_TIMING_TEST, track),
  },
});
