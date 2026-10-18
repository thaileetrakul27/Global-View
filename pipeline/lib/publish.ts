// Shapes of the files the website reads, and the logic that merges a run's
// results with what was published before.
import fs from "node:fs";
import type { Article } from "./googlenews";

export interface CountryFile {
  code: string;
  name: string;
  /** When this country's list was last refreshed. */
  updated: string;
  source: { name: string; edition: string; url: string };
  articles: Article[];
}

export interface IndexEntry {
  name: string;
  articles: number;
  updated: string;
}

export interface IndexFile {
  /** When the pipeline last ran. */
  updated: string;
  countries: Record<string, IndexEntry>;
}

export function readIndex(path: string): IndexFile | null {
  if (!fs.existsSync(path)) return null;
  return JSON.parse(fs.readFileSync(path, "utf8")) as IndexFile;
}

/**
 * Builds the new index: fresh entries for countries that fetched, previous
 * entries kept for countries that failed (their old file stays live), and
 * entries dropped for countries no longer in the run's list.
 */
export function mergeIndex(
  previous: IndexFile | null,
  fresh: Record<string, IndexEntry>,
  failed: string[],
  now: string,
): IndexFile {
  const countries: Record<string, IndexEntry> = { ...fresh };
  for (const code of failed) {
    const old = previous?.countries[code];
    if (old) countries[code] = old;
  }
  return { updated: now, countries };
}
