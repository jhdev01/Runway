import { app, BrowserWindow, ipcMain, dialog, protocol, shell, Tray, Menu, nativeImage } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import { ConfigStore } from './configStore';
import { scanFolder, scanPadFolder, readTrackMetadata } from './fileScanner';
import { IPC, type PpRequest, type PpResponse, type PcoRequest, type PcoResponse, type AppConfig, type TraySnapshot } from '../shared/types';
import { RemoteServer, listLanUrls, listNetworkInterfaces, type RemoteSnapshot } from './remoteServer';

const isDev = process.env.NODE_ENV === 'development';

// Force the app name so menu items ("Quit Runway", "About Runway") and the
// userData path (~/Library/Application Support/Runway) match the product
// name regardless of package.json's `name` field. Must run before any code
// that calls `app.getName()` or `app.getPath('userData')`.
app.setName('Runway');

// Last-ditch safety net for the multicast-dns send-error case. When a
// machine has no usable IPv4 interface (Wi-Fi off, ethernet unplugged,
// VPN routing oddly), `dgram.send` to 224.0.0.251:5353 fires
// EHOSTUNREACH / ENETUNREACH asynchronously inside the multicast-dns
// library. The library uses a noop callback so the error escapes its
// own `warning` event and bubbles up as an uncaught exception —
// Electron then throws the "Uncaught Exception:" dialog before the
// window even paints. These are non-fatal: the remote server still
// works on the bound IP; only the LAN `runway.local` hostname
// advertisement is degraded.
//
// Suppression strategy:
//   1. Use `prependListener` so this fires before Electron's default
//      uncaughtException handler (which is what shows the dialog).
//   2. Recognise mDNS-shaped errors by code AND message substring,
//      swallow them silently.
//   3. For real errors, fall through to default behaviour by re-
//      throwing in a microtask (synchronous throw would re-enter this
//      listener and loop).
const isMdnsLikeError = (err: NodeJS.ErrnoException | undefined): boolean => {
  if (!err) return false;
  const msg = err.message ?? '';
  if (msg.includes('224.0.0.251')) return true;
  if (msg.includes('5353')) return true;
  switch (err.code) {
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'EADDRNOTAVAIL':
    case 'ENETDOWN':
      return true;
    default:
      return false;
  }
};
process.prependListener('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (isMdnsLikeError(err)) {
    console.warn('[remote] mDNS send suppressed:', err.message);
    return;
  }
  // Real error — log here, but don't synchronously throw (would
  // re-enter this listener). Let the default handler still run.
  console.error('[main] uncaughtException', err);
});
process.on('unhandledRejection', (reason) => {
  if (isMdnsLikeError(reason as NodeJS.ErrnoException)) {
    console.warn('[remote] mDNS promise rejection suppressed:', reason);
    return;
  }
  console.error('[main] unhandledRejection', reason);
});

const config = new ConfigStore();

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
// Distinguishes "user clicked the X" (which should hide to tray) from
// "user picked Quit Runway" (which should actually exit). Flipped by
// the before-quit handler and the tray's Quit menu item.
let isQuitting = false;
// Most recent snapshot pushed from the renderer. Used to rebuild the
// tray context menu whenever it's invalidated (snapshot update, show/
// hide toggle, etc).
let lastTraySnapshot: TraySnapshot = {
  isArmed: false,
  statusLine: 'Runway',
  countdownLabel: null,
  upcomingLabels: [],
  nowPlayingLabel: null,
  tickerLabel: null,
};

