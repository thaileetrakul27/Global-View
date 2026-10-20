// USGS earthquakes as disaster reports.
//
// Two public USGS summary feeds are read: significant earthquakes of the past
// month and magnitude 4.5+ earthquakes of the past week. A quake counts as a
// disaster when it is strong and recent, significant by USGS's own score, or
// carries a PAGER impact alert (see isIncluded). Quakes far out at sea are
// left out unless PAGER raises a yellow or worse alert (keptWithoutCountry).
//
// For the stronger quakes the event's detail record is read too, which links
// to two USGS products:
//   ShakeMap  contours of shaking intensity (MMI), drawn as "shaking" areas;
//   PAGER     the towns and cities that felt it and how many people were
//             exposed to each intensity, per country.
// Detail requests are paced and capped per run, and reused from the previous
// run while USGS has not changed the event. Every network step is optional:
// a failure leaves the event without areas rather than dropping it.
import type { FetchDeps } from "../googlenews";
import { USER_AGENT } from "../googlenews";
import { countryAt, fitGeometry, geometryAreaKm2, nearestCountry, normaliseLng, pointInGeometry, toAreaGeometry, type CountryShape } from "./geo";
import type { Area, AreaGeometry, Figure, Place, Position, Severity, SourceEvent, SourceRef } from "./types";

export const USGS_FEEDS = [
  "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_month.geojson",
  "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson",
] as const;

const DAY_MS = 86_400_000;
/** Timeout for one request. */
const TIMEOUT_MS = 30_000;
/** Wait before the one retry of a feed request. */
const FEED_RETRY_MS = 5_000;
/** Wait before the one retry of a detail, ShakeMap or PAGER request. */
const DETAIL_RETRY_MS = 2_000;
/** Gap between detail-phase requests, so USGS is not hit in a burst. */
export const DETAIL_GAP_MS = 300;
/** Most events whose detail record is fetched in one run. */
export const MAX_DETAIL_FETCHES = 15;
/** Events whose detail fetch may fail in a row before the run stops fetching details. */
export const MAX_FAILED_DETAILS = 3;
/** Byte budget for one event's shaking areas, as compact JSON. */
export const AREA_BUDGET_BYTES = 60_000;
/** Weakest shaking drawn as an area (MMI IV, "light": felt indoors by many). */
const MIN_AREA_MMI = 4;
/** Contour rings smaller than this (km2) are specks, not areas. */
const MIN_RING_KM2 = 10;
/** Weakest shaking at which a PAGER city is listed. */
const MIN_CITY_MMI = 4;
/** Cities listed per quake: the most strongly shaken, then the most populous of the rest. */
const CITIES_BY_SHAKING = 8;
const CITIES_BY_POPULATION = 4;
/** A neighbouring country is listed when at least this many people there felt moderate shaking (MMI V) or more. */
const MIN_COUNTRY_EXPOSED = 1_000;
/** PAGER head counts below this are model noise, not worth a figure. */
const MIN_FIGURE_PEOPLE = 1_000;
/** Globe shapes that never own an earthquake. */
const NOT_A_COUNTRY = new Set(["AQ"]);

export const PAGER_SOURCE = "USGS PAGER";
const DYFI_SOURCE = "USGS Did You Feel It?";
const TSUNAMI_LINK: SourceRef = { name: "NOAA tsunami warnings", url: "https://www.tsunami.gov/" };

export type PagerAlert = "green" | "yellow" | "orange" | "red";

/** One earthquake from a USGS summary feed, as this module reads it. */
export interface UsgsQuake {
  id: string;
  /** Every id USGS knows the event by, the preferred one included. */
  ids: string[];
  mag: number | null;
  place: string | null;
  /** Origin time, ms since 1970. */
  time: number;
  /** Last change to the event at USGS, ms since 1970. */
  updated: number;
  url: string;
  detail: string;
  alert: PagerAlert | null;
  /** USGS's flag for large quakes at sea; it does not mean a tsunami happened. */
  tsunami: boolean;
  sig: number;
  felt: number | null;
  /** "earthquake", or e.g. "quarry blast" and "explosion", which are skipped. */
  type: string;
  lat: number;
  lng: number;
  depthKm: number | null;
}

/** What a detail record adds to an event. */
export interface QuakeExtras {
  areas: Area[];
  /** PAGER towns and cities with the shaking they felt. */
  cities: Place[];
  /** Countries where PAGER counts people in moderate shaking or worse, most exposed first. */
  countries: string[];
  /** PAGER exposure estimates. */
  figures: Figure[];
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

/**
 * GETs a JSON document, retrying once after retryMs on any failure (network
 * error, timeout, non-200 status or bad JSON). Null when both attempts fail.
 */
export async function getJson(url: string, deps: FetchDeps, retryMs: number): Promise<unknown | null> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await deps.fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/geo+json, application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await res.text();
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      return JSON.parse(text) as unknown;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.log(`USGS ${url}: attempt ${attempt} failed: ${msg}`);
      if (attempt === 1) await deps.sleep(retryMs);
    }
  }
  return null;
}

/** True for an https URL on a usgs.gov host, the only place detail links may lead. */
export function isUsgsUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "usgs.gov" || u.hostname.endsWith(".usgs.gov"));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Feeds
// ---------------------------------------------------------------------------

