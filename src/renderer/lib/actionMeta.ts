// Per-type metadata for Action Sequence rows. Used everywhere an action
// type is rendered: the type picker, row color tints, timeline markers,
// hover tooltips, etc. One source of truth so the visual vocabulary
// stays consistent across views.

import type { Action, ActionPayload, ActionAnchor, SongAnchor, Track } from '@shared/types';
import { effectiveDuration } from '@shared/types';

export interface ActionTypeMeta {
  type: ActionPayload['type'];
  /** Short verb shown in the type picker. */
  label: string;
  /** Single Unicode character. Cheap, sharp, no SVG sprite needed. */
  icon: string;
  /** CSS color used for the timeline marker, row tint, and icon chip. */
  color: string;
}

export const ACTION_META: Record<ActionPayload['type'], ActionTypeMeta> = {
  midi_send:                 { type: 'midi_send',                 label: 'MIDI send',         icon: '♪',  color: '#facc15' }, // gold
  pp_trigger_slide:          { type: 'pp_trigger_slide',          label: 'PP slide',          icon: '▣', color: '#38bdf8' }, // sky
  pp_trigger_playlist_item:  { type: 'pp_trigger_playlist_item',  label: 'PP playlist item',  icon: '☰', color: '#38bdf8' },
  pp_set_timer:              { type: 'pp_set_timer',              label: 'PP set timer',      icon: '⏱', color: '#0ea5e9' }, // sky-deep
  pp_timer_control:          { type: 'pp_timer_control',          label: 'PP timer control',  icon: '▶', color: '#0ea5e9' },
  audio_fade:                { type: 'audio_fade',                label: 'Audio fade',        icon: '↘', color: '#34d399' }, // emerald
  pad_action:                { type: 'pad_action',                label: 'Pad',               icon: '◎', color: '#c084fc' }, // violet
  music_action:              { type: 'music_action',              label: 'Music transport',   icon: '♫', color: '#fb7185' }, // rose
  change_setlist:            { type: 'change_setlist',            label: 'Change setlist',    icon: '⇄', color: '#e879f9' }, // fuchsia
  arm_playlist:              { type: 'arm_playlist',              label: 'Arm playlist',      icon: '▶', color: '#22d3ee' }, // cyan
};

/**
 * Generate a one-line description of what the action will do, for
 * tooltips and the vertical timeline. Reads off the payload, so e.g.
 * a midi_send shows "Yamaha P-125 · note_on ch1 60".
 */
export function describeAction(action: Action): string {
  const p = action.payload;
  if (action.label) return action.label;
  switch (p.type) {
    case 'midi_send': {
      const port = p.portName || '(no port)';
      const cmd = p.messageType.replace('_', ' ');
      return `${port} · ${cmd} ch${p.channel} ${p.data1}${p.data2 != null && p.messageType !== 'program_change' ? `/${p.data2}` : ''}`;
    }
    case 'pp_trigger_slide':
      return `Trigger active slide #${p.slideIndex}`;
    case 'pp_trigger_playlist_item':
      return `${p.playlistName ?? 'playlist'} → item ${p.itemIndex}${typeof p.slideIndex === 'number' ? ` slide ${p.slideIndex}` : ''}`;
    case 'pp_set_timer':
      return `Set "${p.timerName ?? 'timer'}" → ${p.mode === 'duration' ? `${p.durationSec}s` : 'count down to service'}`;
    case 'pp_timer_control':
      return `${p.op} "${p.timerName ?? 'timer'}"`;
    case 'audio_fade':
      return `${p.bus} bus → ${p.targetGainDb} dB${p.durationSec > 0 ? ` over ${p.durationSec}s` : ' (instant)'}`;
    case 'pad_action':
      return `Pad ${p.op}${p.key ? ` ${p.key}` : ''}`;
    case 'music_action':
      return `Music ${p.op.replace('_', ' ')}`;
    case 'change_setlist':
      return `Change setlist → ${p.playlistName ?? p.playlistId}${p.fadeOutSec > 0 ? ` (fade ${p.fadeOutSec}s)` : ' (cut)'}`;
    case 'arm_playlist':
      return `Arm playlist → ${p.playlistName ?? p.playlistId}${p.fillWithMusic ? ' · fill' : ' · once through'}${p.fadeOutSec > 0 ? ` · fade ${p.fadeOutSec}s` : ''}`;
  }
}

// ─── 4-way "before/after" anchor model ────────────────────────────────
// Internally we still store anchor + signed offsetSec because the engine
// is built that way. The UI shows 4 directional buckets so the operator
// never has to think about negative numbers:
//   before_music   → anchor=playlist_start, offset = -mag
//   after_music    → anchor=playlist_start, offset = +mag
//   before_service → anchor=service_start,  offset = -mag
//   after_service  → anchor=service_start,  offset = +mag

export type AnchorDirection =
  | 'before_music'
  | 'after_music'
  | 'before_service'
  | 'after_service'
  | 'after_first_song'
  | 'before_last_song';

export const ANCHOR_DIRECTION_LABEL: Record<AnchorDirection, string> = {
  before_music:     'before music start',
  after_music:      'after music start',
  before_service:   'before service start',
  after_service:    'after service start',
  after_first_song: 'after first song',
  before_last_song: 'before last song',
};

/**
 * Whether this direction uses a time magnitude (MM:SS) or a song count.
 * The UI flips its magnitude input based on this.
 */
export function isSongDirection(d: AnchorDirection): boolean {
  return d === 'after_first_song' || d === 'before_last_song';
}

/**
 * Map an action's stored fields back to a UI direction. Song-based
 * fields take precedence; time-based otherwise.
 */
