import type { AppConfig, Track, KeyName, PpRequest, PpResponse, RemoteNetworkInterface, MultitracksResult } from '@shared/types';

export {};

declare global {
  const __APP_VERSION__: string;

  interface Window {
    runway: {
      config: {
        get: () => Promise<AppConfig>;
        set: (config: AppConfig) => Promise<boolean>;
        export: () => Promise<{ ok: boolean; path?: string; reason?: string }>;
        import: () => Promise<{ ok: boolean; reason?: string }>;
      };
      files: {
        pickAudio: (multi?: boolean) => Promise<string[]>;
        pickFolder: () => Promise<string | null>;
        scanFolder: (folderPath: string) => Promise<Array<{ filePath: string; metadata: Partial<Track> }>>;
        readMetadata: (filePath: string) => Promise<Partial<Track>>;
        importFile: (srcPath: string) => Promise<string>;
        importPad: (srcPath: string) => Promise<string>;
        scanPadFolder: (
          folderPath: string,
          mode?: 'major' | 'minor' | null,
        ) => Promise<Array<{ filePath: string; key: KeyName }>>;
        iTunesArtLookup: (
          artist: string,
          title: string,
        ) => Promise<{ artworkUrl: string; albumName: string } | null>;
        iTunesCandidatesLookup: (
          artist: string,
          title: string,
        ) => Promise<Array<{ artworkUrl: string; albumName: string; artistName: string; trackName: string }>>;
        spotifyLookup: (
          artist: string,
          title: string,
          creds: { clientId: string; clientSecret: string },
        ) => Promise<{ key?: string; bpm?: number; albumArtUrl?: string; reason?: string } | null>;
        getsongbpmLookup: (
          artist: string,
          title: string,
          apiKey: string,
        ) => Promise<{ key?: string; bpm?: number; reason?: string } | null>;
        multitracksLookup: (
          artist: string,
          title: string,
          durationSec?: number,
        ) => Promise<MultitracksResult>;
        libraryPaths: () => Promise<{ audioDir: string; padsDir: string; userDataDir: string }>;
        revealFolder: (folderPath: string) => Promise<void>;
        writeWav: (req: { suggestedName: string; bytes: ArrayBuffer }) => Promise<string | null>;
      };
      audio: {
        listDevices: () => Promise<unknown[]>;
      };
      proPresenter: {
        request: (req: PpRequest) => Promise<PpResponse>;
      };
      remote: {
        pushSnapshot: (snap: unknown) => Promise<void>;
        lanUrls: () => Promise<{ urls: string[]; port: number }>;
        networkInterfaces: () => Promise<RemoteNetworkInterface[]>;
        onCommand: (callback: (cmd: { type: string; pct?: number; muted?: boolean; key?: string }) => void) => () => void;
      };
      app: {
        openChangelog: () => Promise<{ ok: boolean; reason?: string }>;
        onMenuNavigate: (callback: (path: string) => void) => () => void;
        onMenuOpenChangelog: (callback: () => void) => () => void;
        onMenuSyncNow: (callback: () => void) => () => void;
      };
      tray: {
        update: (snapshot: import('@shared/types').TraySnapshot) => void;
        onShowWindow: (callback: () => void) => () => void;
      };
    };
  }
}
