// GDACS, the Global Disaster Alert and Coordination System run by the UN
// and the European Commission: earthquakes, tropical cyclones, floods,
// volcanoes, droughts and wildfires with an alert level (Green, Orange,
// Red) and, for most events, the real affected area: cyclone wind buffers
// and track, earthquake shaking contours, flood, fire and drought extents.
//
// How the API behaves (probed live, October 2026):
// - The event list is a GeoJSON FeatureCollection of points, 100 per page,
//   sorted by todate (newest first). fromdate/todate select events whose
//   active period overlaps the window, so a drought that started months ago
//   but is still active is returned for a short window (dates are whole
//   days, both ends included). A page past the end, or an empty result, is
//   HTTP 204 with no body. `severity` is a server-side minimum.
// - Paging is not reliable: pages repeat rows and skip whole blocks (one
//   live read of 9 pages repeated 34 events and missed 23 earthquakes), so
//   full windows are split into smaller ones instead of paged.
// - Each event's url.geometry returns a FeatureCollection. TC: overall wind
//   buffers Poly_Green/Orange/Red labelled "60 km/h", "90 km/h", "120 km/h",
//   per-timestep copies (featuretype WindRadii), track point circles
//   (featuretype PointRadii), an uncertainty cone, and the track as
//   two-point LineStrings with a boolean `forecast`. EQ: Poly_SMPInt_*
//   bands labelled "Intensity N" in half steps (each band has holes where
//   stronger shaking is), plus a 100 km Poly_Circle. FL: Poly_Affected and a
//   much larger Poly_Global. WF and DR: Poly_area. VO: only a 30 km
//   Poly_Circle around the volcano.
// - Times are UTC without a zone suffix. The servers sometimes answer 503
//   or reset the connection, so every request is retried once.
import type { FetchDeps } from "../googlenews";
import { USER_AGENT } from "../googlenews";
import type { CountryResolver } from "../resolve";
import { fitGeometry, mergeGeometries, toAreaGeometry } from "./geo";
import type { Area, AreaGeometry, AreaKind, DisasterType, Position, Precision, Severity, SourceEvent, Track } from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const GDACS_API = "https://www.gdacs.org/gdacsapi/api";

export type GdacsType = "EQ" | "TC" | "FL" | "VO" | "DR" | "WF";
export type AlertLevel = "Green" | "Orange" | "Red";

const GDACS_TYPES: readonly GdacsType[] = ["EQ", "TC", "FL", "VO", "DR", "WF"];
const ALERT_LEVELS: readonly AlertLevel[] = ["Green", "Orange", "Red"];

export const TYPE_OF: Record<GdacsType, DisasterType> = {
  EQ: "earthquake",
  TC: "cyclone",
  FL: "flood",
  VO: "volcano",
  DR: "drought",
  WF: "wildfire",
};

const SEVERITY_OF: Record<AlertLevel, Severity> = { Green: 1, Orange: 2, Red: 3 };

/** The list API's page size; a shorter page is the last one. */
export const PAGE_SIZE = 100;
/** Most pages read for one single-day window that still holds more than a page (see fetchWindow). */
export const MAX_PAGES = 15;
/** Pause between requests so the run stays polite to the GDACS servers. */
export const REQUEST_PACE_MS = 400;
/** Wait before the single retry of a failed request. */
export const RETRY_DELAY_MS = 5_000;
/** Per-request time limit; a cyclone's geometry is about 450 KB. */
export const REQUEST_TIMEOUT_MS = 60_000;
/** Most geometries fetched in one run; events beyond it keep their previous areas. */
export const MAX_GEOMETRY_FETCHES = 300;
/** Byte budget for all of one event's areas once written as JSON. */
export const MAX_AREA_BYTES = 60_000;
/** Earthquake shaking bands weaker than this (MMI) are left out: IV is "light", felt indoors. */
export const MIN_INTENSITY = 4;

/**
 * Days after GDACS last saw an event active (its todate) that it stays on
 * the map. TC and FL also stay while GDACS flags them current; DR stays
 * while current or recently updated (GDACS refreshes droughts every ten
 * days but flags only some of the active ones as current).
 */
export const KEEP_DAYS: Record<GdacsType, number> = { TC: 3, FL: 14, EQ: 10, WF: 14, VO: 30, DR: 21 };
/** Orange and Red earthquakes stay longer: the response to a major quake runs for weeks. */
export const MAJOR_EQ_KEEP_DAYS: Record<Exclude<AlertLevel, "Green">, number> = { Orange: 21, Red: 30 };
/** A "current" flag on an event GDACS has not updated for this long is ignored as stale. */
export const CURRENT_MAX_DAYS = 45;
/** Green earthquakes are kept from this magnitude anywhere... */
export const EQ_MIN_MAGNITUDE = 6.0;
/** ...or from this magnitude when GDACS places them in a country. */
export const EQ_MIN_MAGNITUDE_ON_LAND = 5.5;
/** Green wildfires are kept from this burned area, in hectares. */
export const WF_MIN_HECTARES = 10_000;

/** One list query: which types and alert levels, how many days back, and optionally the lowest severity. */
export interface ListQuery {
  types: GdacsType[];
  levels: AlertLevel[];
  days: number;
  /** Lowest severity GDACS should return, in the type's unit (magnitude for EQ, hectares for WF); filtered by the server. */
  minSeverity?: number;
}

