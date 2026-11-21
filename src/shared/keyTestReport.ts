// Builds the plain-text report for the developer-mode "Key test": compares
// detected keys against the operator's own tags and lays the results out so
// they can be pasted straight into a chat for tuning.
//
// The per-song data lines carry the detector's raw note profiles, which is
// enough to re-score every song with different settings later without
// needing the audio again.

import type { KeyName } from './types';
import { keyRelation, type KeyDetectResult, type KeyRelation } from './keyDetect';

export interface KeyTestRow {
  title: string;
  artist?: string;
  durationSec: number;
  tagged: KeyName;
  /** null = the file couldn't be read / decoded / had no tonal content. */
  result: KeyDetectResult | null;
  error?: string;
}

export interface KeyTestSummary {
  total: number;
  analysed: number;
  failed: number;
  exact: number;
  compatible: number;   // exact, relative major/minor, or a fifth away
  top2: number;
  top3: number;
  byRelation: Record<KeyRelation, number>;
}

export function summariseKeyTest(rows: KeyTestRow[]): KeyTestSummary {
  const byRelation: Record<KeyRelation, number> = { same: 0, relative: 0, fifth: 0, parallel: 0, unrelated: 0 };
  let analysed = 0, top2 = 0, top3 = 0;
  for (const r of rows) {
    if (!r.result) continue;
    analysed += 1;
    byRelation[keyRelation(r.tagged, r.result.key)] += 1;
    const rank = r.result.candidates.findIndex(c => c.key === r.tagged);
    if (rank >= 0 && rank < 2) top2 += 1;
    if (rank >= 0 && rank < 3) top3 += 1;
  }
  return {
    total: rows.length,
    analysed,
    failed: rows.length - analysed,
    exact: byRelation.same,
    compatible: byRelation.same + byRelation.relative + byRelation.fifth,
    top2,
    top3,
    byRelation,
  };
}

const pct = (n: number, d: number): string => (d > 0 ? `${Math.round((100 * n) / d)}%` : '—');
const clean = (s: string): string => s.replace(/[|\r\n]+/g, ' ').trim();
/** 12 values → integers summing to ~1000, space-free and compact. */
const pack = (v: number[]): string => {
  const total = v.reduce((a, b) => a + b, 0);
  return v.map(x => (total > 0 ? Math.round((1000 * x) / total) : 0)).join(',');
};

const RELATION_LABEL: Record<KeyRelation, string> = {
  same: 'match',
  relative: 'relative major/minor',
  fifth: 'a fifth away',
  parallel: 'same root, major vs minor',
  unrelated: 'unrelated',
};

export function buildKeyTestReport(
  rows: KeyTestRow[],
  opts: { appVersion: string; date: string; includeData: boolean },
): string {
  const s = summariseKeyTest(rows);
  const n = s.analysed;
  const out: string[] = [];
  out.push(`RUNWAY KEY TEST v1 · app ${opts.appVersion} · ${opts.date}`);
  out.push(`songs ${s.total} · analysed ${n} · failed ${s.failed}`);
  out.push(`exact ${s.exact}/${n} (${pct(s.exact, n)}) · exact-or-compatible ${s.compatible}/${n} (${pct(s.compatible, n)}) · tag in top 2: ${s.top2}/${n} (${pct(s.top2, n)}) · top 3: ${s.top3}/${n} (${pct(s.top3, n)})`);
  out.push(`misses: relative ${s.byRelation.relative} · fifth ${s.byRelation.fifth} · parallel ${s.byRelation.parallel} · unrelated ${s.byRelation.unrelated}`);

  // How trustworthy is the confidence number?
  const bands: string[] = [];
  for (const t of [0.3, 0.5, 0.7]) {
    const sel = rows.filter(r => r.result && r.result.confidence >= t);
    const ok = sel.filter(r => r.result!.key === r.tagged).length;
    bands.push(`>=${t}: ${ok}/${sel.length} exact`);
  }
  out.push(`by confidence: ${bands.join(' · ')}`);

  const misses = rows.filter(r => r.result && r.result.key !== r.tagged);
  out.push('');
  out.push(`--- MISSES (${misses.length}) ---`);
  for (const r of misses) {
    const res = r.result!;
    const others = res.candidates.slice(1).map(c => `${c.key} ${c.score.toFixed(2)}`).join(', ');
    out.push(
      `${clean(r.title)}${r.artist ? ` — ${clean(r.artist)}` : ''} | tagged ${r.tagged} | detected ${res.key} ` +
      `${res.candidates[0].score.toFixed(2)} (${Math.round(res.confidence * 100)}% sure, ${RELATION_LABEL[keyRelation(r.tagged, res.key)]}) | then ${others}`,
    );
  }

  const failed = rows.filter(r => !r.result);
  if (failed.length) {
    out.push('');
    out.push(`--- COULD NOT ANALYSE (${failed.length}) ---`);
    for (const r of failed) out.push(`${clean(r.title)} | tagged ${r.tagged} | ${clean(r.error ?? 'no tonal content')}`);
  }

  if (opts.includeData) {
    out.push('');
    out.push('--- DATA (one line per song, for re-scoring) ---');
    out.push('title|tagged|detected|confidence|tuning cents|seconds|notes|bass|intro bass|outro bass');
    for (const r of rows) {
      if (!r.result) continue;
      const res = r.result;
      out.push([
        clean(r.title).slice(0, 40),
        r.tagged,
        res.key,
        res.confidence.toFixed(2),
        Math.round(res.tuningCents),
        Math.round(r.durationSec),
        pack(res.chroma.harm),
        pack(res.chroma.bass),
        pack(res.chroma.introBass),
        pack(res.chroma.outroBass),
      ].join('|'));
    }
  }
  return out.join('\n');
}
