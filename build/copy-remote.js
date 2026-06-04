// Copies remote PWA assets from src/remote/ → dist/remote/.
// Replaces the Unix shell incantation (`rm -rf ... && mkdir -p ... && cp ...`)
// that used to be the `build:remote` package script — that script worked
// fine on macOS/Linux but blew up on Windows CI runners with
// "The syntax of the command is incorrect" because cmd.exe has no rm/cp.
//
// This Node-based version is cross-platform: same behaviour on macOS,
// Linux, and Windows GitHub Actions.

const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '..', 'src', 'remote');
const DEST = path.resolve(__dirname, '..', 'dist', 'remote');
const ALLOWED_EXT = new Set(['.html', '.css', '.js', '.png', '.json']);

// Wipe + recreate the destination so stale files don't survive a rebuild.
fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(DEST, { recursive: true });

let copied = 0;
for (const name of fs.readdirSync(SRC)) {
  const ext = path.extname(name).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) continue;
  fs.copyFileSync(path.join(SRC, name), path.join(DEST, name));
  copied++;
}

console.log(`[build:remote] copied ${copied} files → ${path.relative(process.cwd(), DEST)}`);
