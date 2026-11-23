// Spotify account link + playlist reader (experimental).
//
// Since Spotify's February 2026 Web API changes, a playlist's song list
// can only be read with a signed-in user's token, and only for playlists
// that user owns or collaborates on. So Runway signs the operator in
// (Authorization Code + PKCE — no client secret needed) and keeps the
// refresh token in userData, encrypted with the OS keychain when
// available. The token is deliberately NOT stored in config.json so it
// never travels with config exports / backups.
//
// Scopes: reading playlists, plus (since quiet start) starting playback on
// this Mac's Spotify app through Spotify Connect. Starting a song that way
// doesn't bring the Spotify window forward, which AppleScript always does.

import { app, safeStorage, shell } from 'electron';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import type { SpotifyPlaylistSummary, SpotifyPlaylistList, SpotifyPlaylistResult, SpotifyPlaylistTrack, SpotifyStatus } from '../shared/types';

// Must match the Redirect URI registered on the Spotify developer app.
// Spotify requires a loopback IP literal ("localhost" is not allowed).
export const SPOTIFY_REDIRECT_PORT = 7813;
export const SPOTIFY_REDIRECT_URI = `http://127.0.0.1:${SPOTIFY_REDIRECT_PORT}/callback`;
const SCOPES = 'playlist-read-private playlist-read-collaborative user-modify-playback-state user-read-playback-state';
const CONTROL_SCOPE = 'user-modify-playback-state';

interface StoredAuth {
  clientId: string; refreshToken: string; displayName?: string;
  /** Scopes Spotify granted at sign-in (older sign-ins: unknown = playlists only). */
  scopes?: string;
  /** Operator's choice: start songs through Spotify Connect (no window flash). */
  quietStart?: boolean;
}

let access: { token: string; expiresAt: number } | null = null;
let pendingServer: http.Server | null = null;

const authFile = () => path.join(app.getPath('userData'), 'spotify-auth.bin');

function loadAuth(): StoredAuth | null {
  try {
    const raw = fs.readFileSync(authFile());
    const text = safeStorage.isEncryptionAvailable() && raw.subarray(0, 1).toString() !== '{'
      ? safeStorage.decryptString(raw)
      : raw.toString('utf8');
    const parsed = JSON.parse(text) as StoredAuth;
    return parsed?.clientId && parsed?.refreshToken ? parsed : null;
  } catch {
    return null;
  }
}