/** A finite number, or null. */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Largest time (ms) a JavaScript Date can hold; beyond it toISOString throws. */
const MAX_DATE_MS = 8.64e15;

/** A finite time in ms that a Date can hold, or null. */
function timeMs(v: unknown): number | null {
  const t = num(v);
  return t !== null && Math.abs(t) <= MAX_DATE_MS ? t : null;
}

/** A non-empty trimmed string, or null. */
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** A longitude in [-180, 180], left exactly as given when it already is (normaliseLng's arithmetic adds float noise). */
function inRangeLng(lng: number): number {
  return lng >= -180 && lng <= 180 ? lng : normaliseLng(lng);
}

/** A PAGER alert colour, or null for anything else. */
function parseAlert(v: unknown): PagerAlert | null {
  return v === "green" || v === "yellow" || v === "orange" || v === "red" ? v : null;
}

/** One feed feature as a UsgsQuake, or null when its id, time or position is unusable. */
function parseQuake(f: unknown): UsgsQuake | null {
  if (!f || typeof f !== "object") return null;
  const feature = f as { id?: unknown; properties?: Record<string, unknown>; geometry?: { type?: unknown; coordinates?: unknown } };
  const id = str(feature.id);
  const p = feature.properties;
  const coords = feature.geometry?.type === "Point" ? feature.geometry.coordinates : null;
  if (!id || !p || !Array.isArray(coords)) return null;
  const lng = num(coords[0]);
  const lat = num(coords[1]);
  const time = timeMs(p.time);
  if (lng === null || lat === null || time === null || Math.abs(lat) > 90 || Math.abs(lng) > 360) return null;
  const ids = (str(p.ids) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    id,
    ids: ids.includes(id) ? ids : [id, ...ids],
    mag: num(p.mag),
    place: str(p.place),
    time,
    updated: Math.max(time, timeMs(p.updated) ?? time),
    url: isUsgsUrl(p.url) ? p.url : `https://earthquake.usgs.gov/earthquakes/eventpage/${encodeURIComponent(id)}`,
    detail: isUsgsUrl(p.detail) ? p.detail : `https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/${encodeURIComponent(id)}.geojson`,
    alert: parseAlert(p.alert),
    tsunami: p.tsunami === 1,
    sig: num(p.sig) ?? 0,
    felt: num(p.felt),
    type: str(p.type) ?? "earthquake",
    lat,
    lng: inRangeLng(lng),
    depthKm: num(coords[2]),
  };
}

/** Parses a USGS GeoJSON summary feed. Null when it is not a FeatureCollection; bad features are skipped. */
export function parseUsgsFeed(json: unknown): UsgsQuake[] | null {
  const doc = json as { type?: unknown; features?: unknown } | null;
  if (!doc || typeof doc !== "object" || doc.type !== "FeatureCollection" || !Array.isArray(doc.features)) return null;
  return doc.features.map(parseQuake).filter((q): q is UsgsQuake => q !== null);
}

/**
 * Joins feeds, keeping one copy of each event (the most recently updated).
 * Two entries are the same event when they share any USGS id: the feeds are
 * regenerated at different times, so one can still list an event under its
 * old preferred id after USGS switched it (e.g. us6000u0ju -> aka2026tuxgky).
 * The kept copy lists every id either copy had.
 */
export function mergeFeeds(lists: UsgsQuake[][]): UsgsQuake[] {
  const kept: UsgsQuake[] = [];
  for (const q of lists.flat()) {
    const i = kept.findIndex((k) => k.ids.some((id) => q.ids.includes(id)));
    if (i === -1) {
      kept.push(q);
      continue;
    }
    const newer = q.updated > kept[i].updated ? q : kept[i];
    kept[i] = { ...newer, ids: [...new Set([newer.id, ...kept[i].ids, ...q.ids])] };
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/**
 * Whether a quake is a current disaster: magnitude 5.5+ in the past 7 days,
 * a USGS significance of 600+ in the past 14 days, or a yellow, orange or
 * red PAGER alert in the past 21 days.
 */
export function isIncluded(q: UsgsQuake, now: string): boolean {
  if (q.type !== "earthquake") return false;
  const ageDays = (Date.parse(now) - q.time) / DAY_MS;
  if (q.mag !== null && q.mag >= 5.5 && ageDays <= 7) return true;
  if (q.sig >= 600 && ageDays <= 14) return true;
  return q.alert !== null && q.alert !== "green" && ageDays <= 21;
}

/** True for orange and red PAGER alerts. */
export function isHighAlert(q: UsgsQuake): boolean {
  return q.alert === "orange" || q.alert === "red";
}

/**
 * Whether a quake with no globe country within 300 km is still kept: when
 * PAGER gives it a yellow, orange or red alert. PAGER only raises an alert
 * for people it expects to be hurt or losses on land, so such a quake is not
 * in the open ocean; it hit an island state the 110m globe has no shape for
 * (Tonga, Samoa, Guam and others).
 */
export function keptWithoutCountry(q: UsgsQuake): boolean {
  return q.alert === "yellow" || isHighAlert(q);
}

/** Red and orange alerts are severe, yellow significant, the rest minor; magnitude 7+ is at least significant. */
export function severityOf(q: UsgsQuake): Severity {
  const base: Severity = isHighAlert(q) ? 3 : q.alert === "yellow" ? 2 : 1;
  return q.mag !== null && q.mag >= 7 && base < 2 ? 2 : base;
}

/** e.g. "Magnitude 6.6, depth 10 km", with a pointer to tsunami.gov for large quakes at sea. */
export function severityText(q: UsgsQuake): string {
  const parts: string[] = [];
  if (q.mag !== null) parts.push(`Magnitude ${q.mag.toFixed(1)}`);
  if (q.depthKm !== null) parts.push(`${parts.length ? "depth" : "Depth"} ${Math.max(0, Math.round(q.depthKm))} km`);
  if (q.tsunami) parts.push(parts.length ? "check tsunami.gov for tsunami alerts" : "Check tsunami.gov for tsunami alerts");
  return parts.join(", ");
}

/** From this distance (km) a quake is no longer "near" the town USGS measures from; the distance is kept. */
const NEAR_KM = 100;

/**
 * USGS place text such as "48 km WNW of Khuzdar, Pakistan" turned into
 * "near Khuzdar, Pakistan". Offsets of 100 km or more stay as USGS wrote
 * them ("203 km WNW of Port-Olry, Vanuatu"), since such a quake is far out
 * at sea rather than near the town. Region names take "in the" before a
 * sea feature or region ("in the central Mid-Atlantic Ridge") and plain
 * "in" otherwise ("in southern Xinjiang, China").
 */
export function locationPhrase(place: string | null): string {
  const text = (place ?? "").trim();
  if (!text) return "";
  const offset = /^(\d+(?:\.\d+)?)\s*km\s+[NSEW]{1,3}\s+of\s+(.+)$/i.exec(text);
  if (offset) return Number(offset[1]) >= NEAR_KM ? text : `near ${offset[2].trim()}`;
  if (/^(off|near|offshore|(north|south|east|west|northeast|northwest|southeast|southwest)\s+of)\b/i.test(text)) {
    return text[0].toLowerCase() + text.slice(1);
  }
  const feature = /\b(sea|ocean|ridge|rise|islands?|region|trench|basin|gulf|strait|peninsula|archipelago|bay|zone|plateau|channel|passage)\b/i;
  return feature.test(text) ? `in the ${text}` : `in ${text}`;
}

/** e.g. "M6.6 earthquake near Río Grande, Panama". */
export function quakeTitle(mag: number | null, place: string | null): string {
  const head = mag === null ? "Earthquake" : `M${mag.toFixed(1)} earthquake`;
  const where = locationPhrase(place);
  return where ? `${head} ${where}` : head;
}

/**
 * When the source last saw the event active: USGS's update time, but never
 * more than two days after the quake, since later edits (felt reports,
 * reviews) do not mean the shaking goes on. Capping rather than falling back
 * to the quake time keeps the value from moving backwards when USGS edits an
 * event on day three, which would make merge.ts drop it from the map early.
 */
export function eventUpdated(q: UsgsQuake): string {
  return new Date(Math.min(q.updated, q.time + 2 * DAY_MS)).toISOString();
}

/** The country a quake belongs to: the one it is in or within 30 km of, else the nearest within 300 km. */
export function primaryCountry(q: Pick<UsgsQuake, "lat" | "lng">, shapes: CountryShape[]): string | null {
  return countryAt(q.lat, q.lng, shapes, 30) ?? nearestCountry(q.lat, q.lng, shapes, 300)?.code ?? null;
}

/** Whether the quake is strong enough for its ShakeMap and PAGER products to be worth fetching. */
export function wantsDetail(q: UsgsQuake): boolean {
  return (q.mag !== null && q.mag >= 6) || (q.alert !== null && q.alert !== "green");
}

// ---------------------------------------------------------------------------
// Detail record
// ---------------------------------------------------------------------------

interface Product {
  status?: unknown;
  preferredWeight?: unknown;
  updateTime?: unknown;
  contents?: Record<string, { url?: unknown } | undefined>;
}

/** A product type's versions from a detail record, preferred first (USGS's weight, then newest). */
function productsOf(detail: unknown, type: string): Product[] {
  const products = (detail as { properties?: { products?: Record<string, unknown> } } | null)?.properties?.products;
  const list = products?.[type];
  if (!Array.isArray(list)) return [];
  return (list as Product[])
    .filter((p) => p && typeof p === "object" && p.status !== "DELETE")
    .sort((a, b) => (num(b.preferredWeight) ?? 0) - (num(a.preferredWeight) ?? 0) || (num(b.updateTime) ?? 0) - (num(a.updateTime) ?? 0));
}

/** The URL of the first of `keys` that the preferred version of a product carries. */
function contentUrl(detail: unknown, type: string, keys: string[]): string | null {
  for (const product of productsOf(detail, type)) {
    for (const key of keys) {
      const url = product.contents?.[key]?.url;
      if (isUsgsUrl(url)) return url;
    }
  }
  return null;
}

/** The ShakeMap intensity contours (cont_mmi.json) linked from a detail record. */
export function shakeMapUrl(detail: unknown): string | null {
  return contentUrl(detail, "shakemap", ["download/cont_mmi.json"]);
}

/** The PAGER city and exposure files linked from a detail record. */
export function pagerUrls(detail: unknown): { cities: string | null; exposures: string | null } {
  return {
    cities: contentUrl(detail, "losspager", ["json/cities.json", "cities.json"]),
    exposures: contentUrl(detail, "losspager", ["json/exposures.json", "exposures.json"]),
  };
}

// ---------------------------------------------------------------------------
// ShakeMap contours
// ---------------------------------------------------------------------------

/** A closed contour line at one intensity. */
export interface ContourRing {
  level: number;
  ring: Position[];
}

/** Longitudes made continuous, so a line crossing the antimeridian runs 179 -> 181. */
function continuous(line: Position[]): Position[] {
  const out: Position[] = [];
  for (const [lng, lat] of line) {
    if (out.length === 0) {
      out.push([lng, lat]);
      continue;
    }
    let d = lng - out[out.length - 1][0];
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    out.push([out[out.length - 1][0] + d, lat]);
  }
  return out;
}

/** A line's valid positions, or null when any is not a finite in-range pair. */
function readLine(raw: unknown): Position[] | null {
  if (!Array.isArray(raw)) return null;
  const out: Position[] = [];
  for (const p of raw) {
    if (!Array.isArray(p)) return null;
    const lng = num(p[0]);
    const lat = num(p[1]);
    if (lng === null || lat === null || Math.abs(lat) > 90 || Math.abs(lng) > 540) return null;
    const last = out[out.length - 1];
    if (!last || last[0] !== lng || last[1] !== lat) out.push([lng, lat]);
  }
  return out;
}

/**
 * Every closed contour line in a ShakeMap cont_mmi.json file, with its MMI
 * level. Lines that run off the edge of the ShakeMap grid are open and are
 * dropped: which side of them shook harder cannot be closed off reliably.
 */
export function contourRings(json: unknown): ContourRing[] {
  const features = (json as { features?: unknown } | null)?.features;
  if (!Array.isArray(features)) return [];
  const out: ContourRing[] = [];
  for (const f of features as { properties?: { value?: unknown }; geometry?: { type?: unknown; coordinates?: unknown } }[]) {
    const level = num(f?.properties?.value);
    const g = f?.geometry;
    if (level === null || !g || !Array.isArray(g.coordinates)) continue;
    const lines = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
    for (const raw of lines) {
      const line = readLine(raw);
      if (!line || line.length < 4) continue;
      const ring = continuous(line);
      const [first, last] = [ring[0], ring[ring.length - 1]];
      if (Math.abs(first[0] - last[0]) > 1e-6 || Math.abs(first[1] - last[1]) > 1e-6) continue;
      ring[ring.length - 1] = [first[0], first[1]];
      out.push({ level, ring });
    }
  }
  return out;
}

/** Twice the signed planar area of a ring (positive when counter-clockwise). */
export function signedArea2(ring: Position[]): number {
  let sum = 0;
  for (let i = 1; i < ring.length; i++) sum += ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1];
  return sum;
}

/** Area of one ring in km2. */
function ringKm2(ring: Position[]): number {
  return geometryAreaKm2({ type: "Polygon", coordinates: [ring] });
}

/**
 * The winding (sign of signedArea2) of rings that enclose stronger shaking.
 * Every hole sits inside a larger outer ring of its own level, so outer
 * rings hold most of the total area and the sign of the summed signed area
 * gives their winding. ShakeMap 4 winds them clockwise (-1), the default.
 */
export function outerWinding(rings: ContourRing[]): number {
  return Math.sign(rings.reduce((sum, r) => sum + signedArea2(r.ring), 0)) || -1;
}

/** The intensities drawn: whole MMI values from IV up (ShakeMap also draws half steps); all from IV if none is whole. */
export function pickLevels(levels: number[]): number[] {
  const strong = [...new Set(levels.filter((l) => l >= MIN_AREA_MMI))].sort((a, b) => a - b);
  const whole = strong.filter((l) => Number.isInteger(l));
  return whole.length > 0 ? whole : strong;
}

/**
 * Builds the area shaken at `level` or more from that level's closed rings.
 * ShakeMap winds every ring the same way around the stronger side, so a
 * ring wound like `outerSign` encloses stronger shaking and one wound the
 * other way is a hole of weaker shaking inside it. Holes go into the
 * smallest enclosing outer ring. Output follows GeoJSON's winding (outer
 * rings counter-clockwise, holes clockwise).
 */
export function levelGeometry(rings: Position[][], outerSign: number): AreaGeometry | null {
  const big = rings.filter((r) => ringKm2(r) >= MIN_RING_KM2);
  const outers = big.filter((r) => Math.sign(signedArea2(r)) === outerSign).map((r) => ({ ring: r, km2: ringKm2(r), holes: [] as Position[][] }));
  const holes = big.filter((r) => Math.sign(signedArea2(r)) !== outerSign);
  for (const hole of holes) {
    const home = outers
      .filter((o) => pointInGeometry(hole[0][0], hole[0][1], { type: "Polygon", coordinates: [o.ring] }))
      .sort((a, b) => a.km2 - b.km2)[0];
    home?.holes.push(hole);
  }
  if (outers.length === 0) return null;
  const ccw = (r: Position[]) => (signedArea2(r) > 0 ? r : [...r].reverse());
  const cw = (r: Position[]) => (signedArea2(r) < 0 ? r : [...r].reverse());
  const coordinates = outers.map((o) => [ccw(o.ring), ...o.holes.map(cw)]);
  return toAreaGeometry({ type: "MultiPolygon", coordinates });
}

/** The polygons of a geometry, each as its list of rings. */
function polygonsOf(g: AreaGeometry): Position[][][] {
  return g.type === "Polygon" ? [g.coordinates] : g.coordinates;
}

/** True when `weaker` encloses `stronger`: it is at least as large and holds a corner of stronger's largest polygon. */
function encloses(weaker: AreaGeometry, stronger: AreaGeometry): boolean {
  if (geometryAreaKm2(weaker) < geometryAreaKm2(stronger)) return false;
  const [largest] = polygonsOf(stronger)
    .map((p) => ({ p, km2: geometryAreaKm2({ type: "Polygon", coordinates: p }) }))
    .sort((a, b) => b.km2 - a.km2);
  const [lng, lat] = largest.p[0][0];
  return pointInGeometry(lng, lat, weaker);
}

/**
 * Drops levels that do not enclose the next stronger level. Shaking areas
 * nest (wherever shaking reached VI it also reached V), so a level that is
 * smaller than the one above it, or lies beside it, lost its main contour
 * off the edge of the ShakeMap grid and holds only stray patches. Seen live
 * on the M6.6 Panama quake us6000u19w, whose MMI IV "area" was a 13 km2
 * speck while MMI V covered 10,700 km2. Takes and returns weakest first.
 */
export function nestedLevels(areas: Area[]): Area[] {
  const kept: Area[] = [];
  for (const area of [...areas].reverse()) {
    const stronger = kept[kept.length - 1];
    if (!stronger || encloses(area.geometry, stronger.geometry)) kept.push(area);
  }
  return kept.reverse();
}

/** Size of a value as compact JSON, in bytes. */
function jsonBytes(value: unknown): number {
  return JSON.stringify(value).length;
}

/**
 * Simplifies areas so their JSON fits in maxBytes. Every area is first
 * lightly simplified (about 500 m); if they are still too big, each gets a
 * share of the budget in proportion to its size; if even that is too big,
 * the weakest levels are dropped first.
 */
export function fitAreas(areas: Area[], maxBytes: number): Area[] {
  const light = areas
    .map((a) => ({ area: a, geometry: fitGeometry(a.geometry, Number.POSITIVE_INFINITY) }))
    .filter((x): x is { area: Area; geometry: AreaGeometry } => x.geometry !== null);
  let out: Area[] = light.map((x) => ({ ...x.area, geometry: x.geometry }));
  const total = jsonBytes(out);
  if (total > maxBytes) {
    const scale = (maxBytes * 0.95) / total; // leaves room for the kind and level fields
    out = light.map((x) => {
      const share = Math.max(200, Math.floor(jsonBytes(x.geometry) * scale));
      return { ...x.area, geometry: fitGeometry(x.area.geometry, share) ?? x.geometry };
    });
  }
  out.sort((a, b) => (a.level ?? 0) - (b.level ?? 0));
  while (out.length > 1 && jsonBytes(out) > maxBytes) out.shift();
  return out;
}

/**
 * Turns a ShakeMap cont_mmi.json file into "shaking" areas, one per whole
 * MMI level from IV up (weakest first), each covering where shaking reached
 * at least that level, fitted together into maxBytes. Levels cut off by the
 * grid edge are left out (nestedLevels). Empty when the file has no usable
 * closed contours.
 */
export function contoursToAreas(json: unknown, maxBytes = AREA_BUDGET_BYTES): Area[] {
  const rings = contourRings(json);
  if (rings.length === 0) return [];
  const outerSign = outerWinding(rings);
  const areas: Area[] = [];
  for (const level of pickLevels(rings.map((r) => r.level))) {
    const geometry = levelGeometry(rings.filter((r) => r.level === level).map((r) => r.ring), outerSign);
    if (geometry) areas.push({ kind: "shaking", level, geometry });
  }
  return fitAreas(nestedLevels(areas), maxBytes);
}

// ---------------------------------------------------------------------------
// PAGER
// ---------------------------------------------------------------------------

const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
const SHAKING = ["", "Not felt", "Weak", "Weak", "Light", "Moderate", "Strong", "Very strong", "Severe", "Violent", "Extreme"];

/** The whole intensity class of an MMI value, 1 to 10. */
function mmiClass(mmi: number): number {
  return Math.min(10, Math.max(1, Math.round(mmi)));
}

/** e.g. "Very strong shaking (intensity VII)". */
export function shakingLabel(mmi: number): string {
  const c = mmiClass(mmi);
  return `${SHAKING[c]} shaking (intensity ${ROMAN[c]})`;
}

interface PagerCity {
  name: string;
  lat: number;
  lng: number;
  pop: number;
  mmi: number;
  capital: boolean;
}

/** The valid cities of a PAGER cities.json file. */
function readCities(json: unknown): PagerCity[] {
  const doc = json as { all_cities?: unknown; onepager_cities?: unknown } | null;
  const list = Array.isArray(doc?.all_cities) ? doc.all_cities : Array.isArray(doc?.onepager_cities) ? doc.onepager_cities : [];
  const out: PagerCity[] = [];
  for (const c of list as Record<string, unknown>[]) {
    const name = str(c?.name);
    const lat = num(c?.lat);
    const lng = num(c?.lon);
    const mmi = num(c?.mmi);
    if (!name || lat === null || lng === null || mmi === null || Math.abs(lat) > 90) continue;
    out.push({ name, lat, lng: inRangeLng(lng), pop: Math.max(0, num(c.pop) ?? 0), mmi, capital: c.iscap === true });
  }
  return out;
}

/**
 * The places PAGER says felt at least light shaking: the eight most
 * strongly shaken, then the four most populous of the rest, listed from
 * strongest shaking down. Each is placed in the country it lies in, or the
 * quake's country when it is too small for the globe's shapes.
 */
export function pagerCities(json: unknown, shapes: CountryShape[], fallbackCountry: string | null): Place[] {
  const felt = readCities(json).filter((c) => c.mmi >= MIN_CITY_MMI);
  const byShaking = [...felt].sort((a, b) => b.mmi - a.mmi || b.pop - a.pop);
  const top = byShaking.slice(0, CITIES_BY_SHAKING);
  const populous = byShaking.slice(CITIES_BY_SHAKING).sort((a, b) => b.pop - a.pop).slice(0, CITIES_BY_POPULATION);
  const places: Place[] = [];
  for (const c of [...top, ...populous].sort((a, b) => b.mmi - a.mmi)) {
    const country = countryAt(c.lat, c.lng, shapes, 30) ?? fallbackCountry;
    if (!country) continue;
    places.push({
      name: c.name,
      country,
      lat: Math.round(c.lat * 10000) / 10000,
      lng: Math.round(c.lng * 10000) / 10000,
      kind: c.capital || c.pop >= 100_000 ? "city" : "town",
      impact: shakingLabel(c.mmi),
      source: "usgs",
    });
  }
  return places;
}

/** A head count written for readers: exact below 1,000, then to the thousand, then in millions. */
export function formatPeople(n: number): string {
  if (n < 1000) return String(Math.round(n));
  const thousands = Math.round(n / 1000) * 1000;
  if (thousands < 1_000_000) return new Intl.NumberFormat("en-US").format(thousands);
  return `${(n / 1_000_000).toFixed(1)} million`;
}

/** Sum of PAGER head counts at MMI levels of at least minMmi (counts[i] belongs to mmis[i]). */
function exposureAtOrAbove(mmis: unknown, counts: unknown, minMmi: number): number {
  if (!Array.isArray(mmis) || !Array.isArray(counts)) return 0;
  let sum = 0;
  mmis.forEach((m, i) => {
    const level = num(m);
    const count = num(counts[i]);
    if (level !== null && count !== null && level >= minMmi) sum += count;
  });
  return sum;
}

/**
 * Reads a PAGER exposures.json file: the countries where at least 1,000
 * people felt moderate shaking or worse (most exposed first, globe codes
 * only), and one figure for how many people felt strong shaking or worse
 * (or moderate, when fewer than 1,000 felt strong shaking; none when
 * fewer than 1,000 felt either).
 */
export function pagerExposure(json: unknown, shapes: CountryShape[], eventUrl: string): { countries: string[]; figures: Figure[] } {
  const pop = (json as { population_exposure?: { mmi?: unknown; aggregated_exposure?: unknown; country_exposures?: unknown } } | null)
    ?.population_exposure;
  if (!pop) return { countries: [], figures: [] };
  const codes = new Set(shapes.map((s) => s.code));
  const perCountry = (Array.isArray(pop.country_exposures) ? pop.country_exposures : [])
    .map((c: { country_code?: unknown; exposure?: unknown }) => ({
      code: str(c?.country_code)?.toUpperCase() ?? "",
      exposed: exposureAtOrAbove(pop.mmi, c?.exposure, 5),
    }))
    .filter((c) => codes.has(c.code) && c.exposed >= MIN_COUNTRY_EXPOSED)
    .sort((a, b) => b.exposed - a.exposed);
  const figures: Figure[] = [];
  const strong = exposureAtOrAbove(pop.mmi, pop.aggregated_exposure, 6);
  const moderate = exposureAtOrAbove(pop.mmi, pop.aggregated_exposure, 5);
  const [count, label] = strong >= MIN_FIGURE_PEOPLE ? [strong, "strong"] : [moderate, "moderate"];
  if (count >= MIN_FIGURE_PEOPLE) {
    figures.push({
      label: `People exposed to ${label} shaking or worse (estimate)`,
      value: formatPeople(count),
      sourceName: PAGER_SOURCE,
      sourceUrl: `${eventUrl}/pager`,
    });
  }
  return { countries: perCountry.map((c) => c.code), figures };
}

// ---------------------------------------------------------------------------
// Detail fetching and reuse
// ---------------------------------------------------------------------------

/** No areas, places, countries or figures. */
export function emptyExtras(): QuakeExtras {
  return { areas: [], cities: [], countries: [], figures: [] };
}

/** What the previous run found in an event's detail record, read back from its SourceEvent. Missing lists read as empty. */
export function extrasFromPrevious(prev: SourceEvent): QuakeExtras {
  const list = <T>(v: T[] | undefined): T[] => (Array.isArray(v) ? v : []);
  return {
    areas: list(prev.areas),
    cities: list(prev.places).filter((p) => p && typeof p === "object" && p.kind !== "site"),
    countries: list(prev.countries),
    figures: list(prev.figures).filter((f) => f?.sourceName === PAGER_SOURCE),
  };
}

/**
 * True for a previous-run report this module can reuse or carry over: a
 * USGS event with an id, a start time and lists for areas, countries and
 * links. The previous run is read back from disk, so anything else is
 * skipped rather than allowed to throw.
 */
export function isPreviousUsgs(e: unknown): e is SourceEvent {
  if (!e || typeof e !== "object") return false;
  const x = e as Partial<SourceEvent>;
  return (
    x.source === "usgs" &&
    typeof x.sourceId === "string" &&
    typeof x.started === "string" &&
    Array.isArray(x.areas) &&
    Array.isArray(x.countries) &&
    Array.isArray(x.links)
  );
}

/** True when extras hold anything worth keeping. */
function hasExtras(x: QuakeExtras): boolean {
  return x.areas.length > 0 || x.cities.length > 0 || x.figures.length > 0;
}

/** The previous run's report of this quake, matched on any of its USGS ids. */
export function findPrevious(previous: SourceEvent[], q: UsgsQuake): SourceEvent | undefined {
  return previous.find((e) => e.sourceId === q.id) ?? previous.find((e) => q.ids.includes(e.sourceId));
}

/** Returns a function that waits gapMs before every call but the first. */
export function pacer(deps: FetchDeps, gapMs: number): () => Promise<void> {
  let first = true;
  return async () => {
    if (!first) await deps.sleep(gapMs);
    first = false;
  };
}

/**
 * Reads one quake's detail record and, from it, its ShakeMap contours and
 * PAGER cities and exposure. `complete` is false when any of those requests
 * failed (or a file could not be read), so the result should not be cached.
 */
export async function fetchDetail(
  q: UsgsQuake,
  country: string | null,
  shapes: CountryShape[],
  deps: FetchDeps,
  pace: () => Promise<void>,
): Promise<{ extras: QuakeExtras; complete: boolean }> {
  const extras = emptyExtras();
  let complete = true;
  try {
    await pace();
    const detail = await getJson(q.detail, deps, DETAIL_RETRY_MS);
    if (detail === null) return { extras, complete: false };
    const contours = shakeMapUrl(detail);
    const pager = pagerUrls(detail);
    if (contours) {
      await pace();
      const json = await getJson(contours, deps, DETAIL_RETRY_MS);
      if (json === null) complete = false;
      else extras.areas = contoursToAreas(json);
    }
    if (pager.cities) {
      await pace();
      const json = await getJson(pager.cities, deps, DETAIL_RETRY_MS);
      if (json === null) complete = false;
      else extras.cities = pagerCities(json, shapes, country);
    }
    if (pager.exposures) {
      await pace();
      const json = await getJson(pager.exposures, deps, DETAIL_RETRY_MS);
      if (json === null) complete = false;
      else Object.assign(extras, pagerExposure(json, shapes, q.url));
    }
  } catch (err) {
    deps.log(`USGS ${q.id}: detail could not be read: ${err instanceof Error ? err.message : String(err)}`);
    complete = false;
  }
  return { extras, complete };
}

/** Extras plus the USGS update time they reflect (SourceEvent.revision); undefined when they must be fetched again. */
export interface DetailResult {
  extras: QuakeExtras;
  revision?: string;
}

/** What to use when an event's detail could not be read this run: the previous run's, else whatever was read. */
export function fallbackDetail(partial: QuakeExtras, prev: SourceEvent | undefined): DetailResult {
  if (prev) {
    const old = extrasFromPrevious(prev);
    if (hasExtras(old) || !hasExtras(partial)) return { extras: old, revision: prev.revision };
  }
  return { extras: partial };
}

/**
 * Gets detail extras for every quake that wants them, most significant
 * first: reused from the previous run while USGS's update time is
 * unchanged, otherwise fetched (at most MAX_DETAIL_FETCHES, requests
 * DETAIL_GAP_MS apart). After MAX_FAILED_DETAILS events in a row fail,
 * USGS is taken to be struggling and the rest keep the previous run's
 * extras, so a run cannot spend most of an hour on timeouts.
 */
export async function loadDetails(
  located: { q: UsgsQuake; country: string | null }[],
  previous: SourceEvent[],
  shapes: CountryShape[],
  deps: FetchDeps,
): Promise<Map<string, DetailResult>> {
  const out = new Map<string, DetailResult>();
  const pace = pacer(deps, DETAIL_GAP_MS);
  let fetched = 0;
  let failedInRow = 0;
  const wanted = located.filter((x) => wantsDetail(x.q)).sort((a, b) => b.q.sig - a.q.sig || b.q.time - a.q.time);
  for (const { q, country } of wanted) {
    const prev = findPrevious(previous, q);
    if (prev && prev.revision === String(q.updated)) {
      out.set(q.id, { extras: extrasFromPrevious(prev), revision: prev.revision });
      continue;
    }
    if (fetched >= MAX_DETAIL_FETCHES || failedInRow >= MAX_FAILED_DETAILS) {
      out.set(q.id, fallbackDetail(emptyExtras(), prev));
      continue;
    }
    fetched++;
    const { extras, complete } = await fetchDetail(q, country, shapes, deps, pace);
    failedInRow = complete ? 0 : failedInRow + 1;
    if (failedInRow === MAX_FAILED_DETAILS) deps.log(`USGS: ${failedInRow} detail fetches failed in a row; skipping the rest this run`);
    out.set(q.id, complete ? { extras, revision: String(q.updated) } : fallbackDetail(extras, prev));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * The sourceId to report a quake under: the id the previous run used while
 * it is still one of the event's USGS ids, else USGS's preferred id. USGS
 * switches an event's preferred id when another network takes it over;
 * keeping the old one keeps the member key "usgs:<id>", and so the
 * disaster's id and research cache, stable.
 */
export function stableSourceId(previous: SourceEvent[], q: UsgsQuake): string {
  return findPrevious(previous, q)?.sourceId ?? q.id;
}

/** Builds the SourceEvent for one quake from its feed entry, country and detail extras. */
export function toSourceEvent(q: UsgsQuake, country: string | null, detail: DetailResult, sourceId: string = q.id): SourceEvent {
  const { extras } = detail;
  const countries = [...new Set([...(country ? [country] : []), ...extras.countries])];
  const places: Place[] = [];
  if (country) {
    places.push({ name: "Epicentre", country, lat: q.lat, lng: q.lng, kind: "site", ...(q.place ? { impact: q.place } : {}), source: "usgs" });
  }
  places.push(...extras.cities);
  const figures = [...extras.figures];
  if (q.felt !== null && q.felt >= 1) {
    figures.push({ label: "Felt reports sent to USGS", value: new Intl.NumberFormat("en-US").format(q.felt), sourceName: DYFI_SOURCE, sourceUrl: `${q.url}/dyfi` });
  }
  const links: SourceRef[] = [{ name: "USGS event page", url: q.url }];
  if (q.tsunami) links.push(TSUNAMI_LINK);
  return {
    source: "usgs",
    sourceId,
    type: "earthquake",
    title: quakeTitle(q.mag, q.place),
    severity: severityOf(q),
    severityText: severityText(q),
    countries,
    lat: q.lat,
    lng: q.lng,
    precision: "exact",
    started: new Date(q.time).toISOString(),
    updated: eventUpdated(q),
    areas: extras.areas,
    places,
    ...(figures.length > 0 ? { figures } : {}),
    links,
    ...(detail.revision !== undefined ? { revision: detail.revision } : {}),
  };
}

/**
 * When one feed failed, the previous run's quakes that the working feed does
 * not list are kept while still recent (14 days, or 21 for significant and
 * severe ones), so a feed outage does not make disasters vanish.
 */
export function carryOver(previous: SourceEvent[], seenIds: Set<string>, now: string): SourceEvent[] {
  const nowMs = Date.parse(now);
  return previous.filter((e) => {
    if (e.source !== "usgs" || seenIds.has(e.sourceId)) return false;
    const ageDays = (nowMs - Date.parse(e.started)) / DAY_MS;
    return ageDays <= (e.severity >= 2 ? 21 : 14);
  });
}

/**
 * Fetches current earthquake disasters from USGS. Returns null only when
 * both feeds fail (the caller then keeps the previous data); otherwise one
 * SourceEvent per included quake, newest first.
 */
export async function fetchUsgs(deps: FetchDeps, now: string, shapes: CountryShape[], previous: SourceEvent[] = []): Promise<SourceEvent[] | null> {
  const feeds: (UsgsQuake[] | null)[] = [];
  for (const url of USGS_FEEDS) {
    const json = await getJson(url, deps, FEED_RETRY_MS);
    const quakes = json === null ? null : parseUsgsFeed(json);
    if (json !== null && quakes === null) deps.log(`USGS ${url}: not a GeoJSON FeatureCollection`);
    feeds.push(quakes);
  }
  const ok = feeds.filter((f): f is UsgsQuake[] => f !== null);
  if (ok.length === 0) return null;

  const land = shapes.filter((s) => !NOT_A_COUNTRY.has(s.code));
  const all = mergeFeeds(ok);
  const located = all
    .filter((q) => isIncluded(q, now))
    .map((q) => ({ q, country: primaryCountry(q, land) }))
    .filter((x) => x.country !== null || keptWithoutCountry(x.q));
  const prevUsgs = (Array.isArray(previous) ? previous : []).filter(isPreviousUsgs);
  const details = await loadDetails(located, prevUsgs, land, deps);
  const events = located.map(({ q, country }) =>
    toSourceEvent(q, country, details.get(q.id) ?? { extras: emptyExtras(), revision: String(q.updated) }, stableSourceId(prevUsgs, q)),
  );
  if (ok.length < feeds.length) {
    const seen = new Set(all.flatMap((q) => q.ids));
    events.push(...carryOver(prevUsgs, seen, now));
  }
  deps.log(`USGS: ${events.length} earthquakes from ${all.length} in the feeds`);
  return events.sort((a, b) => b.started.localeCompare(a.started));
}