/**
 * The list is read in small queries, each going only as far back as its
 * keep window. Green quakes and fires are filtered by severity on the
 * server, so each query stays near or under one page (100 rows), because
 * GDACS's paging is not reliable (see fetchWindow).
 */
export const LIST_QUERIES: readonly ListQuery[] = [
  { types: ["TC", "FL"], levels: ["Green", "Orange", "Red"], days: Math.max(KEEP_DAYS.TC, KEEP_DAYS.FL) + 1 },
  { types: ["EQ"], levels: ["Green"], days: KEEP_DAYS.EQ + 1, minSeverity: Math.min(EQ_MIN_MAGNITUDE, EQ_MIN_MAGNITUDE_ON_LAND) },
  { types: ["EQ"], levels: ["Orange", "Red"], days: Math.max(MAJOR_EQ_KEEP_DAYS.Orange, MAJOR_EQ_KEEP_DAYS.Red) + 1 },
  { types: ["WF"], levels: ["Green"], days: KEEP_DAYS.WF + 1, minSeverity: WF_MIN_HECTARES },
  { types: ["WF"], levels: ["Orange", "Red"], days: KEEP_DAYS.WF + 1 },
  { types: ["VO", "DR"], levels: ["Green", "Orange", "Red"], days: Math.max(KEEP_DAYS.VO, KEEP_DAYS.DR) + 1 },
];

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Small value helpers
// ---------------------------------------------------------------------------

/** Trimmed string form of a JSON value; "" for null, undefined and objects. */
function str(v: unknown): string {
  return typeof v === "string" || typeof v === "number" ? String(v).trim() : "";
}

