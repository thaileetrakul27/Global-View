// Types for the JSON the pipeline writes into public/data, and loaders for it.
// The website reads nothing else.

/** A position on a country's -2 to +2 spectrum. */
export type Score = -2 | -1 | 0 | 1 | 2;

export type Confidence = "high" | "medium" | "low";

export interface Axis {
  /** One plain-words line, e.g. "Reformist and anti-establishment to conservative and pro-establishment". */
  summary: string;
  /** Short word for the -2 end, used in labels such as "Leans reformist". */
  left: string;
  /** Short word for the +2 end. */
  right: string;
}

export interface Article {
  url: string;
  /** Outlet domain, e.g. "example.co.th". */
  outlet: string;
  headline_original: string;
  headline_en: string;
  /** ISO 8601 timestamp. */
  published: string;
  /** From data/sources.json; null means the outlet is unrated. */
  outlet_rating: Score | null;
  /** The model's reading of this article; null means it could not say. */
  article_score: Score | null;
  confidence: Confidence;
  /** One sentence explaining the article score. */
  reason: string;
}

export interface Story {
  id: string;
  title: string;
  /** True when three or more scored articles all sit on one side. */
  blindspot: boolean;
  articles: Article[];
}

export interface CountryFile {
  code: string;
  name: string;
  axis: Axis;
  updated: string;
  stories: Story[];
}

/** Article counts per score, plus those with no usable score. */
export interface Balance {
  "-2": number;
  "-1": number;
  "0": number;
  "1": number;
  "2": number;
  unclear: number;
}

export interface IndexCountry {
  name: string;
  stories: number;
  articles: number;
  balance: Balance;
}

export interface IndexFile {
  updated: string;
  countries: Record<string, IndexCountry>;
}

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
