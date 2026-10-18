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
}

export interface CountryFile {
  code: string;
  name: string;
  /** When this country's list was last refreshed. */
  updated: string;
  source: { name: string; edition: string; url: string };
  articles: Article[];
}

export interface IndexCountry {
  name: string;
  articles: number;
  updated: string;
}

export interface IndexFile {
  /** When the pipeline last ran. */
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
