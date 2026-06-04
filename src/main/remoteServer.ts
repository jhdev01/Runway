import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WebSocketServer, WebSocket } from 'ws';
import { app } from 'electron';
import { Bonjour, type Service as BonjourService } from 'bonjour-service';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const makeMdns: () => MdnsInstance = require('multicast-dns');
interface MdnsQuery { questions: { name: string; type: string }[]; }
interface MdnsAnswer { name: string; type: string; ttl: number; data: string; }
interface MdnsInstance {
  on(event: 'query', cb: (q: MdnsQuery) => void): void;
  on(event: 'warning', cb: (err: unknown) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  respond(p: { answers: MdnsAnswer[] }): void;
  destroy(cb?: () => void): void;
}
import type { RemoteConfig, RemoteNetworkInterface } from '../shared/types';

// Fixed mDNS hostname so a phone PWA bookmarked at `http://runway.local:7811`
// works against ANY Mac running Runway on the same Wi-Fi — not just the
// one it was originally installed from. Bonjour resolves this to whatever
// machine is currently broadcasting it. iOS / Android resolve `.local`
// natively. Conflict resolution: if two Macs run Runway on the same
// network simultaneously, mDNS will append "(2)" automatically — that's
// expected; teams typically run one host at a time.
const MDNS_HOSTNAME = 'runway';

/**
 * Snapshot of runway state pushed to remote clients. Mirrors what the
 * mobile UI's main.js consumes — keep both sides aligned.
 */
export interface RemoteSnapshot {
  // What service is currently focused on the desktop UI ("active" — the
  // upcoming or running service today). Null when no service applies.
  activeService: {
    id: string;
    name?: string;
    date: string;
    startTime: string;
    status: string;
    targetMs: number;       // service start in epoch ms
  } | null;
  // Runway state — the auto-arrange runtime that drives music + pad.
  runway: {
    serviceId: string | null;
    phase: 'queued' | 'music' | 'pad' | 'done';
    isPostService?: boolean;
    targetMs: number;       // service start (= 0 for QuickPlay/post-service)
    musicStartMs: number;
    padStartMs: number;
    padBridgeSec: number;
    padFadeOutSec: number;
    skipPadBridge?: boolean;
    // Derived clock-time for "pad fully off" — only set when not skipped
    // and a real service runway is rolling. Pre-computed here so the
    // remote doesn't have to know the math.
    padOffMs: number;
    // For post-service playlist runways: when the audio actually ends.
    postEndMs: number;
  } | null;
  // Now-playing track summary for the music bus.
  nowPlaying: {
    title?: string;
    artist?: string;
    positionSec: number;
    durationSec: number;
    // Album art as a data: URL so the remote can render it inline
    // without round-tripping through HTTP. Only set when the playing
    // track has embedded artwork.
    albumArtUrl?: string;
  } | null;
  // Next track in the runway after the currently-playing one (if any).
  // Shown as "Up next" on the remote.
  nextTrack: {
    title?: string;
    artist?: string;
  } | null;
  // Whether a real service is currently armed (for the Arm/Disarm
  // button label) and whether the confirm-disarm 3s window is open
  // (for the red-flash second-click warning, mirroring the desktop).
  armed: boolean;
  armConfirmDisarm: boolean;
  // Whether the pad bus is currently audible — drives the Pad Play /
  // Pad Stop toggle button.
  padPlaying: boolean;
  // Master fader 0..100 % — drives the remote's volume slider so the
  // phone reflects the desktop master level and changes from either
  // surface stay in sync.
  masterPct: number;
  masterMuted: boolean;
  // Currently-armed pad key (e.g. "C", "F#m") so the remote's key
  // picker can highlight which one is selected; null when nothing's
  // armed yet. `padKeysAvailable` is the set of keys the user has
  // mapped pads to — drives which buttons in the picker are enabled.
  padArmedKey: string | null;
  padKeysAvailable: string[];
  // True when Fade-to-Pad is engaged. Drives the remote's button
  // visual state (pulsing pink when active, label flips to
  // "Music Back In") and toggles its tap behavior so the operator
  // can recover from the same surface they triggered from.
  fadeToPadActive: boolean;
  // Engine status lights (mirror the desktop top bar).
  status: {
    // 'on' = connected + enabled, 'off' = disabled, 'absent' = no devices.
    midi: 'on' | 'off' | 'absent';
    // ProPresenter heartbeat: 'ok' | 'err' | 'unknown' | 'disabled'.
    pp: 'ok' | 'err' | 'unknown' | 'disabled';
    // Audio bus is live when music or pad is playing.
    audio: 'on' | 'off';
  };
  // Compact recent MIDI log for the remote's MIDI monitor — last ~50
  // entries trimmed to the fields the mobile UI actually renders.
  recentMidi: Array<{
    ts: number;
    dir: 'in' | 'out';
    ch: number;
    type: string;
    d1: number;
    d2: number;
    device?: string;
    action?: string;
  }>;
  // Server timestamp — clients can compare to local Date.now() to detect
  // stale snapshots (we push every ~100ms; missing more than ~500ms means
  // something is wrong).
  serverTimeMs: number;
}

/** Subset of remote-control commands the server forwards to the renderer. */
export type RemoteCommand =
  | { type: 'arm_toggle' }
  | { type: 'panic' }
  | { type: 'start_music_early' }
  | { type: 'start_post_service' }
  | { type: 'pad_play' }
  | { type: 'pad_stop' }
  | { type: 'shuffle' }
  // Push the active service start time back by 2 minutes (also updates
  // the linked ProPresenter timer via the runway's targetMs).
  | { type: 'extend_back' }
  // Pull the active service start time in by 2 minutes.
  | { type: 'extend_forward' }
  // Master fader slider on the remote. pct is 0..100.
  | { type: 'set_master_volume'; pct: number }
  | { type: 'set_master_mute'; muted: boolean }
  // Skip backward / forward through the post-service playlist.
  | { type: 'prev_track' }
  | { type: 'next_track' }
  // Arm a pad key from the remote (e.g. "C", "F#m"). Sets the
  // currently-armed key without firing — operator hits Pad Play
  // separately. If the key passed isn't in the pad bank the
  // controller falls back to the closest mapped key.
  | { type: 'set_pad_key'; key: string }
  // Fade-to-pad — fade music to silence (without stopping) and hold
  // on a key-matched pad. Soft alternative to full panic.
  | { type: 'fade_to_pad' }
  // Wipe the MIDI activity log. Fired from the remote's Clear button
  // next to "View all" in the MIDI Activity panel.
  | { type: 'clear_midi_log' };

type CommandListener = (cmd: RemoteCommand) => void;

interface ClientState {
  unlocked: boolean;
  unlockedAt: number;     // ms timestamp of last successful unlock
  lastActivityAt: number; // refreshed on each command — drives auto-relock
  failedAttempts: number;
  lockoutUntilMs: number; // 0 = no lockout
  autoRelockTimer: NodeJS.Timeout | null;
  // Filled by ping/pong heartbeat — set to true on pong, set to false at
  // the start of each ping cycle. A client that misses a pong gets
  // terminated so the phone reconnects fresh.
  isAlive: boolean;
  // ms timestamp when this client connected. Heartbeat skips clients
  // that are still inside their grace window so iOS Safari isn't
  // ping-killed during initial handshake settle.
  connectedAt: number;
}

/**
 * LAN remote-control server. Always-on while the app runs. HTTP serves the
 * static mobile-friendly client (src/remote, copied to dist/remote at
 * build time); WS broadcasts state snapshots and accepts commands.
 *
 * Authentication: this slice is preview-only — clients can connect and
 * read state freely. Slice 2 introduces a 4-digit PIN that gates command
 * messages from each WS client.
 */
export class RemoteServer {
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private port: number;
  private pin: string;
  private autoRelockSec: number;
  private bindHost: string;
  private staticRoot: string;
  private latestSnapshot: RemoteSnapshot | null = null;
  private commandListeners: Set<CommandListener> = new Set();
  private clients: WeakMap<WebSocket, ClientState> = new WeakMap();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private bonjour: Bonjour | null = null;
  private bonjourService: BonjourService | null = null;
  private mdns: MdnsInstance | null = null;
  // On macOS, the system mDNSResponder daemon owns UDP port 5353 and any
  // user-space mDNS lib (multicast-dns, bonjour-service) silently fails
  // to bind when other apps (Spotify, Chrome) have grabbed it too. We
  // fall back to spawning the system `dns-sd` CLI, which talks to
  // mDNSResponder via its native API — bypasses the port conflict entirely.
  private dnssdProc: import('child_process').ChildProcess | null = null;
  private dnssdProxyProc: import('child_process').ChildProcess | null = null;

