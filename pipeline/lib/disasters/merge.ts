// Clusters SourceEvents from every feed into Disasters.
//
// 1. clusterEvents pairs up events that describe the same disaster: a shared
//    GLIDE number, the same storm or volcano name, or a per-type rule on
//    distance, country and time (matchScore). Pairs join strongest first,
//    and two groups never join when that would put two reports from the same
//    feed together (unless they share a GLIDE number), or, on a weak link,
//    two located reports that are clearly far apart.
// 2. buildDisaster turns one group into a Disaster: the most exact report
//    (then the feed priority) leads; severity, countries, areas, places,
//    figures, links and appeals are combined. The severity is the highest
//    report's, and a news report counts only by the deaths its headlines
//    report (memberSeverity), so a widely carried story never raises a
//    feed's rating on its own.
// 3. assignIds keeps ids stable: a group that shares a member with a disaster
//    from the previous run keeps that disaster's id.
// 4. isOngoing drops disasters not updated within their type's window
//    (longer for significant and severe quakes; an open IFRC appeal keeps a
//    recent disaster on the map).
//
// carryOver keeps the previous run's disasters that a failed feed reported
// and that no report this run carries on. Enrichment fields are left for the integrator: donate is empty
// and research is unset. Every function here is pure; times come in as `now`.
import { normaliseName } from "../resolve";
import { bboxOf, haversineKm, pointInGeometry } from "./geo";
import { newsSeverity } from "./news";
import { SOURCE_PRIORITY, memberKey } from "./types";
import type { AppealRef, Area, Disaster, DisasterType, Figure, Place, Precision, Severity, SourceEvent, SourceName, SourceRef, Track } from "./types";

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Types that can describe the same disaster. Only events of one family match
 * on distance, name or country. A heatwave is its own family: GDACS droughts
 * span months and dozens of countries ("Drought in Europe"), and in the same
 * family they would swallow every heatwave reported inside them.
 */
export type Family = "quake" | "storm" | "water" | "fire" | "volcano" | "dry" | "heat" | "cold" | "dust";

export const FAMILY_OF: Record<DisasterType, Family> = {
  earthquake: "quake",
  tsunami: "quake",
  cyclone: "storm",
  storm: "storm",
  flood: "water",
  landslide: "water",
  wildfire: "fire",
  volcano: "volcano",
  drought: "dry",
  heatwave: "heat",
  coldwave: "cold",
  dust: "dust",
};

/** Two earthquake reports match within this distance (km) of each other... */
export const QUAKE_KM = 150;
/** ...and this many hours apart. */
export const QUAKE_HOURS = 3;
/** A quake report without an epicentre (IFRC, news) matches one in the same country within this many hours. */
export const QUAKE_LOOSE_HOURS = 48;
/** Storm centres (latest positions) within this distance (km) match. */
export const STORM_KM = 400;
/** Flood or landslide centres within this distance (km) match. */
export const FLOOD_KM = 400;
/** Wildfire positions within this distance (km) match. */
export const FIRE_KM = 30;
/** Volcano positions within this distance (km) match. */
export const VOLCANO_KM = 30;
/** Storms with the same name match only when active within this many days of each other (names are reused). */
export const NAME_SLACK_DAYS = 30;

/**
 * How far apart (days) two reports' active periods may be and still count as
 * overlapping. Floods are reported late and for long; heat, cold and dust
 * are short. Earthquakes use start times instead and volcanoes do not move.
 */
export const OVERLAP_SLACK_DAYS: Record<Family, number> = {
  quake: 0,
  storm: 1,
  water: 14,
  fire: 14,
  volcano: Infinity,
  dry: 30,
  heat: 3,
  cold: 3,
  dust: 2,
};

/**
 * Two located reports of one family farther apart than this (km) are never
 * put in one disaster by a weak link (distance, country). Storms move and
 * droughts, cold waves and dust cover whole countries, so they have no limit.
 */
export const APART_KM: Record<Family, number> = {
  quake: 300,
  storm: Infinity,
  water: 1000,
  fire: 100,
  volcano: 100,
  dry: Infinity,
  heat: Infinity,
  cold: Infinity,
  dust: Infinity,
};

/** Days since its last update that a disaster still counts as ongoing. */
export const ONGOING_DAYS: Record<DisasterType, number> = {
  earthquake: 10,
  tsunami: 7,
  cyclone: 3,
  storm: 4,
  flood: 21,
  landslide: 14,
  wildfire: 10,
  volcano: 30,
  drought: 90,
  heatwave: 7,
  coldwave: 7,
  dust: 4,
};

