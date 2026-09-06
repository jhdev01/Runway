/**
 * proPresenterClient — thin wrapper around the ProPresenter Network API.
 *
 * Routes requests through Electron main (window.runway.proPresenter.request)
 * to avoid potential CORS issues across PP versions.
 *
 * Path scheme observed against PP 21 (May 2026):
 *   GET  /version                   — handshake (no /v1 prefix on this one)
 *   GET  /v1/timers                 — list timers
 *   PUT  /v1/timer/{uuid}           — update a timer
 *   GET  /v1/timer/{uuid}/start     — start
 *   GET  /v1/timer/{uuid}/stop      — stop
 *   GET  /v1/timer/{uuid}/reset     — reset
 */

import type { ProPresenterSyncConfig } from '@shared/types';

export interface PpTimer {
  uuid: string;
  name: string;
  // Playlist items expose their position; PP triggers playlist items by
  // index, not uuid. Undefined for things like timers where there's no list
  // position concept.
  index?: number;
  // Playlist-item kind from PP ("presentation", "header", "media", …).
  // Headers are section dividers: they occupy an index but triggering one
  // does nothing visible, so pickers render them as non-selectable labels.
  type?: string;
  // For headers: PP's header_color as a CSS rgb() string, when present.
  headerColor?: string;
  raw: unknown; // full PP response object — handy for debugging
}

export class PpClient {
  // Serialize all outgoing requests so a late-arriving disarm reset can't
  // race past a fresh re-arm PUT and wipe the new timer value. Each `send()`
  // chains onto the previous request's settlement.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private cfg: ProPresenterSyncConfig) {}

  updateConfig(cfg: ProPresenterSyncConfig) {
    this.cfg = cfg;
  }

  /** Best-effort handshake. Returns the PP version string, or throws. */
  async testConnection(): Promise<{ version?: string; raw: unknown }> {
    const res = await this.get('/version');
    if (!res.ok) {
      throw new Error(res.error || `HTTP ${res.status}: ${res.body || 'no body'}`);
    }
    let parsed: unknown = res.body;
    try { parsed = JSON.parse(res.body); } catch { /* leave as text */ }
    const version =
      (parsed as { version?: string })?.version ??
      (parsed as { name?: string })?.name;
    return { version, raw: parsed };
  }

  /**
   * List timers. PP7 returns each timer as something like:
   *   { id: { uuid, name, index }, allows_overrun, countdown: {...} }
   * We normalize to { uuid, name } for the UI.
   */
  async listTimers(): Promise<PpTimer[]> {
    const res = await this.get('/v1/timers');
    if (!res.ok) {
      throw new Error(res.error || `HTTP ${res.status}: ${res.body || 'no body'}`);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(res.body); }
    catch { throw new Error('Could not parse timer list — PP returned non-JSON.'); }
    return normalizeIdList(parsed);
  }

  /**
   * Set the chosen timer to count down to the given absolute target time (epoch ms),
   * then start it. We GET the timer first so we preserve every field PP cares
   * about (uuid + name + index in the id object), then PUT only with the
   * count_down_to_time field replaced — and use the combined `/start`
   * endpoint to set+start in a single request.
   */
  async armCountdownToTime(uuid: string, targetMs: number): Promise<void> {
    const { time_of_day, period } = epochMsToCountDownToTime(targetMs);

    const getRes = await this.get(`/v1/timer/${encodeURIComponent(uuid)}`);
    if (!getRes.ok) {
      throw new Error(getRes.error || `HTTP ${getRes.status}: GET timer failed: ${getRes.body || 'no body'}`);
    }
    let existing: Record<string, unknown>;
    try { existing = JSON.parse(getRes.body); }
    catch { throw new Error('Could not parse timer GET response.'); }

    const body = {
      ...existing,
      id: existing.id, // explicit so we keep PP's exact id shape (uuid+name+index)
      allows_overrun: existing.allows_overrun ?? false,
      // Replace whatever timer-type field was there with count_down_to_time.
      count_down_to_time: { time_of_day, period },
    };
    // Strip the alternate-type field if PP returned it, so we don't ship both.
    delete (body as Record<string, unknown>).countdown;

    console.log('[pp] PUT timer', { uuid, targetMs, time_of_day, period, body });
    const putRes = await this.put(`/v1/timer/${encodeURIComponent(uuid)}/start`, body);
    if (!putRes.ok) {
      throw new Error(putRes.error || `HTTP ${putRes.status}: ${putRes.body || 'no body'}`);
    }
  }

