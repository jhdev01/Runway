/**
 * MtcEngine — emits MIDI Time Code quarter-frame messages out a chosen
 * MIDIOutput so a receiver (e.g. ProPresenter) can sync its timer to ours.
 *
 * Quarter-frame messages are 0xF1 followed by one data byte:
 *   bits 4-6: piece number (0..7)
 *   bits 0-3: nibble of the timecode field for this piece
 *
 * Across 8 pieces (= 2 frames in real time) the receiver assembles a complete
 * HH:MM:SS:FF reading. Pieces 0..7 carry, in order:
 *   0: frame  LSB           1: frame  MSB (1 bit)
 *   2: second LSB           3: second MSB (2 bits)
 *   4: minute LSB           5: minute MSB (2 bits)
 *   6: hour   LSB           7: hour   MSB (1 bit) | rate code (2 bits)
 *
 * Rate code:  0 = 24 fps   1 = 25 fps   2 = 29.97 (drop)   3 = 30 fps
 *
 * The engine never owns the "current TC" itself — it pulls a fresh value from
 * the registered source at the start of each 2-frame cycle (piece 0). The
 * driver in engines.tsx supplies that source, e.g. computing time-until-service.
 */

import type { MtcFrameRate } from '@shared/types';

export interface TcValue {
  hours: number;
  minutes: number;
  seconds: number;
  frames: number;
}

export type TcSource = () => TcValue | null;

const ZERO_TC: TcValue = { hours: 0, minutes: 0, seconds: 0, frames: 0 };

function rateCodeFor(fr: MtcFrameRate): number {
  if (fr === 24) return 0;
  if (fr === 25) return 1;
  return 3; // 30 fps non-drop
}

function quarterFrameDataByte(piece: number, tc: TcValue, rateCode: number): number {
  let nibble = 0;
  switch (piece) {
    case 0: nibble = tc.frames & 0x0F; break;
    case 1: nibble = (tc.frames >> 4) & 0x01; break;
    case 2: nibble = tc.seconds & 0x0F; break;
    case 3: nibble = (tc.seconds >> 4) & 0x03; break;
    case 4: nibble = tc.minutes & 0x0F; break;
    case 5: nibble = (tc.minutes >> 4) & 0x03; break;
    case 6: nibble = tc.hours & 0x0F; break;
    case 7: nibble = ((rateCode & 0x03) << 1) | ((tc.hours >> 4) & 0x01); break;
  }
  return ((piece & 0x07) << 4) | (nibble & 0x0F);
}

export class MtcEngine {
  private output: MIDIOutput | null = null;
  private frameRate: MtcFrameRate = 30;
  private timer: number | null = null;
  private piece = 0;
  // The TC value frozen at piece 0 — quarter frames send slices of THIS over 2 frames.
  private currentTc: TcValue = ZERO_TC;
  private source: TcSource = () => ZERO_TC;
  private listeners: Set<(tc: TcValue | null) => void> = new Set();
  private running = false;

  setOutput(output: MIDIOutput | null) {
    this.output = output;
  }

  setFrameRate(fr: MtcFrameRate) {
    this.frameRate = fr;
    if (this.running) {
      // Restart so the interval matches the new rate.
      this.stop();
      this.start();
    }
  }

  setSource(source: TcSource) {
    this.source = source;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Subscribe to live TC updates (fires once per 2-frame cycle = 8 quarter frames). */
  subscribe(cb: (tc: TcValue | null) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  start() {
    if (this.running) return;
    if (!this.output) return;
    this.running = true;
    this.piece = 0;
    // Snapshot once immediately so the very first byte is consistent with the listener.
    this.currentTc = this.source() ?? ZERO_TC;
    this.notify();

    // Quarter-frame interval in ms = 1000 / (fr * 4).
    const intervalMs = 1000 / (this.frameRate * 4);
    this.timer = window.setInterval(() => this.tick(), intervalMs);
  }

  stop() {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    this.notify();
  }

  private tick() {
    if (!this.output) return;
    if (this.piece === 0) {
      // Re-snapshot the source — the next 8 quarter frames will encode this.
      this.currentTc = this.source() ?? ZERO_TC;
      this.notify();
    }
    const byte = quarterFrameDataByte(this.piece, this.currentTc, rateCodeFor(this.frameRate));
    try {
      this.output.send([0xF1, byte]);
    } catch (err) {
      console.warn('[mtc] send failed', err);
    }
    this.piece = (this.piece + 1) % 8;
  }

  private notify() {
    const tc = this.running ? this.currentTc : null;
    this.listeners.forEach(l => l(tc));
  }

  /** Format a TC value as HH:MM:SS:FF for display. */
  static format(tc: TcValue | null): string {
    if (!tc) return '--:--:--:--';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(tc.hours)}:${pad(tc.minutes)}:${pad(tc.seconds)}:${pad(tc.frames)}`;
  }
}

/**
 * Convert a positive duration in seconds into a TC value at the given frame
 * rate. Negative durations clamp to 0. Hours saturate at 23:59:59:FFmax.
 */
export function secondsToTc(seconds: number, frameRate: MtcFrameRate): TcValue {
  const total = Math.max(0, seconds);
  const wholeSec = Math.floor(total);
  const fractional = total - wholeSec;
  const frames = Math.min(frameRate - 1, Math.floor(fractional * frameRate));
  const h = Math.min(23, Math.floor(wholeSec / 3600));
  const m = Math.floor((wholeSec % 3600) / 60);
  const s = wholeSec % 60;
  return { hours: h, minutes: m, seconds: s, frames };
}
