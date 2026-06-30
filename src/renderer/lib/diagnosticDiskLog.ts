/**
 * diagnosticDiskLog — mirror service-timing console logs to a persistent
 * file (timing.log next to config.json) so the operator can review what
 * happened during a service after the fact, without keeping DevTools open.
 *
 * Implementation: wrap console.log ONCE. The original still fires (DevTools
 * output is unchanged), and any line whose first argument starts with a
 * known diagnostic tag is also shipped to the main process for disk append.
 * Wrapping console.log (rather than editing every call site) means the
 * v10.2.0 timing logs, the failsafe logs, the pre-warm logs, and any future
 * diagnostic line are all captured automatically.
 *
 * The forwarder never throws and never recurses: appendTimingLog is a
 * one-way IPC send (no console.log inside it), and the whole body is guarded.
 */

// Only these prefixes are persisted — the service-flow + timing lines.
// High-frequency / low-value chatter (e.g. '[pp] eager load' polling spam)
// is deliberately excluded so the file stays readable for an operator.
const TIMING_TAGS = [
  '[arm]',
  '[beginMusic]',
  '[scheduleRunway]',
  '[beginPad]',
  '[failsafe]',
  '[prewarm]',
  '[arm_playlist]',
  '[change_setlist]',
  '[reanchor]',
  '[actions]',
];

let installed = false;

function safeStringify(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Install the console.log → timing.log mirror. Idempotent; safe to call
 * from React effects that may run more than once. No-op when the preload
 * bridge isn't present (e.g. running the renderer outside Electron).
 */
export function installDiagnosticDiskLog(): void {
  if (installed) return;
  const append = window.runway?.diagnostics?.appendTimingLog;
  if (!append) return;
  installed = true;

  const original = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    original(...args);
    try {
      const first = args[0];
      if (typeof first !== 'string') return;
      if (!TIMING_TAGS.some(tag => first.startsWith(tag))) return;
      append(args.map(safeStringify).join(' '));
    } catch {
      /* logging must never break the app */
    }
  };
}
