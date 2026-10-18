// Who is reading about whom: counts, per country, how many of its top
// stories are about each other country.
import type { EnrichedArticle } from "./translate";

export interface AttentionFile {
  updated: string;
  /** mentions[TH][US] = how many of Thailand's top stories are about the US. */
  mentions: Record<string, Record<string, number>>;
}

/** A foreign top story about a country, with where it was read. */
export interface AboutArticle {
  /** Country whose top stories this came from. */
  from: string;
  url: string;
  title: string;
  en?: string;
  outlet: string;
  published: string;
}

export interface AboutFile {
  code: string;
  updated: string;
  articles: AboutArticle[];
}

/**
 * For every country that appears in other countries' top stories, the
 * articles themselves, newest first. Domestic stories are left out.
 */
export function buildAboutFiles(countries: { code: string; articles: EnrichedArticle[] }[], updated: string): Record<string, AboutFile> {
  const out: Record<string, AboutFile> = {};
  for (const c of countries) {
    for (const a of c.articles) {
      for (const code of a.about ?? []) {
        if (code === c.code) continue;
        const file = (out[code] ??= { code, updated, articles: [] });
        file.articles.push({ from: c.code, url: a.url, title: a.title, ...(a.en ? { en: a.en } : {}), outlet: a.outlet, published: a.published });
      }
    }
  }
  for (const f of Object.values(out)) f.articles.sort((x, y) => y.published.localeCompare(x.published));
  return out;
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
