// Wording for how a country's list was made, and for the marks the
// pipeline's story ranking (pipeline/lib/trending.ts) puts on articles.
import type { CountryFile } from "./data";

/** Tooltip for the "Trending" tag: what it means, with the outlet count when known. */
export function trendingTitle(outlets: number | undefined): string {
  const count = outlets !== undefined && outlets > 1 ? `${outlets} outlets` : "many outlets";
  return `Recent, and carried by ${count} in the feeds read`;
}

/** Whether a list was grouped and ranked by story. Older files are in feed order and carry no outlet counts. */
export function isRanked(articles: { outlets?: number }[]): boolean {
  return articles.some((a) => a.outlets !== undefined);
}

// Kept short: on a phone the footer must fit in two lines under the list.
const TAIL = "Translations are automatic.";
const OLD_TAIL = "Translations are automatic. Links open the publisher.";

/**
 * The line under a country's list: where it came from and how it was
 * ordered. Both kinds are grouped by story and ranked by recency and
 * outlets; a local list also by Google's top-stories order when Google News
 * answered, and world coverage is called a search. Only older files with
 * articles but no ranking marks keep the old wording, so an empty list never
 * gets the old edition sentence.
 */
export function listFooter(file: Pick<CountryFile, "kind" | "source" | "articles">, name: string): string {
  const world = file.kind === "world";
  if (file.articles.length > 0 && !isRanked(file.articles)) {
    return world ? `Recent ${file.source.name} search results about ${name}. ${OLD_TAIL}` : `Ranked by ${file.source.name} top stories, ${name} edition. ${OLD_TAIL}`;
  }
  if (world) return `${file.source.name} search results, ranked by recency and outlets. ${TAIL}`;
  const top = file.source.name.includes("Google News") ? ", outlets and Google's top stories" : " and outlets";
  return `${file.source.name}, ranked by recency${top}. ${TAIL}`;
}