  /** Stop the timer (panic / disarm). */
  async stopTimer(uuid: string): Promise<void> {
    await this.get(`/v1/timer/${encodeURIComponent(uuid)}/stop`);
  }

  /** Start a previously-configured timer. */
  async startTimer(uuid: string): Promise<void> {
    await this.get(`/v1/timer/${encodeURIComponent(uuid)}/start`);
  }

  /**
   * Configure a timer as a fixed countdown of `durationSec` and start it.
   * Used by the Action Sequence engine when mode === 'duration'. Mirrors
   * armCountdownToTime's GET-then-PUT-/start pattern so we preserve PP's
   * id object intact.
   */
  async armCountdownDuration(uuid: string, durationSec: number): Promise<void> {
    const getRes = await this.get(`/v1/timer/${encodeURIComponent(uuid)}`);
    if (!getRes.ok) {
      throw new Error(getRes.error || `HTTP ${getRes.status}: GET timer failed: ${getRes.body || 'no body'}`);
    }
    let existing: Record<string, unknown>;
    try { existing = JSON.parse(getRes.body); }
    catch { throw new Error('Could not parse timer GET response.'); }

    const body: Record<string, unknown> = {
      ...existing,
      id: existing.id,
      allows_overrun: existing.allows_overrun ?? false,
      countdown: { duration: Math.max(1, Math.round(durationSec)) },
    };
    delete body.count_down_to_time;

    const putRes = await this.put(`/v1/timer/${encodeURIComponent(uuid)}/start`, body);
    if (!putRes.ok) {
      throw new Error(putRes.error || `HTTP ${putRes.status}: ${putRes.body || 'no body'}`);
    }
  }

  /**
   * Trigger a slide in the currently-active presentation. PP's index is
   * zero-based and refers to the flattened slide list of the active
   * presentation (not playlist items — use triggerPlaylistItem for that).
   */
  async triggerActiveSlide(slideIndex: number): Promise<void> {
    const res = await this.get(`/v1/presentation/active/${Math.max(0, Math.round(slideIndex))}/trigger`);
    if (!res.ok) {
      throw new Error(res.error || `HTTP ${res.status}: ${res.body || 'no body'}`);
    }
  }

  /**
   * Trigger slide `slideIndex` of item `itemIndex` inside the given
   * playlist. Useful when an Action wants to jump straight to a
   * specific slide of a presentation that lives in a service playlist —
   * combines the playlist-item activation and the slide trigger into a
   * single operation.
   */
  async triggerPlaylistSlide(
    playlistUuid: string,
    itemIndex: number,
    slideIndex: number,
  ): Promise<void> {
    const path = `/v1/playlist/${encodeURIComponent(playlistUuid)}/${Math.max(0, Math.round(itemIndex))}/${Math.max(0, Math.round(slideIndex))}/trigger`;
    const res = await this.get(path);
    if (!res.ok) {
      throw new Error(res.error || `HTTP ${res.status}: ${res.body || 'no body'}`);
    }
  }

  // ---- Playlists (for "trigger on music start") ----
  //
  // PP's `/v1/playlists` is the main service playlist tree (presentations,
  // songs, announcements). The Playlist endpoints trigger items by INDEX
  // within a playlist, not by uuid — so we always look up the item index
  // along with its name.

