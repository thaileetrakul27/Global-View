// Pure helpers for the disaster panel, the landing list and the phone chip
// row: ordering, filtering, counting, wording, and the checks that keep only
// safe links on the page. Nothing here fetches or touches the DOM.
import type { Disaster, DisasterAppeal, DisasterArea, DisasterPlace, DisasterType, DonationLink } from "./data";
import { DISASTER_META } from "./disasterMeta";
import { money, percent } from "./money";
import { relativeTime } from "./time";

/** Types in the order DISASTER_META lists them, used to break ties. */
const TYPE_ORDER = Object.keys(DISASTER_META) as DisasterType[];

/** Kinds of disaster that can sit over open water with no country named. */
const MARINE: ReadonlySet<DisasterType> = new Set(["cyclone", "storm", "tsunami", "earthquake", "volcano"]);

/** Milliseconds since 1970, or 0 for a missing or broken date. */
function time(iso: string | undefined): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
}

/** Each value once, first occurrence kept. */
function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

// Checking the file

type Loose = Record<string, unknown>;
const isObject = (v: unknown): v is Loose => typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const PRECISIONS = new Set(["exact", "area", "country"]);

/** An area with a polygon or multipolygon geometry; anything else is dropped. */
function isArea(a: unknown): a is DisasterArea {
  if (!isObject(a) || !isObject(a.geometry)) return false;
  const g = a.geometry;
  return (g.type === "Polygon" || g.type === "MultiPolygon") && Array.isArray(g.coordinates);
}

/**
 * The well-formed disasters from a parsed disasters.json, each id once. An
 * entry needs a string id and title, a known type, a severity of 1 to 3, a
 * finite position and lists of areas, places and donation pages; anything
 * else is dropped whole. Optional lists default to empty, and broken areas,
 * places and donation pages are dropped from an otherwise good entry.
 */
export function cleanDisasters(raw: unknown): Disaster[] {
  const seen = new Set<string>();
  const out: Disaster[] = [];
  for (const d of list(raw)) {
    if (!isObject(d)) continue;
    if (typeof d.id !== "string" || !d.id || seen.has(d.id) || typeof d.title !== "string") continue;
    if (typeof d.type !== "string" || !(d.type in DISASTER_META)) continue;
    if (d.severity !== 1 && d.severity !== 2 && d.severity !== 3) continue;
    if (!finite(d.lat) || !finite(d.lng)) continue;
    if (!Array.isArray(d.areas) || !Array.isArray(d.places) || !Array.isArray(d.donate)) continue;
    seen.add(d.id);
    out.push({
      ...(d as unknown as Disaster),
      precision: PRECISIONS.has(d.precision as string) ? (d.precision as Disaster["precision"]) : "area",
      countries: list(d.countries).filter((c): c is string => typeof c === "string"),
      started: typeof d.started === "string" ? d.started : "",
      updated: typeof d.updated === "string" ? d.updated : "",
      areas: d.areas.filter(isArea),
      places: d.places.filter((p): p is DisasterPlace => isObject(p) && typeof p.name === "string" && finite(p.lat) && finite(p.lng)),
      donate: d.donate.filter((l): l is DonationLink => isObject(l) && typeof l.url === "string" && typeof l.org === "string" && typeof l.label === "string"),
      figures: list(d.figures) as Disaster["figures"],
      sources: list(d.sources) as Disaster["sources"],
      appeals: list(d.appeals) as Disaster["appeals"],
      reportedBy: list(d.reportedBy) as Disaster["reportedBy"],
      members: list(d.members) as Disaster["members"],
    });
  }
  return out;
}

// Ordering and filtering

/**
 * Most severe first. Within a severity the newest disaster comes first (by
 * start, then by last update), and the id breaks any remaining tie so the
 * order never flickers between renders.
 */
export function rankDisasters(list: readonly Disaster[]): Disaster[] {
  return [...list].sort(
    (a, b) =>
      b.severity - a.severity ||
      time(b.started) - time(a.started) ||
      time(b.updated) - time(a.updated) ||
      a.id.localeCompare(b.id),
  );
}

/** Disasters that name this country (globe code), ranked. */
export function disastersIn(list: readonly Disaster[], code: string): Disaster[] {
  return rankDisasters(list.filter((d) => d.countries.includes(code)));
}

