/**
 * planningCenterClient — thin wrapper around the Planning Center Services
 * API (read-only). Used to auto-set the pad-bridge key from the week's
 * plan so nobody has to remember to set it.
 *
 * All requests are forwarded through the main process
 * (window.runway.planningCenter.request) because the browser can't call
 * api.planningcenteronline.com directly (no CORS). Auth is HTTP Basic from
 * a Personal Access Token (appId:secret).
 *
 * API shape (Services v2, JSON:API):
 *   GET /services/v2/service_types
 *   GET /services/v2/service_types/{id}/plans?filter=future&order=sort_date&per_page=1
 *   GET /services/v2/service_types/{id}/plans/{planId}/items?per_page=200&order=sequence
 * Song plan items carry attributes.item_type === 'song' and attributes.key_name.
 */

import type { KeyName, PcoSyncConfig } from '@shared/types';
import { pcoKeyToRunway } from '@shared/music';

export interface PcoServiceType {
  id: string;
  name: string;
}

export interface PcoFirstSongKey {
  /** Mapped Runway key, or undefined when PCO's key string didn't resolve. */
  key?: KeyName;
  /** Exact key string PCO returned (for display / diagnostics). */
  rawKey?: string;
  /** First song's title. */
  song?: string;
  /** Plan date, YYYY-MM-DD (local). */
  planDate?: string;
  /** Human-readable plan label (PCO's "dates" string). */
  planLabel?: string;
}

export class PcoClient {
  constructor(private cfg: PcoSyncConfig) {}

  updateConfig(cfg: PcoSyncConfig) {
    this.cfg = cfg;
  }

  private async get(path: string): Promise<{ ok: boolean; status: number; json?: any; error?: string }> {
    if (!window.runway?.planningCenter) {
      return { ok: false, status: 0, error: 'Planning Center bridge unavailable (running outside Electron?).' };
    }
    if (!this.cfg.appId || !this.cfg.secret) {
      return { ok: false, status: 0, error: 'Missing Planning Center App ID / Secret.' };
    }
    const res = await window.runway.planningCenter.request({
      appId: this.cfg.appId,
      secret: this.cfg.secret,
      path,
    });
    if (!res.ok) {
      // PCO returns JSON:API error objects; surface the first detail if present.
      let detail = res.error;
      try {
        const parsed = JSON.parse(res.body);
        detail = parsed?.errors?.[0]?.detail ?? parsed?.error ?? detail;
      } catch { /* non-JSON body */ }
      const reason = res.status === 401
        ? 'Unauthorized — check the App ID and Secret.'
        : detail || `HTTP ${res.status}`;
      return { ok: false, status: res.status, error: reason };
    }
    try {
      return { ok: true, status: res.status, json: JSON.parse(res.body) };
    } catch {
      return { ok: false, status: res.status, error: 'Planning Center returned non-JSON.' };
    }
  }

  /** Handshake — resolves the authenticated org's name, or throws with a reason. */
  async testConnection(): Promise<{ name?: string }> {
    const res = await this.get('/services/v2');
    if (!res.ok) throw new Error(res.error ?? 'Connection failed');
    const name = res.json?.data?.attributes?.name as string | undefined;
    return { name };
  }

  /** List the org's Services service types (e.g. "Sunday Morning"). */
  async listServiceTypes(): Promise<PcoServiceType[]> {
    const res = await this.get('/services/v2/service_types?per_page=100');
    if (!res.ok) throw new Error(res.error ?? 'Could not load service types');
    const data = Array.isArray(res.json?.data) ? res.json.data : [];
    return data
      .map((d: any) => ({ id: String(d.id), name: d?.attributes?.name ?? '(unnamed)' }))
      .filter((s: PcoServiceType) => s.id);
  }

  /**
   * Read the next upcoming plan for `serviceTypeId` and return its first
   * song's key. Returns null when there's no upcoming plan. Throws on
   * connection/auth errors.
   */
  async fetchNextFirstSongKey(serviceTypeId: string): Promise<PcoFirstSongKey | null> {
    // 1) Next future plan, earliest first.
    const planRes = await this.get(
      `/services/v2/service_types/${encodeURIComponent(serviceTypeId)}/plans?filter=future&order=sort_date&per_page=1`,
    );
    if (!planRes.ok) throw new Error(planRes.error ?? 'Could not load plans');
    const plan = Array.isArray(planRes.json?.data) ? planRes.json.data[0] : undefined;
    if (!plan) return null; // no upcoming plan scheduled
    const planId = String(plan.id);
    const sortDate: string | undefined = plan?.attributes?.sort_date;
    const planLabel: string | undefined = plan?.attributes?.dates;
    const planDate = sortDate ? localDateFromIso(sortDate) : undefined;

    // 2) Items in order; find the first song and read its key_name.
    const itemsRes = await this.get(
      `/services/v2/service_types/${encodeURIComponent(serviceTypeId)}/plans/${encodeURIComponent(planId)}/items?per_page=200&order=sequence`,
    );
    if (!itemsRes.ok) throw new Error(itemsRes.error ?? 'Could not load plan items');
    const items = Array.isArray(itemsRes.json?.data) ? itemsRes.json.data : [];
    const firstSong = items.find((it: any) => it?.attributes?.item_type === 'song');
    if (!firstSong) {
      return { planDate, planLabel }; // plan exists but has no song yet
    }
    const rawKey: string | undefined = firstSong?.attributes?.key_name || undefined;
    const song: string | undefined = firstSong?.attributes?.title || undefined;
    return {
      key: pcoKeyToRunway(rawKey),
      rawKey,
      song,
      planDate,
      planLabel,
    };
  }
}

export interface PcoSyncOutcome {
  ok: boolean;
  applied: number;              // how many services got the key set
  result?: PcoFirstSongKey | null;
  reason?: string;              // failure reason or benign note ("No upcoming plan")
}

/**
 * Fetch the next plan's first-song key and apply it to that date's
 * services via `apply`. Shared by the weekly auto-sync and the Settings
 * "Fetch now" button so both behave identically. Never throws — errors
 * come back in `reason`.
 */
export async function runPcoKeySync(
  client: PcoClient,
  cfg: PcoSyncConfig,
  apply: (date: string, key: KeyName) => number,
): Promise<PcoSyncOutcome> {
  if (!cfg.enabled) return { ok: false, applied: 0, reason: 'Planning Center sync is off' };
  if (!cfg.serviceTypeId) return { ok: false, applied: 0, reason: 'No service type selected' };
  try {
    const result = await client.fetchNextFirstSongKey(cfg.serviceTypeId);
    if (!result) return { ok: true, applied: 0, result: null, reason: 'No upcoming plan scheduled' };
    if (!result.key) {
      return {
        ok: true,
        applied: 0,
        result,
        reason: result.rawKey
          ? `Couldn't map key "${result.rawKey}" from Planning Center`
          : (result.song ? 'First song has no key set in Planning Center' : 'Plan has no songs yet'),
      };
    }
    const applied = result.planDate ? apply(result.planDate, result.key) : 0;
    return { ok: true, applied, result };
  } catch (err) {
    return { ok: false, applied: 0, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Convert an ISO datetime to a local YYYY-MM-DD (matches Runway's date keys). */
function localDateFromIso(iso: string): string | undefined {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
