// Removes duplicates and non-news sources from a raw article list.
import fs from "node:fs";
import type { RawArticle } from "./gdelt";

/** Lower-cases, strips punctuation and squashes spaces so near-identical headlines match. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function loadNonNewsDomains(path = "pipeline/config/non-news-domains.json"): string[] {
  const parsed = JSON.parse(fs.readFileSync(path, "utf8")) as { domains: string[] };
  return parsed.domains.map((d) => d.toLowerCase());
}

/** True unless the domain, or a parent of it, is on the block list. */
export function isNewsDomain(domain: string, blocked: string[]): boolean {
  const d = domain.toLowerCase();
  return !blocked.some((b) => d === b || d.endsWith(`.${b}`));
}

/**
 * Key used to spot duplicate headlines. Whitespace is dropped entirely because
 * scripts such as Thai have no word spaces, so spacing differences are noise.
 */
export function titleKey(title: string): string {
  return normalizeTitle(title).replace(/\s+/g, "");
}

export interface CleanResult {
  kept: RawArticle[];
  dropped: { duplicates: number; nonNews: number; empty: number };
}

/**
 * Keeps the first article for each URL and each normalised headline, drops
 * non-news domains and articles with no headline. Order is preserved.
 */
export function cleanArticles(articles: RawArticle[], blocked: string[]): CleanResult {
  const kept: RawArticle[] = [];
  const dropped = { duplicates: 0, nonNews: 0, empty: 0 };
  const seenUrls = new Set<string>();
  const seenTitles = new Set<string>();

  for (const a of articles) {
    const title = titleKey(a.title);
    if (!title || !a.url) {
      dropped.empty++;
      continue;
    }
    if (!isNewsDomain(a.domain, blocked)) {
      dropped.nonNews++;
      continue;
    }
    if (seenUrls.has(a.url) || seenTitles.has(title)) {
      dropped.duplicates++;
      continue;
    }
    seenUrls.add(a.url);
    seenTitles.add(title);
    kept.push(a);
  }
  return { kept, dropped };
}