/**
 * Significant (2) and severe (3) earthquakes and tsunamis stay ongoing this
 * many days after their last update, as GDACS (Orange 21, Red 30 days) and
 * USGS (PAGER yellow and up, 21 days) keep them: relief goes on for weeks.
 */
export const MAJOR_QUAKE_DAYS: Record<2 | 3, number> = { 2: 21, 3: 30 };

/** An open appeal keeps a disaster ongoing only while the disaster started within this many days. */
export const APPEAL_MAX_AGE_DAYS = 120;
/** Most bytes of JSON one disaster's areas may take before lower-priority feeds' areas are dropped. */
export const MAX_AREA_BYTES = 120_000;
/** Most source links kept per disaster. */
export const MAX_SOURCES = 10;

/** Feeds whose summary is preferred, best first. */
const SUMMARY_ORDER: readonly SourceName[] = ["ifrc", "gdacs", "eonet", "usgs", "news"];
/** Feeds whose figures are preferred, best first. */
const FIGURE_ORDER: readonly SourceName[] = ["ifrc", ...SOURCE_PRIORITY.filter((s) => s !== "ifrc")];

const PRECISION_RANK: Record<Precision, number> = { exact: 0, area: 1, country: 2 };

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** A feed's place in a ranking (unknown feeds last). */
function rankIn(order: readonly SourceName[], s: SourceName): number {
  const i = order.indexOf(s);
  return i < 0 ? order.length : i;
}

/** A precision's rank, most exact first (unknown values last). */
function precisionRank(p: Precision): number {
  return PRECISION_RANK[p] ?? 3;
}

/** Plain string order, independent of locale. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Most exact first, then feed priority, then member key: the order that picks a disaster's lead report. */
export function byPrecision(a: SourceEvent, b: SourceEvent): number {
  return (
    precisionRank(a.precision) - precisionRank(b.precision) ||
    rankIn(SOURCE_PRIORITY, a.source) - rankIn(SOURCE_PRIORITY, b.source) ||
    compareText(memberKey(a), memberKey(b))
  );
}

/** Feed priority first, then most exact, then member key. */
export function byPriority(a: SourceEvent, b: SourceEvent): number {
  return (
    rankIn(SOURCE_PRIORITY, a.source) - rankIn(SOURCE_PRIORITY, b.source) ||
    precisionRank(a.precision) - precisionRank(b.precision) ||
    compareText(memberKey(a), memberKey(b))
  );
}

/** Milliseconds of an ISO time, or NaN. */
function ms(iso: string | undefined): number {
  return iso ? Date.parse(iso) : NaN;
}

/**
 * A report's say in its disaster's severity. A feed's report counts at its
 * own rating. A news report counts only by the deaths its headlines report
 * (news.ts newsSeverity), whatever rating it carries: how many outlets carry
 * a story says nothing of the harm done, so a widely carried quake that
 * GDACS rates minor stays minor, and a news report saved under an older
 * rule is rated again.
 */
export function memberSeverity(m: Pick<SourceEvent, "source" | "severity" | "deaths">): Severity {
  return m.source === "news" ? newsSeverity(m.deaths) : m.severity;
}

/** The feed of a member key "source:sourceId". */
export function sourceOfKey(key: string): string {
  const i = key.indexOf(":");
  return i < 0 ? key : key.slice(0, i);
}

/**
 * The event part of a GLIDE number: its year and sequence number,
 * "FL-2026-000165-IND" -> "2026-000165". The number is unique within the
 * year across all hazards and shared by every country the disaster hits,
 * while feeds code the hazard differently (GDACS "FL" where IFRC writes
 * "FF" for a flash flood), so the hazard and country parts are dropped.
 * Other non-empty values are kept whole (upper-cased); undefined when there
 * is none.
 */
export function glideKey(glide: string | undefined): string | undefined {
  const g = (glide ?? "").trim().toUpperCase();
  if (!g) return undefined;
  const m = /^[A-Z]{2}-(\d{4})-(\d{6})\b/.exec(g);
  return m ? `${m[1]}-${m[2]}` : g;
}

/** True when both events carry the same GLIDE number. */
export function sharesGlide(a: SourceEvent, b: SourceEvent): boolean {
  const g = glideKey(a.glide);
  return g !== undefined && g === glideKey(b.glide);
}

