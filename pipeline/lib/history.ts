// Daily snapshots, so the site can show what each country was reading on an
// earlier day. One file per UTC day, overwritten by each run that day, so a
// day's file ends up holding its last state.
import type { SharedStory } from "./shared";
import type { EnrichedArticle } from "./translate";

/** Articles kept per country per day. Small on purpose: the archive lives in git. */
export const SNAPSHOT_ARTICLES = 5;
/** Shared stories kept per day. */
export const SNAPSHOT_STORIES = 10;

export interface SnapshotArticle {
  title: string;
  en?: string;
  url: string;
  outlet: string;
}

export interface SnapshotStory {
  id: string;
  title: string;
  subject: string | null;
  countries: string[];
}

export interface Snapshot {
  /** UTC day, YYYY-MM-DD. */
  date: string;
  /** When this snapshot was last written. */
  updated: string;
  /** Local-edition countries only. */
  countries: Record<string, SnapshotArticle[]>;
  stories: SnapshotStory[];
}

export interface HistoryIndex {
  /** Available days, oldest first. */
  dates: string[];
}

export function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

export function buildSnapshot(
  now: string,
  countries: { code: string; articles: EnrichedArticle[] }[],
  stories: SharedStory[],
): Snapshot {
  const out: Record<string, SnapshotArticle[]> = {};
  for (const c of countries) {
    out[c.code] = c.articles.slice(0, SNAPSHOT_ARTICLES).map((a) => ({
      title: a.title,
      ...(a.en ? { en: a.en } : {}),
      url: a.url,
      outlet: a.outlet,
    }));
  }
  return {
    date: dayOf(now),
    updated: now,
    countries: out,
    stories: stories.slice(0, SNAPSHOT_STORIES).map((s) => ({ id: s.id, title: s.title, subject: s.subject, countries: s.countries })),
  };
}

/** Adds a day to the index, keeping it sorted and free of repeats. */
export function addDay(index: HistoryIndex | null, date: string): HistoryIndex {
  const dates = new Set(index?.dates ?? []);
  dates.add(date);
  return { dates: [...dates].sort() };
}
