/**
 * Playback watchdog for Spotify runs (service, post-service, test run, free
 * play). Spotify can report "playing" while nothing is coming out, e.g.
 * when the Spotify app on this Mac is logged out. While a run is active
 * this reads Spotify's state every 1.5 s and raises an alert when:
 *   - Spotify says it's playing but the position hasn't moved for 4 s,
 *   - Spotify stops answering for 4 s,
 *   - at the start of a run, the Spotify app here isn't on the account.
 * Read-only: it never plays, pauses, seeks or changes the volume, so it
 * can't affect timing.
 */
import { spotifyServiceRun, spotifyTestRun } from './spotifyTestRun';
import { spotifyFreePlay } from './spotifyPost';
import { setSpotifyAlert } from './spotifyAlert';

const TICK_MS = 1500;
const STALL_MS = 4000;

export function startSpotifyWatchdog(): () => void {
  let wasActive = false;
  let track = '';
  let lastPos = -1;
  let stillSince = 0;
  let silentSince = 0;
  let busy = false;

  const clear = () => setSpotifyAlert(null, 'playback');

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const active = spotifyServiceRun.isActive() || spotifyTestRun.isActive() || spotifyFreePlay.isActive();
      if (!active) {
        if (wasActive) clear();
        wasActive = false;
        track = '';
        silentSince = 0;
        return;
      }
      if (!wasActive) {
        wasActive = true;
        // A run just started: check right away that the Spotify app here is
        // signed in to the account (the regular check runs once a minute).
        void window.runway.spotify.health(true).then(h => {
          if (!wasActive) return;
          if (h.account === 'expired') {
            setSpotifyAlert({ kind: 'signed-out', text: 'Spotify signed Runway out. Songs may still start, but sign in again in Settings › Spotify.', action: 'settings' }, 'playback');
          } else if (h.appOnAccount === false) {
            console.warn('[spotify] run started but this Mac’s Spotify app is not on the account', { computers: h.accountComputers });
            setSpotifyAlert({
              kind: 'app-account',
              text: 'Spotify is starting a song, but the Spotify app on this Mac looks logged out (or on a different account). Open Spotify and log in, or the music won’t play.',
            }, 'playback');
          }
        }).catch(() => { /* offline: the stall check below still runs */ });
      }

      const st = await window.runway.spotify.player({ op: 'state' });
      const now = Date.now();
      if (!st.ok) {
        silentSince ||= now;
        if (now - silentSince > STALL_MS) {
          setSpotifyAlert({ kind: 'not-playing', text: `Spotify isn’t answering, so the music may have stopped. ${st.reason ?? 'Check that the Spotify app is open and logged in.'}` }, 'playback');
        }
        return;
      }
      silentSince = 0;
      if (st.playerState !== 'playing') { lastPos = -1; stillSince = 0; return; }   // paused/stopped: the run handles that
      const pos = st.positionSec ?? 0;
      if (st.trackUri !== track || lastPos < 0) {
        track = st.trackUri ?? '';
        lastPos = pos;
        stillSince = now;
        return;
      }
      if (Math.abs(pos - lastPos) > 0.3) {
        // Moving: whatever was wrong, it's playing now.
        lastPos = pos;
        stillSince = now;
        clear();
        return;
      }
      if (now - stillSince > STALL_MS) {
        console.warn('[spotify] playback stalled: Spotify reports playing but the position is not moving', { track, positionSec: pos });
        setSpotifyAlert({
          kind: 'not-playing',
          text: 'Spotify says it’s playing, but the song isn’t moving. The Spotify app on this Mac may be logged out. Open Spotify and check it.',
        }, 'playback');
      }
    } catch {
      /* ignore one bad read */
    } finally {
      busy = false;
    }
  };

  // A service / post-service / test run that gave up (couldn't start a song,
  // Spotify not available) raises the alert too, not just its own strip.
  let lastErr = '';
  const onRun = (s: { status: string; message?: string | null }) => {
    if (s.status === 'error' && s.message && s.message !== lastErr) {
      lastErr = s.message;
      setSpotifyAlert({ kind: 'not-playing', text: `Spotify music stopped: ${s.message}` }, 'playback');
    } else if (s.status === 'running') {
      lastErr = '';
    }
  };
  const unsubs = [spotifyServiceRun.subscribe(onRun), spotifyTestRun.subscribe(onRun)];

  const t = window.setInterval(() => void tick(), TICK_MS);
  return () => { window.clearInterval(t); unsubs.forEach(u => u()); clear(); };
}
