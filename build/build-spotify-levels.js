// Compiles the small macOS helper that draws Spotify waveforms
// (native/spotify-levels/main.swift) into build/native/. Mac only; on any
// other platform, or if the compile fails, Runway still builds and the
// waveform feature just reports that it's unavailable.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const src = path.join(root, 'native', 'spotify-levels', 'main.swift');
const outDir = path.join(root, 'build', 'native');
const out = path.join(outDir, 'runway-spotify-levels');
fs.mkdirSync(outDir, { recursive: true });

if (process.platform !== 'darwin') {
  console.log('[spotify-levels] not on macOS; skipping');
  process.exit(0);
}
try {
  execFileSync('xcrun', [
    'swiftc', '-O',
    '-target', 'arm64-apple-macos13.0',
    '-framework', 'ScreenCaptureKit', '-framework', 'CoreMedia',
    src, '-o', out,
  ], { stdio: 'inherit' });
  execFileSync('codesign', ['--force', '--sign', '-', out], { stdio: 'inherit' });
  console.log('[spotify-levels] built', out);
} catch (e) {
  console.error('[spotify-levels] build FAILED; waveforms will be unavailable in this build');
  try { fs.rmSync(out, { force: true }); } catch { /* ignore */ }
}