  // Lockout policy: 5 wrong PIN tries → 30-second freeze on that client.
  private static MAX_FAILED_ATTEMPTS = 5;
  private static LOCKOUT_MS = 30_000;
  // Ping each client every 30s. Phones backgrounding the browser
  // (especially iOS Safari) often leave a half-open TCP socket; without
  // a ping, the server keeps thinking the client is connected long after
  // the phone has lost the connection.
  private static HEARTBEAT_MS = 30_000;

  constructor(initialConfig: RemoteConfig) {
    this.port = initialConfig.port;
    this.pin = initialConfig.pin;
    this.autoRelockSec = initialConfig.autoRelockSec;
    this.bindHost = normalizeBindHost(initialConfig.bindHost);
    this.staticRoot = resolveRemoteStaticRoot();
  }

  start(): void {
    if (this.server) return;
    this.server = http.createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, socket, head) => {
      // Only upgrade /ws — anything else 404s on http.
      const url = new URL(req.url || '/', 'http://localhost');
      const remote = `${(req.socket.remoteAddress || '?').replace(/^::ffff:/, '')}`;
      if (url.pathname !== '/ws') {
        console.log(`[remote] upgrade rejected — bad path "${url.pathname}" from ${remote}`);
        socket.destroy();
        return;
      }
      console.log(`[remote] upgrade /ws from ${remote}`);
      this.wss!.handleUpgrade(req, socket, head, (client) => {
        console.log(`[remote] ws connected ${remote}`);
        this.wss!.emit('connection', client, req);
      });
    });

