// NASA EONET natural events as disaster reports.
//
// EONET (NASA's Earth Observatory Natural Event Tracker) lists natural events
// that other agencies report: tropical storms from the Joint Typhoon Warning
// Center and NOAA's National Hurricane Center, US wildfires from IRWIN,
// eruptions from the Smithsonian Global Volcanism Program, and now and then
// floods, dust storms, droughts and spells of extreme heat or cold. One
// request reads every event that is still open and was seen in the past 30
// days.
//
// What becomes a SourceEvent:
//   storms     a track of six-hourly positions with winds in knots; the
//              centre is the latest position, and storms EONET has not seen
//              for 3 days are dropped
//   wildfires  US incidents of 5,000 acres or more (prescribed burns left
//              out), drawn as a circle as large as the burned area; fires not
//              reported for 10 days are dropped
//   the rest   a point, or a polygon that is also drawn as the affected area
// Sea and lake ice, water colour and man-made events are not disasters here.
//
// Quirks of the live data (probed October 2026) that the parser repairs:
// - Most GDACS-sourced flood polygons are written [lat, lng], not GeoJSON's
//   [lng, lat] (145 of 208 in one read); their points are the right way
//   round. A polygon that is only valid swapped is swapped while parsing;
//   one valid both ways is swapped when that puts it nearer the countries
//   its title names (orientPolygons).
// - Titles and descriptions carry HTML entities ("Cote d&#039;Ivoire",
//   "Bosnia &amp; Herzegovina", "DEVIL&#039;S CANYON").
// - IRWIN sometimes sends a placeholder point ([1, 3], [189, 7]) for a US
//   fire; such fires are left out.
// - Categories are listed by EONET's internal id, so "manmade" comes last
//   ("Explosion at Tianjin": dustHaze, manmade); any manmade event is skipped.
import type { FetchDeps } from "../googlenews";
import { buildResolver, type CountryResolver } from "../resolve";
import { USER_AGENT } from "../googlenews";
import { centroidOf, circlePolygon, countryAt, fitGeometry, nearestCountry, normaliseLng, toAreaGeometry, type CountryShape } from "./geo";
import type { Area, AreaGeometry, DisasterType, Position, Severity, SourceEvent, SourceRef } from "./types";

export const EONET_URL = "https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=30";

const DAY_MS = 86_400_000;
/** Timeout for the one feed request. */
const TIMEOUT_MS = 60_000;
/** Wait before the one retry. */
export const RETRY_MS = 10_000;
/** Storms EONET has not placed for this long have ended or left the record. */
export const STORM_MAX_AGE_DAYS = 3;
/** Wildfires with no new report for this long are left out. */
export const FIRE_MAX_AGE_DAYS = 10;
/** Smaller wildfires are local incidents, not disasters for this map. */
export const MIN_FIRE_ACRES = 5_000;
/** Byte budget for one event's affected area, as compact JSON. */
export const AREA_BUDGET_BYTES = 60_000;
/** Smallest circle drawn for a wildfire, so it stays visible on the globe. */
export const MIN_FIRE_RADIUS_KM = 2;
/** How far a storm's centre may be from a coast and still name that country. */
const STORM_COUNTRY_KM = 500;
/** How far any other event may be from a coast and still name that country. */
const OTHER_COUNTRY_KM = 200;
/** A track point this close to a country counts as the storm passing over it. */
const TRACK_COUNTRY_KM = 30;
/** Farther than any two points on Earth, for "how far is this country" questions. */
const ANY_KM = 20_100;

const KMH_PER_KNOT = 1.852;
const KM2_PER_ACRE = 0.0040468564224;
const ACRES_PER_HECTARE = 2.4710538147;

/** EONET categories that are not natural disasters for this map. */
const SKIPPED_CATEGORIES = new Set(["manmade", "seaLakeIce", "waterColor"]);
/** Globe shapes that never own an event (there is no Antarctica feed). */
const NOT_A_COUNTRY = new Set(["AQ"]);

