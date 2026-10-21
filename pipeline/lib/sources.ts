// The feeds behind each country's list, and the step that turns them into
// the list the site shows.
//
// A local edition reads Google News: its top stories and its NATION and
// WORLD sections, one request every `delayMs`. Alongside them, since Bing
// is another host, it reads one page of a Bing News search in the
// country's own language. World coverage reads Bing News in the press
// language and a Google News search in English, also side by side. Any
// one feed answering is enough, except that a local edition needs one of
// its Google News feeds: the Bing search alone is a keyword search, not
// the edition's news. When that fails, the country keeps its previous
// file. Stories older than a week are left out of every list.
import { fetchBingFeed } from "./bingnews";
import { dedupeArticles, usableArticles } from "./clean";
import type { CountryConfig } from "./countries";
import { buildSearchUrl, buildSectionUrl, fetchFeed, fetchFeedUrl, type Article, type FetchDeps } from "./googlenews";
import { rankStories } from "./trending";

export type Service = "Google News" | "Bing News";

/** Articles older than this are left out: a search can return pages years old. */
export const MAX_AGE_DAYS = 7;

/** What one country's feeds returned. */
export interface Sources {
  /** The feed recorded in the country file: the first that answered. */
  url: string;
  /** Every article fetched, in feed order: top stories first. */
  articles: Article[];
  /** Links in Google's top-stories feed, in its order; empty when it failed or for world coverage. */
  top: string[];
  /** The services that answered, in the order they are read. */
  services: Service[];
}

type Feed = { url: string; articles: Article[] } | null;

/** Runs requests one after another, `delayMs` apart. */
async function paced(requests: (() => Promise<Feed>)[], delayMs: number, deps: FetchDeps): Promise<Feed[]> {
  const out: Feed[] = [];
  for (const [i, request] of requests.entries()) {
    if (i > 0) await deps.sleep(delayMs);
    out.push(await request());
  }
  return out;
}

/** Joins the feeds that answered; null when none did. */
export function combine(parts: [Service, Feed][], top: Feed): Sources | null {
  const ok = parts.filter((p): p is [Service, NonNullable<Feed>] => p[1] !== null);
  if (!ok.length) return null;
  return {
    url: ok[0][1].url,
    articles: ok.flatMap(([, f]) => f.articles),
    top: top?.articles.map((a) => a.url) ?? [],
    services: [...new Set(ok.map(([s]) => s))],
  };
}

/**
 * A local edition's feeds: Google News top stories, NATION and WORLD, and
 * the Bing News search when the country has one (`country.local`). Null
 * when none of the Google News feeds answered, even if Bing did, so a
 * Google outage keeps the edition's previous list.
 */
export async function fetchLocalSources(country: CountryConfig, delayMs: number, deps: FetchDeps): Promise<Sources | null> {
  const edition = country.edition;
  if (!edition) return null;
  const search = country.local;
  const [[top, nation, world], bing] = await Promise.all([
    paced(
      [
        () => fetchFeed(edition, delayMs, deps),
        () => fetchFeedUrl(buildSectionUrl(edition, "NATION"), `${edition.ceid} NATION`, delayMs, deps),
        () => fetchFeedUrl(buildSectionUrl(edition, "WORLD"), `${edition.ceid} WORLD`, delayMs, deps),
      ],
      delayMs,
      deps,
    ),
    search ? fetchBingFeed(search.name, country.code, search.lang, delayMs, deps, 1) : Promise.resolve(null),
  ]);
  if (!top && !nation && !world) {
    deps.log(`  ${country.code}: no Google News feed answered`);
    return null;
  }
  return combine(
    [
      ["Google News", top],
      ["Google News", nation],
      ["Google News", world],
      ["Bing News", bing],
    ],
    top,
  );
}

/**
 * World coverage: what the country's own outlets publish, from Bing News
 * in the press language, and Google News search results in English.
 */
export async function fetchWorldSources(country: CountryConfig, delayMs: number, deps: FetchDeps): Promise<Sources | null> {
  const local = country.local ?? { lang: "en", name: country.name };
  const [bing, google] = await Promise.all([
    fetchBingFeed(local.name, country.code.slice(0, 2), local.lang, delayMs, deps),
    fetchFeedUrl(buildSearchUrl(country.query ?? `"${country.name}"`), country.code, delayMs, deps),
  ]);
  return combine(
    [
      ["Bing News", bing],
      ["Google News", google],
    ],
    null,
  );
}

/**
 * The list the site shows: junk, repeated links and articles older than
 * MAX_AGE_DAYS dropped, one article per story, ranked by trending.ts, at
 * most `max`. A headline that
 * several outlets run counts each of them; any repeat of it left after
 * ranking (copies days apart are never one story) is dropped. Lexical
 * only, so nothing is translated that is then thrown away.
 */
export function buildList(sources: Sources, max: number, now: string): Article[] {
  const recent = usableArticles(sources.articles).filter((a) => isRecent(a, now));
  return dedupeArticles(rankStories(recent, sources.top, now)).slice(0, max);
}

/** Whether an article is at most MAX_AGE_DAYS old at `now`. */
export function isRecent(article: Pick<Article, "published">, now: string): boolean {
  return Date.parse(now) - Date.parse(article.published) <= MAX_AGE_DAYS * 86_400_000;
}

/** Where a list came from, for the country file: "Google News and Bing News". */
export function sourceName(services: Service[]): string {
  return services.join(" and ");
}
