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

/**
 * Spam that search feeds pick up: pirate streams, "watch free" pages and the
 * like. Matched after NFKC normalisation, which folds the styled and
 * full-width letters spammers use (𝐋𝐈𝐕𝐄, Ｆｒｅｅ) back to plain ASCII.
 */
const JUNK =
  /live\s*stream|streams?\s+free|free\s+(live|online|stream)|watch\s*live|\blive\b.{0,40}\b(tv|free|hd)\b|[[(]\s*(live|watch)|™|#!|📺/i;

/** Characters real headlines rarely use: brackets, @, *, $, |, √ and so on. */
const SYMBOLS = /[^\p{L}\p{N}\s.,:;'"‘’“”\-–—!?()&/%+]/gu;
const SPORT = /\b(rugby|league|football|soccer|cricket|match|game|tv|hd)\b/i;

export function isJunkHeadline(title: string): boolean {
  const t = title.normalize("NFKC");
  if (JUNK.test(t)) return true;
  if ((t.match(SYMBOLS) ?? []).length >= 3) return true;
  if (/\bwatch\b.*\b(vs|v)\b/i.test(t)) return true;
  // All-caps LIVE next to a sports word is a stream page, not a live blog.
  return /\bLIVE\b/.test(t) && SPORT.test(t);
}

/** Keeps the first article for each URL and each normalised headline, in order, minus junk. */
export function dedupeArticles(articles: Article[]): Article[] {
  const kept: Article[] = [];
  const seenUrls = new Set<string>();
  const seenTitles = new Set<string>();
  for (const a of articles) {
    const key = titleKey(a.title);
    if (!key || !a.url || seenUrls.has(a.url) || seenTitles.has(key) || isJunkHeadline(a.title)) continue;
    seenUrls.add(a.url);
    seenTitles.add(key);
    kept.push(a);
  }
  return kept;
}