/** Great-circle distance (km) between two events' positions; Infinity when either is not a number. */
export function distanceKm(a: Pick<SourceEvent, "lat" | "lng">, b: Pick<SourceEvent, "lat" | "lng">): number {
  const km = haversineKm(a, b);
  return Number.isFinite(km) ? km : Infinity;
}

/** True when the events name at least one country in common. */
export function shareCountry(a: SourceEvent, b: SourceEvent): boolean {
  return a.countries.some((c) => b.countries.includes(c));
}

/** True when the active periods [started, updated] overlap, allowing a gap of slackDays. */
export function periodsOverlap(a: SourceEvent, b: SourceEvent, slackDays: number): boolean {
  const [a0, a1, b0, b1] = [ms(a.started), ms(a.updated), ms(b.started), ms(b.updated)];
  if ([a0, a1, b0, b1].some((t) => Number.isNaN(t))) return false;
  if (slackDays === Infinity) return true;
  const slack = slackDays * DAY_MS;
  return a0 <= Math.max(b0, b1) + slack && b0 <= Math.max(a0, a1) + slack;
}

/** True when the events started within `hours` of each other. */
function startsWithin(a: SourceEvent, b: SourceEvent, hours: number): boolean {
  const gap = Math.abs(ms(a.started) - ms(b.started));
  return Number.isFinite(gap) && gap <= hours * HOUR_MS;
}

/** True when the point is in the box, trying the longitude 360 degrees either way for rings past +-180. */
function inBox(lng: number, lat: number, [minLng, minLat, maxLng, maxLat]: [number, number, number, number]): boolean {
  if (lat < minLat || lat > maxLat) return false;
  return [lng, lng + 360, lng - 360].some((x) => x >= minLng && x <= maxLng);
}