/** A finite number from a JSON number or numeric string, else null. */
function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Collapses runs of whitespace to single spaces. */
function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** A JSON object as a record, or null. */
function record(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** GDACS times are UTC without a zone; returns ISO 8601 with Z, or null. */
export function gdacsTime(s: string): string | null {
  const t = s.trim();
  if (!t) return null;
  const zoned = /(?:Z|[+-]\d\d:?\d\d)$/i.test(t);
  const ms = Date.parse(zoned ? t : `${t}Z`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** YYYY-MM-DD of a time in milliseconds, in UTC. */
function ymd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 1234567 -> "1,234,567". */
function thousands(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** "CHAMPI" -> "Champi", "SAN JOSE" -> "San Jose". */
function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[\s-])([a-z])/g, (_, sep: string, c: string) => sep + c.toUpperCase());
}

/** Only https URLs on gdacs.org are trusted from the feed. */
function gdacsUrl(v: unknown): string | null {
  const s = str(v);
  return /^https:\/\/(?:www\.)?gdacs\.org\//i.test(s) ? s : null;
}

// ---------------------------------------------------------------------------
// The event list
// ---------------------------------------------------------------------------

/** One entry of the GDACS event list, validated. */
export interface GdacsListEvent {
  type: GdacsType;
  eventId: string;
  episodeId: string;
  /** e.g. "Tropical Cyclone CHAMPI-26", "Earthquake in Panama". */
  name: string;
  /** e.g. "CHAMPI-26", "Kanlaon", "Europe-2026"; often empty. */
  eventName: string;
  alert: AlertLevel;
  /** ISO3 of the primary country; empty at sea. */
  iso3: string;
  /** Comma-separated country names, e.g. "Guam, Northern Mariana Islands, Japan". */
  country: string;
  affected: { iso3: string; name: string }[];
  /** ISO 8601 with Z. */
  from: string;
  to: string;
  modified: string | null;
  current: boolean;
  severity: number | null;
  severityText: string;
  severityUnit: string;
  description: string;
  htmlDescription: string;
  glide: string;
  lat: number;
  lng: number;
  geometryUrl: string;
  reportUrl: string;
}

/** The point of a list feature: its Point geometry, else the centre of its bbox. */
function pointOf(f: Record<string, unknown>): { lat: number; lng: number } | null {
  const g = record(f.geometry);
  const c = g && g.type === "Point" && Array.isArray(g.coordinates) ? g.coordinates : null;
  if (c && num(c[0]) !== null && num(c[1]) !== null) return { lng: num(c[0])!, lat: num(c[1])! };
  const b = Array.isArray(f.bbox) ? f.bbox.map(num) : [];
  if (b.length === 4 && b.every((x) => x !== null)) {
    const [w, s, e, n] = b as number[];
    return { lng: (w + e) / 2, lat: (s + n) / 2 };
  }
  return null;
}

/** Validates one list feature; null when a required field is missing or malformed. */
export function parseListFeature(feature: unknown): GdacsListEvent | null {
  const f = record(feature);
  const p = record(f?.properties);
  if (!f || !p) return null;
  const type = str(p.eventtype).toUpperCase() as GdacsType;
  const alert = ALERT_LEVELS.find((l) => l.toLowerCase() === str(p.alertlevel).toLowerCase());
  const eventId = str(p.eventid);
  const to = gdacsTime(str(p.todate)) ?? gdacsTime(str(p.fromdate));
  const from = gdacsTime(str(p.fromdate)) ?? to;
  const point = pointOf(f);
  if (!GDACS_TYPES.includes(type) || !alert || !/^\d+$/.test(eventId) || !from || !to || !point) return null;
  if (Math.abs(point.lat) > 90 || Math.abs(point.lng) > 180) return null;
  const episodeId = str(p.episodeid);
  const urls = record(p.url) ?? {};
  const sev = record(p.severitydata) ?? {};
  const affected = (Array.isArray(p.affectedcountries) ? p.affectedcountries : [])
    .map(record)
    .filter((a): a is Record<string, unknown> => a !== null)
    .map((a) => ({ iso3: str(a.iso3), name: collapse(str(a.countryname)) }));
  const ids = `eventtype=${type}&eventid=${eventId}&episodeid=${episodeId}`;
  return {
    type,
    eventId,
    episodeId,
    name: collapse(str(p.name)),
    eventName: collapse(str(p.eventname)),
    alert,
    iso3: str(p.iso3).toUpperCase(),
    country: collapse(str(p.country)),
    affected,
    from,
    to,
    modified: gdacsTime(str(p.datemodified)),
    current: str(p.iscurrent).toLowerCase() === "true" || p.iscurrent === true,
    severity: num(sev.severity),
    severityText: collapse(str(sev.severitytext)),
    severityUnit: str(sev.severityunit),
    description: str(p.description),
    htmlDescription: str(p.htmldescription),
    glide: str(p.glide),
    lat: point.lat,
    lng: point.lng,
    geometryUrl: gdacsUrl(urls.geometry) ?? `${GDACS_API}/polygons/getgeometry?${ids}`,
    reportUrl: gdacsUrl(urls.report) ?? `https://www.gdacs.org/report.aspx?${ids}`,
  };
}

/** The features array of a FeatureCollection, or null when the body is not one. */
function featuresOf(json: unknown): unknown[] | null {
  const fc = record(json);
  return fc && fc.type === "FeatureCollection" && Array.isArray(fc.features) ? fc.features : null;
}

/** How many features a list page held (before validation), for the paging rule. */
export function countFeatures(json: unknown): number {
  return featuresOf(json)?.length ?? 0;
}

/** Parses a list page. Malformed features are skipped; null when the body is not a FeatureCollection. */
export function parseList(json: unknown): GdacsListEvent[] | null {
  const features = featuresOf(json);
  if (!features) return null;
  return features.map(parseListFeature).filter((e): e is GdacsListEvent => e !== null);
}

/** Keeps one entry per event: the latest episode (then the latest todate). Order of first sight is kept. */
export function dedupeEvents(events: GdacsListEvent[]): GdacsListEvent[] {
  const best = new Map<string, GdacsListEvent>();
  for (const e of events) {
    const key = `${e.type}-${e.eventId}`;
    const old = best.get(key);
    const newer = !old || Number(e.episodeId) > Number(old.episodeId) || (e.episodeId === old.episodeId && e.to > old.to);
    if (newer) best.set(key, e);
  }
  return [...best.values()];
}

/** Burned area in hectares from a wildfire's severity data, or null. */
function hectares(e: GdacsListEvent): number | null {
  if (e.severityUnit.toLowerCase() === "ha" && e.severity !== null) return e.severity;
  const m = /([\d.]+)\s*ha\b/i.exec(e.severityText);
  return m ? Number(m[1]) : null;
}

/** A Green earthquake is kept when strong (M6+), or M5.5+ and placed in a country. */
function bigEnoughQuake(e: GdacsListEvent): boolean {
  const m = e.severity ?? 0;
  return m >= EQ_MIN_MAGNITUDE || (m >= EQ_MIN_MAGNITUDE_ON_LAND && e.iso3 !== "");
}

/** Whether an event is ongoing (or recent enough) to put on the map. See KEEP_DAYS. */
export function includeEvent(e: GdacsListEvent, now: string): boolean {
  const age = (Date.parse(now) - Date.parse(e.to)) / DAY_MS;
  const within = (days: number) => age <= days;
  const current = e.current && within(CURRENT_MAX_DAYS);
  switch (e.type) {
    case "TC":
      return current || within(KEEP_DAYS.TC);
    case "FL":
      return current || within(KEEP_DAYS.FL);
    case "EQ":
      return e.alert === "Green" ? within(KEEP_DAYS.EQ) && bigEnoughQuake(e) : within(MAJOR_EQ_KEEP_DAYS[e.alert]);
    case "WF":
      return within(KEEP_DAYS.WF) && (e.alert !== "Green" || (hectares(e) ?? 0) >= WF_MIN_HECTARES);
    case "VO":
      return within(KEEP_DAYS.VO);
    case "DR":
      return e.alert !== "Green" && (current || within(KEEP_DAYS.DR));
  }
}

// ---------------------------------------------------------------------------
// Turning a list entry into a SourceEvent
// ---------------------------------------------------------------------------

/** "CHAMPI-26" -> "CHAMPI"; "" when there is no name. */
function stormName(eventName: string): string {
  return collapse(eventName.replace(/-\d{2,4}$/, "").replace(/[^A-Za-z\s-]/g, " "));
}

/** A readable title, e.g. "Tropical Cyclone Champi", "Drought in Europe", "Eruption of Kanlaon". */
export function tidyTitle(e: Pick<GdacsListEvent, "type" | "name" | "eventName" | "country">): string {
  const name = collapse(e.name);
  if (e.type === "TC") {
    const storm = stormName(e.eventName || name.replace(/^tropical cyclone\s+/i, ""));
    if (storm) return `Tropical Cyclone ${titleCase(storm)}`;
  }
  if (e.type === "DR") {
    const region = collapse(e.eventName.replace(/-\d{4}$/, ""));
    if (region) return `Drought in ${region}`;
  }
  if (e.type === "VO") {
    const volcano = collapse(e.eventName) || collapse(name.replace(/^eruption\s+(?:of\s+)?/i, ""));
    if (volcano) return `Eruption of ${volcano}`;
  }
  if (name) return name;
  const label = TYPE_OF[e.type].replace(/^./, (c) => c.toUpperCase());
  return e.country ? `${label} in ${e.country}` : label;
}

/** Name for matching across sources: storm or volcano name in capitals, e.g. "CHAMPI", "KANLAON". */
export function matchName(e: Pick<GdacsListEvent, "type" | "eventName">): string | undefined {
  if (e.type !== "TC" && e.type !== "VO") return undefined;
  const base = e.type === "TC" ? stormName(e.eventName) : e.eventName;
  const out = base
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
  return out || undefined;
}

/** Short severity line, e.g. "Magnitude 7.7, depth 13 km" or "Hurricane/Typhoon, peak winds 269 km/h". */
export function tidySeverity(e: Pick<GdacsListEvent, "type" | "severityText">): string | undefined {
  const raw = collapse(e.severityText);
  if (e.type === "EQ") {
    const m = /magnitude\s*([\d.]+)\s*M?\s*,?\s*depth\s*:?\s*([\d.]+)\s*km/i.exec(raw);
    if (m) return `Magnitude ${Number(m[1]).toFixed(1)}, depth ${Math.round(Number(m[2]))} km`;
  }
  if (e.type === "TC") {
    const m = /maximum wind speed of\s*([\d.]+)\s*km\/h/i.exec(raw);
    const category = collapse(raw.split("(")[0].replace(/[<>]=?\s*\d+\s*mph/i, ""));
    if (m) return `${category ? `${category}, peak` : "Peak"} winds ${Math.round(Number(m[1]))} km/h`;
  }
  if (e.type === "WF") {
    const m = /([\d.]+)\s*ha\b/i.exec(raw);
    if (m) return `${thousands(Number(m[1]))} ha burned`;
  }
  if (e.type === "DR") {
    const m = /^(\w+) impact for (.+?) in ([\d.]+)\s*km2$/i.exec(raw);
    if (m) return `${m[2].replace(/^./, (c) => c.toUpperCase())} over ${thousands(Number(m[3]))} km² (${m[1].toLowerCase()} impact)`;
  }
  if (!raw || /^magnitude\s*0(?:\.0+)?\s*M?$/i.test(raw)) return undefined;
  return raw;
}

/** Plain text of an HTML fragment. */
function stripHtml(html: string): string {
  return collapse(
    html
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&gt;/gi, ">")
      .replace(/&lt;/gi, "<")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/g, "'"),
  );
}