    this.wss.on('connection', (client) => {
      // Initialize per-client auth state (locked by default).
      this.clients.set(client, {
        unlocked: false,
        unlockedAt: 0,
        lastActivityAt: 0,
        failedAttempts: 0,
        lockoutUntilMs: 0,
        autoRelockTimer: null,
        isAlive: true,
        connectedAt: Date.now(),
      });
      // Pong handler — refresh liveness flag.
      client.on('pong', () => {
        const st = this.clients.get(client);
        if (st) st.isAlive = true;
      });
      // Send the latest snapshot immediately so the UI doesn't sit empty
      // until the next push tick.
      if (this.latestSnapshot) {
        this.sendSnapshotTo(client, this.latestSnapshot);
      }
      client.on('message', (data) => this.handleClientMessage(client, data));
      client.on('close', () => {
        const st = this.clients.get(client);
        if (st?.autoRelockTimer) clearTimeout(st.autoRelockTimer);
        this.clients.delete(client);
      });
    });

    this.server.on('error', (err) => {
      console.warn('[remote] http server error', err);
    });

    // Resilient bind: if the persisted bindHost references an IP that
    // doesn't currently exist on this Mac (NIC unplugged, jumped to a
    // new network, VPN dropped), fall back to 0.0.0.0 for this session
    // so the remote keeps working. The config's bindHost stays as-is so
    // the operator's choice survives — they can fix it from Settings
    // when they're back on the right network.
    let actualBindHost = this.bindHost;
    if (actualBindHost && actualBindHost !== '0.0.0.0') {
      const present = Object.values(os.networkInterfaces())
        .some(list => list?.some(i => i.family === 'IPv4' && i.address === actualBindHost));
      if (!present) {
        console.warn(`[remote] bindHost ${actualBindHost} not found on any active interface, falling back to 0.0.0.0`);
        actualBindHost = '0.0.0.0';
      }
    }

