// A fast lane for Spotify volume changes (macOS).
//
// Fades step Spotify's volume many times a second. Starting a fresh
// osascript for every step takes ~50–120 ms each, which made fades move in
// audible stair-steps. Instead one small JavaScript-for-Automation process
// stays running and sets Spotify's volume as each new value arrives on its
// input (a few ms per change). Same permission as the rest of Runway's
// Spotify control. If it isn't running, callers fall back to osascript.

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';

const SCRIPT = `
ObjC.import('Foundation');
var sp = Application('Spotify');
// Self-check: prove we can talk to Spotify's volume before Runway relies on us.
try { if (sp.running()) { sp.soundVolume(); } console.log('R'); } catch (e) { console.log('E ' + e); }
var input = $.NSFileHandle.fileHandleWithStandardInput;
var buf = '';
while (true) {
  var data = input.availableData;
  if (data.length === 0) break;
  buf += $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
  var i;
  var last = null;
  while ((i = buf.indexOf('\\n')) >= 0) {
    var v = parseInt(buf.slice(0, i), 10);
    buf = buf.slice(i + 1);
    if (!isNaN(v)) last = v;
  }
  // Only the newest value matters if several arrived at once.
  if (last !== null) { try { sp.soundVolume = last; } catch (e) {} }
}
`;

let proc: ChildProcessWithoutNullStreams | null = null;
let ready = false;      // the process passed its self-check
let broken = false;     // give up and always use osascript
let failures = 0;

function ensure(): ChildProcessWithoutNullStreams | null {
  if (process.platform !== 'darwin' || broken) return null;
  if (proc && !proc.killed && proc.exitCode === null) return proc;
  try {
    const p = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
    ready = false;
    p.on('exit', () => {
      if (proc === p) { proc = null; ready = false; }
      if (++failures >= 3) broken = true;
    });
    p.on('error', () => { if (proc === p) { proc = null; ready = false; } broken = true; });
    // JXA's console.log goes to stderr.
    const onOut = (d: Buffer) => {
      const t = d.toString();
      if (/^R\b/m.test(t)) ready = true;
      if (/^E\b/m.test(t)) { broken = true; ready = false; try { p.kill(); } catch { /* ignore */ } }
    };
    p.stdout.on('data', onOut);
    p.stderr.on('data', onOut);
    proc = p;
    return p;
  } catch {
    broken = true;
    return null;
  }
}

/** Sets Spotify's volume through the fast lane. False = use osascript instead. */
export function fastSpotifyVolume(volume: number): boolean {
  const p = ensure();
  // Until it has passed its self-check, use osascript (nothing is lost).
  if (!p || !ready) return false;
  try {
    p.stdin.write(`${Math.round(Math.max(0, Math.min(100, volume)))}\n`);
    return true;
  } catch {
    return false;
  }
}

export function stopFastSpotifyVolume(): void {
  if (proc) { try { proc.stdin.end(); proc.kill(); } catch { /* ignore */ } proc = null; }
}