// Register the custom protocol scheme as privileged BEFORE app.ready.
// This lets the renderer fetch local audio files via runway-audio:///path.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'runway-audio',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true,
      stream: true,
    },
  },
]);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#06090d',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The renderer owns the audio engine and the runway tick loop.
      // Chromium would normally throttle a hidden window — pausing
      // timers, slowing rAF — which can cause music start drift when
      // the operator closes the window to the tray. Keep full priority.
      backgroundThrottling: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    // __dirname at runtime is dist/main/main/, renderer is at dist/renderer/.
    mainWindow.loadFile(path.join(__dirname, '../../renderer/index.html'));
  }

  // Intercept the red close button: hide to tray instead of quitting.
  // before-quit flips isQuitting so Cmd+Q / Quit-from-tray bypass this.
  mainWindow.on('close', (e) => {
    if (!isQuitting && mainWindow) {
      e.preventDefault();
      mainWindow.hide();
      // On macOS, also hide from the Dock so the only entry-point left
      // is the tray icon. Comment this out to keep Dock presence.
      if (process.platform === 'darwin') app.dock?.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function showMainWindow() {
  if (!mainWindow) {
    createWindow();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
  if (process.platform === 'darwin') app.dock?.show();
}

function buildTrayMenu(): Menu {
  const s = lastTraySnapshot;
  const items: Electron.MenuItemConstructorOptions[] = [];

  // Status / countdown / upcoming items: kept "enabled" with no-op
  // click handlers so macOS doesn't grey out the text. Clicking them
  // just dismisses the menu, which is fine for status display.
  const statusItem = (label: string) => ({
    label,
    click: () => { /* no-op — display only */ },
  });

  items.push(statusItem(s.statusLine));

  // Live countdown / phase line.
  if (s.countdownLabel) {
    items.push(statusItem(s.countdownLabel));
  }

  // Now-playing line.
  if (s.nowPlayingLabel) {
    items.push({ type: 'separator' });
    items.push(statusItem(`♪  ${s.nowPlayingLabel}`));
  }

  // Upcoming services — header + each service on its own row.
  if (s.upcomingLabels.length > 0) {
    items.push({ type: 'separator' });
    items.push(statusItem('Today'));
    for (const line of s.upcomingLabels) {
      items.push(statusItem(`  ${line}`));
    }
  }

  items.push({ type: 'separator' });
  items.push({
    label: mainWindow && mainWindow.isVisible() ? 'Hide Runway' : 'Show Runway',
    click: () => {
      if (mainWindow && mainWindow.isVisible()) {
        mainWindow.hide();
        if (process.platform === 'darwin') app.dock?.hide();
      } else {
        showMainWindow();
      }
    },
  });
  items.push({
    label: 'Quit Runway',
    accelerator: 'CmdOrCtrl+Q',
    click: () => {
      isQuitting = true;
      app.quit();
    },
  });

  return Menu.buildFromTemplate(items);
}

function refreshTray() {
  if (!tray) return;
  tray.setContextMenu(buildTrayMenu());
  tray.setTitle(lastTraySnapshot.tickerLabel ?? '');
  tray.setToolTip(lastTraySnapshot.statusLine || 'Runway');
}

function createTray() {
  // On macOS the menu bar wants a template image (black-on-transparent)
  // that the OS tints automatically for light/dark mode. Windows has no
  // such mechanism, so we use the colored .ico instead — Windows picks
  // an appropriate size from the multi-resolution ICO for the tray.
  const isMac = process.platform === 'darwin';
  const iconFile = isMac ? 'trayTemplate.png' : 'icon.ico';
  const iconPath = path.join(__dirname, '..', '..', '..', 'build', iconFile);
  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    console.warn('[tray] icon not found at', iconPath, '— using empty placeholder');
    image = nativeImage.createEmpty();
  } else if (isMac) {
    image.setTemplateImage(true);
  }
  tray = new Tray(image);
  tray.setToolTip('Runway');
  tray.on('click', () => {
    // Default left-click behavior on macOS opens the context menu (set
    // via setContextMenu). On Windows/Linux, click toggles the window.
    if (process.platform !== 'darwin') {
      if (mainWindow?.isVisible()) {
        mainWindow.hide();
      } else {
        showMainWindow();
      }
    }
  });
  refreshTray();
}

/**
 * Build the application menu — replaces Electron's default (which is just
 * standard Edit operations) with one that surfaces Runway-specific
 * actions: About, Settings shortcut, What's Changed link, etc. Cross-
 * platform; the macOS app menu pulls items from the same template.
 */
function buildAppMenu(): Electron.Menu {
  const isMac = process.platform === 'darwin';
  const openChangelog = () => {
    // Reuse the same IPC handler the in-app "What's Changed" button uses.
    if (!mainWindow) return;
    mainWindow.webContents.send('menu:openChangelog');
  };
  const navigateTo = (path: string) => {
    if (!mainWindow) return;
    showMainWindow();
    mainWindow.webContents.send('menu:navigate', path);
  };

  const aboutItem: Electron.MenuItemConstructorOptions = {
    label: `About ${app.name}`,
    click: () => {
      const ver = app.getVersion();
      dialog.showMessageBox(mainWindow ?? undefined as unknown as BrowserWindow, {
        type: 'info',
        title: `About ${app.name}`,
        message: `${app.name} ${ver}`,
        detail: 'Worship audio control: scheduled pre-service music, key-aware playlist arrangement, pad player, MIDI integration with ProPresenter.\n\nCopyright © 2026 Grounded Labs Dev · groundedlabs.dev',
        buttons: ['OK'],
      });
    },
  };

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        aboutItem,
        { type: 'separator' as const },
        {
          label: 'Settings…',
          accelerator: 'Cmd+,',
          click: () => navigateTo('settings'),
        },
        { type: 'separator' as const },
        { role: 'services' as const },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        {
          label: `Quit ${app.name}`,
          accelerator: 'Cmd+Q',
          click: () => { isQuitting = true; app.quit(); },
        },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        ...(isMac ? [] : [
          {
            label: 'Settings…',
            accelerator: 'Ctrl+,',
            click: () => navigateTo('settings'),
          } as Electron.MenuItemConstructorOptions,
          { type: 'separator' as const },
        ]),
        isMac
          ? { role: 'close' as const }
          : { label: 'Quit', accelerator: 'Ctrl+Q', click: () => { isQuitting = true; app.quit(); } },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Live', accelerator: 'CmdOrCtrl+1', click: () => navigateTo('live') },
        { label: 'Schedule', accelerator: 'CmdOrCtrl+2', click: () => navigateTo('schedule') },
        { label: 'Playlists', accelerator: 'CmdOrCtrl+3', click: () => navigateTo('playlists') },
        { label: 'Library', accelerator: 'CmdOrCtrl+4', click: () => navigateTo('library') },
        { label: 'Actions', accelerator: 'CmdOrCtrl+5', click: () => navigateTo('actions') },
        { label: 'Editor', accelerator: 'CmdOrCtrl+6', click: () => navigateTo('editor') },
        { label: 'Settings', accelerator: 'CmdOrCtrl+7', click: () => navigateTo('settings') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [
          { type: 'separator' as const },
          { role: 'front' as const },
        ] : []),
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: "What's Changed", click: openChangelog },
        ...(isMac ? [] : [
          { type: 'separator' as const },
          aboutItem,
        ]),
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

app.whenReady().then(() => {
  // Register the protocol handler that maps runway-audio:// to local files
  protocol.handle('runway-audio', async (request) => {
    try {
      // Strip the scheme: runway-audio:///Users/foo/bar.mp3 -> /Users/foo/bar.mp3
      const u = new URL(request.url);
      // The pathname starts with '/' on macOS/Linux, which is what we want
      const filePath = decodeURIComponent(u.pathname);
      console.log('[protocol] serving', filePath);
      // Read the file directly with fs and return as a Response.
      // net.fetch on file:// URLs is blocked by Electron's security policy.
      const data = await fs.promises.readFile(filePath);
      // Detect content type from extension
      const ext = path.extname(filePath).toLowerCase();
      const contentType =
        ext === '.mp3' ? 'audio/mpeg' :
        ext === '.wav' ? 'audio/wav' :
        ext === '.aiff' || ext === '.aif' ? 'audio/aiff' :
        ext === '.flac' ? 'audio/flac' :
        ext === '.m4a' ? 'audio/mp4' :
        ext === '.ogg' ? 'audio/ogg' :
        'application/octet-stream';
      return new Response(data, {
        status: 200,
        headers: { 'Content-Type': contentType },
      });
    } catch (err) {
      console.error('[protocol] failed to handle', request.url, err);
      return new Response('Not found', { status: 404 });
    }
  });

  registerIpcHandlers();
  startRemoteServer();
  createWindow();
  createTray();
  Menu.setApplicationMenu(buildAppMenu());
  app.on('activate', () => {
    // Clicking the dock icon (or re-launching) — bring the window
    // back even if it was hidden to tray, rather than creating a
    // duplicate. Only spawn fresh when the window's been destroyed.
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
    } else if (!mainWindow.isVisible()) {
      showMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // Don't quit on window-all-closed — the tray icon keeps Runway
  // alive in the background. The Quit menu item flips isQuitting so
  // a real quit gets through.
  if (process.platform !== 'darwin' && isQuitting) app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  remoteServer?.stop();
  tray?.destroy();
  tray = null;
});

let remoteServer: RemoteServer | null = null;

function startRemoteServer() {
  // Read once at startup; later config edits trigger updateConfig via IPC
  // (so a port change restarts the listener).
  const cfg = config.read();
  remoteServer = new RemoteServer(cfg.remote);
  remoteServer.onCommand((cmd) => {
    // Forward to renderer; engines.tsx subscribes and dispatches into
    // the controller so remote commands run through the same code paths
    // as the desktop UI buttons.
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.REMOTE_COMMAND, cmd);
    }
  });
  remoteServer.start();
}

function registerIpcHandlers() {
  ipcMain.handle(IPC.CONFIG_GET, () => config.read());

  ipcMain.handle(IPC.CONFIG_SET, (_e, next: AppConfig) => {
    config.write(next);
    // Forward the remote slice so a port change restarts the listener.
    if (next.remote) remoteServer?.updateConfig(next.remote);
    return true;
  });

  // Export the current config.json to a user-chosen location. Used to
  // migrate setup (playlists, services, MIDI bindings, PP, defaults) to
  // another machine. Audio files are NOT copied — those live in
  // userData/audio and userData/pads and the user re-imports them
  // manually after restoring.
  ipcMain.handle(IPC.CONFIG_EXPORT, async (): Promise<{ ok: boolean; path?: string; reason?: string }> => {
    if (!mainWindow) return { ok: false, reason: 'No window' };
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Runway config',
      defaultPath: `runway-config-${stamp}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, reason: 'Cancelled' };
    try {
      const json = JSON.stringify(config.read(), null, 2);
      await fs.promises.writeFile(result.filePath, json, 'utf8');
      return { ok: true, path: result.filePath };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: msg };
    }
  });

  // Import a previously-exported config.json. Replaces the current config
  // wholesale (after a confirm dialog). The renderer reloads its store
  // from the new file. Audio file paths in the imported config may not
  // exist on this machine — those tracks will show as "missing" in the
  // playlist UI until re-imported.
  ipcMain.handle(IPC.CONFIG_IMPORT, async (): Promise<{ ok: boolean; reason?: string }> => {
    if (!mainWindow) return { ok: false, reason: 'No window' };
    const open = await dialog.showOpenDialog(mainWindow, {
      title: 'Import Runway config',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (open.canceled || open.filePaths.length === 0) return { ok: false, reason: 'Cancelled' };
    const srcPath = open.filePaths[0];
    let parsed: unknown;
    try {
      const raw = await fs.promises.readFile(srcPath, 'utf8');
      parsed = JSON.parse(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `Couldn't read file: ${msg}` };
    }
    // Quick shape check — must be an object with the fields a Runway
    // config has. Catches obvious wrong-file mistakes early.
    if (
      !parsed
      || typeof parsed !== 'object'
      || !Array.isArray((parsed as { playlists?: unknown }).playlists)
      || !Array.isArray((parsed as { tracks?: unknown }).tracks)
    ) {
      return { ok: false, reason: 'File doesn\'t look like a Runway config (missing playlists/tracks).' };
    }
    const confirm = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Replace config', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Import Runway config',
      message: 'Replace your current Runway config?',
      detail: 'This overwrites every setting — playlists, services, MIDI bindings, ProPresenter setup, and defaults — with the imported file. Audio files are not affected. Tracks whose file paths don\'t exist on this machine will show as missing until re-imported.',
    });
    if (confirm.response !== 0) return { ok: false, reason: 'Cancelled' };
    // Stash a timestamped backup of the current config before overwriting,
    // in case the import was a mistake.
    try {
      const backup = config.getPath() + '.bak-' + Date.now();
      await fs.promises.copyFile(config.getPath(), backup);
    } catch {
      // Backup is best-effort. If the current file doesn't exist, just proceed.
    }
    try {
      config.write(parsed as AppConfig);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: msg };
    }
  });

  ipcMain.handle(IPC.FILE_PICK, async (_e, opts: { multi?: boolean }) => {
    if (!mainWindow) return [];
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: opts?.multi
        ? ['openFile', 'multiSelections']
        : ['openFile'],
      filters: [
        { name: 'Audio', extensions: ['mp3', 'wav', 'aiff', 'aif', 'flac', 'm4a', 'ogg'] },
      ],
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle(IPC.FOLDER_PICK, async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle(IPC.FOLDER_SCAN, async (_e, folderPath: string) => {
    return await scanFolder(folderPath);
  });

  ipcMain.handle(IPC.TRACK_METADATA, async (_e, filePath: string) => {
    return await readTrackMetadata(filePath);
  });

  ipcMain.handle(IPC.ITUNES_ART_LOOKUP, async (_e, args: { artist?: string; title?: string }) => {
    const artist = (args?.artist ?? '').trim();
    const title = (args?.title ?? '').trim();
    if (!title) return null;
    return await iTunesArtLookup(artist, title);
  });

  ipcMain.handle(IPC.ITUNES_CANDIDATES_LOOKUP, async (_e, args: { artist?: string; title?: string }) => {
    const artist = (args?.artist ?? '').trim();
    const title = (args?.title ?? '').trim();
    if (!title) return [];
    return await iTunesCandidatesLookup(artist, title);
  });

  ipcMain.handle(IPC.SPOTIFY_LOOKUP, async (_e, args: {
    artist?: string;
    title?: string;
    creds?: { clientId?: string; clientSecret?: string };
  }) => {
    const artist = (args?.artist ?? '').trim();
    const title = (args?.title ?? '').trim();
    const clientId = args?.creds?.clientId?.trim();
    const clientSecret = args?.creds?.clientSecret?.trim();
    if (!title) return { reason: 'No title provided' };
    if (!clientId || !clientSecret) return { reason: 'Spotify credentials not configured' };
    return await spotifyLookup(artist, title, clientId, clientSecret);
  });

  ipcMain.handle(IPC.GETSONGBPM_LOOKUP, async (_e, args: {
    artist?: string;
    title?: string;
    apiKey?: string;
  }) => {
    const artist = (args?.artist ?? '').trim();
    const title = (args?.title ?? '').trim();
    const apiKey = (args?.apiKey ?? '').trim();
    if (!title) return { reason: 'No title provided' };
    if (!apiKey) return { reason: 'GetSongBPM API key not configured' };
    return await getsongbpmLookup(artist, title, apiKey);
  });

  ipcMain.handle(IPC.FILE_IMPORT, async (_e, srcPath: string) => {
    return await importAudioFile(srcPath, 'audio');
  });

  ipcMain.handle(IPC.PAD_IMPORT, async (_e, srcPath: string) => {
    return await importAudioFile(srcPath, 'pads');
  });

  ipcMain.handle(IPC.PAD_FOLDER_SCAN, async (_e, args: { folderPath: string; mode?: 'major' | 'minor' | null } | string) => {
    // Backwards-compat: also accept a bare folderPath string.
    if (typeof args === 'string') return await scanPadFolder(args);
    return await scanPadFolder(args.folderPath, args.mode ?? null);
  });

  ipcMain.handle(IPC.LIBRARY_PATHS, async () => {
    const userDataDir = app.getPath('userData');
    return {
      userDataDir,
      audioDir: path.join(userDataDir, 'audio'),
      padsDir: path.join(userDataDir, 'pads'),
    };
  });

  ipcMain.handle(IPC.REVEAL_FOLDER, async (_e, folderPath: string) => {
    // Ensure the folder exists before revealing — if Runway hasn't
    // imported any audio yet, the audio dir may not exist on disk.
    try { fs.mkdirSync(folderPath, { recursive: true }); } catch {}
    await shell.openPath(folderPath);
  });

  // ---- Persistent service-timing log ----
  // The renderer mirrors its timing-tagged console logs here so the
  // operator can review what happened during a service without keeping
  // DevTools open. Lives next to config.json.
  const timingLogPath = path.join(app.getPath('userData'), 'timing.log');
  // Local-time stamp (operator timezone) — UTC would make a Sunday-morning
  // service read as a different day in the log.
  const localStamp = (): string => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  ipcMain.on(IPC.TIMING_LOG_APPEND, (_e, line: unknown) => {
    if (typeof line !== 'string') return;
    try {
      // Light rotation: keep one backup so the file can't grow without
      // bound across months of services. Timing lines are tiny, so 2 MB
      // already holds a very long history.
      try {
        const st = fs.statSync(timingLogPath);
        if (st.size > 2 * 1024 * 1024) {
          fs.renameSync(timingLogPath, timingLogPath + '.1');
        }
      } catch { /* file doesn't exist yet — fine */ }
      void fs.promises.appendFile(timingLogPath, `${localStamp()}  ${line}\n`, 'utf8')
        .catch(err => console.warn('[timing-log] append failed', err));
    } catch (err) {
      console.warn('[timing-log] append failed', err);
    }
  });
  ipcMain.handle(IPC.TIMING_LOG_REVEAL, async () => {
    try {
      // Create an empty file if nothing's been logged yet so the reveal
      // doesn't fail on a fresh install.
      if (!fs.existsSync(timingLogPath)) {
        fs.writeFileSync(timingLogPath, '', 'utf8');
      }
      shell.showItemInFolder(timingLogPath);
      return { ok: true, path: timingLogPath };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  });

  // Renderer pushes tray-relevant state on store changes. Main caches
  // the latest snapshot and rebuilds the tray menu so it reflects the
  // current armed service, countdown, upcoming services, etc.
  ipcMain.on(IPC.TRAY_UPDATE, (_e, snapshot: TraySnapshot) => {
    lastTraySnapshot = snapshot;
    refreshTray();
  });

  ipcMain.handle(IPC.AUDIO_WRITE_WAV, async (_e, req: { suggestedName: string; bytes: ArrayBuffer }) => {
    if (!mainWindow) return null;
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save edited audio',
      defaultPath: req.suggestedName,
      filters: [{ name: 'WAV', extensions: ['wav'] }],
    });
    if (result.canceled || !result.filePath) return null;
    await fs.promises.writeFile(result.filePath, Buffer.from(req.bytes));
    return result.filePath;
  });

  // Audio device enumeration is done in renderer via navigator.mediaDevices,
  // but we expose this as an empty handler for future native enumeration if needed.
  ipcMain.handle(IPC.AUDIO_DEVICES_LIST, async () => {
    return [];
  });

  // Remote server bridge: renderer pushes runway state snapshots and main
  // broadcasts them to all WS clients. Also serves up the LAN URLs the
  // mobile remote should use.
  ipcMain.handle(IPC.REMOTE_SNAPSHOT, async (_e, snap: RemoteSnapshot): Promise<void> => {
    remoteServer?.pushSnapshot(snap);
  });

  ipcMain.handle(IPC.REMOTE_LAN_URLS, async (): Promise<{ urls: string[]; port: number }> => {
    const cfg = config.read();
    return {
      urls: listLanUrls(cfg.remote.port, cfg.remote.bindHost),
      port: cfg.remote.port,
    };
  });

  ipcMain.handle(IPC.REMOTE_NETWORK_INTERFACES, async () => {
    return listNetworkInterfaces();
  });

  // Open the bundled changelog page in the user's default browser. The
  // packaged source path lives inside `app.asar`, which the OS / browser
  // can't read directly via file:// — only Electron's patched fs can.
  // So copy the file out to a real disk location under tmpdir first,
  // then point the browser at that. Works identically in dev and
  // packaged because fs.copyFileSync transparently handles asar paths.
  ipcMain.handle(IPC.OPEN_CHANGELOG, async () => {
    const candidates = [
      path.resolve(__dirname, '../../remote/changelog.html'),     // packaged dist
      path.resolve(app.getAppPath(), 'dist/remote/changelog.html'), // dev/built
      path.resolve(app.getAppPath(), 'src/remote/changelog.html'),  // dev source
    ];
    const src = candidates.find(p => {
      try { return fs.existsSync(p); }
      catch { return false; }
    });
    if (!src) return { ok: false, reason: 'changelog file not found' };
    const os = require('os') as typeof import('os');
    const tmpDir = path.join(os.tmpdir(), 'runway-changelog');
    try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}
    const dst = path.join(tmpDir, 'changelog.html');
    try {
      fs.copyFileSync(src, dst);
    } catch (err) {
      return { ok: false, reason: `couldn't stage changelog: ${(err as Error).message}` };
    }
    // pathToFileURL handles platform differences (Windows backslashes +
    // drive letters → file:///C:/...); a naive 'file://' + encodeURI(path)
    // works on macOS but produces a malformed URL on Windows that
    // shell.openExternal silently rejects.
    const { pathToFileURL } = require('url') as typeof import('url');
    const fileUrl = pathToFileURL(dst).toString();
    await shell.openExternal(fileUrl);
    return { ok: true };
  });

  // ProPresenter Network API proxy. Renderer can't talk to PP directly because
  // the API doesn't return CORS headers; we forward via Node's http module.
  ipcMain.handle(IPC.PP_REQUEST, async (_e, req: PpRequest): Promise<PpResponse> => {
    return new Promise<PpResponse>(resolve => {
      const bodyStr = req.body !== undefined ? JSON.stringify(req.body) : undefined;
      const headers: Record<string, string> = {
        'Accept': 'application/json',
      };
      if (bodyStr !== undefined) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
      }
      if (req.password) {
        headers['Authorization'] = `Bearer ${req.password}`;
      }
      const opts: http.RequestOptions = {
        hostname: req.host,
        port: req.port,
        path: req.path,
        method: req.method,
        headers,
        timeout: req.timeoutMs ?? 4000,
      };
      const r = http.request(opts, res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          resolve({
            ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      });
      r.on('error', err => {
        resolve({ ok: false, status: 0, body: '', error: err.message });
      });
      r.on('timeout', () => {
        r.destroy(new Error('timeout'));
      });
      if (bodyStr !== undefined) r.write(bodyStr);
      r.end();
    });
  });

  // Planning Center API proxy. Renderer can't call api.planningcenteronline.com
  // directly (CORS), so main forwards the GET over HTTPS with HTTP Basic auth
  // built from the Personal Access Token (appId:secret). Read-only.
  ipcMain.handle(IPC.PCO_REQUEST, async (_e, req: PcoRequest): Promise<PcoResponse> => {
    return new Promise<PcoResponse>(resolve => {
      const auth = Buffer.from(`${req.appId}:${req.secret}`).toString('base64');
      const opts: https.RequestOptions = {
        hostname: 'api.planningcenteronline.com',
        port: 443,
        path: req.path,
        method: 'GET',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Accept': 'application/json',
          'User-Agent': 'Runway',
        },
        timeout: req.timeoutMs ?? 8000,
      };
      const r = https.request(opts, res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          resolve({
            ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      });
      r.on('error', err => resolve({ ok: false, status: 0, body: '', error: err.message }));
      r.on('timeout', () => r.destroy(new Error('timeout')));
      r.end();
    });
  });
}

