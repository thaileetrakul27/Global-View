// Turns place names (cities, districts, provinces) into coordinates with
// OpenStreetMap Nominatim, so the map can show the specific areas a disaster
// affects rather than a dot in the middle of the country.
//
// Nominatim's usage policy (https://operations.osmfoundation.org/policies/nominatim/)
// is followed strictly:
//   - at most one request per second (requests are serialised and paced);
//   - an identifying User-Agent;
//   - every answer is cached in cache/geocode.json: hits forever, misses are
//     asked again after 30 days;
//   - no bulk use: at most MAX_LOOKUPS_PER_RUN new searches per run, the rest
//     wait for the next run.
// Place data is (c) OpenStreetMap contributors under the ODbL; the site shows
// ATTRIBUTION wherever geocoded places appear.
//
// A search sends "name, admin" restricted to the country. When that finds
// nothing usable and an admin was given, the name is searched on its own
// (sources often give loose regions like "Northern Thailand"). The best
// result in the expected country is kept; settlements and administrative
// boundaries win over natural features (the other way round for a site such
// as a volcano), a result of the kind the caller expects wins over one of
// another size, and shops, offices, roads and the like are never used.
// Districts and regions keep a simplified outline.
import fs from "node:fs";
import path from "node:path";
import type { FetchDeps } from "../googlenews";
import { USER_AGENT } from "../googlenews";
import { circlePolygon, fitGeometry, geometryAreaKm2, toAreaGeometry } from "./geo";
import type { Area, AreaGeometry, Place, PlaceKind } from "./types";

export const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
/** Credit line the site must show next to geocoded places. */
export const ATTRIBUTION = "Place data © OpenStreetMap contributors, ODbL";
export const ATTRIBUTION_URL = "https://www.openstreetmap.org/copyright";

export const GEOCODE_CACHE_PATH = "cache/geocode.json";
/** Most Nominatim searches one pipeline run may send. */
export const MAX_LOOKUPS_PER_RUN = 80;
/** Gap between requests: Nominatim allows one per second, so a little more. */
export const PACE_MS = 1100;
/** Wait before the one retry of a failed search. */
export const RETRY_MS = 5000;
/** A cached "not found" is asked again after this many days. */
export const MISS_RETRY_DAYS = 30;
/** Byte budget for one place's outline, as compact JSON. */
export const AREA_MAX_BYTES = 15_000;
/** Outlines bigger than this are a whole country or state, not a specific area. */
export const MAX_AREA_KM2 = 300_000;
/** Radius of the circle drawn for a place without an outline, by kind. */
export const PLACE_RADIUS_KM: Record<PlaceKind, number> = { city: 12, town: 6, district: 25, region: 60, site: 5 };

const TIMEOUT_MS = 20_000;
const DAY_MS = 86_400_000;
const PLACE_KINDS: readonly PlaceKind[] = ["city", "town", "district", "region", "site"];

/** One geocoded place. */
export interface GeoHit {
  /** English name where OpenStreetMap has one, e.g. "Sylhet Division". */
  name: string;
  /** Full OpenStreetMap label, e.g. "Sylhet Division, Bangladesh". */
  displayName: string;
  /** Province or state the place lies in, when it is not that province itself. */
  admin?: string;
  lat: number;
  lng: number;
  kind: PlaceKind;
  /** Globe country code the place was searched in. */
  country: string;
  /** [minLng, minLat, maxLng, maxLat]; maxLng passes 180 for a place across the antimeridian. */
  bbox: [number, number, number, number];
  /** Simplified outline, kept only for districts and regions. */
  area?: AreaGeometry;
}

export interface GeocodeCacheEntry {
  /** null: Nominatim had nothing usable. */
  hit: GeoHit | null;
  /** ISO time of the lookup. */
  at: string;
}

/** Keyed by geocodeKey(country, name, admin). */
export type GeocodeCache = Record<string, GeocodeCacheEntry>;

export interface GeocoderOptions {
  maxLookups?: number;
  paceMs?: number;
  retryMs?: number;
  missRetryDays?: number;
  endpoint?: string;
}

export interface Geocoder {
  /**
   * Coordinates for a place in a globe country, or null when unknown (or
   * deferred to a later run). kind is what the caller expects the place to
   * be (research gives one): "city" prefers Sylhet city to Sylhet Division,
   * "site" prefers a volcano to a village of the same name.
   */
  geocode(name: string, country: string, admin?: string, kind?: PlaceKind): Promise<GeoHit | null>;
  /** Searches sent to Nominatim so far this run. */
  readonly lookups: number;
  /** Uncached names left for a later run because of the cap or an outage. */
  readonly deferred: number;
}

