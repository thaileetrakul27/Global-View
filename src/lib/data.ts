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

/** A foreign top story about a country, with where it was read. */
export interface AboutArticle {
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

export interface WatchingEntry {
  code: string;
  editions: number;
  baseline: number | null;
  share: number;
  sample: string[];
}

export interface UnwatchedEntry {
  code: string;
  matching: number;
  total: number;
  editions: number;
  sample: string[];
}

export type AlertLevel = "Orange" | "Red";
export type AlertType = "earthquake" | "cyclone" | "flood" | "drought" | "wildfire" | "volcano" | "other";

/** A verified disaster alert from GDACS, the UN and EU alert system. */
export interface Alert {
  id: string;
  type: AlertType;
  level: AlertLevel;
  title: string;
  /** GDACS's plain-language summary of the event, when it gives one. */
  description: string | null;
  /** Named event, e.g. a cyclone name. */
  name: string | null;
  /** Countries the alert names, primary first. */
  countries: string[];
  from: string;
  to: string;
  /** Report page on gdacs.org. */
  url: string;
}

/** An alert whose main country almost no edition is reading about. */
export interface QuietEntry {
  code: string;
  alert: string;
  editions: number;
}

/** Humanitarian signals: verified alerts plus estimates from headlines. */
export interface CrisesFile {
  updated: string;
  /** Countries the world has suddenly turned to, with emergency headlines. */
  watching: WatchingEntry[];
  /** Countries whose own news is an emergency almost nobody else is reading about. */
  unwatched: UnwatchedEntry[];
  /** Current Orange and Red GDACS alerts, Red first. */
  alerts: Alert[];
  /** Alerts whose main country few editions are reading about. */
  quiet: QuietEntry[];
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
export const loadAbout = (code: string) => loadOptional<AboutFile>(`/data/about/${code}.json`);
/** A country's own Red Cross or Red Crescent society, from IFRC's directory. */
export interface Society {
  name: string;
  url: string | null;
  directory: string | null;
  /** Its page on the Red Cross Red Crescent donation platform, when it is on it. */
  donate: string | null;
  checked: string | null;
}

/** An active IFRC appeal; amounts in Swiss francs. */
export interface Appeal {
  code: string;
  country: string;
  name: string;
  kind: string;
  disaster: string;
  requested: number;
  funded: number;
  people: number | null;
  start: string;
  end: string;
  url: string;
  event: number | null;
}

/** An IFRC GO emergency: what is happening, in IFRC's words. */
export interface Emergency {
  id: number;
  name: string;
  summary: string | null;
  severity: string | null;
  figures: { number: string; label: string; source: string | null }[];
}

/** A UN-coordinated humanitarian response plan; amounts in US dollars. */
export interface Plan {
  id: number;
  name: string;
  countries: string[];
  required: number;
  funded: number | null;
  end: string;
  url: string;
}

/** Where help is needed and where to send it, from IFRC and UN OCHA. */
export interface HelpFile {
  updated: string;
  sources: { societies: string | null; appeals: string | null; plans: string | null; events: string | null; uncr: string | null };
  societies: Record<string, Society>;
  appeals: Appeal[];
  plans: Plan[];
  /** IFRC GO emergencies behind the appeals, by id. */
  events: Record<string, Emergency>;
  /** UN Crisis Relief donation pages, by country code. */
  uncr: Record<string, string>;
}

/** Files written before emergencies and UN pages existed lack those maps. */
export const loadHelp = async (): Promise<HelpFile | null> => {
  const h = await loadOptional<HelpFile>("/data/help.json");
  return h ? { ...h, events: h.events ?? {}, uncr: h.uncr ?? {} } : null;
};

/** Files written before alerts existed lack the two alert lists. */
export const loadCrises = async (): Promise<CrisesFile | null> => {
  const c = await loadOptional<CrisesFile>("/data/crises.json");
  return c ? { ...c, alerts: c.alerts ?? [], quiet: c.quiet ?? [] } : null;
};

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