/**
 * Copy a source audio file into a managed subdirectory of userData/.
 * Idempotent: re-importing the same file returns the existing dest. Filename
 * collisions with different content get suffixed (-1, -2, …).
 */
async function importAudioFile(srcPath: string, subdir: 'audio' | 'pads' = 'audio'): Promise<string> {
  if (!fs.existsSync(srcPath)) throw new Error(`Source not found: ${srcPath}`);
  const audioDir = path.join(app.getPath('userData'), subdir);
  if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });

  // If the source is already inside the library, no-op.
  if (path.normalize(srcPath).startsWith(path.normalize(audioDir) + path.sep)) {
    return srcPath;
  }

  const baseName = path.basename(srcPath);
  const ext = path.extname(baseName);
  const stem = baseName.slice(0, baseName.length - ext.length);
  const safeStem = stem.replace(/[^a-zA-Z0-9._\- ]/g, '_').slice(0, 200);
  const safeName = safeStem + ext.toLowerCase();

  const srcStat = await fs.promises.stat(srcPath);
  let candidate = path.join(audioDir, safeName);
  let n = 1;

  while (fs.existsSync(candidate)) {
    const dstStat = await fs.promises.stat(candidate);
    // Same size = assume same file; reuse existing dest.
    if (dstStat.size === srcStat.size) return candidate;
    // Different file with same name — bump suffix and try again.
    candidate = path.join(audioDir, `${safeStem}-${n}${ext.toLowerCase()}`);
    n++;
  }

  await fs.promises.copyFile(srcPath, candidate);
  return candidate;
}

