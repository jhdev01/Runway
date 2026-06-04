/** Format seconds as M:SS or H:MM:SS */
export function formatDuration(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '0:00';
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Format as HH:MM:SS for clock displays */
export function formatClock(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Parse 'HH:MM' 24h to seconds-since-midnight */
export function parseTime(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(n => parseInt(n, 10));
  return (h * 3600) + (m * 60);
}

/** Format seconds-since-midnight as 12h time, e.g. "9:00 AM" */
export function formatTime12h(secOfDay: number): string {
  const h24 = Math.floor(secOfDay / 3600);
  const m = Math.floor((secOfDay % 3600) / 60);
  const period = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

/** Today's date as YYYY-MM-DD in the user's local timezone (NOT UTC). */
export function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Day name for a given dayOfWeek 0-6 (0=Sunday) */
export function dayName(dow: number): string {
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dow] || '';
}

/**
 * Compact tech tag for a track row: "FLAC · 44.1k", "MP3 · 48k", or just
 * "FLAC" if the sample rate isn't known (older imports). Returns '' for
 * paths with no recognized extension.
 */
export function formatTrackTech(filePath: string | undefined, sampleRate: number | undefined): string {
  if (!filePath) return '';
  const m = filePath.match(/\.([a-z0-9]+)$/i);
  if (!m) return '';
  const ext = m[1].toLowerCase();
  // Display label per extension. Drop the dot and uppercase, with a few
  // friendlier aliases for the audio formats Runway accepts.
  const label = ({
    aif: 'AIFF',
    aiff: 'AIFF',
    m4a: 'M4A',
    mp3: 'MP3',
    flac: 'FLAC',
    wav: 'WAV',
    ogg: 'OGG',
  } as Record<string, string>)[ext] ?? ext.toUpperCase();
  if (!sampleRate) return label;
  const khz = sampleRate / 1000;
  // Most rates are integers when divided (44.1, 48, 88.2, 96, 192). Show
  // one decimal only when needed; drop trailing .0 otherwise.
  const khzLabel = khz % 1 === 0 ? `${khz}k` : `${khz.toFixed(1)}k`;
  return `${label} · ${khzLabel}`;
}

/** Format a date for display: "Sunday · May 3" */
export function formatDateLong(isoDate: string): string {
  const d = new Date(isoDate + 'T12:00:00');
  return d.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).replace(',', ' ·');
}

/**
 * Decode an audio file with Web Audio to get its real duration.
 * Used as a fallback when music-metadata returns 0 (common on MP3s
 * without a Xing/VBR header). Slow on large files but accurate.
 *
 * Has a 15-second timeout so a malformed file won't hang the import.
 */
export async function probeDuration(filePath: string): Promise<number> {
  const TIMEOUT_MS = 15000;
  try {
    // Use the custom runway-audio:// scheme; file:// is blocked by Electron.
    let p = filePath.replace(/^file:\/\//, '');
    if (!p.startsWith('/')) p = '/' + p;
    const encoded = p.split('/').map(s => encodeURIComponent(s)).join('/');
    const url = `runway-audio://localhost${encoded}`;

    const probe = (async () => {
      const res = await fetch(url);
      const arrayBuf = await res.arrayBuffer();
      const ctx = new AudioContext();
      try {
        const buffer = await ctx.decodeAudioData(arrayBuf);
        return Math.round(buffer.duration * 10) / 10;
      } finally {
        void ctx.close();
      }
    })();

    const timeout = new Promise<number>((_, reject) =>
      setTimeout(() => reject(new Error('probeDuration timeout')), TIMEOUT_MS)
    );

    return await Promise.race([probe, timeout]);
  } catch (err) {
    console.warn('[probeDuration] failed for', filePath, err);
    return 0;
  }
}