/** Lower-case letters and digits only, for comparing sentences. */
function plain(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** A sentence that only restates the alert ("Orange M 7.7 Earthquake in Panama at: ...", "The notification level is Red."). */
function restatesAlert(sentence: string): boolean {
  return (
    /\b(?:alert|notification) level\b/i.test(sentence) ||
    /^(?:green|orange|red)\s+(?:alert\s+)?(?:m\s*[\d.]+\s+)?(?:earthquake|tropical|cyclone|flood|drought|forest|wild|volcan|eruption)/i.test(sentence)
  );
}

/**
 * Summary from the event's description, HTML stripped, with sentences that
 * only restate the alert level or the event's own name dropped. GDACS's
 * list descriptions are usually just the name, so this is often undefined.
 */
export function cleanSummary(e: Pick<GdacsListEvent, "name" | "description">, title = e.name): string | undefined {
  const skip = new Set([plain(e.name), plain(title)]);
  const sentences = stripHtml(e.description)
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s && !restatesAlert(s) && !skip.has(plain(s)));
  const out = sentences.join(" ");
  return out || undefined;
}

/** Prefixes such as "Off East Coast Of", "South Of", "Near Coast Of". */
const OFFSHORE_PREFIX = /^(?:(?:near|off)\s+)?(?:(?:north|south|east|west|northeast|northwest|southeast|southwest|[nsew]\.)\s+)?(?:coast\s+)?of\s+/i;
/** Suffixes such as "Islands", "Region". */
const PLACE_SUFFIX = /\s+(?:islands?|is\.|region|archipelago)$/i;
/** A leading compass word, as in "Southern India". */
const COMPASS_WORD = /^(?:northern|southern|eastern|western|central|north|south|east|west)\s+/i;

/**
 * Resolves a GDACS place name to a globe code, trying the name as given and
 * then without offshore prefixes ("South Of Fiji Islands"), place suffixes
 * ("Vanuatu Islands", "Iceland Region") and a leading compass word
 * ("Southern India").
 */
export function resolvePlaceName(name: string, resolve: CountryResolver): string | undefined {
  let n = collapse(name);
  const steps = [
    (s: string) => s,
    (s: string) => s.replace(OFFSHORE_PREFIX, ""),
    (s: string) => s.replace(PLACE_SUFFIX, "").replace(PLACE_SUFFIX, ""),
    (s: string) => s.replace(COMPASS_WORD, ""),
  ];
  for (const step of steps) {
    n = step(n).trim();
    if (!n) return undefined;
    const code = resolve.byName(n);
    if (code) return code;
  }
  return undefined;
}