/**
 * iTunes Search API fallback for album art. Free, no auth, works for
 * almost everything popular. Returns a `data:image/jpeg;base64,...`
 * URL or null when no match.
 *
 * Strategy:
 *   1. Search by artist+title (most precise).
 *   2. Substitute the default 100x100 artwork URL for 600x600bb.jpg
 *      (Apple supports this URL trick for higher-resolution).
 *   3. Fetch the image bytes, return as a data URL so the renderer
 *      can store it on the Track without dealing with file paths or
 *      the runway-audio:// protocol.
 *
 * Failures are logged and return null — the track keeps its empty
 * `albumArtUrl` and the UI renders the ♪ placeholder. We never throw
 * to the renderer because callers loop through many tracks and one
 * miss shouldn't abort the batch.
 */
// ─── Spotify Web API ────────────────────────────────────────────────
//
// Client-Credentials flow (no user OAuth — server-to-server). Token
// lasts 1 hour; we cache and refresh when expired. Lookup chain per
// track: search by artist+title → take first hit → fetch audio-features
// for tempo/key/mode. Returns parsed key + BPM + (optional) art.
//
// Why no user OAuth: Client-Credentials gives access to public catalog
// endpoints (search, audio-features, audio-analysis), which is all we
// need. Saves the user from a redirect-URI dance.

