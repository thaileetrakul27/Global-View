// IFRC GO operations as disaster reports.
//
// IFRC GO is the Red Cross and Red Crescent movement's operations platform.
// Its public API lists every active appeal: DREF operations (the quick-release
// Disaster Response Emergency Fund) and Emergency Appeals, with the money
// asked for and raised. Most appeals belong to a GO "emergency" (an event)
// whose record names the districts hit, IFRC's severity, headline figures and
// a summary.
//
// This module keeps the appeals for natural disasters that are still running
// and began in the last WINDOW_DAYS days, groups them by emergency, reads each
// emergency's public record once (paced, capped per run, and reused from the
// previous run while GO's update time is unchanged) and places the disaster
// at the centre of its districts. When an emergency's record is not public
// (GO answers 404), has no districts, or an appeal has no emergency at all,
// districts named in the operation's title are looked up instead; failing
// that, the disaster sits at its country's centre. A country the globe does
// not draw (small island states such as Cabo Verde or Tonga) has no globe
// code, so its operations are placed at the centre of GO's districts there,
// with no countries listed, rather than dropped.
//
// Early-action protocols, readiness allocations and imminent-hazard DREFs are
// skipped: they fund preparation, not a disaster under way (except a cyclone,
// which already exists when IFRC acts ahead of landfall).
//
// Field reports and contacts in the API carry staff names, emails and phone
// numbers; none of it is read or stored.
import type { FetchDeps } from "../googlenews";
import { USER_AGENT } from "../googlenews";
import { normaliseName, type CountryResolver } from "../resolve";
import { countryCentroid, normaliseLng, type CountryShape } from "./geo";
import type { AppealRef, DisasterType, Figure, Place, Precision, Severity, SourceEvent, SourceRef } from "./types";

export const GO_API = "https://goadmin.ifrc.org/api/v2";
export const GO_SITE = "https://go.ifrc.org";
/** Every active appeal; GO lists a few hundred, so one page holds them all. */
export const APPEALS_URL = `${GO_API}/appeal/?limit=1000&status=0`;

/** Appeals that started longer ago than this are no longer "right now". */
export const WINDOW_DAYS = 120;
/** Gap between emergency and district requests. */
export const DETAIL_GAP_MS = 250;
/** Most emergency records read in one run. */
export const MAX_DETAIL_FETCHES = 60;
/** Most countries whose district list is read in one run (for title lookups). */
export const MAX_COUNTRY_LOOKUPS = 20;
/** District ids asked for in one request. */
export const DISTRICT_BATCH = 100;
/** Longest summary kept, in characters. */
export const SUMMARY_MAX = 480;
/** Most districts listed as places for one disaster. */
export const MAX_PLACES = 25;
/** Most key figures kept from an emergency. */
export const MAX_FIGURES = 6;
/** An emergency name longer than this gives way to the appeal's shorter name. */
export const MAX_TITLE = 80;
/** Label of the figure built from the appeals' target head counts. */
export const TARGET_LABEL = "People the Red Cross and Red Crescent aim to reach";

const DAY_MS = 86_400_000;
const TIMEOUT_MS = 45_000;
const LIST_RETRY_MS = 5_000;
const DETAIL_RETRY_MS = 2_000;
/** Pages of the appeal list followed at most, should GO ever paginate it. */
const MAX_LIST_PAGES = 5;

// ---------------------------------------------------------------------------
// Small value readers
// ---------------------------------------------------------------------------

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Trimmed string, or "" for anything else. */
function str(x: unknown): string {
  return typeof x === "string" ? x.trim() : "";
}

/** Finite number, or null. */
function num(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

/** ISO 8601 for a parseable date string, else null. */
function isoTime(x: unknown): string | null {
  const s = str(x);
  const ms = s ? Date.parse(s) : NaN;
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Collapses runs of whitespace. */
function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Thousands separators for a plain digit string ("84270" -> "84,270"); anything else as given. */
export function formatValue(value: string): string {
  const v = value.trim();
  return /^\d+$/.test(v) ? new Intl.NumberFormat("en-US").format(Number(v)) : v;
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

/** A GET's outcome: the parsed body, or a failure. missing: GO said 404 (the record is not public). */
export type GetResult = { ok: true; body: unknown } | { ok: false; missing: boolean };

/**
 * GETs a GO API document, retrying once after retryMs on a network error,
 * timeout, bad status or bad JSON. A 404 is an answer, not a failure: GO
 * gives it for emergencies that are not public, so it is not retried.
 */
export async function getJson(url: string, deps: FetchDeps, retryMs: number): Promise<GetResult> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await deps.fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json", "Accept-Language": "en" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await res.text();
      if (res.status === 404) {
        deps.log(`IFRC GO ${url}: not public (404)`);
        return { ok: false, missing: true };
      }
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      return { ok: true, body: JSON.parse(text) as unknown };
    } catch (err) {
      deps.log(`IFRC GO ${url}: attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}`);
      if (attempt === 1) await deps.sleep(retryMs);
    }
  }
  return { ok: false, missing: false };
}

/** Returns a function that waits gapMs before every call but the first. */
export function pacer(deps: FetchDeps, gapMs: number): () => Promise<void> {
  let first = true;
  return async () => {
    if (!first) await deps.sleep(gapMs);
    first = false;
  };
}

// ---------------------------------------------------------------------------
// Appeals
// ---------------------------------------------------------------------------

/** A country as GO describes it. id is GO's own country id (for its country pages). */
export interface GoCountryRef {
  iso: string | null;
  iso3: string | null;
  id: number | null;
  name: string;
}

/** The emergency behind an appeal, as the appeal list describes it (present even when its record is not public). */
export interface GoEventInfo {
  name: string;
  /** IFRC severity: "Red", "Orange" or "Yellow". */
  severity: string | null;
  updatedAt: string | null;
}

/** One active IFRC appeal. Amounts are Swiss francs. */
export interface GoAppeal {
  code: string;
  name: string;
  /** "DREF" or "Emergency Appeal". */
  kind: string;
  /** IFRC disaster type, e.g. "Flood" or "Pluvial/Flash Flood"; "" when missing. */
  dtype: string;
  requested: number;
  funded: number;
  /** People the operation aims to reach, when stated. */
  people: number | null;
  start: string;
  end: string;
  event: number | null;
  /** Null when IFRC runs the appeal from Geneva or a regional office rather than a country. */
  country: GoCountryRef | null;
  eventInfo: GoEventInfo | null;
}

/** A GO country object; null without an ISO code (GO's "IFRC" and region pseudo-countries). */
export function parseCountry(x: unknown): GoCountryRef | null {
  if (!isRecord(x)) return null;
  const iso = str(x.iso).toUpperCase() || null;
  const iso3 = str(x.iso3).toUpperCase() || null;
  if (!iso && !iso3) return null;
  return { iso, iso3, id: num(x.id), name: str(x.name) };
}

/** One appeal row, or null when it lacks a code, name or valid dates. */
export function parseAppeal(row: unknown): GoAppeal | null {
  if (!isRecord(row)) return null;
  const code = str(row.code);
  const name = collapse(str(row.name));
  const start = isoTime(row.start_date);
  const end = isoTime(row.end_date);
  if (!code || !name || !start || !end) return null;
  const details = isRecord(row.event_details) ? row.event_details : null;
  const eventId = num(row.event) ?? (details ? num(details.id) : null);
  return {
    code,
    name,
    kind: str(row.atype_display) || "DREF",
    dtype: isRecord(row.dtype) ? str(row.dtype.name) : "",
    requested: num(row.amount_requested) ?? 0,
    funded: num(row.amount_funded) ?? 0,
    people: num(row.num_beneficiaries) || null,
    start,
    end,
    event: eventId,
    country: parseCountry(row.country),
    eventInfo:
      details && eventId !== null
        ? { name: collapse(str(details.name)), severity: str(details.ifrc_severity_level_display) || null, updatedAt: str(details.updated_at) || null }
        : null,
  };
}

