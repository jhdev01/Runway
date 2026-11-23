// Spotify desktop-app remote control (experimental, macOS only).
//
// Small, stateless commands the renderer's Spotify test run strings
// together: start a song, jump, set the volume, pause, and read the
// playhead. Every call reports when Spotify actually answered so the
// renderer can line readings up against its own clock. Nothing here
// touches Runway's audio engine or any service.

import { systemPreferences } from 'electron';
import { osa, tell, num, lit, friendly } from './spotifyTimingTest';
import type { SpotifyPlayerCommand, SpotifyPlayerReply } from '../shared/types';
import { spotifyConnectPlay, spotifyQuietStartReady, spotifySetQuietStart } from './spotifyAccount';
import { fastSpotifyVolume } from './spotifyVolume';

const URI_RE = /^spotify:(track|playlist):[A-Za-z0-9]+$/;
const CONTEXT_RE = /^spotify:playlist:[A-Za-z0-9]+$/;
// Reads the playhead in the same round trip as any volume change.
const READ_STATE = 'return (id of current track) & "|" & (player state as text) & "|" & (player position as text) & "|" & (sound volume as text)';

function parseState(out: string): Pick<SpotifyPlayerReply, 'trackUri' | 'playerState' | 'positionSec' | 'volume'> {
  const [id, state, pos, vol] = out.split('|');
  return {
    trackUri: id || undefined,
    playerState: (state || undefined) as SpotifyPlayerReply['playerState'],
    positionSec: Number.isFinite(num(pos ?? '')) ? num(pos) : undefined,
    volume: Number.isFinite(num(vol ?? '')) ? Math.round(num(vol)) : undefined,
  };
}

/**
 * Closes Spotify's window (minimizes it if closing isn't possible) so that
 * when a new song pulls Spotify forward there's no window to flash on
 * screen. Spotify keeps running and playing without its window; clicking
 * its Dock icon brings the window back. Needs Runway allowed under
 * System Settings › Privacy & Security › Accessibility; without that it
 * does nothing and returns false.
 */
function accessibilityAllowed(prompt = false): boolean {
  try { return systemPreferences.isTrustedAccessibilityClient(prompt); } catch { return false; }
}
async function tuckSpotifyWindows(): Promise<boolean> {
  if (!accessibilityAllowed(false)) return false;
  try {
    await osa([
      'tell application "System Events"',
      'if exists application process "Spotify" then',
      'tell application process "Spotify"',
      'repeat with w in (every window)',
      'try',
      'click (first button of w whose subrole is "AXCloseButton")',
      'on error',
      'try',
      'set value of attribute "AXMinimized" of w to true',
      'end try',
      'end try',
      'end repeat',
      'end tell',
      'end if',
      'end tell',
    ]);
  } catch { /* Spotify gone or UI changed: leave it */ }
  return true;
}

async function keepSpotifyBehind(): Promise<void> {
  try {
    await osa([
      'tell application "System Events"',
      'repeat 12 times',
      'if exists application process "Spotify" then',
      'if frontmost of application process "Spotify" then set visible of application process "Spotify" to false',
      'end if',
      'delay 0.08',
      'end repeat',
      'end tell',
    ]);
  } catch { /* permission refused: Spotify may come forward */ }
}

