// The feeds behind each country's list, and the step that turns them into
// the list the site shows.
//
// A local edition reads Google News, one request every `delayMs`: its top
// stories, its NATION and WORLD sections, and its TECHNOLOGY and
// ENTERTAINMENT sections, whose links only label soft news for the
// ranking (softLinks). Alongside them, since Bing is another host, it
// reads one page of a Bing News search in the country's own language. World
// coverage reads Bing News in the press language and a Google News search
// in English, also side by side. Any one feed answering is enough, except
// that a local edition needs its top stories, NATION or WORLD: the Bing
// search alone is a keyword search, not the edition's news. When that
// fails, the country keeps its previous file. Stories older than a week
// are left out of every list.
import { fetchBingFeed } from "./bingnews";
import { dedupeArticles, usableArticles } from "./clean";
import type { CountryConfig } from "./countries";
import { buildSearchUrl, buildSectionUrl, fetchFeed, fetchFeedUrl, type Article, type FetchDeps, type Section } from "./googlenews";
import { HEADLINE_POSITIONS, rankStories, type Labels } from "./trending";

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
  /** Links the edition's sections label hard or soft news (softLinks); empty for world coverage. */
  labels: Labels;
}

type Feed = { url: string; articles: Article[] } | null;

/** After its headlines, Google's top-stories feed gives each section a block of this many items. */
export const SECTION_BLOCK = 4;

/**
 * An edition's soft links: those in its TECHNOLOGY and ENTERTAINMENT
 * sections, and every link of a block of the top-stories feed that holds
 * one of them and no hard link. After the HEADLINE_POSITIONS headlines the
 * feed gives SECTION_BLOCK items to each section in turn (World, Business,
 * Technology, Entertainment, Sports, Science, Health; some editions skip
 * a few), and not every item of a block is in its section's own feed, so
 * the block is labelled whole.
 *
 * @param top links in the top-stories feed, in its order
 * @param hard links in the NATION and WORLD sections
 * @param softSections links in the TECHNOLOGY and ENTERTAINMENT sections
 */
export function softLinks(top: string[], hard: string[], softSections: string[]): string[] {
  const isHard = new Set(hard);
  const inSection = new Set(softSections);
  const soft = new Set(softSections);
  for (let start = HEADLINE_POSITIONS; start < top.length; start += SECTION_BLOCK) {
    const block = top.slice(start, start + SECTION_BLOCK);
    if (block.some((u) => inSection.has(u)) && !block.some((u) => isHard.has(u))) for (const u of block) soft.add(u);
  }
  return [...soft];
}

/** The links of the feeds that answered, in order. */
function links(...feeds: Feed[]): string[] {
  return feeds.flatMap((f) => f?.articles.map((a) => a.url) ?? []);
}

/** Runs requests one after another, `delayMs` apart. */
async function paced(requests: (() => Promise<Feed>)[], delayMs: number, deps: FetchDeps): Promise<Feed[]> {
  const out: Feed[] = [];
  for (const [i, request] of requests.entries()) {
    if (i > 0) await deps.sleep(delayMs);
    out.push(await request());
  }
  return out;
}

/** Joins the feeds that answered; null when none did. Without labels, as for world coverage, no link is labelled. */
export function combine(parts: [Service, Feed][], top: Feed, labels: Labels = { hard: [], soft: [] }): Sources | null {
  const ok = parts.filter((p): p is [Service, NonNullable<Feed>] => p[1] !== null);
  if (!ok.length) return null;
  return {
    url: ok[0][1].url,
    articles: ok.flatMap(([, f]) => f.articles),
    top: links(top),
    services: [...new Set(ok.map(([s]) => s))],
    labels,
  };
}

/**
 * A local edition's feeds: Google News top stories, NATION and WORLD, and
 * the Bing News search when the country has one (`country.local`), plus
 * the TECHNOLOGY and ENTERTAINMENT sections for labels only: their
 * articles are not listed, and either failing only labels less. Null when
 * none of top stories, NATION and WORLD answered, even if Bing did, so a
 * Google outage keeps the edition's previous list.
 */
export async function fetchLocalSources(country: CountryConfig, delayMs: number, deps: FetchDeps): Promise<Sources | null> {
  const edition = country.edition;
  if (!edition) return null;
  const search = country.local;
  const section = (s: Section) => () => fetchFeedUrl(buildSectionUrl(edition, s), `${edition.ceid} ${s}`, delayMs, deps);
  const [[top, nation, world, technology, entertainment], bing] = await Promise.all([
    paced(
      [() => fetchFeed(edition, delayMs, deps), section("NATION"), section("WORLD"), section("TECHNOLOGY"), section("ENTERTAINMENT")],
      delayMs,
      deps,
    ),
    search ? fetchBingFeed(search.name, country.code, search.lang, delayMs, deps, 1) : Promise.resolve(null),
  ]);
  if (!top && !nation && !world) {
    deps.log(`  ${country.code}: no Google News feed answered`);
    return null;
  }
  const hard = links(nation, world);
  return combine(
    [
      ["Google News", top],
      ["Google News", nation],
      ["Google News", world],
      ["Bing News", bing],
    ],
    top,
    { hard, soft: softLinks(links(top), hard, links(technology, entertainment)) },
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
 * MAX_AGE_DAYS dropped, one article per story, ranked by trending.ts with
 * the edition's labels (soft news lower), at most `max`. A headline that
 * several outlets run counts each of them; any repeat of it left after
 * ranking (copies days apart are never one story) is dropped. Lexical
 * only, so nothing is translated that is then thrown away.
 */
export function buildList(sources: Sources, max: number, now: string): Article[] {
  const recent = usableArticles(sources.articles).filter((a) => isRecent(a, now));
  return dedupeArticles(rankStories(recent, sources.top, now, sources.labels)).slice(0, max);
}

/** Whether an article is at most MAX_AGE_DAYS old at `now`. */
export function isRecent(article: Pick<Article, "published">, now: string): boolean {
  return Date.parse(now) - Date.parse(article.published) <= MAX_AGE_DAYS * 86_400_000;
}

/** Where a list came from, for the country file: "Google News and Bing News". */
export function sourceName(services: Service[]): string {
  return services.join(" and ");
}