interface SpotifyToken { value: string; expiresAt: number; }
const spotifyTokenCache = new Map<string, SpotifyToken>();
const spotifyResultCache = new Map<string, SpotifyLookupResult>();

interface SpotifyLookupResult {
  key?: string;
  bpm?: number;
  albumArtUrl?: string;
  reason?: string;
}

const SPOTIFY_KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const ENH_MAJ: Record<string, string> = { 'C#': 'Db', 'D#': 'Eb', 'F#': 'F#', 'G#': 'Ab', 'A#': 'Bb' };
const ENH_MIN: Record<string, string> = { 'A#m': 'Bbm' };

async function getSpotifyToken(clientId: string, clientSecret: string): Promise<string | null> {
  const cacheKey = clientId;
  const cached = spotifyTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.value;
  try {
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.warn('[spotify] token fetch failed:', res.status, await res.text().catch(() => ''));
      return null;
    }
    const json = await res.json() as { access_token: string; expires_in: number };
    const tok: SpotifyToken = {
      value: json.access_token,
      expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    };
    spotifyTokenCache.set(cacheKey, tok);
    return tok.value;
  } catch (err) {
    console.warn('[spotify] token error:', err);
    return null;
  }
}

async function spotifyLookup(
  artist: string,
  title: string,
  clientId: string,
  clientSecret: string,
): Promise<SpotifyLookupResult> {
  const cacheKey = `${artist.toLowerCase()}|${title.toLowerCase()}|${clientId}`;
  const cached = spotifyResultCache.get(cacheKey);
  if (cached) return cached;

  const token = await getSpotifyToken(clientId, clientSecret);
  if (!token) {
    const r: SpotifyLookupResult = { reason: 'Could not authenticate with Spotify — check credentials' };
    spotifyResultCache.set(cacheKey, r);
    return r;
  }

  try {
    // Search — quoted artist + title gives Spotify a hint to score
    // exact matches higher than fuzzy ones. Cap the term length so
    // longer parenthetical suffixes ("(Live)", "(Acoustic)", etc.)
    // don't kill the match.
    const term = encodeURIComponent([artist, title].filter(Boolean).join(' ').slice(0, 200));
    const searchRes = await fetch(
      `https://api.spotify.com/v1/search?q=${term}&type=track&limit=3`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) },
    );
    if (!searchRes.ok) {
      const r: SpotifyLookupResult = { reason: `Spotify search failed (${searchRes.status})` };
      spotifyResultCache.set(cacheKey, r);
      return r;
    }
    const search = await searchRes.json() as {
      tracks?: { items?: Array<{
        id: string;
        name: string;
        artists: { name: string }[];
        album: { images: { url: string; height: number }[] };
      }> };
    };
    const items = search.tracks?.items ?? [];
    if (items.length === 0) {
      const r: SpotifyLookupResult = { reason: 'No Spotify match' };
      spotifyResultCache.set(cacheKey, r);
      return r;
    }
    // Best match: prefer entries whose artist contains our query'd artist
    // (case-insensitive). Falls back to first result if nothing matches.
    const lowerArtist = artist.toLowerCase();
    const best = items.find(it => it.artists.some(a => a.name.toLowerCase().includes(lowerArtist)))
      ?? items[0];

    const featRes = await fetch(
      `https://api.spotify.com/v1/audio-features/${best.id}`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) },
    );
    if (!featRes.ok) {
      const r: SpotifyLookupResult = { reason: `audio-features failed (${featRes.status})` };
      spotifyResultCache.set(cacheKey, r);
      return r;
    }
    const feat = await featRes.json() as { key?: number; mode?: number; tempo?: number };

    const result: SpotifyLookupResult = {};
    if (typeof feat.tempo === 'number' && feat.tempo > 0) {
      result.bpm = Math.round(feat.tempo);
    }
    if (typeof feat.key === 'number' && feat.key >= 0 && feat.key < 12) {
      const sharp = SPOTIFY_KEYS[feat.key];
      if (feat.mode === 1) {
        // Major — convert sharps to flats per project canon.
        result.key = ENH_MAJ[sharp] ?? sharp;
      } else if (feat.mode === 0) {
        // Minor — append "m", normalize A#m → Bbm.
        const minorRaw = sharp + 'm';
        result.key = ENH_MIN[minorRaw] ?? minorRaw;
      }
    }

    // Album art — biggest available image, usually 640px.
    const images = best.album.images ?? [];
    if (images.length > 0) {
      const sorted = [...images].sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
      try {
        const imgRes = await fetch(sorted[0].url, { signal: AbortSignal.timeout(8000) });
        if (imgRes.ok) {
          const ab = await imgRes.arrayBuffer();
          const buf = Buffer.from(ab);
          const mime = imgRes.headers.get('content-type') || 'image/jpeg';
          result.albumArtUrl = `data:${mime};base64,${buf.toString('base64')}`;
        }
      } catch { /* ignore */ }
    }

    console.log(
      `[spotify] "${best.artists[0]?.name} — ${best.name}":`,
      result.key ?? '?',
      result.bpm ? `${result.bpm} BPM` : '',
      result.albumArtUrl ? `art ${Math.round(result.albumArtUrl.length / 1024)}KB` : '',
    );
    spotifyResultCache.set(cacheKey, result);
    return result;
  } catch (err) {
    console.warn('[spotify] lookup error:', err);
    return { reason: String(err) };
  }
}