/** Minor disasters are left off the map and the lists until someone asks for them or zooms in. */
export function isMinor(d: Pick<Disaster, "severity">): boolean {
  return d.severity < 2;
}

/** The significant and severe disasters, in the order given. */
export function significantOnly(list: readonly Disaster[]): Disaster[] {
  return list.filter((d) => !isMinor(d));
}

/**
 * Ids of disasters the globe leaves out: the minor ones unless they are
 * shown, never the one whose panel is open.
 */
export function hiddenOnMap(list: readonly Disaster[], opts: { showMinor: boolean; openId: string | null }): Set<string> {
  if (opts.showMinor) return new Set();
  return new Set(list.filter((d) => isMinor(d) && d.id !== opts.openId).map((d) => d.id));
}

/** One disaster by id, or null. */
export function findDisaster(list: readonly Disaster[] | null | undefined, id: string | null | undefined): Disaster | null {
  if (!list || !id) return null;
  return list.find((d) => d.id === id) ?? null;
}

// Counting

export interface TypeCount {
  type: DisasterType;
  count: number;
}

/** How many of each type, most common first; ties keep DISASTER_META's order. */
export function countByType(list: readonly Disaster[]): TypeCount[] {
  const counts = new Map<DisasterType, number>();
  for (const d of list) counts.set(d.type, (counts.get(d.type) ?? 0) + 1);
  return [...counts]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type));
}

/** "3 wildfires", "1 tropical cyclone". */
export function typeCountLabel({ type, count }: TypeCount): string {
  const meta = DISASTER_META[type];
  return `${count} ${(count === 1 ? meta.label : meta.plural).toLowerCase()}`;
}

// Dates

/**
 * "7 Oct", or "7 Oct 2025" when the year differs from now. Read in UTC:
 * sources give day-precision dates as midnight UTC, which local time would
 * shift to the day before in the Americas.
 */