/** Readable names for EONET's source ids, from its /api/v3/sources registry. Unknown ids are shown as given. */
const SOURCE_NAMES: Record<string, string> = {
  AVO: "Alaska Volcano Observatory",
  ABFIRE: "Alberta Wildfire",
  AU_BOM: "Australian Bureau of Meteorology",
  BCWILDFIRE: "BC Wildfire Service",
  CALFIRE: "CAL FIRE",
  CEMS: "Copernicus Emergency Management Service",
  EO: "NASA Earth Observatory",
  Earthdata: "NASA Earthdata",
  FEMA: "FEMA",
  FloodList: "FloodList",
  GDACS: "GDACS",
  GLIDE: "GLIDE",
  InciWeb: "InciWeb",
  IRWIN: "IRWIN wildfire report",
  IDC: "International Charter Space and Major Disasters",
  JTWC: "Joint Typhoon Warning Center",
  MBFIRE: "Manitoba Wildfire Program",
  NASA_DISP: "NASA Disasters Program",
  NASA_HURR: "NASA hurricane updates",
  NOAA_NHC: "National Hurricane Center",
  NOAA_CPC: "NOAA Climate Prediction Center",
  PDC: "Pacific Disaster Center",
  ReliefWeb: "ReliefWeb",
  SIVolcano: "Smithsonian Global Volcanism Program",
  USGS_EHP: "USGS Earthquake Hazards Program",
  DFES_WA: "Western Australia Fire and Emergency Services",
};

/** US states (and DC, Puerto Rico), whose wildfire titles name a county. */
const US_STATES = new Set(
  (
    "Alabama Alaska Arizona Arkansas California Colorado Connecticut Delaware Florida Georgia Hawaii Idaho Illinois " +
    "Indiana Iowa Kansas Kentucky Louisiana Maine Maryland Massachusetts Michigan Minnesota Mississippi Missouri " +
    "Montana Nebraska Nevada New_Hampshire New_Jersey New_Mexico New_York North_Carolina North_Dakota Ohio Oklahoma " +
    "Oregon Pennsylvania Rhode_Island South_Carolina South_Dakota Tennessee Texas Utah Vermont Virginia Washington " +
    "West_Virginia Wisconsin Wyoming District_of_Columbia Puerto_Rico"
  )
    .split(" ")
    .map((s) => s.replace(/_/g, " ").toLowerCase()),
);

/** One dated position of an event, as this module reads it. */
export interface EonetGeometry {
  /** ISO 8601. */
  date: string;
  /** ms since 1970. */
  time: number;
  /** The point itself, or the centroid of a polygon. */
  point: Position;
  /** Set when EONET gave a polygon. */
  polygon?: AreaGeometry;
  magnitude: number | null;
  /** e.g. "kts", "acres", "hectare". */
  unit: string | null;
}

/** One EONET event, with its geometry sorted oldest first. */
export interface EonetEvent {
  id: string;
  title: string;
  description: string | null;
  /** ISO 8601, or null while open. */
  closed: string | null;
  /** The first category id, e.g. "severeStorms". */
  category: string;
  sources: { id: string; url: string }[];
  geometry: EonetGeometry[];
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

/**
 * GETs a JSON document, retrying once after RETRY_MS on any failure (network
 * error, timeout, non-200 status or bad JSON). Null when both attempts fail.
 */
export async function getJson(url: string, deps: FetchDeps): Promise<unknown | null> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await deps.fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await res.text();
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      return JSON.parse(text) as unknown;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.log(`EONET ${url}: attempt ${attempt} failed: ${msg}`);
      if (attempt === 1) await deps.sleep(RETRY_MS);
    }
  }
  return null;
}

/**
 * Reads EONET's open events and turns them into SourceEvents. Null when the
 * feed cannot be read (the caller then keeps the previous run's events).
 */