// ─── GetSongBPM API ─────────────────────────────────────────────────
//
// Free tier: 5,000 lookups/day, attribution required ("Powered by
// getsongbpm.com" — surfaced in the Settings panel). Returns tempo
// + key per matching song. Smaller catalog than Spotify but covers
// the bulk of CCM / worship tracks.
//
// Endpoint shape:
//   https://api.getsongbpm.com/search/?api_key=KEY&type=both&lookup=song:TITLE+artist:ARTIST
// Returns { search: [ { song_title, tempo, key_of, ... } ] }.
//
// We take the first result and parse `tempo` (string number) and
// `key_of` (e.g. "G", "F#m"). The project's KeyName uses sharp/flat
// canonicals, so we normalize via the same enharmonic maps the
// fileScanner uses.

interface GetsongbpmResult {
  key?: string;
  bpm?: number;
  reason?: string;
}
const getsongbpmCache = new Map<string, GetsongbpmResult>();

const GSB_ENH_MAJOR: Record<string, string> = {
  'C#': 'Db', 'D#': 'Eb', 'F#': 'F#', 'G#': 'Ab', 'A#': 'Bb',
};
const GSB_ENH_MINOR: Record<string, string> = {
  'A#m': 'Bbm',
};

function normalizeGsbKey(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  // GetSongBPM returns formats like "G", "F#m", "Bbm". Lowercase 'm'
  // signals minor. Normalize through the project's enharmonic maps.
  const isMinor = /m$/.test(trimmed);
  const root = isMinor ? trimmed.slice(0, -1) : trimmed;
  if (isMinor) {
    return GSB_ENH_MINOR[trimmed] ?? trimmed;
  }
  return GSB_ENH_MAJOR[root] ?? root;
}