/** One search result as Nominatim's jsonv2 format gives it (only the fields used). */
export interface NominatimResult {
  lat?: string;
  lon?: string;
  category?: string;
  type?: string;
  place_rank?: number;
  addresstype?: string;
  name?: string;
  display_name?: string;
  /** [minLat, maxLat, minLng, maxLng] as strings. */
  boundingbox?: string[];
  geojson?: unknown;
  address?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Names, keys and URLs
// ---------------------------------------------------------------------------

/** Globe codes that are not ISO 3166-1 alpha-2, mapped to the country OpenStreetMap files them under. */
const SPECIAL_COUNTRIES: Record<string, string> = { CYN: "cy", SOL: "so", XK: "xk" };

/**
 * Globe countries that OpenStreetMap files inside another country, with the
 * ISO 3166-2 code their addresses carry there. Confirmed live: searching
 * countrycodes=pr, nc or tf finds nothing; Ponce comes back as "us" with
 * "US-PR", Noumea and Port-aux-Francais as "fr" with "FR-NC" and "FR-TF".
 */
const TERRITORIES: Record<string, { cc: string; iso: string; name: string }> = {
  PR: { cc: "us", iso: "US-PR", name: "Puerto Rico" },
  NC: { cc: "fr", iso: "FR-NC", name: "New Caledonia" },
  TF: { cc: "fr", iso: "FR-TF", name: "French Southern and Antarctic Lands" },
};

/** Nominatim's country code for a globe code (lower-case ISO2), or null when there is none. */
export function nominatimCountry(code: string): string | null {
  const c = code.trim().toUpperCase();
  if (TERRITORIES[c]) return TERRITORIES[c].cc;
  if (SPECIAL_COUNTRIES[c]) return SPECIAL_COUNTRIES[c];
  return /^[A-Z]{2}$/.test(c) ? c.toLowerCase() : null;
}

/** The territory's own name for globe codes OpenStreetMap files inside another country, to narrow a search. */
export function territoryName(code: string): string | undefined {
  return TERRITORIES[code.trim().toUpperCase()]?.name;
}

/** The ISO 3166-2 subdivision codes in an address ("ISO3166-2-lvl4" and the like), upper-cased. */
function subdivisionCodes(address: Record<string, string> | undefined): string[] {
  return Object.entries(address ?? {})
    .filter(([k, v]) => k.startsWith("ISO3166-2") && typeof v === "string")
    .map(([, v]) => v.toUpperCase());
}

/**
 * True when a result lies in the given globe country: its country code
 * matches, a territory's results carry the territory's code, and the
 * country it is filed under leaves the territory out (the globe draws
 * Puerto Rico apart from the United States).
 */
export function inGlobeCountry(r: NominatimResult, code: string): boolean {
  const want = nominatimCountry(code);
  const cc = r.address?.country_code;
  if (!want || typeof cc !== "string" || cc.toLowerCase() !== want) return false;
  const codes = subdivisionCodes(r.address);
  const own = TERRITORIES[code.trim().toUpperCase()];
  if (own) return codes.includes(own.iso);
  return !Object.values(TERRITORIES).some((t) => t.cc === want && codes.includes(t.iso));
}

/** Lower-case, accents stripped, punctuation folded to single spaces. Keeps letters of every script. */
export function normaliseKeyPart(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Cache key for one search, e.g. "BD|sunamganj|sylhet". A search for an
 * expected kind ranks results differently, so it gets "|city" and the like.
 */
export function geocodeKey(country: string, name: string, admin?: string, kind?: PlaceKind): string {
  const key = `${country.trim().toUpperCase()}|${normaliseKeyPart(name)}|${normaliseKeyPart(admin ?? "")}`;
  return kind ? `${key}|${kind}` : key;
}

/** The free-form query: "name, admin", or just the name when the admin adds nothing. */
export function searchQuery(name: string, admin?: string): string {
  const n = name.trim();
  const a = (admin ?? "").trim();
  if (!a || normaliseKeyPart(a) === normaliseKeyPart(n)) return n;
  return `${n}, ${a}`;
}

/** The search URL for one query in one country. */
export function buildNominatimUrl(query: string, countryCode: string, endpoint = NOMINATIM_URL): string {
  const params = new URLSearchParams({
    q: query,
    countrycodes: countryCode,
    format: "jsonv2",
    addressdetails: "1",
    limit: "3",
    polygon_geojson: "1",
    polygon_threshold: "0.01",
    "accept-language": "en",
  });
  return `${endpoint}?${params}`;
}

/** True when the text has any Latin letter, so it can be read on an English page. */
export function hasLatin(s: string): boolean {
  return /[A-Za-zÀ-ɏ]/.test(s);
}

/** OpenStreetMap's name, unless it is only in a script the reader cannot read and the query is not. */
export function pickName(osmName: string | undefined, queryName: string): string {
  const o = (osmName ?? "").trim();
  if (!o) return queryName.trim();
  if (!hasLatin(o) && hasLatin(queryName)) return queryName.trim();
  return o;
}

const ADMIN_FIELDS = ["state", "province", "region", "state_district", "county"] as const;

/**
 * The province or state a place lies in, from its address. Skips the place's
 * own name (a state is not inside itself), the country's name (callers
 * sometimes search "Derna, Libya") and unreadable scripts; falls back to the
 * admin the caller searched with.
 */
export function pickAdmin(address: Record<string, string> | undefined, name: string, fallback?: string): string | undefined {
  const skip = new Set([normaliseKeyPart(name), normaliseKeyPart(String(address?.country ?? ""))]);
  for (const field of ADMIN_FIELDS) {
    const v = address?.[field]?.trim();
    if (v && hasLatin(v) && !skip.has(normaliseKeyPart(v))) return v;
  }
  const f = fallback?.trim();
  return f && !skip.has(normaliseKeyPart(f)) ? f : undefined;
}

/** Words that only say what kind of division a name is; dropped when matching admins. */
const ADMIN_WORDS = new Set([
  "province", "state", "region", "division", "district", "county", "department", "governorate",
  "prefecture", "oblast", "krai", "municipality", "territory", "of",
]);

/** True when the result's full label names the given province or state. */
export function mentionsAdmin(r: NominatimResult, admin: string): boolean {
  const core = normaliseKeyPart(admin)
    .split(" ")
    .filter((w) => w && !ADMIN_WORDS.has(w))
    .join(" ");
  if (!core) return false;
  return ` ${normaliseKeyPart(r.display_name ?? "")} `.includes(` ${core} `);
}

// ---------------------------------------------------------------------------
// Reading results
// ---------------------------------------------------------------------------

/** Nominatim address types and the kind of place they are. Anything else is judged by place_rank. */
const ADDRESS_KINDS: Record<string, PlaceKind> = {
  city: "city",
  town: "town",
  village: "town",
  hamlet: "town",
  suburb: "town",
  neighbourhood: "town",
  quarter: "town",
  borough: "town",
  city_block: "town",
  isolated_dwelling: "town",
  locality: "town",
  croft: "town",
  farm: "town",
  square: "town",
  city_district: "district",
  district: "district",
  subdistrict: "district",
  county: "district",
  state_district: "district",
  municipality: "district",
  island: "district",
  state: "region",
  province: "region",
  region: "region",
  archipelago: "region",
};

/** Kind of place by Nominatim's search rank, for address types not in the table. */
function kindByRank(rank: number): PlaceKind {
  if (!Number.isFinite(rank)) return "site";
  if (rank <= 9) return "region";
  if (rank <= 15) return "district";
  if (rank === 16) return "city";
  if (rank <= 25) return "town";
  return "site";
}

/**
 * What kind of place a result is, or null for a whole country or continent
 * (not a specific area). Protected areas count as districts so their outline
 * is kept; other non-settlement features (volcanoes, rivers, parks) are sites.
 */
export function placeKind(r: NominatimResult): PlaceKind | null {
  const rank = Number(r.place_rank);
  if (r.addresstype === "country" || r.addresstype === "continent" || rank <= 4) return null;
  if (r.category === "boundary" && r.type !== "administrative") return "district";
  if (r.category !== "place" && r.category !== "boundary") return "site";
  return ADDRESS_KINDS[r.addresstype ?? ""] ?? kindByRank(rank);
}

/** Categories usable as a natural feature or land area, after settlements and boundaries. */
const SECOND_TIER = new Set(["natural", "waterway", "landuse", "leisure", "mountain_pass"]);

/**
 * Preference for a result: 0 for settlements and administrative boundaries,
 * 1 for natural features and land areas, null for anything else (shops,
 * offices, roads, buildings, museums), which is never used.
 */
export function resultTier(r: NominatimResult): 0 | 1 | null {
  if (r.category === "place") return 0;
  if (r.category === "boundary") return r.type === "administrative" ? 0 : 1;
  return SECOND_TIER.has(r.category ?? "") ? 1 : null;
}

/** Nominatim's [minLat, maxLat, minLng, maxLng] strings as [minLng, minLat, maxLng, maxLat], or null. */
export function parseBbox(raw: unknown): [number, number, number, number] | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const [minLat, maxLat, minLng, maxLng] = raw.map((v) => Number(v));
  if (![minLat, maxLat, minLng, maxLng].every(Number.isFinite)) return null;
  return [minLng, minLat, maxLng, maxLat];
}

/**
 * A bbox spanning more than half the world belongs to a place across the
 * antimeridian (Nominatim gives Taveuni and Chukotka -180 to 180), not to
 * the world. It is rebuilt from the outline with longitudes continuous
 * across 180, as circlePolygon draws them (Taveuni: 179.89 to 180.17), or
 * shrunk to the point without one. A bbox that still wraps is kept.
 */
export function unwrapBbox(bbox: [number, number, number, number], geojson: unknown, lat: number, lng: number): [number, number, number, number] {
  if (bbox[2] - bbox[0] <= 180) return bbox;
  const g = toAreaGeometry(geojson);
  if (!g) return [lng, lat, lng, lat];
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  let west = Infinity;
  let east = -Infinity;
  for (const [x] of polys.flat(2)) {
    const shifted = ((x % 360) + 360) % 360; // 0..360, so places across 180 are continuous
    west = Math.min(west, shifted);
    east = Math.max(east, shifted);
  }
  if (east - west > 180) return bbox;
  const shift = west >= 180 ? 360 : 0;
  return [west - shift, bbox[1], east - shift, bbox[3]];
}

/** A result's outline simplified to the byte budget, or undefined when it is missing, a point or too big. */
export function hitArea(geojson: unknown): AreaGeometry | undefined {
  const g = toAreaGeometry(geojson);
  if (!g || geometryAreaKm2(g) > MAX_AREA_KM2) return undefined;
  return fitGeometry(g, AREA_MAX_BYTES) ?? undefined;
}

/** One result as a GeoHit for the globe country searched, or null when it is unusable. */
export function toGeoHit(r: NominatimResult, country: string, queryName: string, queryAdmin?: string): GeoHit | null {
  const lat = Number(r.lat);
  const lng = Number(r.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const kind = placeKind(r);
  if (!kind) return null;
  const name = pickName(r.name, queryName);
  const admin = pickAdmin(r.address, name, queryAdmin);
  const area = kind === "district" || kind === "region" ? hitArea(r.geojson) : undefined;
  return {
    name,
    displayName: (r.display_name ?? "").trim() || name,
    ...(admin ? { admin } : {}),
    lat,
    lng,
    kind,
    country: country.toUpperCase(),
    bbox: unwrapBbox(parseBbox(r.boundingbox) ?? [lng, lat, lng, lat], r.geojson, lat, lng),
    ...(area ? { area } : {}),
  };
}

/** Size class of each kind, so a search for a city prefers a city to the province of the same name. */
const KIND_SIZE: Record<PlaceKind, number> = { site: 0, city: 0, town: 0, district: 1, region: 2 };

/** How far a result's kind is from the kind the caller expects: 0 when it fits, more the further off. */
export function kindDistance(r: NominatimResult, want?: PlaceKind): number {
  if (!want) return 0;
  const kind = placeKind(r);
  return kind ? Math.abs(KIND_SIZE[kind] - KIND_SIZE[want]) : 3;
}

/**
 * The best usable result in the expected country: settlements and boundaries
 * before natural features (the other way round when the caller wants a
 * site: "Kilauea" finds a village on Kauai before the volcano), then (when
 * preferAdmin is given) results in that province, then results nearest the
 * wanted kind ("Sylhet" finds Sylhet Division before the city), then
 * Nominatim's own order. Null when nothing qualifies.
 */
export function pickBest(
  results: unknown,
  country: string,
  queryName: string,
  queryAdmin?: string,
  preferAdmin?: string,
  want?: PlaceKind,
): GeoHit | null {
  if (!Array.isArray(results)) return null;
  const ranked: { r: NominatimResult; index: number; tier: number; inAdmin: boolean; off: number }[] = [];
  results.forEach((raw: unknown, index) => {
    if (!raw || typeof raw !== "object") return;
    const r = raw as NominatimResult;
    const tier = resultTier(r);
    if (tier === null || !inGlobeCountry(r, country)) return;
    const inAdmin = preferAdmin ? mentionsAdmin(r, preferAdmin) : false;
    ranked.push({ r, index, tier: want === "site" ? 1 - tier : tier, inAdmin, off: kindDistance(r, want) });
  });
  ranked.sort((a, b) => a.tier - b.tier || Number(b.inAdmin) - Number(a.inAdmin) || a.off - b.off || a.index - b.index);
  for (const { r } of ranked) {
    const hit = toGeoHit(r, country, queryName, queryAdmin);
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/** True when a cached answer can be served: hits always, misses until they are missRetryDays old. */
export function isFresh(entry: GeocodeCacheEntry | undefined, now: string, missRetryDays = MISS_RETRY_DAYS): boolean {
  if (!entry) return false;
  if (entry.hit) return true;
  const age = Date.parse(now) - Date.parse(entry.at);
  return Number.isFinite(age) && age < missRetryDays * DAY_MS;
}

/** True for a well-formed cache entry, so a hand-edited or old file cannot break a run. */
export function isCacheEntry(v: unknown): v is GeocodeCacheEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as { hit?: unknown; at?: unknown };
  if (typeof e.at !== "string" || Number.isNaN(Date.parse(e.at))) return false;
  if (e.hit === null) return true;
  const h = e.hit as Partial<GeoHit> | undefined;
  return (
    !!h &&
    typeof h === "object" &&
    typeof h.name === "string" &&
    typeof h.country === "string" &&
    Number.isFinite(h.lat) &&
    Number.isFinite(h.lng) &&
    PLACE_KINDS.includes(h.kind as PlaceKind) &&
    Array.isArray(h.bbox)
  );
}

/** Reads the cache, keeping only well-formed entries. Missing or unreadable files give an empty cache. */
export function readGeocodeCache(file = GEOCODE_CACHE_PATH): GeocodeCache {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const cache: GeocodeCache = {};
  for (const [key, entry] of Object.entries(parsed)) if (isCacheEntry(entry)) cache[key] = entry;
  return cache;
}

/** The cache as JSON with one entry per line, sorted by key, so the committed file diffs cleanly. */
export function serialiseCache(cache: GeocodeCache): string {
  const keys = Object.keys(cache).sort();
  if (keys.length === 0) return "{}\n";
  return `{\n${keys.map((k) => `${JSON.stringify(k)}: ${JSON.stringify(cache[k])}`).join(",\n")}\n}\n`;
}

export function writeGeocodeCache(cache: GeocodeCache, file = GEOCODE_CACHE_PATH): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serialiseCache(cache));
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

/**
 * Statuses that mean this one query is bad, not that Nominatim is down:
 * 400 "Query is too long." (more than about 50 words, confirmed live) and
 * 414 for a URL too long. Retrying cannot help, and stopping the run would
 * let one odd name block every later search, every run.
 */
const REJECTED_STATUS = new Set([400, 414]);

/**
 * Sends one search, retrying once after retryMs on any failure (network
 * error, timeout, non-200 status, or a body that is not a JSON array).
 * Null when both attempts fail. A query Nominatim rejects (400, 414) gives
 * an empty list at once, so it is cached as a miss.
 */
export async function searchNominatim(url: string, deps: FetchDeps, retryMs = RETRY_MS): Promise<unknown[] | null> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await deps.fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json", "Accept-Language": "en" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await res.text();
      if (REJECTED_STATUS.has(res.status)) {
        // Nominatim refused this query, not the service: an empty answer, so the run carries on.
        deps.log(`Nominatim ${url}: query rejected (HTTP ${res.status}): ${text.slice(0, 120)}`);
        return [];
      }
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const body = JSON.parse(text) as unknown;
      if (!Array.isArray(body)) throw new Error(`not a result list: ${text.slice(0, 120)}`);
      return body;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.log(`Nominatim ${url}: attempt ${attempt} failed: ${msg}`);
      if (attempt === 1) await deps.sleep(retryMs);
    }
  }
  return null;
}