    this.server.listen(this.port, actualBindHost, () => {
      const urls = listLanUrls(this.port, actualBindHost);
      console.log('[remote] listening on', urls.length ? urls : `http://localhost:${this.port}`);
      // Publish a fixed mDNS hostname (`runway.local`) so phone bookmarks
      // resolve to whichever Mac is currently running Runway. Done after
      // the HTTP server is listening so the phone never sees an
      // advertised service that isn't yet answering.
      this.publishMdns();
    });

    // Start ping/pong heartbeat to detect half-open sockets.
    this.heartbeatTimer = setInterval(() => this.runHeartbeat(), RemoteServer.HEARTBEAT_MS);
  }

  private publishMdns(): void {
    // Two layers:
    //
    // 1. `multicast-dns` directly answering A queries for `runway.local`.
    //    bonjour-service alone publishes the SRV/PTR records for the
    //    service but doesn't serve an A record for a custom hostname,
    //    so iOS resolution of `runway.local` fails. This responder
    //    fixes that — we listen for "A? runway.local" queries and
    //    reply with whichever non-loopback IPv4 address this Mac is
    //    using right now.
    //
    // 2. Bonjour service publish for `_http._tcp` so the mDNS browser
    //    surfaces "Runway" as a discovered network service (handy for
    //    debugging with apps like Discovery DNS Browser, and for
    //    future PWA-side LAN discovery).
    try {
      const targetName = `${MDNS_HOSTNAME}.local`;
      this.mdns = makeMdns();
      this.mdns.on('warning', (err) => console.warn('[remote] mDNS warning:', err));
      // The mdns instance also emits 'error' for socket-level failures
      // (EACCES, EADDRINUSE). Without a listener, EventEmitter throws
      // an uncaught error and crashes the main process. We swallow
      // these — remote server still works on the bound IP even if
      // mDNS is fully broken.
      this.mdns.on('error', (err: Error) => console.warn('[remote] mDNS error swallowed:', err.message));
      this.mdns.on('query', (q: MdnsQuery) => {
        for (const question of q.questions) {
          // Match runway.local (and the trailing-dot form some clients
          // use). Type 'A' for IPv4; 'ANY' covers some iOS firmwares.
          const isMatch = (question.name === targetName || question.name === `${targetName}.`)
            && (question.type === 'A' || question.type === 'ANY');
          if (!isMatch) continue;
          const ip = this.getActiveIPv4();
          if (!ip) continue;
          try {
            this.mdns?.respond({
              answers: [{
                name: targetName,
                type: 'A',
                ttl: 60,
                data: ip,
              }],
            });
          } catch (err) {
            console.warn('[remote] mDNS respond failed:', err);
          }
        }
      });
      console.log(`[remote] mDNS A-record responder up for ${targetName} → ${this.getActiveIPv4() ?? '(no IPv4 yet)'}`);
    } catch (err) {
      console.warn('[remote] multicast-dns init failed:', err);
    }

    try {
      this.bonjour = new Bonjour();
      this.bonjourService = this.bonjour.publish({
        name: 'Runway',
        type: 'http',
        port: this.port,
        host: MDNS_HOSTNAME,
        txt: { app: 'runway' },
      });
      console.log(`[remote] Bonjour service published: http://${MDNS_HOSTNAME}.local:${this.port}`);
    } catch (err) {
      console.warn('[remote] Bonjour publish failed:', err);
    }

    // macOS fallback: spawn `dns-sd` so the publish goes through the
    // system mDNSResponder. Without this the userspace mDNS libs above
    // get silenced when Spotify/Chrome are also bound to port 5353.
    if (process.platform === 'darwin') {
      this.publishMdnsViaDnsSd();
    }
  }

  /**
   * Publish the service + A record using macOS's native `dns-sd` tool.
   * Two child processes:
   *   1. `dns-sd -R Runway _http._tcp . <port> app=runway`
   *      Registers the SRV/PTR/TXT records for service discovery.
   *   2. `dns-sd -P runway _http._tcp . <port> runway.local <ip> app=runway`
   *      Proxy-publish — registers an A record so `runway.local`
   *      resolves to our IP. This is what makes
   *      `http://runway.local:7811` work from any phone/tablet on
   *      the LAN regardless of which Mac is currently the host.
   * Both processes are kept alive for the lifetime of the remote server
   * and killed in `unpublishMdns()`.
   */
  private publishMdnsViaDnsSd(): void {
    const { spawn } = require('child_process') as typeof import('child_process');
    const ip = this.getActiveIPv4();
    if (!ip) {
      console.warn('[remote] no IPv4 — skipping dns-sd publish');
      return;
    }
    try {
      this.dnssdProc = spawn(
        'dns-sd',
        ['-R', 'Runway', '_http._tcp', '.', String(this.port), 'app=runway'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      this.dnssdProc.on('error', err =>
        console.warn('[remote] dns-sd -R failed to spawn:', (err as Error).message));
      console.log(`[remote] dns-sd -R Runway _http._tcp :${this.port} (pid ${this.dnssdProc.pid})`);
    } catch (err) {
      console.warn('[remote] dns-sd -R spawn threw:', err);
    }
    try {
      this.dnssdProxyProc = spawn(
        'dns-sd',
        ['-P', MDNS_HOSTNAME, '_http._tcp', '.', String(this.port), `${MDNS_HOSTNAME}.local`, ip, 'app=runway'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      this.dnssdProxyProc.on('error', err =>
        console.warn('[remote] dns-sd -P failed to spawn:', (err as Error).message));
      console.log(`[remote] dns-sd -P runway.local → ${ip}:${this.port} (pid ${this.dnssdProxyProc.pid})`);
    } catch (err) {
      console.warn('[remote] dns-sd -P spawn threw:', err);
    }
  }

  /** Pick the IPv4 address `runway.local` should resolve to. Honors the
   *  configured bind host when set; otherwise picks the first
   *  non-loopback IPv4 (matching what the desktop UI would show in
   *  Settings → Remote). */
  private getActiveIPv4(): string | null {
    if (this.bindHost && this.bindHost !== '0.0.0.0' && this.bindHost !== '') {
      return this.bindHost;
    }
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const info of ifaces[name] ?? []) {
        if (info.family === 'IPv4' && !info.internal) return info.address;
      }
    }
    return null;
  }

  private unpublishMdns(): void {
    if (this.bonjourService) {
      try { this.bonjourService.stop?.(() => undefined); } catch {}
      this.bonjourService = null;
    }
    if (this.bonjour) {
      try { this.bonjour.destroy(); } catch {}
      this.bonjour = null;
    }
    if (this.mdns) {
      try { this.mdns.destroy(); } catch {}
      this.mdns = null;
    }
    if (this.dnssdProc) {
      try { this.dnssdProc.kill('SIGTERM'); } catch {}
      this.dnssdProc = null;
    }
    if (this.dnssdProxyProc) {
      try { this.dnssdProxyProc.kill('SIGTERM'); } catch {}
      this.dnssdProxyProc = null;
    }
  }

  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.wss) {
      for (const c of this.wss.clients) {
        try { c.close(); } catch {}
      }
      this.wss.close();
      this.wss = null;
    }
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this.unpublishMdns();
  }

  /**
   * Walk every connected client. Anything that didn't pong since last tick
   * is presumed dead — terminate it so the phone's auto-reconnect kicks in.
   * Then ping the survivors and clear their isAlive flag for next round.
   *
   * Skips clients younger than the heartbeat interval — iOS Safari can
   * take a few seconds to fully settle a fresh WS, and a ping during
   * that window has been observed to cause a "connect → server thinks
   * it's stale → terminate" loop on first page load.
   */
  private runHeartbeat(): void {
    if (!this.wss) return;
    const now = Date.now();
    for (const client of this.wss.clients) {
      const st = this.clients.get(client);
      if (!st) continue;
      if (now - st.connectedAt < RemoteServer.HEARTBEAT_MS) continue;
      if (!st.isAlive) {
        try { client.terminate(); } catch {}
        continue;
      }
      st.isAlive = false;
      try { client.ping(); } catch {}
    }
  }

  /** Push a fresh snapshot to all connected clients. */
  pushSnapshot(snap: RemoteSnapshot): void {
    this.latestSnapshot = snap;
    if (!this.wss) return;
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        this.sendSnapshotTo(client, snap);
      }
    }
  }

  /**
   * Build the per-client state envelope (snapshot + the client's own
   * unlock flag) and send it. Each connected client may have a different
   * unlocked status, so we build one payload per client per tick.
   */
  private sendSnapshotTo(client: WebSocket, snap: RemoteSnapshot): void {
    const st = this.clients.get(client);
    const payload = { ...snap, unlocked: !!st?.unlocked };
    try {
      client.send(JSON.stringify({ type: 'state', payload }));
    } catch { /* client gone */ }
  }

  /** Register a command listener — engines.tsx wires this to the controller. */
  onCommand(listener: CommandListener): () => void {
    this.commandListeners.add(listener);
    return () => this.commandListeners.delete(listener);
  }

  /** Apply a config update — restarts the server if port or bind host changed. */
  updateConfig(next: RemoteConfig): void {
    this.pin = next.pin;
    // Auto-relock window changed: existing connected/unlocked clients
    // continue under the previous timer, but new unlocks use the new
    // value. (Simpler than rescheduling every active timer.)
    this.autoRelockSec = next.autoRelockSec;
    const nextBindHost = normalizeBindHost(next.bindHost);
    if (next.port !== this.port || nextBindHost !== this.bindHost) {
      this.port = next.port;
      this.bindHost = nextBindHost;
      this.stop();
      this.start();
    }
  }

  /** Currently advertised LAN URLs (filtered to bindHost when applicable). */
  getLanUrls(): string[] {
    return listLanUrls(this.port, this.bindHost);
  }

  // ---- private ----

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!req.url) {
      res.writeHead(400);
      res.end();
      return;
    }
    // Map "/" → /index.html. Refuse traversal.
    let urlPath = req.url.split('?')[0];
    if (urlPath === '/') urlPath = '/index.html';
    const safe = path.posix.normalize(urlPath).replace(/^(\.\.[\\/])+/g, '');
    const filePath = path.join(this.staticRoot, safe);
    if (!filePath.startsWith(this.staticRoot)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      // Aggressive no-cache: the remote is small and changes often
      // (especially during dev). Chrome / Safari were caching stale
      // index.html and main.js across sessions, so phones kept seeing
      // the previous build's UI even after the operator updated. Sub-
      // second LAN reloads make caching unnecessary anyway.
      res.writeHead(200, {
        'Content-Type': contentTypeFor(filePath),
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      });
      res.end(data);
    });
  }

  private handleClientMessage(client: WebSocket, raw: import('ws').RawData): void {
    let parsed: unknown;
    try { parsed = JSON.parse(raw.toString()); }
    catch { return; }
    if (!parsed || typeof parsed !== 'object') return;
    const msg = parsed as { type?: string; pin?: string; cmd?: string; payload?: unknown };
    if (typeof msg.type !== 'string') return;

    if (msg.type === 'unlock') {
      this.handleUnlock(client, typeof msg.pin === 'string' ? msg.pin : '');
      return;
    }
    if (msg.type === 'lock') {
      this.handleLock(client);
      return;
    }
    if (msg.type === 'cmd') {
      this.handleCommand(client, typeof msg.cmd === 'string' ? msg.cmd : '', msg.payload);
      return;
    }
    // Unknown type — ignore.
  }

  private handleUnlock(client: WebSocket, pin: string): void {
    const st = this.clients.get(client);
    if (!st) return;
    const now = Date.now();
    // Lockout check
    if (st.lockoutUntilMs > now) {
      const seconds = Math.ceil((st.lockoutUntilMs - now) / 1000);
      this.sendAuth(client, false, `Too many wrong PINs — try again in ${seconds}s.`);
      return;
    }
    if (pin === this.pin) {
      st.unlocked = true;
      st.unlockedAt = now;
      st.lastActivityAt = now;
      st.failedAttempts = 0;
      this.scheduleAutoRelock(client);
      this.sendAuth(client, true);
      // Push fresh state so the unlocked flag propagates immediately.
      if (this.latestSnapshot) this.sendSnapshotTo(client, this.latestSnapshot);
    } else {
      st.failedAttempts += 1;
      if (st.failedAttempts >= RemoteServer.MAX_FAILED_ATTEMPTS) {
        st.lockoutUntilMs = now + RemoteServer.LOCKOUT_MS;
        st.failedAttempts = 0;
        const seconds = Math.ceil(RemoteServer.LOCKOUT_MS / 1000);
        this.sendAuth(client, false, `Locked for ${seconds}s after too many wrong PINs.`);
      } else {
        const left = RemoteServer.MAX_FAILED_ATTEMPTS - st.failedAttempts;
        this.sendAuth(client, false, `Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left.`);
      }
    }
  }

  private handleLock(client: WebSocket): void {
    const st = this.clients.get(client);
    if (!st) return;
    st.unlocked = false;
    if (st.autoRelockTimer) {
      clearTimeout(st.autoRelockTimer);
      st.autoRelockTimer = null;
    }
    this.sendAuth(client, false);
    if (this.latestSnapshot) this.sendSnapshotTo(client, this.latestSnapshot);
  }

  private handleCommand(client: WebSocket, cmd: string, payload?: unknown): void {
    const st = this.clients.get(client);
    if (!st || !st.unlocked) {
      this.sendAuth(client, false, 'Locked — enter PIN first.');
      return;
    }
    // Whitelist of commands we forward. Anything else is rejected so we
    // can grow the surface deliberately rather than accidentally exposing
    // every action.
    const valid: RemoteCommand['type'][] = [
      'arm_toggle',
      'panic',
      'start_music_early',
      'start_post_service',
      'pad_play',
      'pad_stop',
      'shuffle',
      'extend_back',
      'extend_forward',
      'set_master_volume',
      'set_master_mute',
      'prev_track',
      'next_track',
      'set_pad_key',
      'fade_to_pad',
      'clear_midi_log',
    ];
    if (!valid.includes(cmd as RemoteCommand['type'])) return;
    st.lastActivityAt = Date.now();
    this.scheduleAutoRelock(client);
    let command: RemoteCommand;
    if (cmd === 'set_master_volume') {
      const p = (payload && typeof payload === 'object') ? (payload as { pct?: unknown }) : {};
      const pct = typeof p.pct === 'number' ? Math.max(0, Math.min(100, p.pct)) : 100;
      command = { type: 'set_master_volume', pct };
    } else if (cmd === 'set_master_mute') {
      const p = (payload && typeof payload === 'object') ? (payload as { muted?: unknown }) : {};
      command = { type: 'set_master_mute', muted: !!p.muted };
    } else if (cmd === 'set_pad_key') {
      const p = (payload && typeof payload === 'object') ? (payload as { key?: unknown }) : {};
      const key = typeof p.key === 'string' ? p.key : '';
      if (!key) return;
      command = { type: 'set_pad_key', key };
    } else {
      command = { type: cmd } as RemoteCommand;
    }
    for (const listener of this.commandListeners) {
      try { listener(command); }
      catch (err) { console.warn('[remote] command listener threw', err); }
    }
  }

  private sendAuth(client: WebSocket, unlocked: boolean, error?: string): void {
    try {
      client.send(JSON.stringify({
        type: 'auth-result',
        payload: { unlocked, error },
      }));
    } catch { /* client gone */ }
  }

  /**
   * Reset the auto-relock timer for this client. Activity refreshes it;
   * autoRelockSec === 0 disables auto-relock entirely.
   */
  private scheduleAutoRelock(client: WebSocket): void {
    const st = this.clients.get(client);
    if (!st) return;
    if (st.autoRelockTimer) {
      clearTimeout(st.autoRelockTimer);
      st.autoRelockTimer = null;
    }
    if (this.autoRelockSec <= 0) return;
    st.autoRelockTimer = setTimeout(() => {
      const cur = this.clients.get(client);
      if (!cur) return;
      cur.unlocked = false;
      cur.autoRelockTimer = null;
      this.sendAuth(client, false);
      if (this.latestSnapshot) this.sendSnapshotTo(client, this.latestSnapshot);
    }, this.autoRelockSec * 1000);
  }
}

