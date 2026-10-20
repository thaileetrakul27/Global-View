// Builds public/data/disasters.json: fetches every disaster source, merges
// their reports into disasters, researches the most important ones on the
// web within the month's budget, places their affected cities on the map
// and attaches donation pages.
//
// Every source keeps its previous run's reports when it fails (a snapshot
// in cache/disaster-sources.json), so nothing is replaced with an empty
// list. In offline mode (pipeline/derive.ts) nothing is fetched and no
// model is called: the file is rebuilt from the caches alone.
import fs from "node:fs";
import type { AiClient } from "../ai";
import type { FetchDeps } from "../googlenews";
import { writeJson } from "../io";
import type { CountryResolver } from "../resolve";
import { averageResearchCost, canSpend, researchAllowance, type Budget, type Ledger } from "../spend";
import { buildDonations, prepareDonations, readRegistry, refreshRegistry, writeRegistry, type DonationRegistry } from "./donate";
import { fetchEonet } from "./eonet";
import { fetchGdacs } from "./gdacs";
import { createGeocoder, placeArea, placeFromHit, readGeocodeCache, writeGeocodeCache, type Geocoder } from "./geocode";
import { fitGeometry, haversineKm, type CountryShape } from "./geo";
import { fetchIfrc } from "./ifrc";
import { isOngoing, mergeEvents } from "./merge";
import { extractNewsEvents, mentionsDisaster, type NewsArticle } from "./news";
import {
  pruneResearchCache,
  readResearchCache,
  researchDisaster,
  selectForResearch,
  writeResearchCache,
  type ResearchCache,
  type ResearchEntry,
  type ResearchPlace,
} from "./research";
import type { Area, Disaster, DisastersFile, Place, SourceEvent, SourceName } from "./types";
import { fetchUsgs } from "./usgs";

export const DISASTERS_FILE = "disasters.json";
export const SNAPSHOT_PATH = "cache/disaster-sources.json";
export const ATTEMPTS_PATH = "cache/research-attempts.json";

/** Feeds fetched each run, in this order. News comes from the site's own headlines. */
export const FEEDS: readonly SourceName[] = ["gdacs", "usgs", "eonet", "ifrc"];

/** A disaster whose research failed is not tried again for this long. */
export const RETRY_FAILED_HOURS = 24;
/** No new research starts after this long, so the job stays well inside its time limit. */
export const RESEARCH_TIME_MS = 15 * 60_000;
/** The estimate of one research is the month's average times this, for safety. */
export const RESEARCH_COST_MARGIN = 1.5;
/** Live checks of donation pages per run; the rest use cached verdicts. */
export const MAX_DONATION_CHECKS = 150;
/** Place outlines and circles added to one disaster at most. */
export const MAX_PLACE_AREAS = 10;
/** Bytes allowed for one place's outline. */
export const PLACE_AREA_BYTES = 12_000;

/**
 * How far from a disaster's centre an affected place may lie, by type. A
 * geocoded place further away is most likely a different place with the
 * same name, so it is left out.
 */
export const MAX_PLACE_KM: Record<Disaster["type"], number> = {
  earthquake: 500,
  tsunami: 2000,
  cyclone: 2000,
  storm: 1000,
  flood: 900,
  landslide: 400,
  wildfire: 400,
  volcano: 200,
  drought: 3000,
  heatwave: 2000,
  coldwave: 2000,
  dust: 2000,
};

export type Snapshots = Partial<Record<SourceName, { fetched: string; events: SourceEvent[] }>>;