/** Globe codes for an event, primary (iso3) first, then affected countries, then named countries. Unknown names are dropped. */
export function resolveCountries(e: Pick<GdacsListEvent, "iso3" | "affected" | "country">, resolve: CountryResolver): string[] {
  const out: string[] = [];
  const add = (code: string | undefined) => {
    if (code && !out.includes(code)) out.push(code);
  };
  if (e.iso3) add(resolve.byIso3(e.iso3));
  for (const a of e.affected) add((a.iso3 && resolve.byIso3(a.iso3)) || (a.name ? resolvePlaceName(a.name, resolve) : undefined));
  for (const part of e.country.split(",")) if (part.trim()) add(resolvePlaceName(part, resolve));
  return out;
}

/** The source id used across runs, e.g. "TC-1001338". */
export function sourceIdOf(e: Pick<GdacsListEvent, "type" | "eventId">): string {
  return `${e.type}-${e.eventId}`;
}

/**
 * How exact the location is: an epicentre, storm centre or volcano is exact;
 * a wildfire is exact once its burned area is mapped; floods and droughts
 * are modelled over a region.
 */
function precisionOf(type: GdacsType, hasAreas: boolean): Precision {
  if (type === "EQ" || type === "TC" || type === "VO") return "exact";
  if (type === "WF") return hasAreas ? "exact" : "area";
  return "area";
}

/** Areas and track parsed from an event's geometry. */
export interface GdacsGeometry {
  areas: Area[];
  track?: Track;
}

/**
 * Maps a list entry (and its geometry, when fetched) to a SourceEvent.
 * revision defaults to the entry's episode; pass the previous revision when
 * reusing older geometry so the next run fetches the new one ("" for none).
 */
