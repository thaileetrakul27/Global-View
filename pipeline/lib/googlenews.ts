// Reads Google News "Top stories" RSS feeds, one per country edition.
import { XMLParser } from "fast-xml-parser";
import type { Edition } from "./countries";

/** One article as the site stores it. */
export interface Article {
  title: string;
  /** Google News link that redirects to the publisher. */
  url: string;
  /** Publisher name as Google News shows it, e.g. "Bangkok Post". */
  outlet: string;
  /** Publisher home page, when the feed gives one. */
  outletUrl: string | null;
  /** ISO 8601 publish time. */
  published: string;
}

/** Overridable so the script can be run end to end against a local stand-in. */
export const FEED_ENDPOINT = process.env.NEWS_FEED_ENDPOINT ?? "https://news.google.com/rss";

export function buildFeedUrl(e: Edition): string {
  const params = new URLSearchParams({ hl: e.hl, gl: e.gl, ceid: e.ceid });
  return `${FEED_ENDPOINT}?${params}`;
}

/** World coverage: recent English-edition search results about a country. */
export function buildSearchUrl(query: string): string {
  const params = new URLSearchParams({ q: `${query} when:3d`, hl: "en-US", gl: "US", ceid: "US:en" });
  return `${FEED_ENDPOINT}/search?${params}`;
}

/** Google News appends " - Outlet" to every headline; remove it. */
export function stripOutletSuffix(title: string, outlet: string): string {
  const t = title.trim();
  const sep = t.lastIndexOf(" - ");
  if (sep === -1) return t;
  const tail = t.slice(sep + 3).trim().toLowerCase();
  return tail === outlet.trim().toLowerCase() ? t.slice(0, sep).trim() : t;
}

interface FeedItem {
  title?: string;
  link?: string;
  pubDate?: string;
  source?: { "#text"?: string; "@_url"?: string } | string;
}

/**
 * Parses a feed body. Anything that is not an RSS document with a channel is
 * treated as a failure, since Google answers unsupported editions with a
 * redirect page rather than an error status.
 */
export function parseFeed(xml: string): Article[] {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
  let doc: { rss?: { channel?: { item?: FeedItem | FeedItem[] } } };
  try {
    doc = parser.parse(xml);
  } catch {
    throw new Error(`Feed is not XML: ${xml.slice(0, 120).trim()}`);
  }
  const channel = doc.rss?.channel;
  if (!channel) throw new Error(`Feed has no RSS channel: ${xml.slice(0, 120).trim()}`);
  const items = channel.item === undefined ? [] : Array.isArray(channel.item) ? channel.item : [channel.item];

  const articles: Article[] = [];
  for (const it of items) {
    const outlet = typeof it.source === "string" ? it.source : (it.source?.["#text"] ?? "");
    const outletUrl = typeof it.source === "object" ? (it.source?.["@_url"] ?? null) : null;
    const published = it.pubDate ? new Date(it.pubDate) : null;
    if (!it.title || !it.link || !published || Number.isNaN(published.getTime())) continue;
    articles.push({
      title: stripOutletSuffix(String(it.title), outlet),
      url: String(it.link),
      outlet,
      outletUrl,
      published: published.toISOString(),
    });
  }
  return articles;
}

export interface FetchDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  log: (msg: string) => void;
}

export const USER_AGENT = "Mozilla/5.0 (compatible; GlobalView/0.1; +https://github.com/thaileetrakul27/Global-View)";

/**
 * Fetches one edition's top stories, retrying once after `delayMs` on any
 * failure. Returns null when both attempts fail so the run can carry on.
 */
export function fetchFeed(edition: Edition, delayMs: number, deps: FetchDeps) {
  return fetchFeedUrl(buildFeedUrl(edition), edition.ceid, delayMs, deps);
}

/** Fetches and parses any Google News feed URL with the same retry rule. */
export async function fetchFeedUrl(
  url: string,
  label: string,
  delayMs: number,
  deps: FetchDeps,
): Promise<{ url: string; articles: Article[] } | null> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await deps.fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/rss+xml, application/xml, text/xml" },
        redirect: "manual", // an unsupported edition redirects; treat that as a failure
        signal: AbortSignal.timeout(30_000),
      });
      const text = await res.text();
      if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${text.slice(0, 120).trim()}`);
      return { url, articles: parseFeed(text) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.log(`  ${label}: attempt ${attempt} failed: ${msg}`);
      if (attempt === 1) await deps.sleep(delayMs);
    }
  }
  return null;
}