/**
 * A geocoder for one run. Answers come from `cache` when fresh; otherwise
 * Nominatim is searched, one request at a time and paced, and the answer is
 * written into `cache` (the caller saves it with writeGeocodeCache). After the
 * per-run cap, or once a search fails twice (Nominatim down or refusing us),
 * uncached names return null without being cached, so a later run tries them.
 */
export function createGeocoder(deps: FetchDeps, cache: GeocodeCache, now: string, opts: GeocoderOptions = {}): Geocoder {
  const maxLookups = opts.maxLookups ?? MAX_LOOKUPS_PER_RUN;
  const paceMs = opts.paceMs ?? PACE_MS;
  const retryMs = Math.max(opts.retryMs ?? RETRY_MS, paceMs); // a retry is a request too
  const missRetryDays = opts.missRetryDays ?? MISS_RETRY_DAYS;
  const endpoint = opts.endpoint ?? NOMINATIM_URL;

  let lookups = 0;
  let deferred = 0;
  let offline = false;
  let capLogged = false;
  let queue: Promise<unknown> = Promise.resolve();
  const inflight = new Map<string, Promise<GeoHit | null>>();

  /** One paced search, or undefined when the run may not search any more. */
  async function search(query: string, cc: string): Promise<unknown[] | null | undefined> {
    if (offline) return undefined;
    if (lookups >= maxLookups) {
      if (!capLogged) deps.log(`Nominatim: ${maxLookups} searches this run; the rest wait for the next run`);
      capLogged = true;
      return undefined;
    }
    if (lookups > 0) await deps.sleep(paceMs);
    lookups++;
    const results = await searchNominatim(buildNominatimUrl(query, cc, endpoint), deps, retryMs);
    if (results === null) {
      offline = true;
      deps.log("Nominatim: a search failed twice; no more searches this run");
    }
    return results;
  }

  /** Searches "name, admin", then the name alone; caches the answer unless the run had to stop. */
  async function lookup(key: string, name: string, country: string, cc: string, admin: string | undefined, want?: PlaceKind): Promise<GeoHit | null> {
    const queries = [searchQuery(name, admin)];
    if (admin && queries[0] !== name) queries.push(name);
    for (const [i, query] of queries.entries()) {
      const results = await search(query, cc);
      if (!results) {
        deferred++;
        return null;
      }
      // The first search matched the admin, so it may stand in for a missing one; the fallback only prefers it.
      const hit = i === 0 ? pickBest(results, country, name, admin, undefined, want) : pickBest(results, country, name, undefined, admin, want);
      if (hit) {
        cache[key] = { hit, at: now };
        return hit;
      }
    }
    cache[key] = { hit: null, at: now };
    return null;
  }

  async function geocode(name: string, country: string, admin?: string, kind?: PlaceKind): Promise<GeoHit | null> {
    const code = country.trim().toUpperCase();
    const cc = nominatimCountry(code);
    const cleanName = name.trim();
    const cleanAdmin = admin?.trim() || undefined;
    if (!cc || !normaliseKeyPart(cleanName)) return null;
    const key = geocodeKey(code, cleanName, cleanAdmin, kind);
    const cached = cache[key];
    if (cached && isFresh(cached, now, missRetryDays)) return cached.hit;
    const pending = inflight.get(key);
    if (pending) return pending;
    // Serialise: each lookup starts only when the previous one has finished, so pacing holds.
    const run = queue.then(async () => {
      const again = cache[key];
      if (again && isFresh(again, now, missRetryDays)) return again.hit;
      try {
        // A territory's country code covers the whole US or France, so its name narrows the search.
        return await lookup(key, cleanName, code, cc, cleanAdmin ?? territoryName(code), kind);
      } catch (err) {
        deps.log(`Nominatim: lookup of "${cleanName}" (${code}) failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    });
    queue = run.catch(() => undefined);
    inflight.set(key, run);
    try {
      return await run;
    } finally {
      inflight.delete(key);
    }
  }

  return {
    geocode,
    get lookups() {
      return lookups;
    },
    get deferred() {
      return deferred;
    },
  };
}

// ---------------------------------------------------------------------------
// Places and areas for the map
// ---------------------------------------------------------------------------

/** A geocoded place as a disaster's Place. */
export function placeFromHit(hit: GeoHit, impact: string | undefined, source: Place["source"]): Place {
  return {
    name: hit.name,
    ...(hit.admin ? { admin: hit.admin } : {}),
    country: hit.country,
    lat: hit.lat,
    lng: hit.lng,
    kind: hit.kind,
    ...(impact?.trim() ? { impact: impact.trim() } : {}),
    source,
  };
}

/** The area drawn for a place: its outline when the geocoder kept one, else a circle sized by kind. */
export function placeArea(place: Place, hit?: GeoHit | null): Area {
  return { kind: "place", geometry: hit?.area ?? circlePolygon(place.lat, place.lng, PLACE_RADIUS_KM[place.kind]) };
}