export function shortDate(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const sameYear = new Date(t).getUTCFullYear() === new Date(now).getUTCFullYear();
  return new Date(t).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** "Since 7 Oct · updated 3 hours ago"; either half is left out when its date is missing. */
export function sinceLine(d: Pick<Disaster, "started" | "updated">, now: number = Date.now()): string {
  const parts: string[] = [];
  const since = shortDate(d.started, now);
  if (since) parts.push(`Since ${since}`);
  if (Number.isFinite(Date.parse(d.updated))) parts.push(`updated ${relativeTime(d.updated, now)}`);
  const line = parts.join(" · ");
  return line.charAt(0).toUpperCase() + line.slice(1);
}

// Places

/** Point labels some sources give as a place name ("Epicentre"); they say nothing about where. */
const GENERIC_PLACE = new Set(["epicentre", "epicenter", "storm centre", "storm center", "centre", "center"]);

/** "Guam, Saipan +1" from a list of names. */
function listWithMore(names: string[], max: number): string {
  if (!names.length) return "";
  const shown = names.slice(0, Math.max(1, max));
  const rest = names.length - shown.length;
  return `${shown.join(", ")}${rest > 0 ? ` +${rest}` : ""}`;
}

/**
 * One short line saying where: the first affected places, then the
 * countries, e.g. "Guam, Saipan · United States". A place that is just the
 * country's own name, or a bare label such as "Epicentre", is left out.
 * With no country and no place, marine hazards read "At sea".
 */
export function locationLine(
  d: Pick<Disaster, "type" | "countries" | "places">,
  nameOf: (code: string) => string,
  max: { places?: number; countries?: number } = {},
): string {
  const countries = unique(d.countries.map(nameOf));
  const places = unique(d.places.map((p) => p.name.trim()).filter((n) => n && !countries.includes(n) && !GENERIC_PLACE.has(n.toLowerCase())));
  const line = [listWithMore(places, max.places ?? 2), listWithMore(countries, max.countries ?? 2)].filter(Boolean).join(" · ");
  if (line) return line;
  return MARINE.has(d.type) ? "At sea" : "";
}

/** "Northern Mariana Islands, United States": the place's region and country. */
export function placeDetail(place: Pick<DisasterPlace, "admin" | "country">, nameOf: (code: string) => string): string {
  const country = place.country ? nameOf(place.country) : "";
  return unique([place.admin?.trim(), country].filter((s): s is string => !!s)).join(", ");
}

/** "17.8°N 141.6°E". */
export function coordText(lat: number, lng: number): string {
  const f = (v: number, pos: string, neg: string) => `${Math.abs(v).toFixed(1)}°${v >= 0 ? pos : neg}`;
  return `${f(lat, "N", "S")} ${f(lng, "E", "W")}`;
}

/** What the disaster's point is called: "Epicentre", "Storm centre"... */
export function centreLabel(type: DisasterType): string {
  if (type === "earthquake") return "Epicentre";
  if (type === "cyclone" || type === "storm") return "Storm centre";
  if (type === "volcano") return "Volcano";
  return "Centre";
}

/** A title short enough for a chip: the part before the first comma, cut to `max` characters. */
export function shortTitle(title: string, max = 36): string {
  const t = title.trim();
  const comma = t.indexOf(", ");
  const head = comma >= 8 ? t.slice(0, comma) : t;
  return head.length > max ? `${head.slice(0, max - 1).trimEnd()}…` : head;
}

// Links

/**
 * True for an absolute https link to a named host with no embedded
 * credentials. Everything else (http, javascript:, data:, relative paths)
 * is never rendered as a link.
 */
export function isSafeUrl(url: unknown): url is string {
  if (typeof url !== "string" || url.length > 2048) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname.includes(".") && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** The link if it is safe, otherwise undefined (render plain text). */
export function safeHref(url: unknown): string | undefined {
  return isSafeUrl(url) ? url : undefined;
}

/** Same page regardless of case in the host, a trailing slash or a #fragment. */
function urlKey(url: string): string {
  const u = new URL(url);
  return `${u.hostname.toLowerCase()}${u.pathname.replace(/\/+$/, "")}${u.search}`;
}

export type DonationGroupKey = "event" | "redcross" | "un" | "agency" | "government";

export interface DonationGroup {
  key: DonationGroupKey;
  label: string;
  links: DonationLink[];
}

const GROUP_OF: Record<DonationLink["kind"], DonationGroupKey> = {
  society: "redcross",
  appeal: "redcross",
  un: "un",
  agency: "agency",
  government: "government",
};

const GROUPS: { key: DonationGroupKey; label: string }[] = [
  { key: "event", label: "For this disaster" },
  { key: "redcross", label: "Red Cross and Red Crescent" },
  { key: "un", label: "United Nations" },
  { key: "agency", label: "Agencies" },
  { key: "government", label: "Government relief funds" },
];

/** The safe donation links, each page once, in the order the pipeline gave them. */
export function safeDonations(links: readonly DonationLink[]): DonationLink[] {
  const seen = new Set<string>();
  const out: DonationLink[] = [];
  for (const l of links) {
    if (!isSafeUrl(l.url)) continue;
    const key = urlKey(l.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out;
}

/** The group a link goes in: pages for this disaster itself first, the rest by who runs them. */
function groupOf(link: DonationLink): DonationGroupKey | undefined {
  // Only a real true counts: older files have no forEvent at all.
  return link.forEvent === true ? "event" : GROUP_OF[link.kind];
}

/**
 * Safe donation links grouped: pages for this disaster itself (its appeal,
 * checked pages researched for it) first, then the rest by who runs them:
 * Red Cross and Red Crescent, United Nations, agencies, government funds.
 * Empty groups are left out; within a group the pipeline's order is kept.
 */
export function groupDonations(links: readonly DonationLink[]): DonationGroup[] {
  const safe = safeDonations(links);
  return GROUPS.map((g) => ({ ...g, links: safe.filter((l) => groupOf(l) === g.key) })).filter((g) => g.links.length > 0);
}

// Appeals

export interface Funding {
  /** Whole percentage funded, or null when no amount was requested. */
  percent: number | null;
  /** "CHF 220k of CHF 500k funded". */
  text: string;
}

/** How much of an IFRC appeal is funded, in Swiss francs. */
export function appealFunding(a: Pick<DisasterAppeal, "requested" | "funded">): Funding {
  if (!(a.requested > 0)) {
    return { percent: null, text: a.funded > 0 ? `${money(a.funded, "CHF")} funded` : "Funding not reported" };
  }
  const p = percent(a.funded, a.requested);
  const text = a.funded >= a.requested ? `Fully funded: ${money(a.requested, "CHF")}` : `${money(a.funded, "CHF")} of ${money(a.requested, "CHF")} funded`;
  return { percent: p, text };
}