/** True when a's position is inside any of b's areas. */
export function insideAreas(a: Pick<SourceEvent, "lat" | "lng">, b: Pick<SourceEvent, "areas">): boolean {
  if (!Number.isFinite(a.lat) || !Number.isFinite(a.lng)) return false;
  return (b.areas ?? []).some((area) => inBox(a.lng, a.lat, bboxOf(area.geometry)) && pointInGeometry(a.lng, a.lat, area.geometry));
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** True when both events carry the same storm or volcano name (storms only when active about the same time). */
export function sameName(a: SourceEvent, b: SourceEvent): boolean {
  const na = (a.name ?? "").trim().toUpperCase();
  if (!na || na !== (b.name ?? "").trim().toUpperCase()) return false;
  const family = FAMILY_OF[a.type];
  if (family !== FAMILY_OF[b.type]) return false;
  return family === "storm" ? periodsOverlap(a, b, NAME_SLACK_DAYS) : true;
}

/** Earthquakes: two located reports with epicentres close and minutes apart. */
function quakesClose(a: SourceEvent, b: SourceEvent): boolean {
  const located = a.precision !== "country" && b.precision !== "country";
  return located && distanceKm(a, b) <= QUAKE_KM && startsWithin(a, b, QUAKE_HOURS);
}

/** Earthquakes: epicentres close and minutes apart, or for a report without an epicentre, the same country within two days. */
function quakesMatch(a: SourceEvent, b: SourceEvent): boolean {
  if (quakesClose(a, b)) return true;
  const loose = a.precision !== "exact" || b.precision !== "exact";
  return loose && shareCountry(a, b) && startsWithin(a, b, QUAKE_LOOSE_HOURS);
}

/**
 * The link score of a quake report without an epicentre (IFRC, news) and a
 * quake in its country, 2.5 to 2.8: the most severe quake first, then the
 * nearest in time. Distance says little here (IFRC's position is the mean
 * of its districts), and a big quake brings aftershocks of its own in the
 * same days, so by distance the appeal could go to an aftershock.
 */
function looseQuakeScore(a: SourceEvent, b: SourceEvent): number {
  const quake = a.precision === "exact" ? a : b.precision === "exact" ? b : memberSeverity(a) >= memberSeverity(b) ? a : b;
  const hours = Math.abs(ms(a.started) - ms(b.started)) / HOUR_MS;
  return 2.5 + (3 - memberSeverity(quake)) * 0.1 + (Math.min(hours, QUAKE_LOOSE_HOURS) / QUAKE_LOOSE_HOURS) * 0.09;
}

/** Storms: latest positions close (or the same country for a country-level report) while both are active. */
function stormsMatch(a: SourceEvent, b: SourceEvent): boolean {
  if (!periodsOverlap(a, b, OVERLAP_SLACK_DAYS.storm)) return false;
  if (a.precision === "country" || b.precision === "country") return shareCountry(a, b);
  return distanceKm(a, b) <= STORM_KM;
}

/** Floods and landslides: the same country, and close, inside the other's footprint, or only placed by country. */
function floodsMatch(a: SourceEvent, b: SourceEvent): boolean {
  if (!shareCountry(a, b) || !periodsOverlap(a, b, OVERLAP_SLACK_DAYS.water)) return false;
  if (a.precision === "country" || b.precision === "country") return true;
  return distanceKm(a, b) <= FLOOD_KM || insideAreas(a, b) || insideAreas(b, a);
}

/** Wildfires and volcanoes: two located reports at nearly the same spot. */
function sitesMatch(a: SourceEvent, b: SourceEvent, km: number, family: Family): boolean {
  if (a.precision === "country" || b.precision === "country") return false;
  return distanceKm(a, b) <= km && periodsOverlap(a, b, OVERLAP_SLACK_DAYS[family]);
}

/** True when two events of the same family match by that family's distance, country and time rule. */
export function ruleMatch(a: SourceEvent, b: SourceEvent, family: Family): boolean {
  switch (family) {
    case "quake":
      return quakesMatch(a, b);
    case "storm":
      return stormsMatch(a, b);
    case "water":
      return floodsMatch(a, b);
    case "fire":
      return sitesMatch(a, b, FIRE_KM, family);
    case "volcano":
      return sitesMatch(a, b, VOLCANO_KM, family);
    default:
      // Droughts, heat and cold waves, dust: whole-country events.
      return shareCountry(a, b) && periodsOverlap(a, b, OVERLAP_SLACK_DAYS[family]);
  }
}

/**
 * How strongly two events describe the same disaster, lower is stronger:
 * 0 a shared GLIDE number, 1 the same name, 2..3 a distance or country rule
 * (closer is stronger; a quake report without an epicentre scores 2.5 to
 * 2.8 by severity and time, see looseQuakeScore). Null when they do not
 * match. Two reports from one feed match only by GLIDE number.
 */
export function matchScore(a: SourceEvent, b: SourceEvent): number | null {
  if (sharesGlide(a, b)) return 0;
  if (a.source === b.source) return null;
  const family = FAMILY_OF[a.type];
  if (family === undefined || family !== FAMILY_OF[b.type]) return null;
  if (sameName(a, b)) return 1;
  if (!ruleMatch(a, b, family)) return null;
  if (family === "quake" && !quakesClose(a, b)) return looseQuakeScore(a, b);
  return 2 + Math.min(distanceKm(a, b), 20_000) / 20_000;
}

/** Scores of 2 and above are weak links (distance or country rules). */
const WEAK_LINK = 2;

/** True when two located reports of one family, not tied by GLIDE or name, are too far apart to be one disaster. */
export function isApart(a: SourceEvent, b: SourceEvent): boolean {
  if (a.precision === "country" || b.precision === "country") return false;
  const family = FAMILY_OF[a.type];
  if (family !== FAMILY_OF[b.type] || sharesGlide(a, b) || sameName(a, b)) return false;
  return distanceKm(a, b) > APART_KM[family];
}

/** True when two groups may join: no feed twice (unless tied by GLIDE), and on a weak link nothing far apart. */
function canJoin(x: SourceEvent[], y: SourceEvent[], weak: boolean): boolean {
  for (const a of x) {
    for (const b of y) {
      if (a.source === b.source && !sharesGlide(a, b)) return false;
      if (weak && isApart(a, b)) return false;
    }
  }
  return true;
}

/** One report per member key (the most recently updated), sorted by key so the result does not depend on input order. */
export function uniqueEvents(events: SourceEvent[]): SourceEvent[] {
  const byKey = new Map<string, SourceEvent>();
  for (const e of events) {
    const key = memberKey(e);
    const seen = byKey.get(key);
    if (!seen || ms(e.updated) > ms(seen.updated)) byKey.set(key, e);
  }
  return [...byKey.entries()].sort(([a], [b]) => compareText(a, b)).map(([, e]) => e);
}

/**
 * Groups events that describe the same disaster. Every matching pair is a
 * candidate link; links join groups strongest first (ties by member key),
 * skipping a link when canJoin refuses. Groups come out in member-key order.
 */
export function clusterEvents(events: SourceEvent[]): SourceEvent[][] {
  const list = uniqueEvents(events);
  const links: { i: number; j: number; score: number }[] = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const score = matchScore(list[i], list[j]);
      if (score !== null) links.push({ i, j, score });
    }
  }
  links.sort((p, q) => p.score - q.score || p.i - q.i || p.j - q.j);
  const groups: number[][] = list.map((_, i) => [i]);
  const owner = list.map((_, i) => i);
  for (const { i, j, score } of links) {
    const [gi, gj] = [owner[i], owner[j]];
    if (gi === gj) continue;
    const [keep, take] = gi < gj ? [gi, gj] : [gj, gi];
    if (!canJoin(groups[keep].map((k) => list[k]), groups[take].map((k) => list[k]), score >= WEAK_LINK)) continue;
    for (const k of groups[take]) owner[k] = keep;
    groups[keep].push(...groups[take]);
    groups[take] = [];
  }
  return groups.filter((g) => g.length > 0).map((g) => g.sort((a, b) => a - b).map((k) => list[k]));
}