function saveAuth(auth: StoredAuth): void {
  const text = JSON.stringify(auth);
  const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text) : Buffer.from(text, 'utf8');
  fs.writeFileSync(authFile(), data, { mode: 0o600 });
}

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function tokenRequest(params: Record<string, string>): Promise<{
  access_token: string; expires_in: number; refresh_token?: string; scope?: string;
}> {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Spotify sign-in failed (${res.status}): ${await res.text().catch(() => '')}`);
  return res.json() as Promise<{ access_token: string; expires_in: number; refresh_token?: string; scope?: string }>;
}

async function getAccessToken(): Promise<string | null> {
  if (access && access.expiresAt > Date.now() + 30_000) return access.token;
  const auth = loadAuth();
  if (!auth) return null;
  const json = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: auth.refreshToken,
    client_id: auth.clientId,
  });
  access = { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
  // Spotify may rotate the refresh token; keep the newest one.
  if (json.refresh_token && json.refresh_token !== auth.refreshToken) {
    saveAuth({ ...auth, refreshToken: json.refresh_token });
  }
  return access.token;
}

async function api(pathAndQuery: string): Promise<Response> {
  const token = await getAccessToken();
  if (!token) throw new Error('NOT_CONNECTED');
  return fetch(`https://api.spotify.com/v1${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
}

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>Runway</title>` +
  `<body style="font-family:-apple-system,Segoe UI,sans-serif;background:#111;color:#eee;text-align:center;padding-top:18vh">` +
  `<h2>${title}</h2><p>${body}</p></body>`;

/** Wait for Spotify to redirect the browser back to the loopback address. */
function waitForCode(state: string): Promise<string> {
  return new Promise((resolve, reject) => {
    pendingServer?.close();
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', SPOTIFY_REDIRECT_URI);
      if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
      const code = url.searchParams.get('code');
      const err = url.searchParams.get('error');
      const good = !!code && url.searchParams.get('state') === state;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(good
        ? page('Spotify is connected', 'You can close this tab and go back to Runway.')
        : page('Spotify wasn’t connected', 'Go back to Runway and try again.'));
      finish();
      if (good) resolve(code!);
      else reject(new Error(err === 'access_denied' ? 'Sign-in was cancelled.' : 'Spotify sign-in didn’t complete.'));
    });
    const timer = setTimeout(() => { finish(); reject(new Error('Timed out waiting for the Spotify sign-in.')); }, 180_000);
    function finish() {
      clearTimeout(timer);
      server.close();
      if (pendingServer === server) pendingServer = null;
    }
    server.on('error', e => { clearTimeout(timer); reject(e); });
    server.listen(SPOTIFY_REDIRECT_PORT, '127.0.0.1');
    pendingServer = server;
  });
}

export async function spotifyConnect(clientIdRaw: string): Promise<SpotifyStatus> {
  const clientId = (clientIdRaw ?? '').trim();
  if (!/^[A-Za-z0-9]{20,64}$/.test(clientId)) {
    return { connected: false, reason: 'Enter the Client ID from your Spotify developer app first.' };
  }
  try {
    const verifier = b64url(crypto.randomBytes(64));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));
    const waiting = waitForCode(state);
    const authUrl = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: SPOTIFY_REDIRECT_URI,
      code_challenge_method: 'S256',
      code_challenge: challenge,
      scope: SCOPES,
      state,
    }).toString();
    await shell.openExternal(authUrl);
    const code = await waiting;
    const json = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: SPOTIFY_REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
    });
    if (!json.refresh_token) throw new Error('Spotify didn’t return a sign-in token.');
    access = { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
    let displayName: string | undefined;
    try {
      const me = await api('/me');
      if (me.ok) displayName = ((await me.json()) as { display_name?: string }).display_name || undefined;
    } catch { /* name is cosmetic */ }
    const prev = loadAuth();
    saveAuth({ clientId, refreshToken: json.refresh_token, displayName, scopes: json.scope ?? SCOPES, quietStart: prev?.quietStart });
    deviceId = null;
    return spotifyStatus();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      connected: false,
      reason: /EADDRINUSE/.test(msg)
        ? `Another app is using port ${SPOTIFY_REDIRECT_PORT}, which Runway needs for the Spotify sign-in.`
        : msg,
    };
  }
}

const canControl = (auth: StoredAuth | null) => !!auth?.scopes?.split(/\s+/).includes(CONTROL_SCOPE);

export function spotifyStatus(): SpotifyStatus {
  const auth = loadAuth();
  return auth
    ? { connected: true, displayName: auth.displayName, canControl: canControl(auth), quietStart: !!auth.quietStart }
    : { connected: false };
}

/** Saves the quiet-start choice with the Spotify sign-in (not in config.json). */
export function spotifySetQuietStart(on: boolean): SpotifyStatus {
  const auth = loadAuth();
  if (auth) saveAuth({ ...auth, quietStart: on });
  return spotifyStatus();
}

/** Quiet start is on and the sign-in allows it. */
export function spotifyQuietStartReady(): boolean {
  const auth = loadAuth();
  return !!auth?.quietStart && canControl(auth);
}

// ── Quiet start (Spotify Connect) ────────────────────────────────────
// Runway only ever starts songs on THIS computer's Spotify app. It finds it
// by the Mac's name (what Spotify shows in its device list); if the name
// doesn't match and there's more than one computer, it won't guess, and
// the caller falls back to starting the song the usual way.

let deviceId: string | null = null;
let computerName: string | null = null;
function thisComputerName(): string {
  if (computerName !== null) return computerName;
  try {
    computerName = process.platform === 'darwin'
      ? execFileSync('scutil', ['--get', 'ComputerName'], { timeout: 2000 }).toString().trim()
      : os.hostname();
  } catch { computerName = os.hostname(); }
  return computerName;
}

async function findThisDevice(): Promise<string | null> {
  const token = await getAccessToken();
  if (!token) return null;
  const res = await fetch('https://api.spotify.com/v1/me/player/devices', {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return null;
  const json = await res.json() as { devices?: Array<{ id: string | null; name?: string; type?: string; is_restricted?: boolean }> };
  const computers = (json.devices ?? []).filter(d => d.id && !d.is_restricted && d.type === 'Computer');
  const name = thisComputerName().toLowerCase();
  const named = computers.find(d => (d.name ?? '').toLowerCase() === name);
  if (named) return named.id;
  return computers.length === 1 ? computers[0].id : null;
}

/**
 * Starts `uri` (inside the playlist `contextUri` when given) from its
 * beginning on this computer's Spotify app via Spotify Connect.
 */
export async function spotifyConnectPlay(uri: string, contextUri?: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const token = await getAccessToken();
    if (!token) return { ok: false, reason: 'Not signed in to Spotify.' };
    for (let attempt = 0; attempt < 2; attempt++) {
      deviceId ??= await findThisDevice();
      if (!deviceId) return { ok: false, reason: 'Couldn’t find this computer in Spotify’s device list.' };
      const body = contextUri
        ? { context_uri: contextUri, offset: { uri }, position_ms: 0 }
        : { uris: [uri], position_ms: 0 };
      const res = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(deviceId)}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) return { ok: true };
      // Device went away (Spotify restarted): look it up again once.
      if (res.status === 404 && attempt === 0) { deviceId = null; continue; }
      return { ok: false, reason: `Spotify said ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}` };
    }
    return { ok: false, reason: 'Spotify didn’t accept the song.' };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export function spotifyDisconnect(): SpotifyStatus {
  access = null;
  deviceId = null;
  try { fs.unlinkSync(authFile()); } catch { /* already gone */ }
  return { connected: false };
}

/** Accepts a Spotify playlist share link or URI; returns the playlist id. */
export function parseSpotifyPlaylistId(input: string): string | null {
  const s = (input ?? '').trim();
  const m = s.match(/^spotify:playlist:([A-Za-z0-9]+)$/)
    ?? s.match(/open\.spotify\.com\/(?:intl-[a-z-]+\/)?playlist\/([A-Za-z0-9]+)/i);
  return m ? m[1] : null;
}

interface RawTrack {
  type?: string; uri?: string; name?: string; duration_ms?: number; is_local?: boolean;
  artists?: Array<{ name?: string }>;
  album?: { images?: Array<{ url?: string }> };
}
// Feb 2026 renamed `track` → `item`; accept both.
interface RawItem { item?: RawTrack | null; track?: RawTrack | null; is_local?: boolean }

export async function spotifyReadPlaylist(link: string): Promise<SpotifyPlaylistResult> {
  const id = parseSpotifyPlaylistId(link);
  if (!id) return { ok: false, reason: 'That doesn’t look like a Spotify playlist link.' };
  const notYours = 'Runway can only read playlists you created or collaborate on. Open the playlist in Spotify, choose “Add to other playlist → New playlist” to make your own copy, and paste that link instead.';
  try {
    const head = await api(`/playlists/${id}`);
    if (head.status === 401) return { ok: false, reason: 'Spotify sign-in expired. Disconnect and connect again.' };
    if (head.status === 404) return { ok: false, reason: 'Spotify couldn’t find that playlist.' };
    if (!head.ok) return { ok: false, reason: `Spotify returned an error (${head.status}).` };
    const meta = (await head.json()) as { name?: string };

    const tracks: SpotifyPlaylistTrack[] = [];
    let skipped = 0;
    for (let offset = 0; offset < 2000; offset += 50) {
      const res = await api(`/playlists/${id}/items?limit=50&offset=${offset}`);
      if (res.status === 403) return { ok: false, reason: notYours };
      if (!res.ok) return { ok: false, reason: `Spotify returned an error (${res.status}) reading the songs.` };
      const body = (await res.json()) as { items?: RawItem[]; next?: string | null };
      const items = body.items ?? [];
      for (const it of items) {
        const t = it.item ?? it.track;
        // Podcast episodes and "local file" entries can't be driven by URI.
        if (!t || it.is_local || t.is_local || t.type === 'episode'
            || !t.uri?.startsWith('spotify:track:') || !(Number(t.duration_ms) > 0)) {
          skipped++;
          continue;
        }
        tracks.push({
          uri: t.uri,
          title: t.name ?? 'Untitled',
          artist: (t.artists ?? []).map(a => a.name).filter(Boolean).join(', '),
          durationMs: Number(t.duration_ms),
          // Spotify lists album images largest first (640, 300, 64 px);
          // the middle one is sharp at row size without being heavy.
          albumArtUrl: t.album?.images?.[1]?.url ?? t.album?.images?.[0]?.url,
        });
      }
      if (!body.next || items.length === 0) break;
    }
    if (tracks.length === 0 && skipped === 0) return { ok: false, reason: notYours };
    return { ok: true, playlistId: id, name: meta.name ?? 'Spotify playlist', tracks, skipped };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: msg === 'NOT_CONNECTED' ? 'Connect Spotify first.' : msg };
  }
}


interface RawPlaylist {
  id?: string; name?: string; collaborative?: boolean;
  owner?: { id?: string };
  images?: Array<{ url?: string }> | null;
  // Spotify renamed tracks → items in Feb 2026; accept both.
  tracks?: { total?: number }; items?: { total?: number };
}

/**
 * Lists the signed-in user's playlists that Runway can read: ones they own
 * or collaborate on. (Spotify doesn't let apps read songs in playlists the
 * user merely follows, so those are left out instead of failing later.)
 */
export async function spotifyListPlaylists(): Promise<SpotifyPlaylistList> {
  try {
    const meRes = await api('/me');
    if (meRes.status === 401) return { ok: false, reason: 'Spotify sign-in expired. Disconnect and connect again.' };
    if (!meRes.ok) return { ok: false, reason: `Spotify returned an error (${meRes.status}).` };
    const me = (await meRes.json()) as { id?: string };
    const out: SpotifyPlaylistSummary[] = [];
    for (let offset = 0; offset < 1000; offset += 50) {
      const res = await api(`/me/playlists?limit=50&offset=${offset}`);
      if (!res.ok) return { ok: false, reason: `Spotify returned an error (${res.status}) listing playlists.` };
      const body = (await res.json()) as { items?: Array<RawPlaylist | null>; next?: string | null };
      const items = body.items ?? [];
      for (const p of items) {
        if (!p?.id) continue;
        if (p.owner?.id !== me.id && !p.collaborative) continue;
        out.push({
          id: p.id,
          name: p.name ?? 'Untitled playlist',
          imageUrl: p.images?.[p.images.length > 1 ? 1 : 0]?.url,
          songCount: p.items?.total ?? p.tracks?.total,
        });
      }
      if (!body.next || items.length === 0) break;
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, playlists: out };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: msg === 'NOT_CONNECTED' ? 'Connect Spotify first.' : msg };
  }
}


/**
 * Downloads a Spotify album image and returns it as a data URL, so the
 * art can be kept in Runway's config and shown without internet (same
 * way imported tracks keep their embedded art). Only Spotify's image CDN.
 */
export async function spotifyFetchArt(url: string): Promise<{ ok: boolean; dataUrl?: string; reason?: string }> {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !/(^|\.)scdn\.co$|(^|\.)spotifycdn\.com$/.test(u.hostname)) {
      return { ok: false, reason: 'Not a Spotify image.' };
    }
    const res = await fetch(u.toString());
    if (!res.ok) return { ok: false, reason: `Image download failed (${res.status}).` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 600 * 1024) return { ok: false, reason: 'Image too large.' };
    const mime = res.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
    return { ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
