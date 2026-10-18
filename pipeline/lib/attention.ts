// Who is reading about whom: counts, per country, how many of its top
// stories are about each other country.
import type { EnrichedArticle } from "./translate";

export interface AttentionFile {
  updated: string;
  /** mentions[TH][US] = how many of Thailand's top stories are about the US. */
  mentions: Record<string, Record<string, number>>;
}

export function buildAttention(countries: { code: string; articles: EnrichedArticle[] }[], updated: string): AttentionFile {
  const mentions: Record<string, Record<string, number>> = {};
  for (const c of countries) {
    const row: Record<string, number> = {};
    for (const a of c.articles) {
      for (const code of a.about ?? []) {
        if (code === c.code) continue; // domestic news is not attention abroad
        row[code] = (row[code] ?? 0) + 1;
      }
    }
    if (Object.keys(row).length) mentions[c.code] = row;
  }
  return { updated, mentions };
}