// ---------------------------------------------------------------------------
// Earthquake sequences
// ---------------------------------------------------------------------------

/** Aftershocks are folded into their main shock for this long after it. */
export const AFTERSHOCK_DAYS = 21;
/** A weaker quake this long before a stronger one is treated as its foreshock. */
export const FORESHOCK_DAYS = 3;

/** The magnitude a quake report states ("Magnitude 6.6, ..." or "M6.6 earthquake ..."), or null. */
export function quakeMagnitude(e: Pick<SourceEvent, "severityText" | "title">): number | null {
  const m = /magnitude\s+(\d+(?:\.\d+)?)/i.exec(e.severityText ?? "") ?? /\bM\s?(\d+(?:\.\d+)?)\b/.exec(e.title);
  const v = m ? Number(m[1]) : NaN;
  return Number.isFinite(v) && v > 0 && v < 10 ? v : null;
}

/** Two feeds' reports of one shock are this close in time, distance and magnitude. */
export const SAME_SHOCK_MINUTES = 10;
export const SAME_SHOCK_KM = 100;
export const SAME_SHOCK_MAGNITUDE = 0.5;

/**
 * True when two quake reports are one shock seen by two feeds: different
 * feeds, minutes apart, close together and of about the same magnitude.
 * Stricter than quakesClose, which also links a large quake's aftershocks
 * of the first hours.
 */
export function sameShock(a: SourceEvent, b: SourceEvent): boolean {
  if (a.source === b.source) return false;
  const ma = quakeMagnitude(a);
  const mb = quakeMagnitude(b);
  if (ma !== null && mb !== null && Math.abs(ma - mb) > SAME_SHOCK_MAGNITUDE) return false;
  return Math.abs(ms(a.started) - ms(b.started)) <= SAME_SHOCK_MINUTES * 60_000 && distanceKm(a, b) <= SAME_SHOCK_KM;
}

/** Gardner-Knopoff aftershock distance for a main shock of magnitude m: about 53 km at M6, 71 km at M7, 86 km at M7.7. */
export function aftershockKm(m: number): number {
  return 10 ** (0.1238 * m + 0.983);
}

/**
 * Folds aftershocks (and foreshocks) into their main shock, so a sequence
 * shows as one disaster instead of five. Strongest quakes are taken as main
 * shocks first; a weaker located quake within the main shock's
 * Gardner-Knopoff distance, from FORESHOCK_DAYS before it to AFTERSHOCK_DAYS
 * after it, is absorbed. Another feed's report of the main shock itself
 * (sameShock) is never absorbed: it joins in clustering as usual.
 * Returns the events left to cluster and, per main shock's member key, the
 * reports folded into it.
 */
export function groupSequences(events: SourceEvent[]): { kept: SourceEvent[]; absorbed: Map<string, SourceEvent[]> } {
  const quakes = events
    .filter((e) => FAMILY_OF[e.type] === "quake" && e.precision === "exact" && quakeMagnitude(e) !== null)
    .sort((a, b) => quakeMagnitude(b)! - quakeMagnitude(a)! || ms(a.started) - ms(b.started) || compareText(memberKey(a), memberKey(b)));
  const gone = new Set<SourceEvent>();
  const absorbed = new Map<string, SourceEvent[]>();
  for (const main of quakes) {
    if (gone.has(main)) continue;
    const mag = quakeMagnitude(main)!;
    const km = aftershockKm(mag);
    const start = ms(main.started);
    for (const other of quakes) {
      if (other === main || gone.has(other) || absorbed.has(memberKey(other))) continue;
      if (quakeMagnitude(other)! > mag || sameShock(main, other)) continue;
      const dt = ms(other.started) - start;
      if (dt < -FORESHOCK_DAYS * DAY_MS || dt > AFTERSHOCK_DAYS * DAY_MS) continue;
      if (distanceKm(main, other) > km) continue;
      gone.add(other);
      absorbed.set(memberKey(main), [...(absorbed.get(memberKey(main)) ?? []), other]);
    }
  }
  return { kept: events.filter((e) => !gone.has(e)), absorbed };
}