export async function fetchEonet(deps: FetchDeps, now: string, shapes: CountryShape[]): Promise<SourceEvent[] | null> {
  try {
    const raw = await getJson(EONET_URL, deps);
    if (raw === null) return null;
    const events = parseEonetFeed(raw);
    if (!events) {
      deps.log("EONET: the response has no events list");
      return null;
    }
    const out = eventsFromFeed(events, now, shapes);
    deps.log(`EONET: ${out.length} of ${events.length} open events kept`);
    return out;
  } catch (err) {
    deps.log(`EONET: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** A finite number, or null. */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** A trimmed string with runs of whitespace (non-breaking spaces too) made single spaces; "" for anything else. */
export function collapse(v: unknown): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
}

/** The HTML entities EONET leaves in titles, by name. */
const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Decodes HTML entities once: "Cote d&#039;Ivoire" -> "Cote d'Ivoire", "&amp;" -> "&". Unknown entities are kept. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] !== "#") return NAMED_ENTITIES[code.toLowerCase()] ?? whole;
    const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
  });
}

/** collapse() of a string with its HTML entities decoded; "" for anything else. */
function text(v: unknown): string {
  return typeof v === "string" ? collapse(decodeEntities(v)) : "";
}

/**
 * The category an event is filed under: "manmade" when it has that category
 * at all (EONET lists it last, after the natural one), else the first that
 * is not skipped, else the first.
 */
export function pickCategory(ids: string[]): string {
  if (ids.includes("manmade")) return "manmade";
  return ids.find((id) => !SKIPPED_CATEGORIES.has(id)) ?? ids[0] ?? "";
}

/** Swaps the two numbers of every position of raw polygon coordinates ([lat, lng] -> [lng, lat]); anything else is returned as it is. */
export function swapRawAxes(coordinates: unknown): unknown {
  if (!Array.isArray(coordinates)) return coordinates;
  return coordinates.map((ring) =>
    Array.isArray(ring) ? ring.map((p) => (Array.isArray(p) && p.length >= 2 ? [p[1], p[0], ...p.slice(2)] : p)) : ring,
  );
}

/** The geometry with each position's longitude and latitude swapped, or null when that is not a valid geometry. */
export function swapAxes(geom: AreaGeometry): AreaGeometry | null {
  const coordinates = geom.type === "Polygon" ? swapRawAxes(geom.coordinates) : geom.coordinates.map(swapRawAxes);
  return toAreaGeometry({ type: geom.type, coordinates });
}

/**
 * One geometry entry, or null when its date or coordinates are unusable. A
 * polygon that is only valid with its axes swapped (GDACS floods written
 * [lat, lng], e.g. [35.27, 139.67] in Japan) is read swapped.
 */
export function parseGeometry(raw: unknown): EonetGeometry | null {
  if (!raw || typeof raw !== "object") return null;
  const g = raw as { date?: unknown; type?: unknown; coordinates?: unknown; magnitudeValue?: unknown; magnitudeUnit?: unknown };
  const time = typeof g.date === "string" ? Date.parse(g.date) : NaN;
  if (!Number.isFinite(time)) return null;
  const base = { date: new Date(time).toISOString(), time, magnitude: num(g.magnitudeValue), unit: collapse(g.magnitudeUnit) || null };
  if (g.type === "Point" && Array.isArray(g.coordinates)) {
    const lng = num(g.coordinates[0]);
    const lat = num(g.coordinates[1]);
    if (lng === null || lat === null || Math.abs(lat) > 90 || Math.abs(lng) > 540) return null;
    return { ...base, point: [lng >= -180 && lng <= 180 ? lng : normaliseLng(lng), lat] };
  }
  if (g.type === "Polygon") {
    const polygon =
      toAreaGeometry({ type: "Polygon", coordinates: g.coordinates }) ?? toAreaGeometry({ type: "Polygon", coordinates: swapRawAxes(g.coordinates) });
    if (!polygon) return null;
    const c = centroidOf(polygon);
    return { ...base, point: [c.lng, c.lat], polygon };
  }
  return null;
}

/** One event, or null without an id, title, category or any usable geometry. */
export function parseEvent(raw: unknown): EonetEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as { id?: unknown; title?: unknown; description?: unknown; closed?: unknown; categories?: unknown; sources?: unknown; geometry?: unknown };
  const id = collapse(e.id);
  const title = text(e.title);
  const categoryIds = (Array.isArray(e.categories) ? e.categories : []).map((c) => collapse((c as { id?: unknown } | null)?.id)).filter(Boolean);
  const category = pickCategory(categoryIds);
  const geometry = (Array.isArray(e.geometry) ? e.geometry : [])
    .map(parseGeometry)
    .filter((g): g is EonetGeometry => g !== null)
    .sort((a, b) => a.time - b.time);
  if (!id || !title || !category || geometry.length === 0) return null;
  const closedMs = typeof e.closed === "string" ? Date.parse(e.closed) : NaN;
  const sources = (Array.isArray(e.sources) ? e.sources : [])
    .map((s) => ({ id: collapse((s as { id?: unknown })?.id), url: collapse((s as { url?: unknown })?.url) }))
    .filter((s) => s.id && s.url);
  return {
    id,
    title,
    description: text(e.description) || null,
    closed: Number.isFinite(closedMs) ? new Date(closedMs).toISOString() : null,
    category,
    sources,
    geometry,
  };
}

/**
 * Parses an EONET events response; bad events are skipped. Null when it has
 * no events list, or when it lists events and none can be read (a changed
 * format must keep the previous run's events, not publish none).
 */
export function parseEonetFeed(json: unknown): EonetEvent[] | null {
  const doc = json as { events?: unknown } | null;
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.events)) return null;
  const events = doc.events.map(parseEvent).filter((e): e is EonetEvent => e !== null);
  return doc.events.length > 0 && events.length === 0 ? null : events;
}

// ---------------------------------------------------------------------------
// Types and names
// ---------------------------------------------------------------------------

const CYCLONE_WORDS = /\b(hurricane|typhoon|cyclone|cyclonic|tropical storm|tropical depression|subtropical storm)\b/i;
const COLD_WORDS = /\b(cold|colder|freez\w*|frost\w*|chill\w*|snow\w*|blizzard\w*|winter\w*|dzud|ice|icy)\b/i;

/** True when a storm's title names a tropical cyclone (hurricane, typhoon, cyclone, tropical storm or depression). */
export function isTropicalCyclone(title: string): boolean {
  return CYCLONE_WORDS.test(title) && !/\bextra-?tropical\b/i.test(title);
}

/** The disaster type for an EONET category, or null for categories that are skipped or unknown. */
export function eventType(category: string, title: string): DisasterType | null {
  if (SKIPPED_CATEGORIES.has(category)) return null;
  switch (category) {
    case "severeStorms":
      return isTropicalCyclone(title) ? "cyclone" : "storm";
    case "wildfires":
      return "wildfire";
    case "volcanoes":
      return "volcano";
    case "floods":
      return "flood";
    case "landslides":
      return "landslide";
    case "drought":
      return "drought";
    case "dustHaze":
      return "dust";
    case "tempExtremes":
      return COLD_WORDS.test(title) ? "coldwave" : "heatwave";
    case "snow":
      return "coldwave";
    case "earthquakes":
      return "earthquake";
    default:
      return null;
  }
}

/** Upper case without accents or punctuation, for matching across sources: "Man-yi" -> "MAN YI". */
export function matchName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

/** Words storm agencies put before a storm's name. */
const STORM_PREFIX =
  /^(?:(?:super|severe|very|extremely|major|intense|potential|post-?tropical|sub-?tropical|tropical|cyclonic|cyclone|typhoon|hurricane|storm|depression|deep|remnants?|of)\s+)+/i;

/** A storm's proper name for matching: "Super Typhoon Champi" -> "CHAMPI". Undefined when the title has no name. */
export function stormName(title: string): string | undefined {
  const rest = collapse(title.replace(/\([^)]*\)/g, " ")).replace(STORM_PREFIX, "");
  if (/^(storm|depression|cyclone|hurricane|typhoon)$/i.test(rest)) return undefined;
  return matchName(rest) || undefined;
}

/** A volcano's name for matching: "Kilauea Volcano, Hawaii" -> "KILAUEA". */
export function volcanoName(title: string): string | undefined {
  const t = collapse(title);
  const m = /^(.*?)\s+volcano\b/i.exec(t);
  const base = m ? m[1] : t.split(",")[0];
  return matchName(base) || undefined;
}

/** Drops the GDACS event number EONET appends to GDACS-sourced titles: "Flood in Spain 1104235" -> "Flood in Spain". */
export function stripGdacsNumber(title: string): string {
  return collapse(title.replace(/\s+\d{6,8}(?=\s*(\(|$))/, ""));
}

// ---------------------------------------------------------------------------
// Storms
// ---------------------------------------------------------------------------

/** Knots to km/h, rounded. */
export function knotsToKmh(kts: number): number {
  return Math.round(kts * KMH_PER_KNOT);
}

/** A geometry's wind in knots, or null when it has none. */
export function knotsOf(g: EonetGeometry): number | null {
  return g.magnitude !== null && g.magnitude >= 0 && (g.unit ?? "").toLowerCase() === "kts" ? g.magnitude : null;
}

/** Severity from a storm's peak winds: hurricane strength (64 kt) is 2, category 4 (113 kt) is 3. */
export function stormSeverity(peakKts: number | null): Severity {
  if (peakKts === null || peakKts < 64) return 1;
  return peakKts >= 113 ? 3 : 2;
}

/** "Winds up to 93 km/h (peak 194 km/h)": the latest winds, and the peak when it was stronger. */
export function stormSeverityText(latestKts: number | null, peakKts: number | null): string | undefined {
  if (latestKts === null) return undefined;
  const latest = knotsToKmh(latestKts);
  const peak = peakKts === null ? latest : knotsToKmh(peakKts);
  return peak > latest ? `Winds up to ${latest} km/h (peak ${peak} km/h)` : `Winds up to ${latest} km/h`;
}

/**
 * The countries a storm affects: the one at or nearest its centre (within
 * 500 km), then any others its past track crossed, most recent first.
 */
export function stormCountries(track: Position[], shapes: CountryShape[]): string[] {
  const out: string[] = [];
  const add = (code: string | null | undefined) => {
    if (code && !NOT_A_COUNTRY.has(code) && !out.includes(code)) out.push(code);
  };
  const last = track[track.length - 1];
  if (last) add(countriesNear(last[1], last[0], shapes, STORM_COUNTRY_KM)[0]);
  for (let i = track.length - 1; i >= 0; i--) add(countryAt(track[i][1], track[i][0], shapes, TRACK_COUNTRY_KM));
  return out;
}

/** A storm as a SourceEvent, or null when EONET has not placed it for STORM_MAX_AGE_DAYS. */
export function stormEvent(ev: EonetEvent, type: DisasterType, now: string, shapes: CountryShape[]): SourceEvent | null {
  const last = ev.geometry[ev.geometry.length - 1];
  if (ageDays(last.time, now) > STORM_MAX_AGE_DAYS) return null;
  const winds = ev.geometry.map(knotsOf).filter((k): k is number => k !== null);
  const peak = winds.length ? Math.max(...winds) : null;
  const latest = winds.length ? winds[winds.length - 1] : null;
  const past = ev.geometry.map((g) => g.point);
  const out = baseEvent(ev, type, stormSeverity(peak), last.point, stormCountries(past, shapes));
  const text = stormSeverityText(latest, peak);
  if (text) out.severityText = text;
  out.track = { past, forecast: [] };
  // Only tropical cyclones have names other feeds (GDACS) share.
  const name = type === "cyclone" ? stormName(ev.title) : undefined;
  if (name) out.name = name;
  return out;
}

// ---------------------------------------------------------------------------
// Wildfires
// ---------------------------------------------------------------------------

/** True for a planned burn: "Prescribed Fire ..." anywhere in the title, or a standalone "RX"/"Rx" token. */
export function isPrescribedFire(title: string): boolean {
  return /\bprescribed (fire|burn)\b/i.test(title) || /(^|[^A-Za-z0-9])R[Xx](?=$|[^A-Za-z0-9])/.test(title);
}

/** The burned area in acres from a geometry's magnitude (acres or hectares), or null when unknown. */
export function burnedAcres(g: EonetGeometry): number | null {
  if (g.magnitude === null || g.magnitude < 0) return null;
  const unit = (g.unit ?? "").toLowerCase();
  if (unit === "acres" || unit === "acre" || unit === "ac") return g.magnitude;
  if (unit === "hectare" || unit === "hectares" || unit === "ha") return g.magnitude * ACRES_PER_HECTARE;
  return null;
}

/** Severity from burned acres: 100,000+ is 2, 500,000+ is 3. */
export function fireSeverity(acres: number | null): Severity {
  if (acres === null || acres < 100_000) return 1;
  return acres >= 500_000 ? 3 : 2;
}

/** Radius (km) of a circle whose area equals the burned area, at least MIN_FIRE_RADIUS_KM. */
export function fireRadiusKm(acres: number): number {
  return Math.max(MIN_FIRE_RADIUS_KM, Math.sqrt((acres * KM2_PER_ACRE) / Math.PI));
}

/** 1234567 -> "1,234,567". */
export function thousands(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** "63 km² burned (15,582 acres)". */
export function fireSeverityText(acres: number): string {
  return `${thousands(acres * KM2_PER_ACRE)} km² burned (${thousands(acres)} acres)`;
}

/** Title-cases a name written all in capitals ("SAN FRANCISCO 2" -> "San Francisco 2"); mixed-case names are kept. */
export function tidyCaps(s: string): string {
  if (/[a-z]/.test(s) || (s.match(/[A-Z]/g) ?? []).length < 4) return s;
  return s.toLowerCase().replace(/(^|[\s\-/(])([a-z])/g, (_, sep: string, c: string) => sep + c.toUpperCase());
}

/** A US county name with its kind: "Cassia" -> "Cassia County", "Morehouse" (Louisiana) -> "Morehouse Parish". */
export function countyLabel(county: string, state: string): string {
  const c = tidyCaps(county);
  if (/\b(county|parish|borough|city|area|municipality)$/i.test(c)) return c;
  const s = state.toLowerCase();
  if (s === "alaska") return c;
  return `${c} ${s === "louisiana" ? "Parish" : "County"}`;
}

/**
 * A readable wildfire title. IRWIN titles read "Wildfire NAME, COUNTY, STATE"
 * (older ones "NAME Wildfire, COUNTY, STATE"; complexes "Incident Complex
 * NAME, ..."); they become "NAME Fire, COUNTY County, STATE". GDACS-sourced
 * titles that carry an IRWIN title in brackets ("Wildfire in United States
 * 1023255 (Palisades Wildfire, Los Angeles, California)") use the bracketed
 * one. Other titles only lose a GDACS event number.
 */
export function fireTitle(title: string): string {
  const t = stripGdacsNumber(title);
  const bracketed = /\(([^()]+)\)$/.exec(t)?.[1];
  if (bracketed) {
    const inner = fireTitle(bracketed);
    if (inner !== collapse(bracketed)) return inner;
  }
  const parts = t.split(/\s*,\s*/);
  if (parts.length < 3 || !US_STATES.has(parts[parts.length - 1].toLowerCase())) return t;
  const state = parts[parts.length - 1];
  const county = parts[parts.length - 2];
  const name = tidyCaps(
    parts
      .slice(0, -2)
      .join(", ")
      .replace(/^(wildfire|incident complex)\s+/i, "")
      .replace(/\s+wildfire$/i, "")
      .trim(),
  );
  if (!name || !county) return t;
  const fire = /\b(fire|complex)$/i.test(name) ? name : `${name} Fire`;
  return `${fire}, ${countyLabel(county, state)}, ${state}`;
}

/**
 * False when a fire's point cannot be where it burns: out at sea (no country
 * within reach), or outside the US for a title that ends in a US state.
 * IRWIN sometimes sends a placeholder point, e.g. [1, 3] (the Gulf of
 * Guinea) for "MOXEE ORCHARD Wildfire, Yakima, Washington".
 */
export function fireLocated(title: string, countries: string[]): boolean {
  if (countries.length === 0) return false;
  const state = (title.split(/\s*,\s*/).pop() ?? "").toLowerCase();
  if (!US_STATES.has(state)) return true;
  // Puerto Rico is its own shape on the globe.
  return countries.includes(state === "puerto rico" ? "PR" : "US");
}

/**
 * A wildfire as a SourceEvent, or null for prescribed burns, fires under
 * MIN_FIRE_ACRES, fires with no report for FIRE_MAX_AGE_DAYS and fires whose
 * point is a placeholder (fireLocated). A fire with no reported size is
 * kept, without an area.
 */
export function fireEvent(ev: EonetEvent, now: string, shapes: CountryShape[]): SourceEvent | null {
  if (isPrescribedFire(ev.title)) return null;
  const last = ev.geometry[ev.geometry.length - 1];
  if (ageDays(last.time, now) > FIRE_MAX_AGE_DAYS) return null;
  const sizes = ev.geometry.map(burnedAcres).filter((a): a is number => a !== null);
  const acres = sizes.length ? sizes[sizes.length - 1] : null;
  if (acres !== null && acres < MIN_FIRE_ACRES) return null;
  const [lng, lat] = last.point;
  const countries = countriesNear(lat, lng, shapes, OTHER_COUNTRY_KM);
  if (!fireLocated(stripGdacsNumber(ev.title).replace(/\)$/, ""), countries)) return null;
  const out = baseEvent(ev, "wildfire", fireSeverity(acres), last.point, countries);
  out.title = fireTitle(ev.title);
  if (acres !== null) {
    out.severityText = fireSeverityText(acres);
    out.areas = [{ kind: "affected", geometry: circlePolygon(lat, lng, fireRadiusKm(acres)) }];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Volcanoes and everything else
// ---------------------------------------------------------------------------

/** One resolver per shapes array, built on first use. */
const resolvers = new WeakMap<CountryShape[], CountryResolver>();

/** The shared name resolver (globe names, full names and common aliases) for these shapes. */
function resolverFor(shapes: CountryShape[]): CountryResolver {
  let r = resolvers.get(shapes);
  if (!r) {
    r = buildResolver(shapes);
    resolvers.set(shapes, r);
  }
  return r;
}

/** Long forms GDACS uses before a country's common name: "Islamic Republic of Iran", "The Republic of North Macedonia". */
const LONG_FORM = /^(?:the\s+)?(?:islamic\s+|united\s+|federal\s+|plurinational\s+|bolivarian\s+)?(?:republic|state|kingdom)\s+of\s+(?:the\s+)?/i;

/** One name resolved to a globe code: as written, then without a long-form prefix, then split at "and" / "&". */
function resolveName(name: string, shapes: CountryShape[]): string[] {
  const resolver = resolverFor(shapes);
  const one = (n: string) => {
    const code = resolver.byName(n) ?? resolver.byName(n.replace(LONG_FORM, ""));
    return code && !NOT_A_COUNTRY.has(code) ? code : undefined;
  };
  const whole = one(name);
  if (whole) return [whole];
  return name
    .split(/\s+(?:and|&)\s+/i)
    .map(one)
    .filter((c): c is string => c !== undefined);
}

/**
 * Every country a title names, resolved to globe codes in title order: the
 * list after "in" ("Flood in India, Nepal 1104198" -> IN, NP), else the last
 * comma part ("Kanlaon Volcano, Philippines" -> PH; "Dust Storm, Saudi
 * Arabia/Iraq" -> SA, IQ). Empty when the title names none (e.g. "Kilauea
 * Volcano, Hawaii").
 */
export function titleCountries(title: string, shapes: CountryShape[]): string[] {
  const t = stripGdacsNumber(title).replace(/\s*\([^)]*\)$/, "");
  const after = /\bin\s+(.+)$/i.exec(t)?.[1];
  const parts = after ? after.split(/\s*[,/]\s*/) : (t.split(",").pop() ?? "").split(/\s*\/\s*/);
  const out: string[] = [];
  for (const part of parts.map(collapse).filter(Boolean)) {
    for (const code of resolveName(part, shapes)) if (!out.includes(code)) out.push(code);
  }
  if (out.length === 0 && after) {
    const last = collapse(t.split(",").pop());
    if (last !== collapse(after)) out.push(...resolveName(last, shapes));
  }
  return out;
}

/** The first country a title names, or null (see titleCountries). */
export function titleCountry(title: string, shapes: CountryShape[]): string | null {
  return titleCountries(title, shapes)[0] ?? null;
}

/** Shortest distance (km) from a point to any of these countries' shapes: 0 inside, Infinity when none has a shape. */
export function kmToCountries(lat: number, lng: number, codes: string[], shapes: CountryShape[]): number {
  const own = shapes.filter((s) => codes.includes(s.code));
  return own.length ? (nearestCountry(lat, lng, own, ANY_KM)?.km ?? Infinity) : Infinity;
}

/**
 * The event with each polygon read the right way round. GDACS-sourced flood
 * polygons usually come as [lat, lng]; one that is valid either way (e.g.
 * [46.9, 35.5] in Ukraine, which read as [lng, lat] lies in Iran) is swapped
 * when its swapped centre is nearer the countries the title names. Events
 * whose title names no country are left as they are.
 */
export function orientPolygons(ev: EonetEvent, shapes: CountryShape[]): EonetEvent {
  if (!ev.geometry.some((g) => g.polygon)) return ev;
  const named = titleCountries(ev.title, shapes);
  if (named.length === 0) return ev;
  const geometry = ev.geometry.map((g): EonetGeometry => {
    const swapped = g.polygon ? swapAxes(g.polygon) : null;
    if (!g.polygon || !swapped) return g;
    const given = centroidOf(g.polygon);
    const alt = centroidOf(swapped);
    if (kmToCountries(alt.lat, alt.lng, named, shapes) >= kmToCountries(given.lat, given.lng, named, shapes)) return g;
    return { ...g, point: [alt.lng, alt.lat], polygon: swapped };
  });
  return { ...ev, geometry };
}

/** The affected area from the latest polygon EONET gave, fitted to AREA_BUDGET_BYTES. */
export function polygonAreas(ev: EonetEvent): Area[] {
  const latest = [...ev.geometry].reverse().find((g) => g.polygon);
  const geometry = latest?.polygon ? fitGeometry(latest.polygon, AREA_BUDGET_BYTES) : null;
  return geometry ? [{ kind: "affected", geometry }] : [];
}

/** "Magnitude 7.5" when EONET gives an earthquake magnitude (units Mw, Mb, Ml and so on). */
export function quakeSeverityText(g: EonetGeometry): string | undefined {
  return g.magnitude !== null && /^M/.test(g.unit ?? "") ? `Magnitude ${g.magnitude.toFixed(1)}` : undefined;
}

/**
 * A volcano, flood, drought, dust storm, landslide, heat or cold wave or
 * earthquake as a SourceEvent. Volcanoes are severity 2 (EONET lists
 * eruptions), everything else 1. Countries: the one at the event's position
 * first when the title names it too ("Flood in India, Nepal" in Mumbai is
 * IN, NP), otherwise the title's countries, then the one at the position.
 */
export function otherEvent(ev: EonetEvent, type: DisasterType, shapes: CountryShape[]): SourceEvent {
  const last = ev.geometry[ev.geometry.length - 1];
  const [lng, lat] = last.point;
  const named = titleCountries(ev.title, shapes);
  const at = countriesNear(lat, lng, shapes, OTHER_COUNTRY_KM);
  const ordered = at.length && named.includes(at[0]) ? [at[0], ...named] : [...named, ...at];
  const countries = ordered.filter((c, i, all) => all.indexOf(c) === i);
  const out = baseEvent(ev, type, type === "volcano" ? 2 : 1, last.point, countries);
  out.areas = polygonAreas(ev);
  if (type === "earthquake") {
    const text = quakeSeverityText(last);
    if (text) out.severityText = text;
  }
  if (type === "volcano") {
    const name = volcanoName(ev.title);
    if (name) out.name = name;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------

/** Days from an instant (ms) to now. */
function ageDays(time: number, now: string): number {
  return (Date.parse(now) - time) / DAY_MS;
}

/** The globe country at or near a point: inside or within 30 km, else the nearest within maxKm. Empty at sea. */
export function countriesNear(lat: number, lng: number, shapes: CountryShape[], maxKm: number): string[] {
  const code = countryAt(lat, lng, shapes, 30) ?? nearestCountry(lat, lng, shapes, maxKm)?.code ?? null;
  return code && !NOT_A_COUNTRY.has(code) ? [code] : [];
}

/** The event's https source pages, named readably, one per URL. */
export function sourceLinks(sources: EonetEvent["sources"]): SourceRef[] {
  const out: SourceRef[] = [];
  for (const s of sources) {
    let url: URL;
    try {
      url = new URL(s.url);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || out.some((l) => l.url === s.url)) continue;
    out.push({ name: SOURCE_NAMES[s.id] ?? s.id.replace(/_/g, " "), url: s.url });
  }
  return out;
}

/** The fields every EONET SourceEvent shares. */
function baseEvent(ev: EonetEvent, type: DisasterType, severity: Severity, at: Position, countries: string[]): SourceEvent {
  const hasGdacs = ev.sources.some((s) => s.id === "GDACS");
  const out: SourceEvent = {
    source: "eonet",
    sourceId: ev.id,
    type,
    title: hasGdacs ? stripGdacsNumber(ev.title) : ev.title,
    severity,
    countries,
    lat: at[1],
    lng: at[0],
    precision: "exact",
    started: ev.geometry[0].date,
    updated: ev.geometry[ev.geometry.length - 1].date,
    areas: [],
    links: sourceLinks(ev.sources),
  };
  if (ev.description) out.summary = ev.description;
  return out;
}

/** An event as a SourceEvent, or null when its category is skipped or a type rule drops it. Polygons are oriented first. */
export function toSourceEvent(ev: EonetEvent, now: string, shapes: CountryShape[]): SourceEvent | null {
  const type = eventType(ev.category, ev.title);
  if (!type) return null;
  const oriented = orientPolygons(ev, shapes);
  if (oriented.category === "severeStorms") return stormEvent(oriented, type, now, shapes);
  if (type === "wildfire") return fireEvent(oriented, now, shapes);
  return otherEvent(oriented, type, shapes);
}

/**
 * EONET sometimes lists one incident twice under two ids (the same title,
 * place and time from two IRWIN records). Keeps the most recently updated
 * copy, or on a tie the one with the newer EONET id.
 */
export function dedupeEvents(events: SourceEvent[]): SourceEvent[] {
  const idNumber = (e: SourceEvent) => Number(/\d+$/.exec(e.sourceId)?.[0] ?? 0);
  const byKey = new Map<string, SourceEvent>();
  for (const e of events) {
    const key = `${e.type}|${e.title.toLowerCase()}|${e.lat.toFixed(3)}|${e.lng.toFixed(3)}`;
    const seen = byKey.get(key);
    const newer = !seen || e.updated > seen.updated || (e.updated === seen.updated && idNumber(e) > idNumber(seen));
    if (newer) byKey.set(key, e);
  }
  return [...byKey.values()];
}

/** All of a feed's events that are still open on `now` and pass the type rules, without duplicates. */
export function eventsFromFeed(events: EonetEvent[], now: string, shapes: CountryShape[]): SourceEvent[] {
  const nowMs = Date.parse(now);
  const open = events.filter((e) => e.closed === null || Date.parse(e.closed) > nowMs);
  const out = open.map((e) => toSourceEvent(e, now, shapes)).filter((e): e is SourceEvent => e !== null);
  return dedupeEvents(out);
}
