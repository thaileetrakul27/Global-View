// Types for the JSON the pipeline writes into public/data, and loaders for it.
// The website reads nothing else.

export interface Article {
  title: string;
  /** Link to the article (a Google News link that redirects to the publisher). */
  url: string;
  /** Publisher name, e.g. "Bangkok Post". */
  outlet: string;
  /** Publisher home page, when known. */
  outletUrl: string | null;
  /** ISO 8601 publish time. */
  published: string;
  /** English headline, when translated. Equals title for English headlines. */
  en?: string;
  /** Country codes the headline is about, when known. */
  about?: string[];
}

/**
 * local: the country's own Google News top stories, what its public reads.
 * world: the country has no edition, so this is coverage about it from elsewhere.
 */
export type CoverageKind = "local" | "world";

export interface CountryFile {
  code: string;
  name: string;
  /** Absent in older files, which are all local. */
  kind?: CoverageKind;
  /** When this country's list was last refreshed. */
  updated: string;
  source: { name: string; edition: string; url: string };
  articles: Article[];
}

export interface IndexCountry {
  name: string;
  kind?: CoverageKind;
  articles: number;
  updated: string;
}

export interface IndexFile {
  /** When the pipeline last ran. */
  updated: string;
  countries: Record<string, IndexCountry>;
}

export interface SharedArticle {
  code: string;
  url: string;
  title: string;
  en: string;
  outlet: string;
  about?: string[];
}

export interface SharedStory {
  id: string;
  title: string;
  /** When the story was first seen; absent in older files. */
  since?: string;
  /** The country the story is mostly about; absent in older files. */
  subject?: string | null;
  /** Country codes reading it, most first. */
  countries: string[];
  articles: SharedArticle[];
}

export interface SharedFile {
  updated: string;
  stories: SharedStory[];
}

export interface AttentionFile {
  updated: string;
  /** mentions[TH][US] = how many of Thailand's top stories are about the US. */
  mentions: Record<string, Record<string, number>>;
}

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

/** One UTC day as the pipeline last saw it. Local-edition countries only. */
export interface Snapshot {
  date: string;
  updated: string;
  countries: Record<string, SnapshotArticle[]>;
  stories: SnapshotStory[];
}

export interface HistoryIndex {
  /** Available days, oldest first, YYYY-MM-DD. */
  dates: string[];
}

/** Optional files: null when the pipeline has not produced them yet. */
async function loadOptional<T>(path: string): Promise<T | null> {
  const res = await fetch(path);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Could not load ${path} (${res.status})`);
  return (await res.json()) as T;
}

export const loadShared = () => loadOptional<SharedFile>("/data/shared.json");
export const loadAttention = () => loadOptional<AttentionFile>("/data/attention.json");
export const loadHistoryIndex = () => loadOptional<HistoryIndex>("/data/history/index.json");
export const loadSnapshot = (date: string) => loadOptional<Snapshot>(`/data/history/${date}.json`);

export async function loadIndex(): Promise<IndexFile> {
  const res = await fetch("/data/index.json");
  if (!res.ok) throw new Error(`Could not load index (${res.status})`);
  return (await res.json()) as IndexFile;
}

/** Resolves to null when the country has no data file. */
export async function loadCountry(code: string): Promise<CountryFile | null> {
  const res = await fetch(`/data/countries/${code}.json`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Could not load ${code} (${res.status})`);
  return (await res.json()) as CountryFile;
}