/** The previous run's reports per source; empty when the file is missing or unreadable. */
export function readSnapshots(path = SNAPSHOT_PATH): Snapshots {
  try {
    const raw = JSON.parse(fs.readFileSync(path, "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return {};
    const out: Snapshots = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const s = v as { fetched?: unknown; events?: unknown };
      if (typeof s?.fetched === "string" && Array.isArray(s.events)) out[k as SourceName] = { fetched: s.fetched, events: s.events.filter(Boolean) as SourceEvent[] };
    }
    return out;
  } catch {
    return {};
  }
}

/** Disaster ids whose research failed, with the time of the attempt. */
export function readAttempts(path = ATTEMPTS_PATH): Record<string, string> {
  try {
    const raw = JSON.parse(fs.readFileSync(path, "utf8")) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Drops failed attempts older than the retry window. */
export function pruneAttempts(attempts: Record<string, string>, now: string): Record<string, string> {
  const cutoff = Date.parse(now) - RETRY_FAILED_HOURS * 3_600_000;
  return Object.fromEntries(Object.entries(attempts).filter(([, at]) => Date.parse(at) > cutoff));
}

/** The previous disasters file, or null. */
export function readDisastersFile(path: string): DisastersFile | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path, "utf8")) as DisastersFile;
    return Array.isArray(raw?.disasters) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Up to max of the site's own headlines about a disaster: in or about one
 * of its countries, naming a hazard, newest first. They help research find
 * local reporting.
 */
export function relatedHeadlines(d: Pick<Disaster, "countries">, articles: NewsArticle[], max = 10): { title: string; outlet: string; url: string }[] {
  const codes = new Set(d.countries);
  if (codes.size === 0) return [];
  return articles
    .filter((a) => (codes.has(a.country) || (a.about ?? []).some((c) => codes.has(c))) && mentionsDisaster(a.en ?? a.title))
    .sort((a, b) => Date.parse(b.published) - Date.parse(a.published))
    .slice(0, max)
    .map((a) => ({ title: a.en ?? a.title, outlet: a.outlet, url: a.url }));
}

/** True when a geocoded point is close enough to the disaster to be one of its places (any distance for country-level disasters). */
export function nearEnough(d: Pick<Disaster, "type" | "lat" | "lng" | "precision">, p: { lat: number; lng: number }): boolean {
  if (d.precision === "country") return true;
  return haversineKm(d, p) <= MAX_PLACE_KM[d.type];
}

/** Places geocoded from research or news, each with its map area. */
export interface LocatedPlace {
  place: Place;
  area: Area;
}

/** Geocodes research places with the run's shared geocoder, keeping those near the disaster. */
export async function locatePlaces(geocoder: Geocoder, d: Disaster, places: ResearchPlace[], source: Place["source"]): Promise<LocatedPlace[]> {
  const out: LocatedPlace[] = [];
  for (const p of places) {
    const hit = await geocoder.geocode(p.name, p.country, p.admin, p.kind);
    if (!hit || !nearEnough(d, hit)) continue;
    const place = placeFromHit(hit, p.impact, source);
    if (out.some((x) => x.place.name === place.name && x.place.country === place.country)) continue;
    out.push({ place, area: placeArea(place, hit) });
  }
  return out;
}

/** True when the disaster has a mapped footprint of its own (not just circles around places). */
export function hasFootprint(d: Pick<Disaster, "areas">): boolean {
  return d.areas.some((a) => a.kind !== "place");
}

/** A place area simplified to the per-place budget; null when it vanishes. */
function fittedArea(area: Area): Area | null {
  const geometry = fitGeometry(area.geometry, PLACE_AREA_BYTES);
  return geometry ? { ...area, geometry } : null;
}

/**
 * Adds located places to a disaster: names and impacts for the panel and
 * labels, and areas for the map when the disaster has no footprint of its
 * own. A disaster known only by country moves to its places.
 */
export function withPlaces(d: Disaster, located: LocatedPlace[]): Disaster {
  if (located.length === 0) return d;
  const places = [...d.places];
  for (const { place } of located) {
    if (!places.some((p) => p.name === place.name && p.country === place.country)) places.push(place);
  }
  let areas = d.areas;
  if (!hasFootprint(d)) {
    const extra = located
      .slice(0, MAX_PLACE_AREAS)
      .map((l) => fittedArea(l.area))
      .filter((a): a is Area => a !== null);
    areas = [...d.areas, ...extra].slice(0, MAX_PLACE_AREAS);
  }
  const moved =
    d.precision === "country"
      ? {
          lat: located.reduce((s, l) => s + l.place.lat, 0) / located.length,
          lng: located.reduce((s, l) => s + l.place.lng, 0) / located.length,
          precision: "area" as const,
        }
      : {};
  return { ...d, places, areas, ...moved };
}

/** The first cited host as a source label, e.g. "reliefweb.int". */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Adds a research entry's summary, figures and sources to a disaster. Feed figures come first; at most six. */
export function withResearch(d: Disaster, entry: ResearchEntry): Disaster {
  const figures = [...d.figures];
  for (const f of entry.figures) if (!figures.some((x) => x.label.toLowerCase() === f.label.toLowerCase())) figures.push(f);
  const sources = [...d.sources];
  for (const s of entry.sources) if (!sources.some((x) => x.url === s.url)) sources.push({ name: s.title || hostOf(s.url), url: s.url });
  const lead = entry.sources[0];
  return {
    ...d,
    ...(entry.summary ? { summary: entry.summary, summarySource: lead ? { name: lead.title || hostOf(lead.url), url: lead.url } : d.summarySource } : {}),
    figures: figures.slice(0, 6),
    sources: sources.slice(0, 12),
    research: { at: entry.at, model: entry.model, searches: entry.searches },
  };
}

/**
 * True when research newer than the feeds' last activity says a minor or
 * significant disaster is over and no IFRC appeal is still open. Severe
 * disasters stay until the feeds drop them.
 */
export function researchSaysOver(d: Disaster, entry: ResearchEntry | undefined, now: string): boolean {
  if (!entry || entry.ongoing !== false || d.severity === 3) return false;
  if (Date.parse(entry.at) <= Date.parse(d.updated)) return false;
  return !d.appeals.some((a) => Date.parse(a.end) >= Date.parse(now));
}

/** Moves news events to their geocoded places; events with no place that geocodes are dropped. */
export async function locateNewsEvents(events: SourceEvent[], geocoder: Geocoder): Promise<SourceEvent[]> {
  const out: SourceEvent[] = [];
  for (const e of events) {
    if (e.lat !== 0 || e.lng !== 0 || e.precision !== "country") {
      out.push(e);
      continue;
    }
    const places: Place[] = [];
    for (const p of e.places ?? []) {
      const hit = await geocoder.geocode(p.name, p.country, p.admin, p.kind);
      if (hit) places.push(placeFromHit(hit, p.impact, "news"));
    }
    if (places.length === 0) continue;
    const lat = places.reduce((s, p) => s + p.lat, 0) / places.length;
    const lng = places.reduce((s, p) => s + p.lng, 0) / places.length;
    out.push({ ...e, places, lat, lng, precision: "area" });
  }
  return out;
}

export interface DisasterRun {
  outDir: string;
  now: string;
  deps: FetchDeps;
  /** Null without credentials, with --no-ai, or once the month's budget is spent. */
  ai: AiClient | null;
  ledger: Ledger;
  budget: Budget;
  /** Every published article (local and world coverage), for news extraction and research hints. */
  articles: NewsArticle[];
  resolve: CountryResolver;
  shapes: CountryShape[];
  globeCodes: Set<string>;
  /** Globe code -> English name. */
  countryNames: Record<string, string>;
  /** No fetching, geocoding, model calls or live checks: rebuild from the caches. */
  offline?: boolean;
  log: (msg: string) => void;
}

/** Fetches every feed, keeping a failed feed's previous reports. */
async function fetchFeeds(run: DisasterRun, snapshots: Snapshots): Promise<{ events: SourceEvent[]; fetched: DisastersFile["fetched"]; next: Snapshots }> {
  const { deps, now, resolve, shapes, log } = run;
  const next: Snapshots = { ...snapshots };
  const fetched = { gdacs: null, usgs: null, eonet: null, ifrc: null, news: null } as DisastersFile["fetched"];
  for (const source of FEEDS) {
    const prev = snapshots[source]?.events ?? [];
    let fresh: SourceEvent[] | null = null;
    if (!run.offline) {
      log(`Disasters: fetching ${source}`);
      try {
        if (source === "gdacs") fresh = await fetchGdacs(deps, now, resolve, prev);
        else if (source === "usgs") fresh = await fetchUsgs(deps, now, shapes, prev);
        else if (source === "eonet") fresh = await fetchEonet(deps, now, shapes);
        else if (source === "ifrc") fresh = await fetchIfrc(deps, now, resolve, shapes, prev);
      } catch (err) {
        log(`Disasters: ${source} failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
        fresh = null;
      }
    }
    if (fresh) {
      next[source] = { fetched: now, events: fresh };
      log(`Disasters: ${source} gave ${fresh.length} reports`);
    } else if (!run.offline) {
      log(`Disasters: ${source} failed; keeping its ${prev.length} reports from ${snapshots[source]?.fetched ?? "never"}`);
    }
    fetched[source] = next[source]?.fetched ?? null;
  }
  const events = FEEDS.flatMap((s) => next[s]?.events ?? []);
  return { events, fetched, next };
}

/**
 * Runs web research on the disasters that need it most, within the day's
 * allowance, this run's cap and a time limit. Updates cache and attempts.
 */
async function runResearch(run: DisasterRun, disasters: Disaster[], cache: ResearchCache, attempts: Record<string, string>): Promise<number> {
  const { ai, ledger, budget, now, log } = run;
  if (!ai || run.offline) return 0;
  if (!canSpend(ledger, budget, now)) {
    log("Research: the month's budget is used up; skipped");
    return 0;
  }
  const estimate = averageResearchCost(ledger, now) * RESEARCH_COST_MARGIN;
  const candidates = disasters.filter((d) => !attempts[d.id]);
  const picked = selectForResearch(candidates, cache, now, { maxCalls: budget.maxResearchPerRun, allowanceUsd: researchAllowance(ledger, budget, now), costEstimateUsd: estimate });
  log(`Research: ${picked.length} of ${disasters.length} disasters picked (allowance $${researchAllowance(ledger, budget, now).toFixed(2)}, about $${estimate.toFixed(3)} each)`);
  const started = Date.now();
  let done = 0;
  for (const d of picked) {
    if (Date.now() - started > RESEARCH_TIME_MS) {
      log("Research: time limit reached; the rest wait for the next run");
      break;
    }
    // The allowance is read again after each call, from the real spend.
    if (researchAllowance(ledger, budget, now) < estimate || !canSpend(ledger, budget, now)) {
      log("Research: today's allowance is used up");
      break;
    }
    const headlines = relatedHeadlines(d, run.articles);
    const entry = await researchDisaster(ai, d, { countryNames: run.countryNames, headlines, resolve: run.resolve, now, log });
    if (entry) {
      cache[d.id] = entry;
      done++;
      log(`  researched ${d.id}: ${entry.places.length} places, ${entry.figures.length} figures, ${entry.donation.length} donation pages, ${entry.searches} searches`);
    } else {
      attempts[d.id] = now;
      log(`  research failed for ${d.id}; retried after ${RETRY_FAILED_HOURS} h`);
    }
  }
  return done;
}

/** Builds and writes public/data/disasters.json and the caches. Returns the file. */
export async function updateDisasters(run: DisasterRun): Promise<DisastersFile> {
  const { outDir, now, deps, log } = run;
  const outPath = `${outDir}/${DISASTERS_FILE}`;
  const previous = readDisastersFile(outPath);
  const snapshots = readSnapshots();
  const { events: feedEvents, fetched, next } = await fetchFeeds(run, snapshots);

  // The run's one geocoder: Nominatim at one request a second, cached forever.
  const geocodeCache = readGeocodeCache();
  const geocoder = createGeocoder(deps, geocodeCache, now, run.offline ? { maxLookups: 0 } : {});

  // Disasters in the site's own headlines, placed by geocoding their places.
  let newsEvents = next.news?.events ?? [];
  if (run.ai && !run.offline && canSpend(run.ledger, run.budget, now)) {
    const extracted = await extractNewsEvents(run.ai, run.articles, run.resolve, now, { codes: run.globeCodes, previous: newsEvents, log });
    if (extracted) {
      newsEvents = await locateNewsEvents(extracted, geocoder);
      next.news = { fetched: now, events: newsEvents };
      log(`Disasters: news gave ${extracted.length} events, ${newsEvents.length} placed`);
    } else {
      log("Disasters: news extraction failed; previous news events kept");
    }
  }
  fetched.news = next.news?.fetched ?? null;

  let disasters = mergeEvents([...feedEvents, ...newsEvents], previous?.disasters ?? null, now);
  log(`Disasters: ${disasters.length} ongoing after merging ${feedEvents.length + newsEvents.length} reports`);

  // Web research within the budget, then its results on every disaster that has them.
  const cache = readResearchCache();
  const attempts = pruneAttempts(readAttempts(), now);
  await runResearch(run, disasters, cache, attempts);
  const enriched: Disaster[] = [];
  for (const d of disasters) {
    const entry = cache[d.id];
    if (researchSaysOver(d, entry, now)) {
      log(`  ${d.id}: research says it is over; left off the map`);
      continue;
    }
    let out = entry ? withResearch(d, entry) : d;
    if (entry?.places.length) out = withPlaces(out, await locatePlaces(geocoder, out, entry.places, "research"));
    enriched.push(out);
  }
  disasters = enriched.filter((d) => isOngoing(d, now) || d.appeals.length > 0);

  // Donation pages: registries by fixed rule plus researched pages that pass the allowlist and a live check.
  let registry: DonationRegistry = readRegistry();
  if (!run.offline) registry = await refreshRegistry(registry, deps, now, run.resolve, { probeCodes: [...run.globeCodes] });
  let checks = 0;
  for (const d of disasters) {
    const input = { countries: d.countries, appeals: d.appeals, researched: cache[d.id]?.donation ?? [] };
    if (run.offline || checks >= MAX_DONATION_CHECKS) {
      d.donate = buildDonations(input, registry, now);
      continue;
    }
    const before = Object.keys(registry.verdicts).length;
    d.donate = await prepareDonations(input, registry, deps, now, { maxChecks: 3 });
    checks += Math.max(0, Object.keys(registry.verdicts).length - before);
  }

  const file: DisastersFile = { updated: now, fetched, disasters };
  writeJson(outPath, file);
  if (!run.offline) {
    writeJson(SNAPSHOT_PATH, next);
    writeRegistry(registry);
    writeJson(ATTEMPTS_PATH, attempts);
  }
  writeGeocodeCache(geocodeCache);
  writeResearchCache(pruneResearchCache(cache, disasters.map((d) => d.id), now));
  const bytes = fs.statSync(outPath).size;
  log(
    `Disasters: wrote ${disasters.length} (${disasters.filter((d) => d.research).length} researched, ${disasters.reduce((n, d) => n + d.donate.length, 0)} donation links, ${geocoder.lookups} new geocoder lookups) in ${Math.round(bytes / 1024)} KB`,
  );
  return file;
}
