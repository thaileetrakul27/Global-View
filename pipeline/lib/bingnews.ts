// Bing News RSS for countries without a Google News edition. Bing serves
// a news search per market (cc) and language (setlang), so a query for
// the country's own name in its own language returns what its local
// outlets are publishing. Each item carries the publisher's name and a
// redirect link that embeds the publisher's URL.
import { XMLParser } from "fast-xml-parser";
import type { Article, FetchDeps } from "./googlenews";
import { USER_AGENT } from "./googlenews";

export const BING_ENDPOINT = process.env.BING_NEWS_ENDPOINT ?? "https://www.bing.com/news/search";
/** Items per page Bing returns; the second page starts at 13. */
export const BING_PAGE = 12;

export function buildBingUrl(query: string, cc: string, lang: string, first = 1): string {
  const p = new URLSearchParams({ q: query, format: "rss", cc: cc.toUpperCase(), setlang: lang });
  if (first > 1) p.set("first", String(first));
  return `${BING_ENDPOINT}?${p.toString()}`;
}

/** The publisher's own URL from Bing's redirect link, or the link itself. */
export function publisherUrl(link: string): string {
  try {
    const u = new URL(link);
    const target = u.searchParams.get("url");
    if (target && /^https?:\/\//.test(target)) return target;
  } catch {
    // not a URL; fall through
  }
  return link;
}

interface Item {
  title?: string | number;
  link?: string;
  pubDate?: string;
  "News:Source"?: string | number;
}

export function parseBingFeed(xml: string): Article[] {
  const parser = new XMLParser({ ignoreAttributes: true, htmlEntities: true });
  let doc: { rss?: { channel?: { item?: Item | Item[] } | "" } };
  try {
    doc = parser.parse(xml);
  } catch {
    throw new Error(`Bing feed is not XML: ${xml.slice(0, 120).trim()}`);
  }
  if (!doc.rss || doc.rss.channel === undefined) throw new Error(`Not a Bing News feed: ${xml.slice(0, 120).trim()}`);
  const raw = doc.rss.channel === "" ? undefined : doc.rss.channel.item;
  const items = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const out: Article[] = [];
  for (const it of items) {
    const published = it.pubDate ? new Date(it.pubDate) : null;
    if (!it.title || !it.link || !published || Number.isNaN(published.getTime())) continue;
    out.push({
      title: String(it.title).trim(),
      url: publisherUrl(String(it.link)),
      outlet: it["News:Source"] === undefined ? "" : String(it["News:Source"]).trim(),
      outletUrl: null,
      published: published.toISOString(),
    });
  }
  return out;
}

/**
 * Fetches up to two pages of results, retrying a failed page once after
 * `delayMs`. Null when the first page fails both times; a failed second
 * page just ends the list.
 */
export async function fetchBingFeed(query: string, cc: string, lang: string, delayMs: number, deps: FetchDeps, pages = 2): Promise<{ url: string; articles: Article[] } | null> {
  const articles: Article[] = [];
  const seen = new Set<string>();
  const firstUrl = buildBingUrl(query, cc, lang);
  for (let page = 0; page < pages; page++) {
    const url = buildBingUrl(query, cc, lang, 1 + page * BING_PAGE);
    let got: Article[] | null = null;
    for (let attempt = 1; attempt <= 2 && !got; attempt++) {
      try {
        const res = await deps.fetch(url, {
          headers: { "User-Agent": USER_AGENT, Accept: "application/rss+xml, application/xml, text/xml" },
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        got = parseBingFeed(await res.text());
      } catch (err) {
        deps.log(`  ${cc} Bing page ${page + 1} attempt ${attempt}: ${err instanceof Error ? err.message : String(err)}`);
        if (attempt === 1) await deps.sleep(delayMs);
      }
    }
    if (!got) {
      if (page === 0) return null;
      break;
    }
    for (const a of got) {
      if (seen.has(a.url)) continue;
      seen.add(a.url);
      articles.push(a);
    }
    if (got.length < BING_PAGE) break;
    if (page + 1 < pages) await deps.sleep(delayMs); // no wait after the last page
  }
  return { url: firstUrl, articles };
}
