// Reads Google News RSS feeds: each country edition's top stories, its
// NATION and WORLD sections (and TECHNOLOGY and ENTERTAINMENT, read only to
// label soft news), and English search results for world coverage.
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
  /**
   * Other outlets Google lists under the item as covering the same story
   * (names only). Used to count coverage while ranking, then dropped: it
   * is never published.
   */
  related?: string[];
  /**
   * How many outlets in the fetched feeds carry this story (see
   * trending.ts). Absent before ranking and in older files.
   */
  outlets?: number;
  /** Recent and carried by several outlets. Absent before ranking and in older files. */
  trending?: boolean;
}

/** Overridable so the script can be run end to end against a local stand-in. */
export const FEED_ENDPOINT = process.env.NEWS_FEED_ENDPOINT ?? "https://news.google.com/rss";

export function buildFeedUrl(e: Edition): string {
  const params = new URLSearchParams({ hl: e.hl, gl: e.gl, ceid: e.ceid });
  return `${FEED_ENDPOINT}?${params}`;
}

/**
 * Topic sections read besides the top stories: the country's own news and
 * the world as it sees it, whose articles join the list, and technology
 * and entertainment, whose links only label soft news (sources.ts).
 */
export type Section = "NATION" | "WORLD" | "TECHNOLOGY" | "ENTERTAINMENT";

/**
 * An edition's topic section. Google answers with a redirect to the
 * section's own feed (…/rss/topics/<id>), which fetchFeedUrl follows.
 */
export function buildSectionUrl(e: Edition, topic: Section): string {
  const params = new URLSearchParams({ hl: e.hl, gl: e.gl, ceid: e.ceid });
  return `${FEED_ENDPOINT}/headlines/section/topic/${topic}?${params}`;
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
  description?: string;
  source?: { "#text"?: string; "@_url"?: string } | string;
}

/**
 * The start of a response body, on one line, for an error message: an
 * HTML page's line breaks would otherwise split the run log.
 */
export function snippet(body: string): string {
  return body.slice(0, 120).replace(/\s+/g, " ").trim();
}

/** A numeric character reference's character, or the reference itself when it names none. */
function codePoint(n: number, raw: string): string {
  return n <= 0x10ffff ? String.fromCodePoint(n) : raw;
}

/** Decodes the few HTML entities outlet names carry ("Ciel &amp; Espace"). */
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (raw, n: string) => codePoint(Number(n), raw))
    .replace(/&#x([0-9a-f]+);/gi, (raw, n: string) => codePoint(parseInt(n, 16), raw))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/**
 * The other outlets in an item's description: Google lists up to five
 * articles on the same story there, each followed by its outlet in a grey
 * <font> tag. Only the names are read; the item's own outlet is left out.
 */
export function relatedOutlets(description: string, own: string): string[] {
  const out: string[] = [];
  const self = own.trim().toLowerCase();
  for (const m of description.matchAll(/<font[^>]*>([^<]*)<\/font>/gi)) {
    const name = decodeEntities(m[1]).trim();
    if (name && name.toLowerCase() !== self && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * Parses a feed body. Anything that is not an RSS document with a channel is
 * treated as a failure, since Google answers unsupported editions with a
 * redirect page rather than an error status. Text is kept as text, so an
 * outlet named "444" or a headline "2026" is never read as a number.
 */
export function parseFeed(xml: string): Article[] {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", parseTagValue: false });
  let doc: { rss?: { channel?: { item?: FeedItem | FeedItem[] } } };
  try {
    doc = parser.parse(xml);
  } catch {
    throw new Error(`Feed is not XML: ${snippet(xml)}`);
  }
  const channel = doc.rss?.channel;
  if (!channel) throw new Error(`Feed has no RSS channel: ${snippet(xml)}`);
  const items = channel.item === undefined ? [] : Array.isArray(channel.item) ? channel.item : [channel.item];

  const articles: Article[] = [];
  for (const it of items) {
    const outlet = String(typeof it.source === "object" ? (it.source?.["#text"] ?? "") : (it.source ?? ""));
    const outletUrl = typeof it.source === "object" ? (it.source?.["@_url"] ?? null) : null;
    const published = it.pubDate ? new Date(it.pubDate) : null;
    if (!it.title || !it.link || !published || Number.isNaN(published.getTime())) continue;
    const related = typeof it.description === "string" ? relatedOutlets(it.description, outlet) : [];
    articles.push({
      title: stripOutletSuffix(String(it.title), outlet),
      url: String(it.link),
      outlet,
      outletUrl,
      published: published.toISOString(),
      ...(related.length ? { related } : {}),
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

/**
 * Where a feed's redirect may be followed: only further into the feed
 * endpoint (https://news.google.com/rss/…), as the topic sections do.
 * Anything else, such as the page an unsupported edition is sent to, is
 * null and counts as a failure.
 */
export function allowedRedirect(from: string, location: string | null): string | null {
  if (!location) return null;
  try {
    const target = new URL(location, from).href;
    return target.startsWith(`${FEED_ENDPOINT}/`) ? target : null;
  } catch {
    return null;
  }
}

/**
 * Fetches and parses any Google News feed URL with the same retry rule,
 * following at most one redirect, and only one allowedRedirect accepts.
 */
export async function fetchFeedUrl(
  url: string,
  label: string,
  delayMs: number,
  deps: FetchDeps,
): Promise<{ url: string; articles: Article[] } | null> {
  const get = (target: string) =>
    deps.fetch(target, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/rss+xml, application/xml, text/xml" },
      redirect: "manual", // followed by hand below, so other redirects stay failures
      signal: AbortSignal.timeout(30_000),
    });
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      let res = await get(url);
      if (res.status >= 300 && res.status < 400) {
        const next = allowedRedirect(url, res.headers.get("location"));
        if (next) {
          await res.text(); // release the connection before the next request
          res = await get(next);
        }
      }
      const text = await res.text();
      if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${snippet(text)}`);
      return { url, articles: parseFeed(text) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.log(`  ${label}: attempt ${attempt} failed: ${msg}`);
      if (attempt === 1) await deps.sleep(delayMs);
    }
  }
  return null;
}