export async function spotifyPlayer(cmd: SpotifyPlayerCommand): Promise<SpotifyPlayerReply> {
  if (process.platform !== 'darwin') {
    return { ok: false, reason: 'Spotify control only works on a Mac for now.' };
  }
  const sentAt = Date.now();
  try {
    let out = '';
    switch (cmd.op) {
      case 'check': {
        const running = await osa(['application "Spotify" is running']);
        if (running !== 'true') return { ok: false, reason: 'Spotify isn’t open. Open the Spotify app and try again.' };
        out = await osa(tell('return "|" & (player state as text) & "||" & (sound volume as text)'));
        break;
      }
      case 'quietStart':
        spotifySetQuietStart(!!cmd.on);
        return { ok: true, sentAt, answeredAt: Date.now() };
      case 'macOutput': {
        // The Mac's own speaker volume / mute, so the editor can say why a
        // preview is silent (e.g. still muted from a waveform scan).
        const o = await osa(['set v to get volume settings', 'return ((output volume of v) as text) & "|" & ((output muted of v) as text)']);
        const [vol, muted] = o.split('|');
        return { ok: true, sentAt, answeredAt: Date.now(), macVolume: Number(vol), macMuted: muted === 'true' };
      }
      case 'macUnmute':
        await osa(['set volume without output muted']);
        return { ok: true, sentAt, answeredAt: Date.now() };
      case 'tuck':
        return { ok: true, sentAt, answeredAt: Date.now(), accessibilityAllowed: await tuckSpotifyWindows() };
      case 'accessibility':
        // prompt: true shows macOS's own "allow in Accessibility" prompt.
        return { ok: true, sentAt, answeredAt: Date.now(), accessibilityAllowed: accessibilityAllowed(!!cmd.prompt) };
      case 'play': {
        if (!URI_RE.test(cmd.uri)) return { ok: false, reason: 'Not a Spotify song or playlist.' };
        // Quiet start: through Spotify Connect, which doesn't bring Spotify
        // forward. If it can't (offline, device not found), fall through to
        // the usual AppleScript start so the song still plays.
        if (spotifyQuietStartReady() && cmd.uri.startsWith('spotify:track:')) {
          const ctx = cmd.contextUri && CONTEXT_RE.test(cmd.contextUri) ? cmd.contextUri : undefined;
          const q = await spotifyConnectPlay(cmd.uri, ctx);
          if (q.ok) return { ok: true, sentAt, answeredAt: Date.now(), wasFrontmost: true, quiet: true };
          console.warn('[spotify] quiet start failed; starting the usual way:', q.reason);
        }
        // No window, nothing to flash when the new song pulls Spotify forward.
        // Runs alongside the play command (it finishes before the song has
        // loaded and Spotify comes forward), so song timing isn't delayed.
        void tuckSpotifyWindows();
        // Note whether Spotify was already in front, so 'background' only
        // hides it again when starting a song is what pulled it forward.
        out = await osa([
          'set wasFront to false',
          'try',
          'tell application "System Events" to set wasFront to frontmost of application process "Spotify"',
          'end try',
          // "in context" keeps Spotify in the playlist instead of jumping to
          // the song's album (and carrying on with that album).
          ...tell(cmd.contextUri && CONTEXT_RE.test(cmd.contextUri)
            ? `play track "${cmd.uri}" in context "${cmd.contextUri}"`
            : `play track "${cmd.uri}"`),
          'return "front:" & (wasFront as text)',
        ]);
        const answeredAt = Date.now();
        const wasFrontmost = out.trim() === 'front:true';
        // Spotify pulls itself forward when a new song starts. If it wasn't in
        // front, keep pushing it back for the next second (it can come forward
        // a beat after the command). Runs alongside; doesn't delay the reply.
        if (!wasFrontmost) void keepSpotifyBehind();
        return { ok: true, sentAt, answeredAt, wasFrontmost };
      }
      case 'background':
        // Hide Spotify if it jumped in front (macOS brings it forward when a
        // new song starts). Hiding the front app returns focus to whatever
        // was in front before. Needs one-time permission to control System
        // Events; if refused, Spotify just stays where it is.
        try {
          await osa([
            'tell application "System Events"',
            'if exists application process "Spotify" then',
            'if frontmost of application process "Spotify" then set visible of application process "Spotify" to false',
            'end if',
            'end tell',
          ]);
        } catch { /* permission refused or Spotify gone: leave it */ }
        break;
      case 'nowPlaying': {
        // Tab-separated so song titles with "|" don't break the split.
        const o = await osa(tell(
          'set T to ASCII character 9',
          'return (id of current track) & T & (player state as text) & T & (player position as text) & T & (sound volume as text) & T & (name of current track) & T & (artist of current track) & T & (duration of current track as text) & T & (artwork url of current track)',
        ));
        const [id, st, pos, vol, title, artist, dur, art] = o.split('\t');
        return {
          ok: true, sentAt, answeredAt: Date.now(),
          trackUri: id || undefined,
          playerState: (st || undefined) as SpotifyPlayerReply['playerState'],
          positionSec: Number.isFinite(num(pos ?? '')) ? num(pos) : undefined,
          volume: Number.isFinite(num(vol ?? '')) ? Math.round(num(vol)) : undefined,
          title, artist,
          durationSec: Number.isFinite(num(dur ?? '')) ? num(dur) / 1000 : undefined,
          artworkUrl: art || undefined,
        };
      }
      case 'seek':
        await osa(tell(`set player position to ${lit(Math.max(0, cmd.positionSec))}`));
        break;
      case 'volume':
        // Fast lane first (fades send many of these a second); osascript if it isn't available.
        if (!fastSpotifyVolume(cmd.volume)) {
          await osa(tell(`set sound volume to ${Math.round(Math.max(0, Math.min(100, cmd.volume)))}`));
        }
        break;
      case 'pause':
        await osa(tell('pause'));
        break;
      case 'resume':
        await osa(tell('play'));
        break;
      case 'state':
        out = await osa(tell(READ_STATE));
        break;
      case 'volumeAndState':
        out = await osa(tell(
          `set sound volume to ${Math.round(Math.max(0, Math.min(100, cmd.volume)))}`,
          READ_STATE,
        ));
        break;
    }
    const answeredAt = Date.now();
    return { ok: true, sentAt, answeredAt, ...(out ? parseState(out) : {}) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // -1728: Spotify has no current track (e.g. mid-load). Not a failure;
    // the caller just sees no track and asks again.
    if (/-1728/.test(msg)) return { ok: true, sentAt, answeredAt: Date.now() };
    return { ok: false, reason: friendly(e) };
  }
}