export function directionFromAction(
  anchor: ActionAnchor,
  offsetSec: number,
  songAnchor: SongAnchor | undefined,
  _songOffset: number | undefined,
): AnchorDirection {
  if (songAnchor === 'first_song') return 'after_first_song';
  if (songAnchor === 'last_song') return 'before_last_song';
  const before = offsetSec < 0;
  if (anchor === 'playlist_start') return before ? 'before_music' : 'after_music';
  return before ? 'before_service' : 'after_service';
}

/**
 * Patch values to apply when the user picks a direction. The caller
 * combines these with the current magnitude (time or song count) to
 * produce the final stored offsetSec / songOffset.
 */
export function patchForDirection(
  direction: AnchorDirection,
  magnitude: number,
): {
  anchor?: ActionAnchor;
  offsetSec: number;
  songAnchor?: SongAnchor;
  songOffset?: number;
} {
  // For "before_*" directions with magnitude 0 we store a tiny
  // negative offsetSec so the sign survives the round-trip. Without
  // this, picking "before service" with the magnitude still at 0:00
  // saved offsetSec=0, which the direction-derivation read back as
  // "after service" — and the dropdown snapped back every time.
  // -1e-9 sec is sub-microsecond — engine fires effectively at the
  // anchor moment, display still reads 0:00.
  const SIGN_SENTINEL = 1e-9;
  const abs = Math.abs(magnitude);
  switch (direction) {
    case 'before_music':
      return { anchor: 'playlist_start', offsetSec: abs > 0 ? -abs : -SIGN_SENTINEL, songAnchor: undefined, songOffset: undefined };
    case 'after_music':
      return { anchor: 'playlist_start', offsetSec: abs, songAnchor: undefined, songOffset: undefined };
    case 'before_service':
      return { anchor: 'service_start', offsetSec: abs > 0 ? -abs : -SIGN_SENTINEL, songAnchor: undefined, songOffset: undefined };
    case 'after_service':
      return { anchor: 'service_start', offsetSec: abs, songAnchor: undefined, songOffset: undefined };
    case 'after_first_song':
      return { offsetSec: 0, songAnchor: 'first_song', songOffset: Math.abs(Math.round(magnitude)) };
    case 'before_last_song':
      // Song-based directions disambiguate via songAnchor, so the
      // sentinel isn't needed here — but we still want songOffset
      // negative so the engine walks backward from the last track.
      return { offsetSec: 0, songAnchor: 'last_song', songOffset: -Math.abs(Math.round(magnitude)) };
  }
}

/** Back-compat shim used by older callers — anchor + signed offset only. */
export function anchorAndSignFor(direction: AnchorDirection): {
  anchor: ActionAnchor;
  sign: 1 | -1;
} {
  switch (direction) {
    case 'before_music':     return { anchor: 'playlist_start', sign: -1 };
    case 'after_music':      return { anchor: 'playlist_start', sign:  1 };
    case 'before_service':   return { anchor: 'service_start',  sign: -1 };
    case 'after_service':    return { anchor: 'service_start',  sign:  1 };
    // Song-based directions don't translate to a time anchor cleanly;
    // pick a neutral default. Callers that hit this path should use
    // patchForDirection() instead.
    case 'after_first_song':
    case 'before_last_song':
      return { anchor: 'playlist_start', sign: 1 };
  }
}

export function directionFromAnchorAndOffset(
  anchor: ActionAnchor,
  offsetSec: number,
): AnchorDirection {
  return directionFromAction(anchor, offsetSec, undefined, undefined);
}

/**
 * Resolve an action's wall-clock fire time given the current runway.
 * Used by both the Live view (to render markers) and the controller's
 * fireDueActions (to actually fire). Returns null when the action's
 * song reference is out of bounds — the engine should skip it.
 */
export function resolveActionFireMs(
  action: Action,
  sequenceAnchor: ActionAnchor,
  runway: {
    targetMs: number;
    musicStartMs: number;
    trackIds: string[];
    crossfadeSec?: number;
    startOffsetSec?: number;
  },
  tracks: Track[],
): number | null {
  if (action.songAnchor) {
    const ids = runway.trackIds;
    if (ids.length === 0) return null;
    const baseIdx = action.songAnchor === 'first_song' ? 0 : ids.length - 1;
    const targetIdx = baseIdx + (action.songOffset ?? 0);
    // Out-of-bounds at the start = skip. At the end we allow ONE
    // step past the last song — that's interpreted as "fire when the
    // playlist finishes" (= sum of all song durations from
    // musicStartMs). Use case: action at the END of a 2-song prayer
    // playlist that arms the next service.
    if (targetIdx < 0 || targetIdx > ids.length) return null;
    const fireAtPlaylistEnd = targetIdx === ids.length;
    const walkUpTo = fireAtPlaylistEnd ? ids.length : targetIdx;
    let cumSec = 0;
    for (let i = 0; i < walkUpTo; i++) {
      const t = tracks.find(tr => tr.id === ids[i]);
      if (t) cumSec += effectiveDuration(t);
    }
    // Track 0 plays from `startOffsetSec` (head trim) to its end, so
    // each track at index >= 1 starts in wall-clock `startOffsetSec`
    // earlier than the simple sum of preceding effDurs would suggest.
    // Track 0 itself is unaffected (always starts at musicStartMs).
    const startOff = runway.startOffsetSec ?? 0;
    const adj = (targetIdx >= 1 || fireAtPlaylistEnd) ? startOff : 0;
    return runway.musicStartMs + (cumSec - adj) * 1000;
  }
  const anchor = action.anchor ?? sequenceAnchor;
  const anchorMs = anchor === 'service_start' ? runway.targetMs : runway.musicStartMs;
  return anchorMs + action.offsetSec * 1000;
}