/**
 * Adds a sequence's folded reports to its disaster: their member keys (so
 * ids stay stable), the latest activity, the highest severity, and an
 * "Aftershocks" figure with the count and the strongest magnitude.
 */
export function withAftershocks(d: Disaster, members: SourceEvent[], absorbed: Map<string, SourceEvent[]>): Disaster {
  const folded = members.flatMap((m) => absorbed.get(memberKey(m)) ?? []);
  if (folded.length === 0) return d;
  const keys = [...new Set([...d.members, ...folded.map(memberKey)])].sort(compareText);
  const updated = new Date(Math.max(ms(d.updated), ...folded.map((e) => ms(e.updated)))).toISOString();
  // One shock reported by two feeds counts once: group by epicentre and time.
  const shocks = folded.filter((e, i) => !folded.slice(0, i).some((x) => sameShock(x, e)));
  const strongest = [...shocks].sort((a, b) => quakeMagnitude(b)! - quakeMagnitude(a)!)[0];
  const later = shocks.filter((e) => ms(e.started) >= ms(d.started)).length;
  const label = later === shocks.length ? "Aftershocks" : "Related quakes";
  const figure: Figure = {
    label,
    value: `${shocks.length}, strongest M${quakeMagnitude(strongest)!.toFixed(1)}`,
    sourceName: strongest.source === "usgs" ? "USGS" : strongest.source.toUpperCase(),
    sourceUrl: strongest.links[0]?.url ?? d.sources[0]?.url ?? "",
  };
  return {
    ...d,
    members: keys,
    updated,
    severity: Math.max(d.severity, ...folded.map(memberSeverity)) as Severity,
    figures: figure.sourceUrl ? [...d.figures.filter((f) => f.label !== label), figure] : d.figures,
  };
}

// ---------------------------------------------------------------------------
// Building a disaster
// ---------------------------------------------------------------------------