async function getsongbpmLookup(
  artist: string,
  title: string,
  apiKey: string,
): Promise<GetsongbpmResult> {
  const cacheKey = `${artist.toLowerCase()}|${title.toLowerCase()}|${apiKey}`;
  const cached = getsongbpmCache.get(cacheKey);
  if (cached) return cached;

  try {
    // Clean up common ID3-tag noise that hurts matching:
    //   "I'm So Blessed - Best Day Remix" → "I'm So Blessed"
    //   "Echo (Live)" → "Echo"
    //   "Yet (feat. Hillsong Worship)" → "Yet"
    //   "Title - Single Version" → "Title"
    // GetSongBPM's catalog uses canonical song titles; remix/live/feat
    // suffixes on the search query routinely return zero results.
    const cleanTitle = title
      .replace(/\s*\([^)]*\)\s*$/g, '')          // trailing parentheticals
      .replace(/\s*\[[^\]]*\]\s*$/g, '')         // trailing bracketed
      .replace(/\s+-\s+(remix|live|acoustic|version|edit|mix|extended|radio|single|feat\.?|featuring).*$/i, '')
      .trim() || title;
    const cleanArtist = artist
      .replace(/\s*\(feat\.?[^)]*\)/gi, '')
      .replace(/\s*\bfeat\.?\b.*$/i, '')
      .trim() || artist;

    // type=both with the `song:TITLE artist:ARTIST` lookup format lets
    // the server narrow to the right recording instead of grabbing
    // whatever song with that title is most popular (worship covers
    // share titles with secular tracks all the time). Falls back to
    // title-only when there's no artist on the file.
    const lookup = cleanArtist
      ? `song:${cleanTitle} artist:${cleanArtist}`
      : `song:${cleanTitle}`;
    const searchType = cleanArtist ? 'both' : 'song';
    const url = `https://api.getsong.co/search/?api_key=${encodeURIComponent(apiKey)}&type=${searchType}&lookup=${encodeURIComponent(lookup)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      const r: GetsongbpmResult = { reason: `GetSongBPM HTTP ${res.status}` };
      getsongbpmCache.set(cacheKey, r);
      return r;
    }
    interface GsbHit {
      song_title?: string;
      tempo?: string | number;
      key_of?: string;
      artist?: { name?: string };
    }
    const json = await res.json() as {
      // On hit `search` is an array of GsbHit; on miss it's an object
      // like `{ error: "..." }`. We handle both shapes below — without
      // this guard the previous code crashed with "Cannot read tempo
      // of undefined" because hits[0] resolved to undefined when the
      // server returned the error-object form.
      search?: GsbHit[] | { error?: string };
      error?: string;
    };
    if (json.error) {
      const r: GetsongbpmResult = { reason: `GetSongBPM: ${json.error}` };
      getsongbpmCache.set(cacheKey, r);
      return r;
    }
    const raw = json.search;
    let hits: GsbHit[] = [];
    if (Array.isArray(raw)) {
      hits = raw;
    } else if (raw && typeof raw === 'object' && 'error' in raw && raw.error) {
      const r: GetsongbpmResult = { reason: `GetSongBPM: ${raw.error}` };
      getsongbpmCache.set(cacheKey, r);
      return r;
    }
    // Fallback: if type=both returned nothing, retry as title-only
    // type=song. Catches the case where the artist filter was too
    // strict (e.g. file artist "CAIN" but catalog has "Cain").
    if (hits.length === 0 && searchType === 'both') {
      const fallbackUrl = `https://api.getsong.co/search/?api_key=${encodeURIComponent(apiKey)}&type=song&lookup=${encodeURIComponent(cleanTitle)}`;
      const fr = await fetch(fallbackUrl, { signal: AbortSignal.timeout(8000) });
      if (fr.ok) {
        const fjson = await fr.json() as { search?: GsbHit[] | { error?: string } };
        if (Array.isArray(fjson.search)) hits = fjson.search;
      }
    }
    if (hits.length === 0) {
      const r: GetsongbpmResult = { reason: 'No GetSongBPM match' };
      getsongbpmCache.set(cacheKey, r);
      return r;
    }
    // Score each hit by artist similarity. Require at least a partial
    // artist match before accepting key/BPM — without this, "I'm So
    // Blessed" by some random pop artist could overwrite the CAIN
    // version's key. Falls back to first hit only when nothing in the
    // candidate list looks artist-similar.
    const lowerArtist = cleanArtist.toLowerCase();
    const tokens = lowerArtist.split(/\s+/).filter(t => t.length >= 3);
    const artistMatch = lowerArtist
      ? hits.find(h => {
          const n = (h.artist?.name ?? '').toLowerCase();
          if (!n) return false;
          if (n.includes(lowerArtist) || lowerArtist.includes(n)) return true;
          // Token overlap — handles "CAIN" vs "Cain Officially" etc.
          return tokens.some(t => n.includes(t));
        })
      : undefined;
    const best = artistMatch ?? hits[0];

    // If we asked for an artist but couldn't find ANY hit whose artist
    // contained any of our query tokens, refuse the result rather than
    // applying a stranger's track's key. The audio analyzer + manual
    // editor are better fallbacks than confidently wrong data.
    if (lowerArtist && !artistMatch) {
      const r: GetsongbpmResult = {
        reason: `GetSongBPM: matched "${best.artist?.name ?? '?'} — ${best.song_title ?? '?'}" but artist doesn't match query "${artist}" — refused`,
      };
      console.log('[getsongbpm]', r.reason);
      getsongbpmCache.set(cacheKey, r);
      return r;
    }
    const result: GetsongbpmResult = {};
    if (best.tempo != null) {
      const n = Number(best.tempo);
      if (!isNaN(n) && n >= 30 && n <= 300) result.bpm = Math.round(n);
    }
    if (best.key_of) {
      const k = normalizeGsbKey(best.key_of);
      if (k) result.key = k;
    }
    console.log(
      `[getsongbpm] "${artist} — ${title}" → "${best.artist?.name ?? '?'} — ${best.song_title ?? '?'}":`,
      result.key ?? '?',
      result.bpm ? `${result.bpm} BPM` : '',
    );
    getsongbpmCache.set(cacheKey, result);
    return result;
  } catch (err) {
    console.warn('[getsongbpm] lookup error:', err);
    return { reason: String(err) };
  }
}