/**
 * Resolve where the static remote files live. In dev they're in
 * src/remote/ (relative to project root). When packaged they're copied
 * to dist/remote/ next to dist/main/.
 */
function resolveRemoteStaticRoot(): string {
  // __dirname at runtime is dist/main/main/ in dev, or
  // <App>/Resources/app.asar/dist/main/main/ in packaged builds.
  // Both share the same relative layout: dist/remote/ is two levels up.
  // In dev the source files are three levels up at <root>/src/remote/
  // and we prefer those so HTML/CSS edits land instantly. The bundled
  // dist/remote/ (only present after `npm run package`) is the fallback
  // and the canonical path in packaged builds.
  if (!app.isPackaged) {
    const devSrc = path.resolve(__dirname, '../../../src/remote');
    if (fs.existsSync(devSrc)) return devSrc;
  }
  const packaged = path.resolve(__dirname, '../../remote');
  return packaged;
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js':   return 'application/javascript; charset=utf-8';
    case '.css':  return 'text/css; charset=utf-8';
    case '.svg':  return 'image/svg+xml';
    case '.png':  return 'image/png';
    case '.json': return 'application/json; charset=utf-8';
    default:      return 'application/octet-stream';
  }
}

/**
 * Discover URLs the LAN can reach this server on. Returns the
 * mDNS hostname URL first (macOS publishes `[hostname].local`
 * via mDNSResponder by default — iOS/Android resolve it natively),
 * then per-interface IPv4 URLs as fallback. The hostname URL is
 * the one to prefer for QR codes / PWA install because it survives
 * DHCP IP changes on the host machine.
 *
 * When a specific bind host is in use, return only the matching IP —
 * the server isn't actually listening on the other interfaces, so
 * advertising them would confuse the phone.
 */
