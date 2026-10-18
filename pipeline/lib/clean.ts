// Removes duplicate articles from a feed.
import type { Article } from "./googlenews";

/** Lower-cases, strips punctuation and squashes spaces so near-identical headlines match. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Key used to spot duplicate headlines. Whitespace is dropped entirely because
 * scripts such as Thai have no word spaces, so spacing differences are noise.
 */
export function titleKey(title: string): string {
  return normalizeTitle(title).replace(/\s+/g, "");
}

/** Keeps the first article for each URL and each normalised headline, in order. */
export function dedupeArticles(articles: Article[]): Article[] {
  const kept: Article[] = [];
  const seenUrls = new Set<string>();
  const seenTitles = new Set<string>();
  for (const a of articles) {
    const key = titleKey(a.title);
    if (!key || !a.url || seenUrls.has(a.url) || seenTitles.has(key)) continue;
    seenUrls.add(a.url);
    seenTitles.add(key);
    kept.push(a);
  }
  return kept;
}