/** "<source>-<type>-<sourceId>" lower-cased, anything but a-z, 0-9 and "-" replaced by "-". */
export function freshId(e: Pick<SourceEvent, "source" | "type" | "sourceId">): string {
  return `${e.source}-${e.type}-${e.sourceId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

/** The title: an EONET storm name, a USGS quake description, otherwise the lead report's. */
export function pickTitle(primary: SourceEvent, members: SourceEvent[]): string {
  const prefer: SourceName | null = primary.type === "cyclone" || primary.type === "storm" ? "eonet" : primary.type === "earthquake" ? "usgs" : null;
  const preferred = prefer ? members.find((m) => m.source === prefer && m.title.trim()) : undefined;
  return (preferred ?? primary).title;
}

/** The highest severity's text: the lead report's when it has the highest severity, else the next in order. */
function pickSeverityText(ordered: SourceEvent[], max: number): string | undefined {
  return ordered.find((m) => memberSeverity(m) === max && m.severityText)?.severityText;
}

/** Distinct values in order of first appearance. */
function distinct<T>(values: T[], keyOf: (v: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((v) => {
    const key = keyOf(v);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The earliest and latest valid times among the members (the lead's own when none parse). */
function timeSpan(members: SourceEvent[], primary: SourceEvent): { started: string; updated: string } {
  let started = primary.started;
  let updated = primary.updated;
  for (const m of members) {
    if (ms(m.started) < ms(started) || Number.isNaN(ms(started))) started = m.started;
    if (ms(m.updated) > ms(updated) || Number.isNaN(ms(updated))) updated = m.updated;
  }
  return { started, updated };
}

/** UTF-8 size of a value as JSON. */
function jsonBytes(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v), "utf8");
}

/**
 * All members' areas, highest-priority feed first. While the total is over
 * maxBytes, the lowest-priority feed's areas are dropped; the first feed
 * with areas is always kept (each feed already fits its own).
 */
export function capAreas(byPriorityMembers: SourceEvent[], maxBytes = MAX_AREA_BYTES): Area[] {
  const groups = byPriorityMembers.map((m) => m.areas ?? []).filter((a) => a.length > 0);
  let keep = groups.length;
  while (keep > 1 && jsonBytes(groups.slice(0, keep).flat()) > maxBytes) keep--;
  return groups.slice(0, keep).flat();
}

/** The member track with the most points (past and forecast); ties go to the higher-priority feed. */
export function pickTrack(byPriorityMembers: SourceEvent[]): Track | undefined {
  let best: Track | undefined;
  for (const m of byPriorityMembers) {
    const t = m.track;
    if (!t) continue;
    const n = (t.past?.length ?? 0) + (t.forecast?.length ?? 0);
    if (n > 0 && (!best || n > best.past.length + best.forecast.length)) best = t;
  }
  return best;
}

/** The summary (and the link it came from): IFRC's first, then GDACS, EONET, USGS and news. */
export function pickSummary(members: SourceEvent[]): { summary?: string; summarySource?: SourceRef } {
  const ranked = [...members].sort((a, b) => rankIn(SUMMARY_ORDER, a.source) - rankIn(SUMMARY_ORDER, b.source) || byPriority(a, b));
  const m = ranked.find((e) => e.summary?.trim());
  if (!m) return {};
  return m.links[0] ? { summary: m.summary, summarySource: m.links[0] } : { summary: m.summary };
}

/** Every member's figures, one per label (case and spacing ignored), IFRC's first. */
export function mergeFigures(members: SourceEvent[]): Figure[] {
  const ranked = [...members].sort((a, b) => rankIn(FIGURE_ORDER, a.source) - rankIn(FIGURE_ORDER, b.source) || byPriority(a, b));
  return distinct(
    ranked.flatMap((m) => m.figures ?? []),
    (f) => f.label.trim().toLowerCase().replace(/\s+/g, " "),
  );
}

/** Every member's places, one per name and country, in member order. */
export function mergePlaces(ordered: SourceEvent[]): Place[] {
  return distinct(
    ordered.flatMap((m) => m.places ?? []),
    (p) => `${normaliseName(p.name) || p.name.trim().toLowerCase()}|${p.country}`,
  );
}

/** Every member's links, one per URL, lead report's first, at most MAX_SOURCES. */
export function mergeSources(ordered: SourceEvent[]): SourceRef[] {
  return distinct(
    ordered.flatMap((m) => m.links ?? []),
    (l) => l.url,
  ).slice(0, MAX_SOURCES);
}

/** Every member's appeals, one per code. */
export function mergeAppeals(ordered: SourceEvent[]): AppealRef[] {
  return distinct(
    ordered.flatMap((m) => m.appeals ?? []),
    (a) => a.code,
  );
}

/**
 * One Disaster from a group of matching events. The lead report is the most
 * exact (then by feed priority); it gives the type, the position and the
 * fresh id. The severity is the highest memberSeverity: a news report raises
 * a feed's rating only by the deaths its headlines report. Donation pages
 * and research are left for the integrator.
 */
export function buildDisaster(members: SourceEvent[]): Disaster {
  if (members.length === 0) throw new Error("buildDisaster needs at least one event");
  const primary = [...members].sort(byPrecision)[0];
  const byPrio = [...members].sort(byPriority);
  const ordered = [primary, ...byPrio.filter((m) => m !== primary)];
  const severity = Math.max(...members.map(memberSeverity)) as Severity;
  const severityText = pickSeverityText(ordered, severity);
  const track = pickTrack(byPrio);
  const out: Disaster = {
    id: freshId(primary),
    type: primary.type,
    title: pickTitle(primary, byPrio),
    severity,
    countries: distinct(
      ordered.flatMap((m) => m.countries),
      (c) => c,
    ),
    lat: primary.lat,
    lng: primary.lng,
    precision: primary.precision,
    ...timeSpan(members, primary),
    areas: capAreas(byPrio),
    places: mergePlaces(ordered),
    ...pickSummary(members),
    figures: mergeFigures(members),
    sources: mergeSources(ordered),
    appeals: mergeAppeals(ordered),
    donate: [],
    reportedBy: SOURCE_PRIORITY.filter((s) => members.some((m) => m.source === s)),
    members: members.map(memberKey).sort(compareText),
  };
  if (severityText) out.severityText = severityText;
  if (track) out.track = track;
  return out;
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/**
 * Gives each disaster the id of the previous disaster it shares the most
 * members with. Each previous id goes to one disaster only: the biggest
 * overlap first, then the disaster whose own fresh id it is. The others
 * keep their fresh ids, with "-2", "-3"... added when one is already taken
 * (by a disaster this run or by any previous one, which may be carried over).
 */
export function assignIds(disasters: Disaster[], previous: Disaster[] | null): Disaster[] {
  const prev = previous ?? [];
  const ownerOf = new Map<string, number[]>();
  prev.forEach((p, pi) => p.members.forEach((k) => ownerOf.set(k, [...(ownerOf.get(k) ?? []), pi])));
  const claims: { di: number; id: string; overlap: number }[] = [];
  disasters.forEach((d, di) => {
    const counts = new Map<number, number>();
    for (const k of d.members) for (const pi of ownerOf.get(k) ?? []) counts.set(pi, (counts.get(pi) ?? 0) + 1);
    for (const [pi, overlap] of counts) claims.push({ di, id: prev[pi].id, overlap });
  });
  claims.sort(
    (a, b) =>
      b.overlap - a.overlap ||
      Number(disasters[b.di].id === b.id) - Number(disasters[a.di].id === a.id) ||
      compareText(a.id, b.id) ||
      a.di - b.di,
  );
  const ids: (string | undefined)[] = disasters.map(() => undefined);
  const taken = new Set<string>();
  for (const c of claims) {
    if (ids[c.di] !== undefined || taken.has(c.id)) continue;
    ids[c.di] = c.id;
    taken.add(c.id);
  }
  for (const p of prev) taken.add(p.id);
  return disasters.map((d, di) => {
    let id = ids[di];
    if (id === undefined) {
      id = d.id;
      for (let n = 2; taken.has(id); n++) id = `${d.id}-${n}`;
      taken.add(id);
    }
    return id === d.id ? d : { ...d, id };
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Days after its last update that a disaster stays ongoing: its type's window, longer for a significant or severe quake (MAJOR_QUAKE_DAYS). */
export function ongoingDays(d: Pick<Disaster, "type"> & Partial<Pick<Disaster, "severity">>): number {
  const base = ONGOING_DAYS[d.type] ?? 7;
  const major = FAMILY_OF[d.type] === "quake" && (d.severity === 2 || d.severity === 3) ? MAJOR_QUAKE_DAYS[d.severity] : 0;
  return Math.max(base, major);
}

/**
 * True while the disaster is current: updated within ongoingDays, or it
 * started within APPEAL_MAX_AGE_DAYS and an IFRC appeal for it has not ended.
 */
export function isOngoing(d: Pick<Disaster, "type" | "started" | "updated" | "appeals"> & Partial<Pick<Disaster, "severity">>, now: string): boolean {
  const at = ms(now);
  if (at - ms(d.updated) <= ongoingDays(d) * DAY_MS) return true;
  if (!(at - ms(d.started) <= APPEAL_MAX_AGE_DAYS * DAY_MS)) return false;
  return (d.appeals ?? []).some((a) => ms(a.end) >= at);
}

/** Most severe first, then most recently updated, then by id. */
export function compareDisasters(a: Disaster, b: Disaster): number {
  const ua = ms(a.updated);
  const ub = ms(b.updated);
  return b.severity - a.severity || (ub || 0) - (ua || 0) || compareText(a.id, b.id);
}

/**
 * The disasters ongoing at `now`, built from every feed's events. Ids are
 * kept from `previous` where members carry over.
 */
export function mergeEvents(events: SourceEvent[], previous: Disaster[] | null, now: string): Disaster[] {
  const { kept, absorbed } = groupSequences(uniqueEvents(events));
  const built = clusterEvents(kept)
    .map((members) => withAftershocks(buildDisaster(members), members, absorbed))
    .filter((d) => isOngoing(d, now));
  return assignIds(built, previous).sort(compareDisasters);
}

/**
 * The previous run's disasters to keep unchanged because a failed feed
 * reported them: at least one member is from a failed feed, no member is in
 * freshMembers, and the disaster is still ongoing. The integrator appends
 * these to mergeEvents' result.
 *
 * Pass as freshMembers the member keys of this run's disasters (mergeEvents'
 * result). Then a disaster is also kept when the working feeds dropped their
 * reports of it, or still list them but those alone are no longer ongoing
 * (GDACS's Orange alert kept a quake that USGS rates minor). The keys of all
 * fresh events work too, but such a disaster then drops out for the run.
 */
export function carryOver(previous: Disaster[], failedSources: Set<SourceName>, freshMembers: Set<string>, now: string): Disaster[] {
  return previous.filter(
    (d) =>
      d.members.length > 0 &&
      d.members.some((k) => failedSources.has(sourceOfKey(k) as SourceName)) &&
      d.members.every((k) => !freshMembers.has(k)) &&
      isOngoing(d, now),
  );
}