export function listLanUrls(port: number, bindHost?: string): string[] {
  const out: string[] = [];
  const filter = bindHost && bindHost !== '0.0.0.0' && bindHost !== '' ? bindHost : null;

  // Fixed mDNS hostname — `runway.local` resolves to whichever Mac is
  // currently running Runway on the LAN (we publish this name on
  // startup via Bonjour). The phone bookmark stays the same regardless
  // of which laptop is hosting, so the operator can carry the same
  // PWA install across home / church / venue setups.
  out.push(`http://${MDNS_HOSTNAME}.local:${port}`);

  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (filter && info.address !== filter) continue;
      out.push(`http://${info.address}:${port}`);
    }
  }
  return out;
}

/** Enumerate non-loopback IPv4 interfaces — used by Settings → Remote dropdown. */
export function listNetworkInterfaces(): RemoteNetworkInterface[] {
  const out: RemoteNetworkInterface[] = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] ?? []) {
      if (info.family === 'IPv4' && !info.internal) {
        out.push({ name, address: info.address });
      }
    }
  }
  return out;
}

/**
 * Normalize the user-configured bind host. Empty string / undefined / the
 * literal '0.0.0.0' all collapse to '0.0.0.0' (= listen on every NIC).
 */
function normalizeBindHost(value: string | undefined): string {
  if (!value || value === '0.0.0.0') return '0.0.0.0';
  return value.trim();
}
