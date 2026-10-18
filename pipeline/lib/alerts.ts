// Verified disaster alerts from GDACS, the Global Disaster Alert and
// Coordination System run by the UN and the European Commission. Its RSS
// feed is public domain and lists natural disasters with an alert level:
// Green (routine), Orange (likely humanitarian impact) or Red (severe).
// Only Orange and Red alerts are kept, and each is attached to the
// countries it names so the site can show them on a country's panel.
import { XMLParser } from "fast-xml-parser";
import type { CountryConfig, GlobeFeature } from "./countries";
import type { FetchDeps } from "./googlenews";
import { USER_AGENT } from "./googlenews";

export const GDACS_FEED = "https://www.gdacs.org/xml/rss.xml";

export type AlertLevel = "Orange" | "Red";
export type AlertType = "earthquake" | "cyclone" | "flood" | "drought" | "wildfire" | "volcano" | "other";

export interface Alert {
  /** GDACS event id, stable across updates of the same event. */
  id: string;
  type: AlertType;
  level: AlertLevel;
  /** GDACS's own one-line title. */
  title: string;
  /** Named event, e.g. a cyclone name, when there is one. */
  name: string | null;
  /** ISO 3166-1 alpha-2 codes of the countries the alert names, primary first. */
  countries: string[];
  /** When the event started and when GDACS last saw it active (ISO dates). */
  from: string;
  to: string;
  /** Report page on gdacs.org. */
  url: string;
}

/** How long an alert stays listed after GDACS last saw it active. */
export const KEEP_DAYS: Record<AlertLevel, number> = { Orange: 10, Red: 21 };

const TYPES: Record<string, AlertType> = { EQ: "earthquake", TC: "cyclone", FL: "flood", DR: "drought", WF: "wildfire", VO: "volcano" };

/** Maps the country names and ISO3 codes GDACS uses onto the site's codes. */
export interface CountryResolver {
  byIso3: (iso3: string) => string | undefined;
  byName: (name: string) => string | undefined;
}

/** Names GDACS uses that differ from the map's labels. */
const ALIASES: Record<string, string> = {
  turkiye: "TR",
  "czech republic": "CZ",
  "ivory coast": "CI",
  "cote d ivoire": "CI",
  "united states": "US",
  usa: "US",
  "united kingdom": "GB",
  uk: "GB",
  "democratic republic of congo": "CD",
  "dr congo": "CD",
  "republic of congo": "CG",
  congo: "CG",
  "viet nam": "VN",
  "lao pdr": "LA",
  "iran islamic republic of": "IR",
  "syrian arab republic": "SY",
  "russian federation": "RU",
  "korea republic of": "KR",
  "korea democratic people s republic of": "KP",
  "north korea": "KP",
  swaziland: "SZ",
  eswatini: "SZ",
  macedonia: "MK",
  "bolivia plurinational state of": "BO",
  "venezuela bolivarian republic of": "VE",
  "tanzania united republic of": "TZ",
  burma: "MM",
  "occupied palestinian territory": "PS",
  "gaza strip": "PS",
  "west bank": "PS",
};

/** Lower-case letters and digits only, accents and "the" removed, so spellings line up. */
export function normaliseName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\bthe\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildResolver(features: GlobeFeature[], configs: CountryConfig[] = []): CountryResolver {
  const iso3 = new Map<string, string>();
  const names = new Map<string, string>();
  for (const f of features) {
    if (f.iso3) iso3.set(f.iso3.toUpperCase(), f.code);
    names.set(normaliseName(f.name), f.code);
    names.set(normaliseName(f.admin), f.code);
  }
  for (const c of configs) names.set(normaliseName(c.name), c.code);
  for (const [alias, code] of Object.entries(ALIASES)) names.set(alias, code);
  return {
    byIso3: (code) => iso3.get(code.toUpperCase()),
    byName: (name) => names.get(normaliseName(name)),
  };
}

interface Item {
  title?: string;
  link?: string;
  "gdacs:eventid"?: string | number;
  "gdacs:eventtype"?: string;
  "gdacs:alertlevel"?: string;
  "gdacs:eventname"?: string;
  "gdacs:iso3"?: string;
  "gdacs:country"?: string;
  "gdacs:fromdate"?: string;
  "gdacs:todate"?: string;
  "gdacs:datemodified"?: string;
}

const text = (v: unknown): string => (v === undefined || v === null ? "" : String(v).trim());

function isoDate(s: string): string | null {
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * Parses the GDACS feed into Orange and Red alerts that are still recent,
 * dropping any whose countries the globe cannot show.
 */
export function parseAlerts(xml: string, resolve: CountryResolver, now: string): Alert[] {
  const parser = new XMLParser({ ignoreAttributes: true });
  let doc: { rss?: { channel?: { item?: Item | Item[] } | "" } };
  try {
    doc = parser.parse(xml);
  } catch {
    throw new Error(`GDACS feed is not XML: ${xml.slice(0, 120).trim()}`);
  }
  if (!doc.rss || doc.rss.channel === undefined) throw new Error(`Not a GDACS feed: ${xml.slice(0, 120).trim()}`);
  const raw = doc.rss.channel === "" ? undefined : doc.rss.channel.item;
  const items = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const nowMs = Date.parse(now);
  const out: Alert[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const level = text(it["gdacs:alertlevel"]);
    if (level !== "Orange" && level !== "Red") continue;
    const id = text(it["gdacs:eventid"]);
    if (!id || seen.has(id)) continue;
    const to = isoDate(text(it["gdacs:todate"]) || text(it["gdacs:datemodified"]));
    const from = isoDate(text(it["gdacs:fromdate"])) ?? to;
    if (!to || !from) continue;
    if (nowMs - Date.parse(to) > KEEP_DAYS[level] * 86_400_000) continue;
    const countries: string[] = [];
    const add = (code: string | undefined) => {
      if (code && !countries.includes(code)) countries.push(code);
    };
    add(resolve.byIso3(text(it["gdacs:iso3"])));
    for (const name of text(it["gdacs:country"]).split(",")) if (name.trim()) add(resolve.byName(name));
    if (!countries.length) continue;
    seen.add(id);
    out.push({
      id,
      type: TYPES[text(it["gdacs:eventtype"])] ?? "other",
      level,
      title: text(it.title),
      name: text(it["gdacs:eventname"]) || null,
      countries,
      from,
      to,
      url: text(it.link) || `https://www.gdacs.org/report.aspx?eventid=${id}`,
    });
  }
  // Red before Orange, then most recently active first.
  return out.sort((a, b) => (a.level === b.level ? b.to.localeCompare(a.to) : a.level === "Red" ? -1 : 1));
}

/**
 * Fetches the GDACS feed, retrying once after `delayMs` since the server
 * returns 503 now and then. Null when both attempts fail so the previous
 * alerts are kept.
 */
export async function fetchAlerts(
  resolve: CountryResolver,
  now: string,
  deps: FetchDeps,
  url = GDACS_FEED,
  delayMs = 5_000,
): Promise<Alert[] | null> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await deps.fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/rss+xml, application/xml, text/xml" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseAlerts(await res.text(), resolve, now);
    } catch (err) {
      deps.log(`GDACS attempt ${attempt}: ${err instanceof Error ? err.message : String(err)}`);
      if (attempt === 1) await deps.sleep(delayMs);
    }
  }
  deps.log("GDACS: both attempts failed; previous alerts kept");
  return null;
}
