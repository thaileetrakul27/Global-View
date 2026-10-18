// Spots two kinds of humanitarian signal in the data:
//   watching: a country has suddenly entered many countries' top stories,
//             and most of those stories describe an emergency;
//   unwatched: a country's own top stories are dominated by an emergency
//              that almost nobody else is reading about.
// Both are computed from headlines alone and are estimates.
import fs from "node:fs";
import type { AboutFile, AttentionFile } from "./attention";
import type { EnrichedArticle } from "./translate";

export interface CrisisTerms {
  terms: string[];
}

export function loadCrisisTerms(path = "pipeline/config/crisis-terms.json"): CrisisTerms {
  return JSON.parse(fs.readFileSync(path, "utf8")) as CrisisTerms;
}

/** True when any term appears as a whole word or phrase in the headline. */
export function isCrisisHeadline(text: string, terms: CrisisTerms): boolean {
  const t = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ")} `;
  return terms.terms.some((term) => t.includes(` ${term.toLowerCase()} `));
}

/** For each country, how many distinct editions have it in their top stories. */
export function inboundEditions(att: AttentionFile): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of Object.values(att.mentions)) {
    for (const code of Object.keys(row)) out[code] = (out[code] ?? 0) + 1;
  }
  return out;
}

export interface WatchingEntry {
  code: string;
  /** Editions with the country in their top stories today. */
  editions: number;
  /** Typical editions over previous days, or null when too little history. */
  baseline: number | null;
  /** Share of the foreign stories about it that describe an emergency. */
  share: number;
  /** A few of those headlines, in English. */
  sample: string[];
}

export interface UnwatchedEntry {
  code: string;
  /** Emergency stories among the country's own top stories. */
  matching: number;
  total: number;
  editions: number;
  sample: string[];
}

export interface CrisesFile {
  updated: string;
  watching: WatchingEntry[];
  unwatched: UnwatchedEntry[];
}

export interface CrisisInput {
  attention: AttentionFile;
  abouts: Record<string, AboutFile>;
  /** Local-edition countries with their own top stories. */
  locals: { code: string; articles: EnrichedArticle[] }[];
  /** Per country, inbound edition counts on previous days (oldest first). */
  baselines: Record<string, number[]>;
  terms: CrisisTerms;
  now: string;
}

/** Spike rules. With under three days of history a fixed bar applies instead. */
export const MIN_EDITIONS = 8;
export const COLD_START_EDITIONS = 15;
export const MIN_SHARE = 0.4;
export const MIN_MATCHING = 3;
/** Unwatched rules. */
export const UNWATCHED_MAX_EDITIONS = 2;
export const UNWATCHED_MIN_MATCHING = 4;
export const UNWATCHED_MIN_SHARE = 0.3;
export const UNWATCHED_LIMIT = 8;

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function detectCrises(input: CrisisInput): CrisesFile {
  const editions = inboundEditions(input.attention);
  const watching: WatchingEntry[] = [];
  for (const [code, e] of Object.entries(editions)) {
    const articles = input.abouts[code]?.articles ?? [];
    const matching = articles.filter((a) => isCrisisHeadline(a.en ?? a.title, input.terms));
    const share = articles.length ? matching.length / articles.length : 0;
    const history = input.baselines[code] ?? [];
    const baseline = history.length >= 3 ? median(history) : null;
    const spike = baseline === null ? e >= COLD_START_EDITIONS : e >= Math.max(MIN_EDITIONS, 2 * baseline);
    if (spike && share >= MIN_SHARE && matching.length >= MIN_MATCHING) {
      watching.push({ code, editions: e, baseline, share: Math.round(share * 100) / 100, sample: matching.slice(0, 3).map((a) => a.en ?? a.title) });
    }
  }
  watching.sort((a, b) => b.editions - a.editions);

  const unwatched: UnwatchedEntry[] = [];
  for (const c of input.locals) {
    const domestic = c.articles.filter((a) => (a.about ?? []).includes(c.code));
    const matching = domestic.filter((a) => isCrisisHeadline(a.en ?? a.title, input.terms));
    const e = editions[c.code] ?? 0;
    if (matching.length >= UNWATCHED_MIN_MATCHING && matching.length / c.articles.length >= UNWATCHED_MIN_SHARE && e <= UNWATCHED_MAX_EDITIONS) {
      unwatched.push({ code: c.code, matching: matching.length, total: c.articles.length, editions: e, sample: matching.slice(0, 3).map((a) => a.en ?? a.title) });
    }
  }
  unwatched.sort((a, b) => b.matching / b.total - a.matching / a.total || b.matching - a.matching);

  return { updated: input.now, watching, unwatched: unwatched.slice(0, UNWATCHED_LIMIT) };
}
