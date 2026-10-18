// Talks to the GDELT DOC 2.0 API in article-list mode.
// Docs: https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/

/** Overridable so the script can be run end to end against a local stand-in. */
export const GDELT_ENDPOINT = process.env.GDELT_ENDPOINT ?? "https://api.gdeltproject.org/api/v2/doc/doc";

/** One article as the pipeline stores it, before labelling. */
export interface RawArticle {
  url: string;
  title: string;
  domain: string;
  /** GDELT language name, e.g. "Thai". */
  language: string;
  /** When GDELT first saw the article, ISO 8601. */
  seen: string;
  /** GDELT's source country name. */
  sourceCountry: string;
}

interface GdeltArticle {
  url: string;
  url_mobile?: string;
  title: string;
  seendate: string;
  socialimage?: string;
  domain: string;
  language: string;
  sourcecountry: string;
}

export interface GdeltQuery {
  /** GDELT (FIPS) country code. */
  gdeltCode: string;
  timespan: string;
  maxRecords: number;
}

/** Builds the request URL. Exported so tests can check it without a network. */
export function buildGdeltUrl(q: GdeltQuery): string {
  const params = new URLSearchParams({
    query: `sourcecountry:${q.gdeltCode}`,
    mode: "ArtList",
    format: "json",
    timespan: q.timespan,
    maxrecords: String(Math.min(q.maxRecords, 250)),
    sort: "DateDesc",
  });
  return `${GDELT_ENDPOINT}?${params}`;
}

/** "20261018T093000Z" -> "2026-10-18T09:30:00Z". */
export function gdeltDateToIso(seendate: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(seendate);
  if (!m) throw new Error(`Unexpected GDELT date ${seendate}`);
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

/**
 * Parses a response body. GDELT answers errors and rate limits with plain
 * text and HTTP 200 or 429, so anything that is not JSON is treated as a
 * failure with the text as the message.
 */
export function parseGdeltResponse(text: string): RawArticle[] {
  let parsed: { articles?: GdeltArticle[] };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`GDELT did not return JSON: ${text.slice(0, 160).trim()}`);
  }
  return (parsed.articles ?? []).map((a) => ({
    url: a.url,
    title: a.title ?? "",
    domain: a.domain,
    language: a.language,
    seen: gdeltDateToIso(a.seendate),
    sourceCountry: a.sourcecountry,
  }));
}

export interface FetchDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  log: (msg: string) => void;
}

export const USER_AGENT = "GlobalView/0.1 (open-source news bias map; github.com/thaileetrakul27/Global-View)";

/**
 * Fetches one country's article list, retrying once after `delayMs` on any
 * failure. Returns null when both attempts fail so the run can carry on
 * with the other countries.
 */
export async function fetchGdelt(
  q: GdeltQuery,
  delayMs: number,
  deps: FetchDeps,
): Promise<{ url: string; articles: RawArticle[] } | null> {
  const url = buildGdeltUrl(q);
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await deps.fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 160).trim()}`);
      return { url, articles: parseGdeltResponse(text) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.log(`  ${q.gdeltCode}: attempt ${attempt} failed: ${msg}`);
      if (attempt === 1) await deps.sleep(delayMs);
    }
  }
  return null;
}