/** GO's link to the next page (an http link is upgraded to https); "" when there is none; null when it leads off the GO API. */
function nextPage(x: unknown): string | null {
  const next = str(x).replace(/^http:\/\//i, "https://");
  if (!next) return "";
  return next.startsWith(`${GO_API}/`) ? next : null;
}

/**
 * The appeal list page: its appeals, the next page's URL, GO's total count
 * and the number of raw rows. Null when it is not a GO list, or when its
 * next link leads off the GO API (the list could not be read whole).
 */
export function parseAppealList(json: unknown): { appeals: GoAppeal[]; next: string | null; total: number | null; rows: number } | null {
  if (!isRecord(json) || !Array.isArray(json.results)) return null;
  const next = nextPage(json.next);
  if (next === null) return null;
  const appeals = json.results.map(parseAppeal).filter((a): a is GoAppeal => a !== null);
  return { appeals, next: next || null, total: num(json.count), rows: json.results.length };
}

/**
 * Why an appeal list that was read cannot stand in for the whole one: pages
 * left unread, no rows at all (GO always has hundreds of active appeals), or
 * fewer rows than GO counts. Null when it is whole.
 */
export function listProblem(nextUrl: string | null, rows: number, total: number | null): string | null {
  if (nextUrl) return `more than ${MAX_LIST_PAGES} pages`;
  if (rows === 0) return "the list is empty";
  if (total !== null && rows < total) return `only ${rows} of ${total} rows`;
  return null;
}

/** Reads every active appeal, following pages. Null when any page fails or the list is not whole, so a partial list never replaces a whole one. */
export async function fetchAppeals(deps: FetchDeps): Promise<GoAppeal[] | null> {
  const out: GoAppeal[] = [];
  let url: string | null = APPEALS_URL;
  let rows = 0;
  let total: number | null = null;
  for (let page = 0; url && page < MAX_LIST_PAGES; page++) {
    const res = await getJson(url, deps, LIST_RETRY_MS);
    const list = res.ok ? parseAppealList(res.body) : null;
    if (!list) {
      deps.log(`IFRC GO appeals: ${res.ok ? "not an appeal list" : "could not be read"}; previous data kept`);
      return null;
    }
    if (total === null) total = list.total;
    rows += list.rows;
    out.push(...list.appeals);
    url = list.next;
  }
  const problem = listProblem(url, rows, total);
  if (problem) {
    deps.log(`IFRC GO appeals: ${problem}; previous data kept`);
    return null;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Which appeals count
// ---------------------------------------------------------------------------

const CYCLONE_WORDS = /\b(?:tropical (?:cyclone|storm|depression)s?|cyclones?|hurricanes?|typhoons?)\b/i;
const WILDFIRE_WORDS = /\b(?:wild ?fires?|forest fires?|bush ?fires?|vegetation fires?|veld ?fires?|grass ?fires?)\b/i;
const LOCAL_STORM_WORDS = /\b(?:hail|wind|rain|thunder|snow|ice)\s?storms?\b|\bhail\b|\btornado(?:es)?\b|\bblizzards?\b/i;
/** Words that mark an operation as something other than a natural hazard. */
const NOT_NATURAL_WORDS =
  /\b(?:cholera|measles|dengue|ebola|marburg|mpox|malaria|polio|diphtheria|meningitis|outbreak|epidemic|election|population movement|displacement|refugees?|migra\w*|conflict|unrest|violence|explosion|returnees)\b/i;

/** Hazard words in a title, in the order they are tried (the more specific first). */
const NAME_HAZARDS: [RegExp, DisasterType][] = [
  [/\btsunamis?\b/i, "tsunami"],
  [/\bearthquakes?\b|\bseismic\b/i, "earthquake"],
  [/\bvolcan\w*|\beruptions?\b/i, "volcano"],
  [CYCLONE_WORDS, "cyclone"],
  [/\b(?:flash )?floods?\b|\bflooding\b|\binundations?\b/i, "flood"],
  [/\b(?:land|mud)slides?\b|\bmudflows?\b/i, "landslide"],
  // GO files "Heavy Rains" operations under Other; what they respond to is flooding.
  [/\b(?:heavy|torrential|intense|extreme|monsoon)\s+(?:rains?|rainfalls?)\b/i, "flood"],
  [WILDFIRE_WORDS, "wildfire"],
  [/\bdroughts?\b|\bdry spell\b/i, "drought"],
  [/\bheat ?waves?\b|\bextreme heat\b/i, "heatwave"],
  [/\bcold ?waves?\b|\bcold spell\b|\bextreme cold\b|\bdzud\b|\b(?:extreme|harsh|severe)\s+winter\b|\bwinter conditions?\b/i, "coldwave"],
  [/\b(?:dust|sand) ?storms?\b/i, "dust"],
  [/\b(?:hail|wind|rain|thunder|snow|ice|winter)?\s?storms?\b|\btornado(?:es)?\b|\bhail\b|\bblizzards?\b|\bheavy snow(?:falls?)?\b|\bsnowfalls?\b/i, "storm"],
];

/** The natural hazard a title names, e.g. "Zimbabwe Hailstorms" -> storm; null when it names none or names a non-natural crisis. */
export function typeFromName(name: string): DisasterType | null {
  if (NOT_NATURAL_WORDS.test(name)) return null;
  for (const [re, type] of NAME_HAZARDS) if (re.test(name)) return type;
  return null;
}

/**
 * The map's disaster type for an IFRC disaster type, or null for crises that
 * are not natural disasters (epidemics, population movement, conflict,
 * transport and chemical accidents...). "Fire" counts only when the title
 * says wildfire; "Other" only when the title names a natural hazard. GO files
 * hail and wind storms under "Storm Surge", so a surge titled as a local
 * storm is a storm, otherwise a cyclone.
 */
export function dtypeToType(dtype: string, name: string): DisasterType | null {
  switch (dtype.trim().toLowerCase()) {
    case "flood":
    case "flash flood":
    case "pluvial/flash flood":
      return "flood";
    case "cyclone":
      return "cyclone";
    case "storm surge":
      return LOCAL_STORM_WORDS.test(name) && !CYCLONE_WORDS.test(name) ? "storm" : "cyclone";
    case "severe local storm":
    case "storm":
      return "storm";
    case "earthquake":
      return "earthquake";
    case "tsunami":
      return "tsunami";
    case "volcanic eruption":
      return "volcano";
    case "drought":
      return "drought";
    case "heat wave":
      return "heatwave";
    case "cold wave":
      return "coldwave";
    case "landslide":
      return "landslide";
    case "fire":
      return WILDFIRE_WORDS.test(name) ? "wildfire" : typeFromName(name);
    case "other":
      return typeFromName(name);
    default:
      return null;
  }
}

const PREPARATION_WORDS = /\bs?EAP(?:\d|\b)|\bearly action\b|\banticipatory\b|\breadiness\b|\bpreparedness\b|\bcontingency\b/i;

/** True for an operation that prepares for a hazard rather than responds to one (an imminent cyclone still counts). */
export function isPreparation(name: string, type: DisasterType | null): boolean {
  return PREPARATION_WORDS.test(name) || (/\bimminent\b/i.test(name) && type !== "cyclone");
}

/** The appeal's disaster type when it responds to a natural disaster, else null. */
export function naturalType(a: Pick<GoAppeal, "dtype" | "name">): DisasterType | null {
  const type = dtypeToType(a.dtype, a.name);
  return type && !isPreparation(a.name, type) ? type : null;
}

/** True while the appeal runs and began within WINDOW_DAYS (a start up to two days ahead is allowed). */
export function isCurrent(a: Pick<GoAppeal, "start" | "end">, now: string): boolean {
  const nowMs = Date.parse(now);
  const start = Date.parse(a.start);
  return Date.parse(a.end) >= nowMs && start >= nowMs - WINDOW_DAYS * DAY_MS && start <= nowMs + 2 * DAY_MS;
}

/** Appeals sharing an emergency. Appeals without one stand alone, keyed "appeal-<code>". */
export interface AppealGroup {
  key: string;
  event: number | null;
  /** Largest first. */
  appeals: GoAppeal[];
}

/** Largest request first, then earliest start, then code. */
function byImportance(a: GoAppeal, b: GoAppeal): number {
  return b.requested - a.requested || a.start.localeCompare(b.start) || a.code.localeCompare(b.code);
}

/** Groups appeals by emergency id, dropping repeated codes. Groups keep the order their first appeal appeared in. */
export function groupAppeals(appeals: GoAppeal[]): AppealGroup[] {
  const groups = new Map<string, AppealGroup>();
  const seen = new Set<string>();
  for (const a of appeals) {
    if (seen.has(a.code)) continue;
    seen.add(a.code);
    const key = a.event !== null ? String(a.event) : `appeal-${a.code}`;
    const group = groups.get(key) ?? { key, event: a.event, appeals: [] };
    group.appeals.push(a);
    groups.set(key, group);
  }
  for (const g of groups.values()) g.appeals.sort(byImportance);
  return [...groups.values()];
}

/** A group chosen for the map, with its disaster type. */
export interface Operation extends AppealGroup {
  type: DisasterType;
}

/**
 * The groups that describe a natural disaster happening now: at least one
 * appeal is current and responds to a natural hazard. The largest such
 * appeal leads (it gives the type, the primary country and, when needed, the
 * title); the group's other appeals still running follow, largest first.
 */
export function selectOperations(appeals: GoAppeal[], now: string): Operation[] {
  const nowMs = Date.parse(now);
  const out: Operation[] = [];
  for (const g of groupAppeals(appeals)) {
    const lead = g.appeals.find((a) => isCurrent(a, now) && naturalType(a) !== null);
    if (!lead) continue;
    const others = g.appeals.filter((a) => a !== lead && Date.parse(a.end) >= nowMs);
    out.push({ ...g, appeals: [lead, ...others], type: naturalType(lead)! });
  }
  return out;
}

/** Emergency Appeals first, then the newest operations, so the read cap spares the biggest. */
export function prioritise(ops: Operation[]): Operation[] {
  const rank = (op: Operation) => (op.appeals.some(isEmergencyAppeal) ? 0 : 1);
  const latest = (op: Operation) => op.appeals.reduce((m, a) => (a.start > m ? a.start : m), "");
  return [...ops].sort((a, b) => rank(a) - rank(b) || latest(b).localeCompare(latest(a)) || a.key.localeCompare(b.key));
}

function isEmergencyAppeal(a: Pick<GoAppeal, "kind">): boolean {
  return /emergency appeal/i.test(a.kind);
}

// ---------------------------------------------------------------------------
// Emergency records and districts
// ---------------------------------------------------------------------------

/** An emergency's public record, only the parts this module uses. */
export interface GoEvent {
  id: number;
  name: string;
  countries: GoCountryRef[];
  districts: { id: number; name: string }[];
  glide?: string;
  /** disaster_start_date as ISO, when given. */
  started: string | null;
  updatedAt: string | null;
  /** The newest field report's date: when the disaster was last reported active. */
  lastReport: string | null;
  /** HTML. */
  summary: string;
  severity: string | null;
  affected: number | null;
  keyFigures: { number: string; deck: string; source: string }[];
}

/** The parts of an emergency record this module uses; null when it is not one. Of the field reports only the newest date is read; contacts never. */
export function parseEvent(json: unknown): GoEvent | null {
  if (!isRecord(json)) return null;
  const id = num(json.id);
  const name = collapse(str(json.name));
  if (id === null || !name) return null;
  const list = (x: unknown) => (Array.isArray(x) ? x : []);
  const districts = list(json.districts)
    .filter(isRecord)
    .map((d) => ({ id: num(d.id), name: collapse(str(d.name)) }))
    .filter((d): d is { id: number; name: string } => d.id !== null);
  const keyFigures = list(json.key_figures)
    .filter(isRecord)
    .map((f) => ({ number: typeof f.number === "number" ? String(f.number) : str(f.number), deck: collapse(str(f.deck)), source: collapse(str(f.source)) }))
    .filter((f) => f.number && f.deck);
  const glide = str(json.glide).toUpperCase();
  return {
    id,
    name,
    countries: list(json.countries).map(parseCountry).filter((c): c is GoCountryRef => c !== null),
    districts,
    ...(glide ? { glide } : {}),
    started: isoTime(json.disaster_start_date),
    updatedAt: str(json.updated_at) || null,
    lastReport: latestReport(list(json.field_reports)),
    summary: typeof json.summary === "string" ? json.summary : "",
    severity: str(json.ifrc_severity_level_display) || null,
    affected: num(json.num_affected) || null,
    keyFigures,
  };
}

/**
 * The newest field report date. GO's own updated_at is the time the record
 * was last edited, which can be weeks after the disaster ended, so it is
 * never used to judge whether a disaster is still active.
 */
export function latestReport(reports: unknown[]): string | null {
  const times = reports
    .filter(isRecord)
    .map((r) => isoTime(r.report_date) ?? isoTime(r.created_at))
    .filter((t): t is string => t !== null);
  return latest(times) ?? null;
}

/** A GO district (a province, state or region) with its centre. */
export interface GoDistrict {
  id: number;
  name: string;
  iso: string | null;
  iso3: string | null;
  lat: number;
  lng: number;
}

/** District rows with a usable centroid; null when the body is not a GO list. */
export function parseDistricts(json: unknown): GoDistrict[] | null {
  if (!isRecord(json) || !Array.isArray(json.results)) return null;
  const out: GoDistrict[] = [];
  for (const r of json.results) {
    if (!isRecord(r)) continue;
    const id = num(r.id);
    const name = collapse(str(r.name));
    const coords = isRecord(r.centroid) && Array.isArray(r.centroid.coordinates) ? r.centroid.coordinates : [];
    const lng = num(coords[0]);
    const lat = num(coords[1]);
    if (id === null || !name || lng === null || lat === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    out.push({ id, name, iso: str(r.country_iso).toUpperCase() || null, iso3: str(r.country_iso3).toUpperCase() || null, lat, lng });
  }
  return out;
}

export function eventUrl(id: number): string {
  return `${GO_API}/event/${id}/`;
}

export function districtsByIdUrl(ids: number[]): string {
  return `${GO_API}/district/?id__in=${ids.join(",")}&limit=${ids.length}`;
}

export function districtsOfCountryUrl(iso3: string): string {
  return `${GO_API}/district/?country__iso3=${encodeURIComponent(iso3)}&limit=500`;
}

/**
 * Looks up districts by id, DISTRICT_BATCH per request. Only the asked-for
 * ids are kept (GO ignores filters it does not know and would list every
 * district). complete is false when any request failed.
 */
export async function fetchDistrictsById(
  ids: number[],
  deps: FetchDeps,
  pace: () => Promise<void>,
): Promise<{ found: Map<number, GoDistrict>; complete: boolean }> {
  const found = new Map<number, GoDistrict>();
  let complete = true;
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += DISTRICT_BATCH) {
    const batch = unique.slice(i, i + DISTRICT_BATCH);
    await pace();
    const res = await getJson(districtsByIdUrl(batch), deps, DETAIL_RETRY_MS);
    const rows = res.ok ? parseDistricts(res.body) : null;
    if (!rows) {
      complete = false;
      continue;
    }
    const wanted = new Set(batch);
    for (const d of rows) if (wanted.has(d.id)) found.set(d.id, d);
  }
  return { found, complete };
}

/** One country's districts (by ISO3), keeping only rows of that country; null on failure. */
export async function fetchCountryDistricts(iso3: string, deps: FetchDeps, pace: () => Promise<void>): Promise<GoDistrict[] | null> {
  await pace();
  const res = await getJson(districtsOfCountryUrl(iso3), deps, DETAIL_RETRY_MS);
  const rows = res.ok ? parseDistricts(res.body) : null;
  return rows ? rows.filter((d) => d.iso3 === iso3.toUpperCase()) : null;
}

/** District names too generic to find in a title ("Central", "Western"). */
const GENERIC_DISTRICTS = new Set([
  "central", "centre", "center", "north", "south", "east", "west", "northern", "southern", "eastern", "western",
  "north east", "north west", "south east", "south west", "northeast", "northwest", "southeast", "southwest",
  "capital", "coast", "coastal", "island", "islands", "lake", "lakes", "river", "upper", "lower", "middle",
  "interior", "highlands", "lowlands", "greater", "national capital", "metropolitan", "region", "district",
  "province", "city", "flood", "floods", "storm", "fire", "drought", "free", "contested",
]);

/** Administrative words around a district's own name, in normalised form ("district autonome d abidjan", "chin state"). */
const ADMIN_PREFIX = /^(?:district autonome d e|district autonome d|district autonome de|autonomous (?:district|region) of|region|province|state|department|governorate|prefecture|county|oblast|district)\s+/;
const ADMIN_SUFFIX = /\s+(?:region|province|state|division|department|governorate|prefecture|county|oblast|district|municipality)$/;

/**
 * The normalised names a district may go by in a title: each language's
 * name ("Pejë / Pec"), the name without brackets or words such as "Region"
 * and "State", and the name in brackets ("Region I (Ilocos Region)" ->
 * "ilocos"; "District Autonome D'Abidjan" -> "abidjan").
 */
export function districtAliases(name: string): string[] {
  const out = new Set<string>();
  for (const part of name.split("/")) {
    const inside = /\(([^)]*)\)/.exec(part)?.[1] ?? "";
    for (const raw of [part, part.replace(/\([^)]*\)/g, " "), inside]) {
      const n = normaliseName(raw);
      if (!n) continue;
      out.add(n);
      out.add(n.replace(ADMIN_PREFIX, "").replace(ADMIN_SUFFIX, "").trim());
    }
  }
  return [...out].filter(Boolean);
}

/** True when needle (normalised) appears in hay (normalised) as whole words. */
function hasWords(hay: string, needle: string): boolean {
  return needle.length > 0 && ` ${hay} `.includes(` ${needle} `);
}

/**
 * The districts whose names appear as whole words in the titles, e.g.
 * "Congo Likouala Flood" -> Likouala. The country's own name is removed
 * from the titles first and never matched, so "Panama Earthquake" does not
 * pick Panama province. Short and generic names are ignored. A district
 * matches by any of its aliases (districtAliases): either language's name,
 * or its name without words such as "Region" ("Abidjan Floods" -> District
 * Autonome D'Abidjan).
 */
export function matchDistricts(titles: string[], districts: GoDistrict[], countryNames: string[]): GoDistrict[] {
  const countries = countryNames.map(normaliseName).filter(Boolean);
  let text = normaliseName(titles.join(" | "));
  for (const c of countries) text = ` ${text} `.split(` ${c} `).join(" ").trim();
  const usable = (n: string) => n.length >= 4 && !GENERIC_DISTRICTS.has(n) && !countries.includes(n);
  const out: GoDistrict[] = [];
  for (const d of districts) {
    const names = districtAliases(d.name).filter(usable);
    if (names.some((n) => hasWords(text, n)) && !out.some((o) => o.id === d.id)) out.push(d);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Countries and places
// ---------------------------------------------------------------------------

/** Globe codes, cached per shapes array. */
const codeCache = new WeakMap<CountryShape[], Set<string>>();

function shapeCodes(shapes: CountryShape[]): Set<string> {
  let codes = codeCache.get(shapes);
  if (!codes) {
    codes = new Set(shapes.map((s) => s.code));
    codeCache.set(shapes, codes);
  }
  return codes;
}

/** The globe code for a GO country (ISO3 first, then ISO2 when the globe has it). */
export function countryCode(c: Pick<GoCountryRef, "iso" | "iso3">, resolve: CountryResolver, shapes: CountryShape[]): string | undefined {
  const byIso3 = c.iso3 ? resolve.byIso3(c.iso3) : undefined;
  if (byIso3) return byIso3;
  return c.iso && shapeCodes(shapes).has(c.iso) ? c.iso : undefined;
}

/**
 * The globe code an appeal is for: its country; else the ISO2 inside its
 * code ("MDREC032" -> EC), for appeals IFRC runs from Geneva; else the
 * longest leading words of its name that are a country ("Congo Likouala
 * Flood" -> CG).
 */
export function appealCountry(a: Pick<GoAppeal, "code" | "name" | "country">, resolve: CountryResolver, shapes: CountryShape[]): string | undefined {
  const own = a.country ? countryCode(a.country, resolve, shapes) : undefined;
  if (own) return own;
  const m = /^MDR([A-Z]{2})\d/.exec(a.code);
  if (m && shapeCodes(shapes).has(m[1])) return m[1];
  const head = a.name.split(/\s+[-–—:|]\s*|:\s*/)[0];
  const words = head.split(/\s+/).filter(Boolean);
  for (let n = Math.min(words.length, 5); n >= 1; n--) {
    const code = resolve.byName(words.slice(0, n).join(" "));
    if (code) return code;
  }
  return undefined;
}

/** Codes in order, each once: the appeals' countries (largest appeal first), then the emergency's. */
export function orderCountries(appealCodes: (string | undefined)[], eventCodes: string[]): string[] {
  const out: string[] = [];
  for (const c of [...appealCodes, ...eventCodes]) if (c && !out.includes(c)) out.push(c);
  return out;
}

/** The country's name for a title: the globe's short name, or its full name when the short one is abbreviated. */
export function displayName(code: string, shapes: CountryShape[]): string | undefined {
  const s = shapes.find((x) => x.code === code);
  if (!s) return undefined;
  return s.name.includes(".") ? s.admin : s.name;
}

/** Districts as places (kind "district"), each once by name, at most MAX_PLACES. */
export function districtPlaces(districts: GoDistrict[], fallbackCountry: string | undefined, resolve: CountryResolver, shapes: CountryShape[]): Place[] {
  const out: Place[] = [];
  for (const d of districts) {
    const country = countryCode(d, resolve, shapes) ?? fallbackCountry;
    if (!country || out.some((p) => p.name === d.name && p.country === country)) continue;
    out.push({ name: d.name, country, lat: round4(d.lat), lng: round4(d.lng), kind: "district", source: "ifrc" });
    if (out.length >= MAX_PLACES) break;
  }
  return out;
}

/** Rounds to 4 decimals (about 10 m), never -0. */
function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4 || 0;
}

/** Mean of points on the sphere (antimeridian-safe), rounded to 4 decimals. */
export function meanPoint(points: { lat: number; lng: number }[]): { lat: number; lng: number } {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const p of points) {
    const lat = (p.lat * Math.PI) / 180;
    const lng = (p.lng * Math.PI) / 180;
    x += Math.cos(lat) * Math.cos(lng);
    y += Math.cos(lat) * Math.sin(lng);
    z += Math.sin(lat);
  }
  const lat = (Math.atan2(z, Math.hypot(x, y)) * 180) / Math.PI;
  const lng = normaliseLng((Math.atan2(y, x) * 180) / Math.PI);
  return { lat: round4(lat), lng: round4(lng) };
}

/** Where to draw the disaster: the centre of its districts (area), else its first country's centre (country). Null when neither is known. */
export function locate(places: Place[], countries: string[], shapes: CountryShape[]): { lat: number; lng: number; precision: Precision } | null {
  if (places.length > 0) return { ...meanPoint(places), precision: "area" };
  for (const code of countries) {
    const c = countryCentroid(code, shapes);
    if (c) return { lat: c.lat, lng: c.lng, precision: "country" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”",
  ldquo: "“", ndash: "–", mdash: "—", hellip: "…", deg: "°", ordm: "º", ordf: "ª",
  euro: "€", pound: "£", times: "×", szlig: "ß", laquo: "«", raquo: "»", middot: "·",
  bull: "•", iexcl: "¡", iquest: "¿", aelig: "æ", oslash: "ø", thinsp: " ", ensp: " ", emsp: " ",
};
/** Combining marks for accented-letter entities such as &oacute; and &ntilde;. */
const ACCENTS: Record<string, string> = { acute: "́", grave: "̀", circ: "̂", uml: "̈", tilde: "̃", cedil: "̧", ring: "̊" };

/** Decodes numeric, named and accented-letter HTML entities; unknown ones are left as they are. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (m, hex: string) => safeCodePoint(parseInt(hex, 16)) ?? m)
    .replace(/&#(\d+);/g, (m, dec: string) => safeCodePoint(Number(dec)) ?? m)
    .replace(/&([a-z])(acute|grave|circ|uml|tilde|cedil|ring);/gi, (m, letter: string, accent: string) => (letter + ACCENTS[accent.toLowerCase()]).normalize("NFC"))
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED_ENTITIES[name] ?? NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

function safeCodePoint(n: number): string | null {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : null;
}

/** HTML to plain text: scripts and styles out, tags out, entities decoded, whitespace collapsed, no space before punctuation. */
export function stripHtml(html: string): string {
  const text = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ");
  return collapse(decodeEntities(text)).replace(/\s+([.,;:!?)])/g, "$1").replace(/([(])\s+/g, "$1");
}

/** Report headings GO summaries often open with. */
const HEADING = /^(?:\d+(?:\.\d+)*\.?\s+)?(?:executive summary|situation(?:al)? overview|description of (?:the )?(?:event|disaster|situation|hazard|crisis)|event description|current situation|background|summary|overview|context|situation)\s*[:.–-]?\s+/i;

/** Words that open a sentence rather than a heading ("1. The Government of Nepal declared..."). */
const SENTENCE_START = /^(?:the|a|an|on|in|at|as|by|for|from|since|after|before|during|following|according|due|over|between|while|when|with|this|these|there|heavy|torrential)$/i;

/**
 * Drops a leading report heading such as "1. Situation Overview " or
 * "Executive Summary ", when a capitalised sentence follows. A numbered
 * paragraph that opens with a sentence ("1. The Government...") loses only
 * its number.
 */
export function dropHeading(text: string): string {
  const m = HEADING.exec(text);
  if (m && /^[A-Z0-9"“']/.test(text.slice(m[0].length))) return text.slice(m[0].length);
  const numbered = /^(\d+\.\s+)((?:[A-Z][\w-]*\s+){1,3})(?=[A-Z])/.exec(text);
  if (!numbered) return text;
  return SENTENCE_START.test(numbered[2].split(/\s/)[0]) ? text.slice(numbered[1].length) : text.slice(numbered[0].length);
}

/** Words written with a full stop that does not end a sentence ("St. Paul River", "Mt. Lewotobi", "No. 7"). */
const ABBREVIATIONS = new Set([
  "st", "mt", "no", "nos", "dr", "mr", "mrs", "ms", "prof", "gov", "govt", "approx", "est", "fig", "vs",
  "gen", "col", "lt", "capt", "sgt", "rev", "inc", "ltd", "co", "jan", "feb", "mar", "apr", "jun", "jul",
  "aug", "sep", "sept", "oct", "nov", "dec",
]);

/** True when the full stop at index i follows an abbreviation or an initial ("U.S.", "J. Smith"). */
function isAbbreviation(text: string, i: number): boolean {
  if (text[i] !== ".") return false;
  const word = /([A-Za-z]+)$/.exec(text.slice(0, i))?.[1];
  return !!word && (word.length === 1 || ABBREVIATIONS.has(word.toLowerCase()));
}

/**
 * The opening of a text, cut at the last sentence end before max characters.
 * A sentence ends at . ! or ? followed by a space and a capital or digit, so
 * "6:00 p.m. for" is not an end, nor is the stop after an abbreviation or an
 * initial ("St. Paul", "U.S. Agency"). Without a sentence end past a third
 * of max, the text is cut at a word and given an ellipsis.
 */
export function opening(text: string, max = SUMMARY_MAX): string {
  if (text.length <= max) return text;
  const window = text.slice(0, max + 1);
  let cut = -1;
  for (const m of window.matchAll(/[.!?]["'”)\]]?(?=\s+["'“(]?[A-Z0-9])/g)) {
    if (isAbbreviation(window, m.index ?? 0)) continue;
    const end = (m.index ?? 0) + m[0].length;
    if (end <= max) cut = end;
  }
  if (cut > max / 3) return text.slice(0, cut);
  const words = text.slice(0, max).replace(/\s+\S*$/, "");
  return `${words.replace(/[\s,;:–-]+$/, "")}…`;
}

/** The summary to show: plain text, heading dropped, first sentences up to SUMMARY_MAX; undefined when empty. */
export function summaryOf(html: string): string | undefined {
  const text = opening(dropHeading(stripHtml(html)));
  return text.length >= 20 ? text : undefined;
}

/** Hazard words; a title without one gets the disaster type from GO's generated name. */
const HAZARD_WORD =
  /\b(?:floods?|flooding|flash|inundations?|earthquakes?|quakes?|tsunamis?|cyclones?|hurricanes?|typhoons?|storms?|hailstorms?|windstorms?|snowstorms?|rainstorms?|surge|tornado(?:es)?|landslides?|mudslides?|mudflows?|fires?|wildfires?|bushfires?|droughts?|heat ?waves?|cold ?waves?|volcan\w*|eruptions?|monsoon|rains?|hail|blizzards?|dzud)\b/i;
/** GO's generated emergency name: "PAN: Flood - 08-2026 - Bocas del Toro Floods". */
const GENERATED_NAME = /^([A-Z]{3})\s*:\s*(.+?)\s+-\s+\d{1,2}-\d{4}\s+-\s+(.+)$/;
/** Appeal codes in brackets at the end: "(MDRBD018)", "(EAP2022TJ02)". */
const TRAILING_CODES = /\s*\((?=[^)]*[A-Z]{3})(?=[^)]*\d{2})[A-Z0-9]{5,}(?:\s*[,;/]\s*[A-Z0-9]{5,})*\)\s*$/;
const MONTH_AT_END = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)$/i;

/** Drops a trailing date: " - 08-2026", " 10/2026", ", 2026", " 2026" (but not "July 2026"). */
export function dropTrailingDate(title: string): string {
  let t = title.replace(/\s*[,–—-]\s*\d{1,2}[-/](?:19|20)\d{2}$/, "").replace(/\s+\d{1,2}\/(?:19|20)\d{2}$/, "");
  const m = /^(.*?)(?:\s*[,–—-]\s*|\s+)(?:19|20)\d{2}$/.exec(t);
  if (m && m[1].trim() && !MONTH_AT_END.test(m[1].trim())) t = m[1];
  return t;
}

/**
 * A readable title from an emergency or appeal name. Trailing appeal codes
 * and dates go; GO's generated names lose their "ISO3: Type - MM-YYYY - "
 * prefix and gain the country's name (and the hazard, when the rest does not
 * say it): "SLE: Flash Flood - 08-2026 - Freetown" -> "Sierra Leone:
 * Freetown flash flood".
 */
export function tidyTitle(raw: string, countryName?: string): string {
  let t = collapse(raw).replace(TRAILING_CODES, "");
  let hazard = "";
  let generated = false;
  for (let m = GENERATED_NAME.exec(t); m; m = GENERATED_NAME.exec(t)) {
    hazard = m[2].trim();
    t = m[3].trim();
    generated = true;
  }
  if (generated) {
    t = t.replace(/^[A-Z]{3}\s*:\s*/, ""); // "TJK: Flood and Mudflow Ayni district"
    if (!HAZARD_WORD.test(t) && hazard && !/^other$/i.test(hazard)) t = `${t} ${hazard.toLowerCase()}`;
    if (countryName && !hasWords(normaliseName(t), normaliseName(countryName))) t = `${countryName}: ${t}`;
  }
  t = dropTrailingDate(t.replace(/\s+:/g, ":"));
  t = t.replace(/[\s.,;:–—-]+$/, "");
  return t || collapse(raw);
}

const NAME_STOPWORDS = new Set(["and", "season", "surge", "eap", "seap", "response", "appeal", "operation", "in", "of", "the", "affected", "impact", "emergency"]);

/** Capitals without accents, e.g. "Maila" -> "MAILA". */
function matchKey(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}

/** A storm's or volcano's name for matching across sources, e.g. "Hurricane Melissa" -> "MELISSA"; undefined when none is named. */
export function hazardName(texts: string[], type: DisasterType): string | undefined {
  const accept = (raw: string | undefined) => {
    const w = raw?.replace(/^["'‘“]+|["'’”.]+$/g, ""); // "Tropical Cyclone 'Jude'"
    return w && /^[A-Z][A-Za-zÀ-ɏ-]+$/.test(w) && !NAME_STOPWORDS.has(w.toLowerCase()) ? matchKey(w) : undefined;
  };
  for (const text of texts) {
    if (type === "cyclone") {
      for (const m of text.matchAll(/\b(?:super\s+)?(?:tropical\s+(?:cyclone|storm|depression)s?|cyclones?|hurricanes?|typhoons?)\s+([^\s,;:()]+)/gi)) {
        const name = accept(m[1]);
        if (name) return name;
      }
    }
    if (type === "volcano") {
      const mount = /\b(?:mount|mt\.?)\s+([^\s,;:()]+)/i.exec(text);
      const before = /\b([^\s,;:()]+)\s+volcano\b/i.exec(text);
      const name = accept(mount?.[1]) ?? accept(before?.[1]);
      if (name) return name;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** What an emergency's record (or a title lookup) adds to its appeals. Kept between runs while GO's update time is unchanged. */
export interface EventExtras {
  /** True when the emergency's GO page is public, so links may lead there. */
  public: boolean;
  /** The emergency's own name, when its record was read. */
  name?: string;
  countries: string[];
  places: Place[];
  started?: string;
  /** When the disaster was last reported active (newest field report). */
  lastActive?: string;
  summary?: string;
  figures: Figure[];
  glide?: string;
  /**
   * Where to draw an operation in a country the globe does not have (small
   * island states such as Cabo Verde or Tonga): the centre of GO's districts
   * there. Used only when neither places nor a globe country place it.
   */
  centre?: { lat: number; lng: number; precision: Precision };
}

/** Extras plus the revision they reflect; no revision means "read again next run". */
export interface LoadedExtras {
  extras: EventExtras;
  revision?: string;
}

export function emptyExtras(isPublic = false): EventExtras {
  return { public: isPublic, countries: [], places: [], figures: [] };
}

export function emergencyPage(id: number): string {
  return `${GO_SITE}/emergencies/${id}`;
}

export function countryPage(id: number): string {
  return `${GO_SITE}/countries/${id}`;
}

/** Key figures as Figures (digits get separators), plus "People affected" from the record when no figure covers it. */
export function eventFigures(ev: Pick<GoEvent, "keyFigures" | "affected">, pageUrl: string): Figure[] {
  const out: Figure[] = [];
  for (const f of ev.keyFigures) {
    if (out.some((o) => o.label.toLowerCase() === f.deck.toLowerCase())) continue;
    out.push({ label: f.deck, value: formatValue(f.number), sourceName: f.source || "IFRC", sourceUrl: pageUrl });
    if (out.length >= MAX_FIGURES) break;
  }
  if (ev.affected && !out.some((f) => /affect/i.test(f.label))) {
    out.push({ label: "People affected", value: formatValue(String(Math.round(ev.affected))), sourceName: "IFRC", sourceUrl: pageUrl });
  }
  return out;
}

/** Extras from an emergency's public record; places are added once its districts are looked up. */
export function extrasFromEvent(ev: GoEvent, resolve: CountryResolver, shapes: CountryShape[]): EventExtras {
  const countries = orderCountries([], ev.countries.map((c) => countryCode(c, resolve, shapes)).filter((c): c is string => !!c));
  const summary = summaryOf(ev.summary);
  return {
    public: true,
    name: ev.name,
    countries,
    places: [],
    ...(ev.started ? { started: ev.started } : {}),
    ...(ev.lastReport ? { lastActive: ev.lastReport } : {}),
    ...(summary ? { summary } : {}),
    figures: eventFigures(ev, emergencyPage(ev.id)),
    ...(ev.glide ? { glide: ev.glide } : {}),
  };
}

/** The extras a previous run's report carries, to reuse while the emergency is unchanged. */
export function extrasFromPrevious(prev: SourceEvent): EventExtras {
  return {
    public: prev.links.some((l) => l.url.startsWith(`${GO_SITE}/emergencies/`)),
    name: prev.title,
    countries: prev.countries,
    places: prev.places ?? [],
    started: prev.started,
    lastActive: prev.updated,
    ...(prev.summary ? { summary: prev.summary } : {}),
    figures: (prev.figures ?? []).filter((f) => f.label !== TARGET_LABEL),
    ...(prev.glide ? { glide: prev.glide } : {}),
    // A report with no globe country was placed by its centre; keep it.
    ...(prev.countries.length === 0 ? { centre: { lat: prev.lat, lng: prev.lng, precision: prev.precision } } : {}),
  };
}

/** Where GO's districts put an operation: the centre of the matched ones (area), else of all the country's (country); undefined when there are none. */
export function districtCentre(matched: GoDistrict[], all: GoDistrict[]): EventExtras["centre"] {
  if (matched.length > 0) return { ...meanPoint(matched), precision: "area" };
  if (all.length > 0) return { ...meanPoint(all), precision: "country" };
  return undefined;
}

/** The previous run's report of this operation. */
export function findPrevious(previous: SourceEvent[], key: string): SourceEvent | undefined {
  return previous.find((e) => e.source === "ifrc" && e.sourceId === key);
}

/**
 * What the extras of an operation depend on: GO's update time of the
 * emergency, or for an appeal without one, its name and country (all a
 * title lookup reads). Undefined when unknown.
 */
export function revisionOf(op: AppealGroup): string | undefined {
  if (op.event !== null) return op.appeals.find((a) => a.eventInfo?.updatedAt)?.eventInfo?.updatedAt ?? undefined;
  const a = op.appeals[0];
  return a ? `appeal:${normaliseName(a.name)}:${a.country?.iso3 ?? ""}` : undefined;
}

/** When this run could not read an operation's extras: the previous run's (to be read again next run), else none. */
export function fallbackExtras(prev: SourceEvent | undefined): LoadedExtras {
  return { extras: prev ? extrasFromPrevious(prev) : emptyExtras() };
}

/** IFRC's severity colour as a level: Red 3, Orange 2, Yellow (or unknown) 1; an Emergency Appeal makes it at least 2. */
export function severityOf(level: string | null | undefined, appeals: Pick<GoAppeal, "kind">[]): Severity {
  const base: Severity = /^red$/i.test(level ?? "") ? 3 : /^orange$/i.test(level ?? "") ? 2 : 1;
  return appeals.some(isEmergencyAppeal) && base < 2 ? 2 : base;
}

/** e.g. "IFRC Orange alert, Emergency Appeal" or "IFRC DREF operation". */
export function severityText(level: string | null | undefined, appeals: Pick<GoAppeal, "kind">[]): string {
  const kinds = [...new Set(appeals.map((a) => (isEmergencyAppeal(a) ? "Emergency Appeal" : "DREF")))];
  const ops = kinds.length ? kinds.join(" and ") : "DREF";
  const colour = /^(red|orange|yellow)$/i.test(level ?? "") ? `${level![0].toUpperCase()}${level!.slice(1).toLowerCase()}` : "";
  return colour ? `IFRC ${colour} alert, ${ops}` : `IFRC ${ops} operation`;
}

/** The figure of how many people the operations aim to reach (the largest target, since a DREF and its later appeal overlap). */
export function targetFigure(appeals: Pick<GoAppeal, "people">[], url: string): Figure | undefined {
  const most = Math.max(0, ...appeals.map((a) => a.people ?? 0));
  return most > 0 ? { label: TARGET_LABEL, value: formatValue(String(Math.round(most))), sourceName: "IFRC", sourceUrl: url } : undefined;
}

/** The GO page for an operation: its emergency when public, else its country page, else GO's emergency list. */
export function operationPage(op: AppealGroup, isPublic: boolean): SourceRef {
  if (op.event !== null && isPublic) return { name: "IFRC GO emergency", url: emergencyPage(op.event) };
  const withCountry = op.appeals.find((a) => a.country?.id != null);
  if (withCountry?.country?.id != null) return { name: "IFRC GO country page", url: countryPage(withCountry.country.id) };
  return { name: "IFRC GO emergencies", url: `${GO_SITE}/emergencies` };
}

/** One appeal as an AppealRef, linked to the operation's GO page (its own country page when it has no emergency). */
export function toAppealRef(a: GoAppeal, page: string, hasEvent: boolean): AppealRef {
  const url = !hasEvent && a.country?.id != null ? countryPage(a.country.id) : page;
  return { code: a.code, name: a.name, kind: a.kind, requested: Math.round(a.requested), funded: Math.round(a.funded), url, end: a.end };
}

/** The latest of the given ISO times. */
function latest(times: (string | null | undefined)[]): string | undefined {
  const ms = times.map((t) => (t ? Date.parse(t) : NaN)).filter((t) => !Number.isNaN(t));
  return ms.length ? new Date(Math.max(...ms)).toISOString() : undefined;
}

/** The earliest of the given ISO times. */
function earliest(times: string[]): string {
  return new Date(Math.min(...times.map((t) => Date.parse(t)))).toISOString();
}

/** The title: the emergency's name tidied, or the lead appeal's when the emergency's is missing or long. */
export function operationTitle(op: AppealGroup, extras: EventExtras, countryName?: string): string {
  const lead = op.appeals[0];
  const eventName = extras.name ?? op.appeals.find((a) => a.eventInfo?.name)?.eventInfo?.name;
  const fromEvent = eventName ? tidyTitle(eventName, countryName) : "";
  if (fromEvent && (fromEvent.length <= MAX_TITLE || !lead)) return fromEvent;
  return lead ? tidyTitle(lead.name, countryName) : fromEvent;
}

/**
 * Builds the SourceEvent for one operation from its appeals and extras.
 * Null when it cannot be placed (no country the globe knows and no centre
 * from GO's districts).
 */
export function toSourceEvent(op: Operation, loaded: LoadedExtras, resolve: CountryResolver, shapes: CountryShape[]): SourceEvent | null {
  const { extras } = loaded;
  const countries = orderCountries(op.appeals.map((a) => appealCountry(a, resolve, shapes)), extras.countries);
  const where = locate(extras.places, countries, shapes) ?? extras.centre ?? null;
  if (!where || op.appeals.length === 0) return null;
  const info = op.appeals.find((a) => a.eventInfo)?.eventInfo ?? null;
  const page = operationPage(op, extras.public);
  const target = targetFigure(op.appeals, page.url);
  const figures = [...extras.figures, ...(target ? [target] : [])];
  const title = operationTitle(op, extras, countries[0] ? displayName(countries[0], shapes) : undefined);
  const name = hazardName([extras.name ?? "", info?.name ?? "", ...op.appeals.map((a) => a.name)], op.type);
  return {
    source: "ifrc",
    sourceId: op.key,
    type: op.type,
    title,
    severity: severityOf(info?.severity, op.appeals),
    severityText: severityText(info?.severity, op.appeals),
    countries,
    lat: where.lat,
    lng: where.lng,
    precision: where.precision,
    started: extras.started ?? earliest(op.appeals.map((a) => a.start)),
    // The last sign of activity: a field report, an appeal opening or the start. Not GO's record edit time.
    updated: latest([extras.lastActive, extras.started, ...op.appeals.map((a) => a.start)]) ?? op.appeals[0].start,
    areas: [],
    places: extras.places,
    ...(extras.summary ? { summary: extras.summary } : {}),
    ...(figures.length ? { figures } : {}),
    links: [page],
    ...(extras.glide ? { glide: extras.glide } : {}),
    ...(name ? { name } : {}),
    ...(loaded.revision !== undefined ? { revision: loaded.revision } : {}),
    appeals: op.appeals.map((a) => toAppealRef(a, page.url, op.event !== null)),
  };
}

// ---------------------------------------------------------------------------
// Loading extras
// ---------------------------------------------------------------------------

/** One operation whose extras are being built this run. */
interface Pending {
  op: Operation;
  prev?: SourceEvent;
  extras: EventExtras;
  /** District ids from the emergency's record, still to be looked up. */
  districtIds: number[];
  /** True when places are to be found from district names in the titles. */
  byTitle: boolean;
  /** False once any lookup failed: then no revision is kept, so it is read again next run. */
  complete: boolean;
  revision?: string;
}

/** Shared state for one run's lookups. */
export interface LoadContext {
  deps: FetchDeps;
  resolve: CountryResolver;
  shapes: CountryShape[];
  previous: SourceEvent[];
}

/**
 * Reads the emergency records of the operations that need it (most
 * important first, at most MAX_DETAIL_FETCHES), reusing the previous run's
 * extras while GO's update time is unchanged. Returns the pending lookups;
 * operations settled without them are put straight into `out`.
 */
async function readEvents(ops: Operation[], ctx: LoadContext, pace: () => Promise<void>, out: Map<string, LoadedExtras>): Promise<Pending[]> {
  const pending: Pending[] = [];
  let reads = 0;
  for (const op of prioritise(ops)) {
    const prev = findPrevious(ctx.previous, op.key);
    const revision = revisionOf(op);
    if (prev && revision !== undefined && prev.revision === revision) {
      out.set(op.key, { extras: extrasFromPrevious(prev), revision });
      continue;
    }
    if (op.event === null) {
      pending.push({ op, prev, extras: emptyExtras(), districtIds: [], byTitle: true, complete: true, revision });
      continue;
    }
    if (reads >= MAX_DETAIL_FETCHES) {
      out.set(op.key, fallbackExtras(prev));
      continue;
    }
    reads++;
    await pace();
    const res = await getJson(eventUrl(op.event), ctx.deps, DETAIL_RETRY_MS);
    const ev = res.ok ? parseEvent(res.body) : null;
    if (ev) {
      const extras = extrasFromEvent(ev, ctx.resolve, ctx.shapes);
      const districtIds = ev.districts.map((d) => d.id);
      pending.push({ op, prev, extras, districtIds, byTitle: districtIds.length === 0, complete: true, revision: ev.updatedAt ?? revision });
    } else if (!res.ok && res.missing) {
      pending.push({ op, prev, extras: emptyExtras(false), districtIds: [], byTitle: true, complete: true, revision });
    } else {
      if (res.ok) ctx.deps.log(`IFRC GO emergency ${op.event}: not an emergency record`);
      out.set(op.key, fallbackExtras(prev));
    }
  }
  return pending;
}

/** Fills places from the districts the emergency records list, in one batched lookup. */
async function placeByDistrictIds(pending: Pending[], ctx: LoadContext, pace: () => Promise<void>): Promise<void> {
  const withIds = pending.filter((p) => p.districtIds.length > 0);
  if (withIds.length === 0) return;
  const { found, complete } = await fetchDistrictsById(withIds.flatMap((p) => p.districtIds), ctx.deps, pace);
  for (const p of withIds) {
    const districts = p.districtIds.map((id) => found.get(id)).filter((d): d is GoDistrict => !!d);
    if (!complete && districts.length < p.districtIds.length) p.complete = false;
    const fallback = primaryCode(p, ctx);
    p.extras.places = districtPlaces(districts, fallback, ctx.resolve, ctx.shapes);
    // No globe country to put places in: draw the operation at its districts' centre.
    if (p.extras.places.length === 0 && districts.length > 0) p.extras.centre = districtCentre(districts, []);
  }
}

/** The operation's primary globe code: its appeals' countries (largest first), then its emergency's. */
function primaryCode(p: Pending, ctx: LoadContext): string | undefined {
  return orderCountries(p.op.appeals.map((a) => appealCountry(a, ctx.resolve, ctx.shapes)), p.extras.countries)[0];
}

/**
 * The ISO3 GO knows the operation's primary country by: GO's own code from
 * the appeal (Kosovo is XKX in GO but KOS on the globe), else the globe's.
 */
function primaryIso3(p: Pending, ctx: LoadContext): { code: string; iso3: string } | undefined {
  const code = primaryCode(p, ctx);
  if (!code) return undefined;
  const own = p.op.appeals.find((a) => a.country?.iso3 && countryCode(a.country, ctx.resolve, ctx.shapes) === code)?.country?.iso3;
  const iso3 = own ?? ctx.shapes.find((s) => s.code === code)?.iso3;
  return iso3 ? { code, iso3: iso3.toUpperCase() } : undefined;
}

/** GO's ISO3 for an operation in a country the globe does not have (e.g. CPV, Cabo Verde); undefined when the globe has its country. */
function offGlobeIso3(p: Pending, ctx: LoadContext): string | undefined {
  if (primaryCode(p, ctx)) return undefined;
  return p.op.appeals.find((a) => a.country?.iso3)?.country?.iso3 ?? undefined;
}

/** Every name the operation is known by: the emergency's and the appeals'. */
function titlesOf(p: Pending): string[] {
  return [p.extras.name ?? "", ...p.op.appeals.map((a) => a.eventInfo?.name ?? ""), ...p.op.appeals.map((a) => a.name)].filter(Boolean);
}

/**
 * Fills places from district names in the titles, reading each country's
 * district list once (at most MAX_COUNTRY_LOOKUPS). An operation in a
 * country the globe does not have gets a centre from GO's districts there
 * instead, so it is still drawn.
 */
async function placeByTitle(pending: Pending[], ctx: LoadContext, pace: () => Promise<void>): Promise<void> {
  const lists = new Map<string, GoDistrict[] | null>();
  /** One country's districts; null when the read failed, undefined when over the cap. */
  const districtsOf = async (iso3: string): Promise<GoDistrict[] | null | undefined> => {
    if (!lists.has(iso3)) {
      if (lists.size >= MAX_COUNTRY_LOOKUPS) return undefined;
      lists.set(iso3, await fetchCountryDistricts(iso3, ctx.deps, pace));
    }
    return lists.get(iso3);
  };
  for (const p of pending) {
    const primary = primaryIso3(p, ctx);
    const offGlobe = primary ? undefined : offGlobeIso3(p, ctx);
    if (primary ? !p.byTitle : !offGlobe || p.extras.centre) continue;
    const districts = await districtsOf(primary?.iso3 ?? offGlobe!);
    if (!districts) {
      p.complete = false;
      continue;
    }
    const shape = primary ? ctx.shapes.find((s) => s.code === primary.code) : undefined;
    const names = [shape?.name ?? "", shape?.admin ?? "", ...p.op.appeals.map((a) => a.country?.name ?? "")].filter(Boolean);
    const matched = matchDistricts(titlesOf(p), districts, names);
    if (primary) p.extras.places = districtPlaces(matched, primary.code, ctx.resolve, ctx.shapes);
    else p.extras.centre = districtCentre(matched, districts);
  }
}

/** The settled extras of a pending operation: complete ones with their revision; otherwise the previous run's places (and centre) are kept when this run found none. */
function settle(p: Pending): LoadedExtras {
  if (p.complete) return { extras: p.extras, ...(p.revision !== undefined ? { revision: p.revision } : {}) };
  const places = p.extras.places.length > 0 ? p.extras.places : (p.prev?.places ?? []);
  const centre = p.extras.centre ?? (p.prev ? extrasFromPrevious(p.prev).centre : undefined);
  return { extras: { ...p.extras, places, ...(centre ? { centre } : {}) } };
}

/** Extras for every operation, keyed by operation key. */
export async function loadExtras(ops: Operation[], ctx: LoadContext): Promise<Map<string, LoadedExtras>> {
  const out = new Map<string, LoadedExtras>();
  const pace = pacer(ctx.deps, DETAIL_GAP_MS);
  const pending = await readEvents(ops, ctx, pace, out);
  await placeByDistrictIds(pending, ctx, pace);
  await placeByTitle(pending, ctx, pace);
  for (const p of pending) out.set(p.op.key, settle(p));
  return out;
}

/** Most severe first, then the most recently started. */
function bySeverity(a: SourceEvent, b: SourceEvent): number {
  return b.severity - a.severity || b.started.localeCompare(a.started) || a.sourceId.localeCompare(b.sourceId);
}

/**
 * Fetches IFRC GO's operations for natural disasters happening now. Returns
 * null only when the appeal list cannot be read (the caller then keeps the
 * previous data); a failed emergency or district lookup falls back to the
 * previous run's details for that operation.
 */
export async function fetchIfrc(deps: FetchDeps, now: string, resolve: CountryResolver, shapes: CountryShape[], previous: SourceEvent[] = []): Promise<SourceEvent[] | null> {
  const appeals = await fetchAppeals(deps);
  if (!appeals) return null;
  const ops = selectOperations(appeals, now);
  const extras = await loadExtras(ops, { deps, resolve, shapes, previous });
  const out: SourceEvent[] = [];
  for (const op of ops) {
    const ev = toSourceEvent(op, extras.get(op.key) ?? fallbackExtras(undefined), resolve, shapes);
    if (ev) out.push(ev);
    else deps.log(`IFRC GO ${op.key}: no country on the globe to place it; skipped`);
  }
  deps.log(`IFRC GO: ${out.length} natural-disaster operations from ${appeals.length} active appeals`);
  return out.sort(bySeverity);
}