/**
 * Single-best-match iTunes lookup used by the auto-refresh path.
 * Returns the 600x600 artwork as a data URL plus the matched album
 * name so callers can auto-fill missing album metadata. Cached per
 * (artist|title) for the lifetime of the main process.
 */
type ITunesMatch = { artworkUrl: string; albumName: string };
// Positive cache only — misses (network failure, rate limit, no
// match) are NOT cached, so the next refresh re-attempts. Caching
// nulls turned a transient blip into permanent missing art with no
// way to recover short of restarting the app.
const iTunesCache = new Map<string, ITunesMatch>();
async function iTunesArtLookup(artist: string, title: string): Promise<ITunesMatch | null> {
  const cacheKey = `${artist.toLowerCase()}|${title.toLowerCase()}`;
  const cached = iTunesCache.get(cacheKey);
  if (cached) return cached;
  try {
    const term = encodeURIComponent([artist, title].filter(Boolean).join(' ').slice(0, 200));
    const url = `https://itunes.apple.com/search?term=${term}&entity=song&limit=1`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const json = await res.json() as { results?: { artworkUrl100?: string; collectionName?: string }[] };
    const top = json.results?.[0];
    const small = top?.artworkUrl100;
    if (!small) return null;
    const big = small.replace('100x100bb', '600x600bb');
    const imgRes = await fetch(big, { signal: AbortSignal.timeout(8000) });
    if (!imgRes.ok) return null;
    const ab = await imgRes.arrayBuffer();
    const buf = Buffer.from(ab);
    const mime = imgRes.headers.get('content-type') || 'image/jpeg';
    const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
    const match: ITunesMatch = { artworkUrl: dataUrl, albumName: top?.collectionName ?? '' };
    iTunesCache.set(cacheKey, match);
    console.log(`[itunes] art for "${artist} - ${title}" — ${Math.round(buf.length / 1024)}KB · ${match.albumName}`);
    return match;
  } catch (err) {
    console.warn('[itunes] lookup failed', err);
    return null;
  }
}

/**
 * Multi-candidate iTunes lookup for the artwork picker. Returns up to
 * 8 distinct (album, artist) results — same song often shows up across
 * studio / live / deluxe / compilation releases, and the operator
 * picks which cover they want stored on the track.
 *
 * Each candidate's 600x600 image is fetched and inlined as a data URL
 * because the renderer's CSP blocks remote img sources. This is
 * relatively expensive (8 × ~50KB) but only runs when the user opens
 * the picker explicitly, so it stays out of the auto-refresh hot path.
 */
type ITunesCandidate = {
  artworkUrl: string;
  albumName: string;
  artistName: string;
  trackName: string;
};
async function iTunesCandidatesLookup(artist: string, title: string): Promise<ITunesCandidate[]> {
  try {
    const term = encodeURIComponent([artist, title].filter(Boolean).join(' ').slice(0, 200));
    const url = `https://itunes.apple.com/search?term=${term}&entity=song&limit=20`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const json = await res.json() as {
      results?: { artworkUrl100?: string; collectionName?: string; artistName?: string; trackName?: string }[];
    };
    const results = json.results ?? [];
    // Dedupe by (artist | album) so we don't show 3 identical thumbnails
    // when a song appears multiple times on the same record.
    const seen = new Set<string>();
    const unique: typeof results = [];
    for (const r of results) {
      const k = `${(r.artistName ?? '').toLowerCase()}|${(r.collectionName ?? '').toLowerCase()}`;
      if (seen.has(k)) continue;
      seen.add(k);
      unique.push(r);
      if (unique.length >= 8) break;
    }
    const out: ITunesCandidate[] = [];
    for (const r of unique) {
      const small = r.artworkUrl100;
      if (!small) continue;
      try {
        const big = small.replace('100x100bb', '600x600bb');
        const imgRes = await fetch(big, { signal: AbortSignal.timeout(8000) });
        if (!imgRes.ok) continue;
        const ab = await imgRes.arrayBuffer();
        const buf = Buffer.from(ab);
        const mime = imgRes.headers.get('content-type') || 'image/jpeg';
        const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
        out.push({
          artworkUrl: dataUrl,
          albumName: r.collectionName ?? '',
          artistName: r.artistName ?? '',
          trackName: r.trackName ?? '',
        });
      } catch { /* skip this candidate */ }
    }
    console.log(`[itunes] ${out.length} candidates for "${artist} - ${title}"`);
    return out;
  } catch (err) {
    console.warn('[itunes] candidates lookup failed', err);
    return [];
  }
}