export function toSourceEvent(e: GdacsListEvent, resolve: CountryResolver, geometry?: GdacsGeometry | null, revision = e.episodeId): SourceEvent {
  const title = tidyTitle(e);
  const areas = geometry?.areas ?? [];
  const updated = e.modified && e.modified > e.to ? e.modified : e.to;
  const out: SourceEvent = {
    source: "gdacs",
    sourceId: sourceIdOf(e),
    type: TYPE_OF[e.type],
    title,
    severity: SEVERITY_OF[e.alert],
    countries: resolveCountries(e, resolve),
    lat: e.lat,
    lng: e.lng,
    precision: precisionOf(e.type, areas.length > 0),
    started: e.from,
    updated,
    areas,
    links: [{ name: "GDACS report", url: e.reportUrl }],
  };
  const severityText = tidySeverity(e);
  const summary = cleanSummary(e, title);
  const name = matchName(e);
  if (severityText) out.severityText = severityText;
  if (geometry?.track) out.track = geometry.track;
  if (summary) out.summary = summary;
  if (e.glide) out.glide = e.glide;
  if (name) out.name = name;
  if (revision) out.revision = revision;
  return out;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Which Area a geometry feature becomes, or null to ignore it. */
export function classifyFeature(type: GdacsType, props: Record<string, unknown>): { kind: AreaKind; level?: number } | null {
  const cls = str(props.Class);
  const label = collapse(str(props.polygonlabel));
  if (type === "TC") {
    // Per-timestep wind radii and track point circles carry a featuretype; the overall buffers do not.
    if (str(props.featuretype) || !/^Poly_(?:Green|Orange|Red)$/.test(cls)) return null;
    const m = /^(\d+(?:\.\d+)?)\s*km\/h$/i.exec(label);
    return m ? { kind: "wind", level: Number(m[1]) } : null;
  }
  if (type === "EQ") {
    const m = /^intensity\s+(\d+(?:\.\d+)?)$/i.exec(label);
    if (!cls.startsWith("Poly_SMPInt") || !m || Number(m[1]) < MIN_INTENSITY) return null;
    return { kind: "shaking", level: Number(m[1]) };
  }
  if (type === "VO") return /^Poly_(?:area|Affected|Circle)$/i.test(cls) ? { kind: "affected" } : null;
  return /^Poly_(?:area|Affected)$/i.test(cls) ? { kind: "affected" } : null;
}

/** Valid [lng, lat] positions of a LineString's coordinates, rounded to 3 decimals. */
function linePositions(coords: unknown): Position[] {
  if (!Array.isArray(coords)) return [];
  const out: Position[] = [];
  for (const c of coords) {
    const lng = Array.isArray(c) ? num(c[0]) : null;
    const lat = Array.isArray(c) ? num(c[1]) : null;
    if (lng === null || lat === null || Math.abs(lat) > 90 || Math.abs(lng) > 540) continue;
    out.push([Math.round(lng * 1000) / 1000 || 0, Math.round(lat * 1000) / 1000 || 0]);
  }
  return out;
}

const posKey = (p: Position) => `${p[0]},${p[1]}`;
const samePos = (a: Position, b: Position) => a[0] === b[0] && a[1] === b[1];

/** Squared planar distance in degrees (longitude wrapped across the antimeridian), for picking nearest points. */
function dist2(a: Position, b: Position): number {
  const dLng = Math.abs(a[0] - b[0]) % 360;
  return Math.min(dLng, 360 - dLng) ** 2 + (a[1] - b[1]) ** 2;
}

/** Joins chains greedily, each next to the chain whose start is nearest the current end. Returns the order and the total gap. */
function greedyOrder(chains: Position[][], first: number): { order: number[]; gap: number } {
  const order = [first];
  const left = chains.map((_, i) => i).filter((i) => i !== first);
  let gap = 0;
  while (left.length > 0) {
    const last = chains[order[order.length - 1]];
    const tail = last[last.length - 1];
    let best = 0;
    left.forEach((c, k) => {
      if (dist2(tail, chains[c][0]) < dist2(tail, chains[left[best]][0])) best = k;
    });
    gap += Math.sqrt(dist2(tail, chains[left[best]][0]));
    order.push(left.splice(best, 1)[0]);
  }
  return { order, gap };
}

/**
 * Joins line pieces into one polyline by matching end points to start
 * points (GDACS lists track segments grouped by storm category, not in time
 * order). Pieces that do not touch are joined end to nearest start, trying
 * each stretch as the first and keeping the order with the smallest total
 * gap.
 */
export function chainLines(lines: Position[][]): Position[] {
  const pieces = lines.filter((l) => l.length >= 2);
  if (pieces.length === 0) return [];
  const used = new Array<boolean>(pieces.length).fill(false);
  const byStart = new Map<string, number[]>();
  pieces.forEach((l, i) => byStart.set(posKey(l[0]), [...(byStart.get(posKey(l[0])) ?? []), i]));
  const ends = new Set(pieces.map((l) => posKey(l[l.length - 1])));

  // Follow touching pieces from each head into chains.
  const chains: Position[][] = [];
  const follow = (start: number) => {
    const chain = [...pieces[start]];
    used[start] = true;
    for (;;) {
      const next = (byStart.get(posKey(chain[chain.length - 1])) ?? []).find((i) => !used[i]);
      if (next === undefined) break;
      used[next] = true;
      chain.push(...pieces[next].slice(1));
    }
    chains.push(chain);
  };
  pieces.forEach((l, i) => {
    if (!used[i] && !ends.has(posKey(l[0]))) follow(i);
  });
  pieces.forEach((_, i) => {
    if (!used[i]) follow(i); // loops or leftovers
  });
  if (chains.length === 1) return chains[0];

  // Order separate stretches so the gaps between them are smallest.
  const best = chains.map((_, i) => greedyOrder(chains, i)).reduce((a, b) => (b.gap < a.gap ? b : a));
  const out: Position[] = [];
  for (const i of best.order) {
    const next = chains[i];
    out.push(...(out.length > 0 && samePos(out[out.length - 1], next[0]) ? next.slice(1) : next));
  }
  return out;
}

/** How far (degrees) the storm's listed position may be from its track for the track to be split there. */
const TRACK_SPLIT_MAX_DEG = 2;

/**
 * A storm track from GDACS line pieces: the past path, and the forecast
 * starting where the storm is now. GDACS flags pieces as forecast, but the
 * piece that ends at the current position is sometimes flagged forecast too,
 * so when the storm's current position is known the whole track is chained
 * in time order and split at the vertex nearest to it. Without a position
 * (or when it is far from the track) the forecast flags decide.
 */
export function buildTrack(segments: { coords: Position[]; forecast: boolean }[], current?: { lat: number; lng: number }): Track | undefined {
  if (segments.length === 0) return undefined;
  if (current) {
    const full = chainLines(segments.map((s) => s.coords));
    const here: Position = [current.lng, current.lat];
    let at = -1;
    full.forEach((p, i) => {
      if (at < 0 || dist2(p, here) <= dist2(full[at], here)) at = i; // ties go to the later vertex
    });
    if (at >= 0 && dist2(full[at], here) <= TRACK_SPLIT_MAX_DEG ** 2) {
      return { past: full.slice(0, at + 1), forecast: at < full.length - 1 ? full.slice(at) : [] };
    }
  }
  const past = chainLines(segments.filter((s) => !s.forecast).map((s) => s.coords));
  const forecast = chainLines(segments.filter((s) => s.forecast).map((s) => s.coords));
  if (past.length === 0 && forecast.length === 0) return undefined;
  const now = past[past.length - 1];
  if (now && forecast.length > 0 && !samePos(now, forecast[0])) forecast.unshift(now);
  return { past, forecast };
}

/** Size of a geometry written as JSON. */
function geometryBytes(g: AreaGeometry): number {
  return JSON.stringify(g).length;
}

/** Smallest share of the budget any one area gets, so thin bands keep a usable outline. */
const MIN_AREA_SHARE_BYTES = 1_500;
/** Times fitAreas halves the shares before it starts leaving areas out. */
const FIT_ROUNDS = 5;

/** Total JSON size of the areas' geometries. */
function areasBytes(areas: Area[]): number {
  return areas.reduce((sum, a) => sum + geometryBytes(a.geometry), 0);
}

/**
 * Simplifies every area so that together their geometries fit in maxBytes
 * of JSON. Each area gets a share of the budget in proportion to its raw
 * size (never below a small floor); areas that vanish are dropped. If the
 * total is still over budget, the shares are halved and the areas fitted
 * again; after FIT_ROUNDS, areas are kept in order while they fit, so the
 * result is over budget only when the first area alone cannot shrink enough.
 */
export function fitAreas(areas: Area[], maxBytes = MAX_AREA_BYTES): Area[] {
  if (areas.length === 0) return [];
  const sizes = areas.map((a) => geometryBytes(a.geometry));
  const total = sizes.reduce((s, n) => s + n, 0);
  let scale = total > maxBytes ? maxBytes / total : 1;
  let floor = Math.min(MIN_AREA_SHARE_BYTES, Math.floor(maxBytes / areas.length));
  let fitted: Area[] = [];
  for (let round = 0; round < FIT_ROUNDS; round++) {
    fitted = [];
    areas.forEach((a, i) => {
      const geometry = fitGeometry(a.geometry, Math.max(floor, Math.floor(sizes[i] * scale)));
      if (geometry) fitted.push({ ...a, geometry });
    });
    if (areasBytes(fitted) <= maxBytes) return fitted;
    scale /= 2;
    floor = Math.max(1, Math.floor(floor / 2));
  }
  const kept: Area[] = [];
  let used = 0;
  for (const a of fitted) {
    const bytes = geometryBytes(a.geometry);
    if (kept.length > 0 && used + bytes > maxBytes) continue;
    kept.push(a);
    used += bytes;
  }
  return kept;
}

/** Orders areas so broad, weak zones come first: affected, then wind and shaking by level. */
function areaOrder(a: Area, b: Area): number {
  const rank = (x: Area) => ["affected", "place", "wind", "shaking"].indexOf(x.kind);
  return rank(a) - rank(b) || (a.level ?? 0) - (b.level ?? 0);
}

/**
 * Parses an event's geometry FeatureCollection into areas (validated,
 * grouped by kind and level, simplified to maxBytes in total) and, for
 * cyclones, the track, split into past and forecast at `current` (the
 * storm's listed position) when given. Null when the body is not a
 * FeatureCollection.
 */
export function parseGeometry(
  type: GdacsType,
  json: unknown,
  current?: { lat: number; lng: number },
  maxBytes = MAX_AREA_BYTES,
): GdacsGeometry | null {
  const features = featuresOf(json);
  if (!features) return null;
  const groups = new Map<string, { kind: AreaKind; level?: number; geoms: AreaGeometry[] }>();
  const segments: { coords: Position[]; forecast: boolean }[] = [];
  for (const feature of features) {
    const f = record(feature);
    const props = record(f?.properties) ?? {};
    const g = record(f?.geometry);
    if (!f || !g) continue;
    if (type === "TC" && (g.type === "LineString" || g.type === "MultiLineString")) {
      const forecast = props.forecast === true || str(props.forecast).toLowerCase() === "true";
      const lines = g.type === "LineString" ? [g.coordinates] : Array.isArray(g.coordinates) ? g.coordinates : [];
      for (const line of lines) {
        const coords = linePositions(line);
        if (coords.length >= 2) segments.push({ coords, forecast });
      }
      continue;
    }
    const cls = classifyFeature(type, props);
    const geom = cls ? toAreaGeometry(g) : null;
    if (!cls || !geom) continue;
    const key = `${cls.kind}:${cls.level ?? ""}`;
    const group = groups.get(key) ?? { ...cls, geoms: [] };
    group.geoms.push(geom);
    groups.set(key, group);
  }
  const areas: Area[] = [...groups.values()]
    .map(({ geoms, ...cls }) => ({ ...cls, geometry: geoms.length === 1 ? geoms[0] : mergeGeometries(geoms) }))
    .sort(areaOrder);
  const out: GdacsGeometry = { areas: fitAreas(areas, maxBytes) };
  const track = type === "TC" ? buildTrack(segments, current) : undefined;
  if (track) out.track = track;
  return out;
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

/**
 * GETs a GDACS JSON URL, retrying once after delayMs. Resolves to { body }
 * (body is null for HTTP 204 or an empty reply, which GDACS uses for "no
 * events") or to null when both attempts fail. Never throws.
 */
export async function fetchJson(url: string, label: string, deps: FetchDeps, delayMs = RETRY_DELAY_MS): Promise<{ body: unknown } | null> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await deps.fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 204) return { body: null };
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 120).trim()}`);
      return { body: text.trim() ? JSON.parse(text) : null };
    } catch (err) {
      deps.log(`GDACS ${label}: attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}`);
      if (attempt === 1) await deps.sleep(delayMs);
    }
  }
  return null;
}

/** A list window in whole UTC days, both ends included, as YYYY-MM-DD. */
export interface ListWindow {
  from: string;
  to: string;
}

/** A query's window: `days` back from now, through tomorrow (so nothing late in the UTC day is cut off). */
export function queryWindow(q: ListQuery, now: string): ListWindow {
  const nowMs = Date.parse(now);
  return { from: ymd(nowMs - q.days * DAY_MS), to: ymd(nowMs + DAY_MS) };
}

/**
 * Splits a window into two halves of whole days that together cover it
 * (GDACS includes both end days, probed live: 04..11 plus 12..20 returns
 * the same rows as 04..20). Null for a single day, which cannot be split.
 */
export function splitWindow(w: ListWindow): [ListWindow, ListWindow] | null {
  const fromMs = Date.parse(w.from);
  const span = Math.round((Date.parse(w.to) - fromMs) / DAY_MS);
  if (!(span >= 1)) return null;
  const leftEnd = fromMs + Math.floor(span / 2) * DAY_MS;
  return [
    { from: w.from, to: ymd(leftEnd) },
    { from: ymd(leftEnd + DAY_MS), to: w.to },
  ];
}

/** The list URL for one query, window and page. */
export function listUrl(q: ListQuery, w: ListWindow, page: number): string {
  const severity = q.minSeverity !== undefined ? `&severity=${q.minSeverity}` : "";
  return (
    `${GDACS_API}/events/geteventlist/SEARCH?eventlist=${q.types.join(";")}&alertlevel=${q.levels.join(";")}` +
    `&fromdate=${w.from}&todate=${w.to}${severity}&pagenumber=${page}`
  );
}

/** Counts list requests so they are paced REQUEST_PACE_MS apart. */
interface ListPacer {
  requests: number;
}

/** One list page: its events and how many features it held. Null when it failed twice or was not a FeatureCollection. */
async function fetchPage(q: ListQuery, w: ListWindow, page: number, deps: FetchDeps, pacer: ListPacer): Promise<{ events: GdacsListEvent[]; count: number } | null> {
  if (pacer.requests++ > 0) await deps.sleep(REQUEST_PACE_MS);
  const label = `list ${q.types.join(";")} ${q.levels.join(";")} ${w.from}..${w.to} page ${page}`;
  const res = await fetchJson(listUrl(q, w, page), label, deps);
  if (!res) return null;
  if (res.body === null) return { events: [], count: 0 };
  const events = parseList(res.body);
  if (!events) {
    deps.log(`GDACS ${label}: not a FeatureCollection`);
    return null;
  }
  return { events, count: countFeatures(res.body) };
}

/**
 * Reads one query over one window. A short first page is the whole answer.
 * A full one means more rows than a page holds, and GDACS's later pages
 * repeat and skip rows, so the window is split and each part read on its
 * own, down to single days; only a single day that still fills a page is
 * paged through (up to MAX_PAGES). Null when any request fails.
 */
async function fetchWindow(q: ListQuery, w: ListWindow, deps: FetchDeps, pacer: ListPacer): Promise<GdacsListEvent[] | null> {
  const first = await fetchPage(q, w, 1, deps, pacer);
  if (!first || first.count < PAGE_SIZE) return first?.events ?? null;
  const out = [...first.events];
  const parts = splitWindow(w);
  if (parts) {
    for (const part of parts) {
      const events = await fetchWindow(q, part, deps, pacer);
      if (!events) return null;
      out.push(...events);
    }
    return out;
  }
  deps.log(`GDACS list ${q.types.join(";")} ${w.from}: more than ${PAGE_SIZE} rows in one day; paging, which may skip rows`);
  for (let page = 2; page <= MAX_PAGES; page++) {
    const next = await fetchPage(q, w, page, deps, pacer);
    if (!next) return null;
    out.push(...next.events);
    if (next.count < PAGE_SIZE) break;
  }
  return out;
}

/**
 * Reads every list query (see fetchWindow). Null when any request fails
 * twice or is not a FeatureCollection, since a partial list would drop
 * events that are still active. Rows may repeat; dedupeEvents removes them.
 */
export async function fetchList(deps: FetchDeps, now: string, queries: readonly ListQuery[] = LIST_QUERIES): Promise<GdacsListEvent[] | null> {
  const events: GdacsListEvent[] = [];
  const pacer: ListPacer = { requests: 0 };
  for (const q of queries) {
    const part = await fetchWindow(q, queryWindow(q, now), deps, pacer);
    if (!part) return null;
    events.push(...part);
  }
  return events;
}

/** Areas and track of a previous SourceEvent, when it had any (previous runs are read from a file, so shapes are checked). */
function previousGeometry(p: SourceEvent | undefined): GdacsGeometry | null {
  const areas = Array.isArray(p?.areas) ? p.areas : [];
  const track = p?.track && Array.isArray(p.track.past) && Array.isArray(p.track.forecast) ? p.track : undefined;
  if (areas.length === 0 && !track) return null;
  return track ? { areas, track } : { areas };
}

/**
 * Fetches GDACS events that are ongoing now, with their affected areas.
 * Geometry is fetched only for included events, REQUEST_PACE_MS apart, and
 * reused from `previous` when the same event and episode was seen before.
 * When a geometry fetch fails, the previous areas (any episode) are kept
 * with their old revision so the next run tries again; with none, the event
 * is kept without areas. Null when the event list failed or came back
 * empty (GDACS always lists some floods, fires or droughts, so an empty
 * list is a server fault and must not replace the previous events).
 */
export async function fetchGdacs(deps: FetchDeps, now: string, resolve: CountryResolver, previous: SourceEvent[] = []): Promise<SourceEvent[] | null> {
  const listed = await fetchList(deps, now);
  if (!listed || listed.length === 0) {
    deps.log(`GDACS: event list ${listed ? "came back empty" : "failed"}; previous events kept`);
    return null;
  }
  const events = dedupeEvents(listed).filter((e) => includeEvent(e, now));
  const mine = (Array.isArray(previous) ? previous : []).filter((p) => p?.source === "gdacs" && typeof p.sourceId === "string");
  const before = new Map(mine.map((p) => [p.sourceId, p]));
  const out: SourceEvent[] = [];
  let fetched = 0;
  let reused = 0;
  for (const e of events) {
    const old = before.get(sourceIdOf(e));
    let geometry = old?.revision === e.episodeId ? previousGeometry(old) : null;
    let revision = e.episodeId;
    if (geometry) reused++;
    else if (fetched < MAX_GEOMETRY_FETCHES) {
      await deps.sleep(REQUEST_PACE_MS);
      fetched++;
      const res = await fetchJson(e.geometryUrl, `geometry ${sourceIdOf(e)}`, deps);
      geometry = res ? parseGeometry(e.type, res.body, e) : null;
    }
    if (!geometry && previousGeometry(old)) {
      geometry = previousGeometry(old);
      revision = old?.revision ?? "";
    }
    out.push(toSourceEvent(e, resolve, geometry, revision));
  }
  deps.log(`GDACS: ${out.length} ongoing events from ${listed.length} listed; ${fetched} geometries fetched, ${reused} reused`);
  return out;
}