  async listPlaylists(): Promise<PpTimer[]> {
    const res = await this.get('/v1/playlists');
    if (!res.ok) {
      throw new Error(res.error || `HTTP ${res.status}: ${res.body || 'no body'}`);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(res.body); }
    catch { throw new Error('Could not parse playlists.'); }
    // PP's tree: each node has field_type "playlist" | "group" | "folder",
    // plus optional `children`. Recursively flatten so nested playlists
    // appear in the dropdown, prefixed by their folder path
    // (e.g. "Youth Group / Life Youth Outreach").
    return flattenPlaylistTree(parsed);
  }

  async listPlaylistItems(playlistUuid: string): Promise<PpTimer[]> {
    const res = await this.get(`/v1/playlist/${encodeURIComponent(playlistUuid)}`);
    if (!res.ok) {
      throw new Error(res.error || `HTTP ${res.status}: ${res.body || 'no body'}`);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(res.body); }
    catch { throw new Error('Could not parse playlist items.'); }
    // PP returns { id: {playlist}, items: [...] } — items are nested, not top-level.
    const items = (parsed as { items?: unknown }).items ?? parsed;
    return normalizeIdList(items);
  }

  /** Fire item at `index` inside `playlistUuid`. */
  async triggerPlaylistItem(playlistUuid: string, index: number): Promise<void> {
    const res = await this.get(`/v1/playlist/${encodeURIComponent(playlistUuid)}/${index}/trigger`);
    if (!res.ok) {
      throw new Error(res.error || `HTTP ${res.status}: trigger failed: ${res.body || 'no body'}`);
    }
  }

  /**
   * Clear every PP layer — slide, media, video_input, audio, props, messages,
   * announcements. Equivalent to hitting the "Clear All" button in PP. Issues
   * the requests in parallel; if any individual layer fails we log and continue
   * (PP may not have all layers configured in every workflow).
   */
  async clearAllLayers(): Promise<void> {
    const layers = ['slide', 'media', 'video_input', 'audio', 'props', 'messages', 'announcements'];
    await Promise.all(layers.map(async layer => {
      try {
        const res = await this.get(`/v1/clear/layer/${layer}`);
        if (!res.ok) console.warn(`[pp] clear layer ${layer}: HTTP ${res.status}`);
      } catch (err) {
        console.warn(`[pp] clear layer ${layer} failed`, err);
      }
    }));
  }

  /** Reset the timer to its starting value (used after stop). */
  async resetTimer(uuid: string): Promise<void> {
    await this.get(`/v1/timer/${encodeURIComponent(uuid)}/reset`);
  }

  // ---- low-level helpers ----

  private get(path: string) {
    return this.send('GET', path);
  }

  private put(path: string, body: unknown) {
    return this.send('PUT', path, body);
  }

  private send(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) {
    if (!window.runway?.proPresenter) {
      throw new Error('ProPresenter bridge unavailable (running outside Electron?).');
    }
    const next = this.queue.then(() => window.runway!.proPresenter.request({
      host: this.cfg.host,
      port: this.cfg.port,
      method,
      path,
      password: this.cfg.password || undefined,
      body,
    }));
    // Swallow rejections in the queue chain so one failed request doesn't
    // permanently break the queue. Callers still see the original promise.
    this.queue = next.catch(() => undefined);
    return next;
  }
}

/**
 * Convert an absolute epoch-ms target to PP's count_down_to_time shape:
 *   { time_of_day: seconds-into-the-12h-period, period: 'am' | 'pm' }
 *
 * PP's `time_of_day` is hours-within-the-12h-cycle as 0..11 (NOT the
 * displayed 1..12). So:
 *   - 5:00 PM → 5 * 3600 = 18000, period 'pm' (matches GET /v1/timers)
 *   - 12:00 AM → 0, period 'am' (NOT 12*3600 — that gets interpreted as
 *     halfway through the cycle and throws the countdown off by 12 hours)
 *   - 12:30 PM → 1800, period 'pm'
 */
