// Pure helpers for reading story data. No DOM, so they are easy to test and
// can be shared with the pipeline.
import type { Article, Axis, Balance, Score } from "./data";

export const SCORES: Score[] = [-2, -1, 0, 1, 2];

/**
 * The score the site should display for an article. Low confidence counts as
 * no score at all, so the site never forces a label it cannot back up.
 */
export function effectiveScore(a: Pick<Article, "article_score" | "confidence">): Score | null {
  if (a.article_score === null || a.confidence === "low") return null;
  return a.article_score;
}

export function emptyBalance(): Balance {
  return { "-2": 0, "-1": 0, "0": 0, "1": 0, "2": 0, unclear: 0 };
}

/** Counts articles per effective score. */
export function countBalance(articles: Article[]): Balance {
  const b = emptyBalance();
  for (const a of articles) {
    const s = effectiveScore(a);
    if (s === null) b.unclear++;
    else b[String(s) as `${Score}`]++;
  }
  return b;
}

/** Three or more scored articles, all left of centre or all right of it. */
export function isBlindspot(articles: Article[]): boolean {
  const scores = articles.map(effectiveScore).filter((s): s is Score => s !== null);
  if (scores.length < 3) return false;
  return scores.every((s) => s > 0) || scores.every((s) => s < 0);
}

/** Which side of a story is missing when it is a blindspot, for the tag text. */
export function blindspotSide(articles: Article[], axis: Axis): string | null {
  if (!isBlindspot(articles)) return null;
  const scores = articles.map(effectiveScore).filter((s): s is Score => s !== null);
  return scores[0] > 0 ? axis.left : axis.right;
}

/** Human label for a score on a given axis, e.g. "Leans reformist". */
export function scoreLabel(score: Score | null, axis: Axis): string {
  switch (score) {
    case -2:
      return `Strongly ${axis.left}`;
    case -1:
      return `Leans ${axis.left}`;
    case 0:
      return "Centre";
    case 1:
      return `Leans ${axis.right}`;
    case 2:
      return `Strongly ${axis.right}`;
    default:
      return "Unclear";
  }
}

/** Label for an outlet's stored rating; unrated outlets never get a guess. */
export function outletLabel(rating: Score | null, axis: Axis): string {
  return rating === null ? "Unrated" : scoreLabel(rating, axis);
}

/** "Updated 2 hours ago" style text. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const diff = Math.max(0, now - Date.parse(iso));
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} days ago`;
}

/** Short outlet name for display: the domain without "www." or the TLD. */
export function outletName(domain: string): string {
  return domain.replace(/^www\./, "").replace(/\.[a-z.]+$/i, "");
}
