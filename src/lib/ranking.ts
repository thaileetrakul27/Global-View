// Wording for how a country's list was made, and for the marks the
// pipeline's story ranking (pipeline/lib/trending.ts) puts on articles.
import type { CountryFile } from "./data";

/** "5 outlets" when more than one outlet carries the story, else null. */
export function outletsLabel(outlets: number | undefined): string | null {
  return outlets !== undefined && outlets > 1 ? `${outlets} outlets` : null;
}

/** Whether a list was grouped and ranked by story. Older files are in feed order and carry no outlet counts. */
export function isRanked(articles: { outlets?: number }[]): boolean {
  return articles.some((a) => a.outlets !== undefined);
}

const RANKED = "grouped by story and ranked by how recent it is and how many outlets carry it";
const TAIL = "Translations are automatic. Links open the publisher.";

/** Where a local list's headlines came from, from the file's source name. */
function localSources(sourceName: string): string {
  const google = sourceName.includes("Google News");
  const bing = sourceName.includes("Bing News");
  if (google && bing) return "Google News top stories and sections and Bing News";
  if (google) return "Google News top stories and sections";
  return sourceName;
}

/** The line under a country's list: where it came from and how it was ordered. */
export function listFooter(file: Pick<CountryFile, "kind" | "source" | "articles">, name: string): string {
  const ranked = isRanked(file.articles);
  if (file.kind === "world") {
    return ranked
      ? `Recent ${file.source.name} search results about ${name}, grouped by story and ranked by how recent they are and how many outlets carry them. ${TAIL}`
      : `Recent ${file.source.name} search results about ${name}. ${TAIL}`;
  }
  return ranked ? `From ${localSources(file.source.name)}, ${RANKED}. ${TAIL}` : `Ranked by ${file.source.name} top stories, ${name} edition. ${TAIL}`;
}