/**
 * PP returns lists of objects with an `id: { uuid, name, index }` envelope —
 * timers, media playlists, media items all use this shape. Pull (uuid, name)
 * out and drop entries without a uuid.
 */
/**
 * PP's `/v1/playlists` returns a tree of nodes:
 *   { id: {uuid, name, index}, field_type: 'playlist' | 'group' | 'folder',
 *     children: PlaylistNode[] }
 * Walk it and return only the leaf playlists (skip pure folders), with each
 * playlist's display name prefixed by the folder path so the operator can
 * tell duplicates apart in the picker.
 */
function flattenPlaylistTree(parsed: unknown): PpTimer[] {
  const out: PpTimer[] = [];
  const walk = (node: unknown, prefix: string) => {
    if (!node || typeof node !== 'object') return;
    const n = node as {
      id?: { uuid?: string; name?: string; index?: number };
      field_type?: string;
      children?: unknown;
    };
    const id = n.id ?? {};
    const name = id.name ?? '(unnamed)';
    const fullName = prefix ? `${prefix} / ${name}` : name;

    // A node is a leaf playlist if its field_type explicitly says 'playlist'.
    // Some PP versions omit field_type on leaves — treat any node with no
    // children as a playlist too. Folders/groups always have a field_type.
    const childArr = Array.isArray(n.children) ? n.children : [];
    const looksLikePlaylist =
      n.field_type === 'playlist'
      || (childArr.length === 0 && n.field_type !== 'group' && n.field_type !== 'folder');
    const looksLikeContainer =
      n.field_type === 'group' || n.field_type === 'folder' || childArr.length > 0;

    if (looksLikePlaylist && id.uuid) {
      out.push({
        uuid: id.uuid,
        name: fullName,
        index: typeof id.index === 'number' ? id.index : undefined,
        raw: n,
      });
    }
    if (looksLikeContainer) {
      for (const child of childArr) walk(child, fullName);
    }
  };

  const list = Array.isArray(parsed) ? parsed : [];
  for (const node of list) walk(node, '');
  return out;
}

/**
 * PP reports colors as { red, green, blue, alpha } floats in 0–1. Convert
 * to a CSS rgb() string; undefined when the shape isn't recognizable.
 */
function ppColorToCss(c: unknown): string | undefined {
  if (!c || typeof c !== 'object') return undefined;
  const { red, green, blue } = c as { red?: unknown; green?: unknown; blue?: unknown };
  if (typeof red !== 'number' || typeof green !== 'number' || typeof blue !== 'number') return undefined;
  const to255 = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  return `rgb(${to255(red)}, ${to255(green)}, ${to255(blue)})`;
}

function normalizeIdList(parsed: unknown): PpTimer[] {
  const list = Array.isArray(parsed) ? parsed : [];
  return list
    .map(item => {
      const rec = item as {
        id?: { uuid?: string; name?: string; index?: number };
        type?: unknown;
        header_color?: unknown;
      };
      const id = rec.id ?? {};
      return {
        uuid: id.uuid ?? '',
        name: id.name ?? '(unnamed)',
        index: typeof id.index === 'number' ? id.index : undefined,
        type: typeof rec.type === 'string' ? rec.type.toLowerCase() : undefined,
        headerColor: ppColorToCss(rec.header_color),
        raw: item,
      };
    })
    .filter(t => t.uuid);
}

function epochMsToCountDownToTime(targetMs: number): { time_of_day: number; period: 'am' | 'pm' } {
  const d = new Date(targetMs);
  const h24 = d.getHours();
  const m = d.getMinutes();
  const s = d.getSeconds();
  // Hour within the 12-hour cycle, encoded as 0..11.
  // 0:00, 12:00 → 0; 1:00, 13:00 → 1; ... 11:00, 23:00 → 11.
  const hForSec = h24 % 12;
  const period: 'am' | 'pm' = h24 < 12 ? 'am' : 'pm';
  return { time_of_day: hForSec * 3600 + m * 60 + s, period };
}
