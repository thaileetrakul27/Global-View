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
import path from "node:path";
import type { AiClient } from "../ai";
import type { FetchDeps } from "../googlenews";
import { writeCompactJson, writeJson } from "../io";
import type { CountryResolver } from "../resolve";
import { averageResearchCost, canSpend, noteResearch, researchAllowance, type Budget, type Ledger } from "../spend";
import { REGISTRY_PATH, buildDonations, prepareDonations, readRegistry, refreshRegistry, searchDomains, writeRegistry, type DonationRegistry } from "./donate";
import { fetchEonet } from "./eonet";
import { fetchGdacs } from "./gdacs";
import { GEOCODE_CACHE_PATH, createGeocoder, placeArea, placeFromHit, readGeocodeCache, writeGeocodeCache, type Geocoder } from "./geocode";
import { dropSeaParts, fitGeometry, haversineKm, type CountryShape } from "./geo";
import { fetchIfrc } from "./ifrc";
import { isOngoing, mergeEvents } from "./merge";
import { extractNewsEvents, mentionsDisaster, type NewsArticle } from "./news";
import {
  RESEARCH_CACHE_PATH,
  pruneResearchCache,
  readResearchCache,
  researchDisaster,
  searchDonationPages,
  selectDonationBackfill,
  selectForResearch,
  wantsDonationSearch,
  withDonationSearch,
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

/** Where one run keeps its caches. */
export interface CachePaths {
  snapshot: string;
  attempts: string;
  registry: string;
  geocode: string;
  research: string;
}

/** The cache files under dir; the defaults when dir is "cache". */
export function cachePaths(dir = "cache"): CachePaths {
  const at = (defaultPath: string) => `${dir}/${path.basename(defaultPath)}`;
  return { snapshot: at(SNAPSHOT_PATH), attempts: at(ATTEMPTS_PATH), registry: at(REGISTRY_PATH), geocode: at(GEOCODE_CACHE_PATH), research: at(RESEARCH_CACHE_PATH) };
}

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

/** The attempts key for a disaster's failed donation search, apart from its research's own key. */
export function donationAttemptKey(id: string): string {
  return `donation:${id}`;
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
    // Research writes its own summary, so the feed's credit never goes with
    // it: it is credited to the first page it cites, or to nobody.
    ...(entry.summary ? { summary: entry.summary, summarySource: lead ? { name: lead.title || hostOf(lead.url), url: lead.url } : undefined } : {}),
    figures: figures.slice(0, 6),
    sources: sources.slice(0, 12),
    research: { at: entry.at, model: entry.model, searches: entry.searches, ...(entry.summary ? { summary: true } : {}) },
  };
}

/** Hazards that happen on land: their areas lose the parts that are almost all sea. */
export const LAND_HAZARDS: ReadonlySet<Disaster["type"]> = new Set(["flood", "drought", "wildfire", "landslide", "heatwave", "coldwave"]);

/**
 * A land hazard's affected areas and place areas without their parts that
 * are almost all sea (see dropSeaParts): a province boundary can take in
 * offshore islands and their waters, which would otherwise be drawn as a
 * flood in the open sea. Areas left with no part are dropped, but never all
 * of them: when nothing would be left, the disaster keeps its areas.
 */
export function trimSeaAreas(d: Disaster, shapes: CountryShape[]): Disaster {
  if (!LAND_HAZARDS.has(d.type) || shapes.length === 0 || d.areas.length === 0) return d;
  let changed = false;
  const areas: Area[] = [];
  for (const a of d.areas) {
    if (a.kind !== "affected" && a.kind !== "place") {
      areas.push(a);
      continue;
    }
    const geometry = dropSeaParts(a.geometry, shapes, d);
    if (geometry !== a.geometry) changed = true;
    if (geometry) areas.push(geometry === a.geometry ? a : { ...a, geometry });
  }
  if (!changed || areas.length === 0) return d;
  return { ...d, areas };
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

/**
 * Moves news events to their geocoded places. An event with no place that
 * geocodes is dropped, unless the geocoder had to leave a lookup for later
 * (its cap or an outage) and the previous run placed the same event: then
 * it keeps that run's places.
 */
export async function locateNewsEvents(events: SourceEvent[], geocoder: Geocoder, previous: SourceEvent[] = []): Promise<SourceEvent[]> {
  const out: SourceEvent[] = [];
  for (const e of events) {
    if (e.lat !== 0 || e.lng !== 0 || e.precision !== "country") {
      out.push(e);
      continue;
    }
    const deferredBefore = geocoder.deferred;
    const places: Place[] = [];
    for (const p of e.places ?? []) {
      const hit = await geocoder.geocode(p.name, p.country, p.admin, p.kind);
      if (hit) places.push(placeFromHit(hit, p.impact, "news"));
    }
    if (places.length === 0) {
      const before = geocoder.deferred > deferredBefore ? previous.find((x) => x.source === e.source && x.sourceId === e.sourceId && x.precision !== "country") : undefined;
      if (before) out.push({ ...e, places: before.places, lat: before.lat, lng: before.lng, precision: before.precision });
      continue;
    }
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
  /** Epoch ms after which no new research or live donation check starts. */
  deadline?: number;
  /** Folder of the run's caches; "cache" by default. */
  cacheDir?: string;
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
 * allowance, this run's cap and a time limit. A significant disaster (or
 * one with an IFRC appeal) also gets a donation search for pages about the
 * event, right after its research. Then disasters researched before the
 * donation search existed, or before they became significant, get one
 * (at most MAX_DONATION_BACKFILL), within the same limits. The registry
 * gives each search its official sites. Updates cache and attempts.
 */
async function runResearch(
  run: DisasterRun,
  disasters: Disaster[],
  cache: ResearchCache,
  attempts: Record<string, string>,
  paths: CachePaths,
  registry: DonationRegistry,
): Promise<number> {
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
  const stopAt = Math.min(Date.now() + RESEARCH_TIME_MS, run.deadline ?? Infinity);
  // Checked before each new research or donation search; the allowance is
  // read again each time, from the real spend. Once false, false for the run.
  let stopped = false;
  const mayStart = (): boolean => {
    if (stopped) return false;
    if (Date.now() > stopAt) log("Research: time limit reached; the rest wait for the next run");
    else if (researchAllowance(ledger, budget, now) < estimate || !canSpend(ledger, budget, now)) log("Research: today's allowance is used up");
    else return true;
    stopped = true;
    return false;
  };
  // Saved after every call, so a run cut off later keeps what it paid for.
  const save = () => {
    writeResearchCache(cache, paths.research);
    writeJson(paths.attempts, attempts);
  };
  // One donation search for a disaster with a cached entry; its pages are merged into the entry.
  const searchDonations = async (d: Disaster): Promise<void> => {
    const entry = cache[d.id];
    if (!entry) return;
    const pages = await searchDonationPages(ai, d, { countryNames: run.countryNames, allowedDomains: searchDomains(d.countries, registry), now, entry, log });
    if (pages === null) {
      attempts[donationAttemptKey(d.id)] = now;
      log(`  donation search failed for ${d.id}; retried after ${RETRY_FAILED_HOURS} h`);
      return;
    }
    cache[d.id] = withDonationSearch(entry, pages, now);
    log(`  donation search for ${d.id}: ${pages.length} pages, ${pages.filter((p) => p.specific).length} about the event`);
  };

  let done = 0;
  const handled = new Set<string>();
  for (const d of picked) {
    if (!mayStart()) break;
    handled.add(d.id);
    const headlines = relatedHeadlines(d, run.articles);
    const callsBefore = totalCalls(ledger);
    const entry = await researchDisaster(ai, d, { countryNames: run.countryNames, headlines, resolve: run.resolve, now, log });
    if (entry) {
      cache[d.id] = entry;
      done++;
      log(`  researched ${d.id}: ${entry.places.length} places, ${entry.figures.length} figures, ${entry.donation.length} donation pages, ${entry.searches} searches`);
      // Part of the same research, so only the deadline and the month's cap can stop it here.
      if (wantsDonationSearch(d) && Date.now() <= (run.deadline ?? Infinity) && canSpend(ledger, budget, now)) await searchDonations(d);
    } else {
      attempts[d.id] = now;
      log(`  research failed for ${d.id}; retried after ${RETRY_FAILED_HOURS} h`);
    }
    // One researched disaster for the cost average, however many responses it and its donation search took.
    if (totalCalls(ledger) > callsBefore) noteResearch(ledger, new Date().toISOString());
    save();
  }

  // Entries without a donation search. These are not counted as researches,
  // so their spend raises the cost average a little: the safe side.
  const backfill = stopped ? [] : selectDonationBackfill(disasters, cache, (id) => handled.has(id) || Boolean(attempts[donationAttemptKey(id)]));
  if (backfill.length > 0) log(`Research: donation search for ${backfill.length} disasters researched earlier`);
  for (const d of backfill) {
    if (!mayStart()) break;
    await searchDonations(d);
    save();
  }
  return done;
}

/** API responses recorded in every month of the ledger. */
function totalCalls(ledger: Ledger): number {
  return Object.values(ledger.months).reduce((n, m) => n + m.calls, 0);
}

/** Builds and writes public/data/disasters.json and the caches. Returns the file. */
export async function updateDisasters(run: DisasterRun): Promise<DisastersFile> {
  const { outDir, now, deps, log } = run;
  const paths = cachePaths(run.cacheDir);
  const outPath = `${outDir}/${DISASTERS_FILE}`;
  const previous = readDisastersFile(outPath);
  const snapshots = readSnapshots(paths.snapshot);
  const { events: feedEvents, fetched, next } = await fetchFeeds(run, snapshots);

  // The run's one geocoder: Nominatim at one request a second, cached forever.
  const geocodeCache = readGeocodeCache(paths.geocode);
  const geocoder = createGeocoder(deps, geocodeCache, now, run.offline ? { maxLookups: 0 } : {});

  // Disasters in the site's own headlines, placed by geocoding their places.
  let newsEvents = next.news?.events ?? [];
  if (run.ai && !run.offline && canSpend(run.ledger, run.budget, now)) {
    const extracted = await extractNewsEvents(run.ai, run.articles, run.resolve, now, { codes: run.globeCodes, previous: newsEvents, log });
    if (extracted) {
      newsEvents = await locateNewsEvents(extracted, geocoder, newsEvents);
      next.news = { fetched: now, events: newsEvents };
      log(`Disasters: news gave ${extracted.length} events, ${newsEvents.length} placed`);
    } else {
      log("Disasters: news extraction failed; previous news events kept");
    }
  }
  fetched.news = next.news?.fetched ?? null;

  let disasters = mergeEvents([...feedEvents, ...newsEvents], previous?.disasters ?? null, now);
  log(`Disasters: ${disasters.length} ongoing after merging ${feedEvents.length + newsEvents.length} reports`);
  // Never replace a map with an empty one because every source failed: with
  // no fresh feed and no snapshot to fall back on, the previous file's
  // disasters that are still ongoing stay. The caches this run filled are
  // saved all the same.
  const freshFeed = FEEDS.some((s) => fetched[s] === now);
  if (disasters.length === 0 && !freshFeed && previous && previous.disasters.length > 0) {
    const still = previous.disasters.filter((d) => isOngoing(d, now) || d.appeals.length > 0);
    if (still.length > 0) {
      log(`Disasters: no reports this run; ${still.length} still ongoing kept from the previous map`);
      const kept: DisastersFile = { ...previous, disasters: still };
      writeCompactJson(outPath, kept);
      if (!run.offline) writeCompactJson(paths.snapshot, next);
      writeGeocodeCache(geocodeCache, paths.geocode);
      return kept;
    }
  }

  // Web research within the budget, then its results on every disaster that
  // has them. The donation search takes its official sites from the cached
  // registry, which is refreshed further down.
  const cache = readResearchCache(paths.research);
  const attempts = pruneAttempts(readAttempts(paths.attempts), now);
  let registry: DonationRegistry = readRegistry(paths.registry);
  await runResearch(run, disasters, cache, attempts, paths, registry);
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
  disasters = enriched.filter((d) => isOngoing(d, now) || d.appeals.length > 0).map((d) => trimSeaAreas(d, run.shapes));

  // Donation pages: registries by fixed rule plus researched pages that pass the allowlist and a live check.
  if (!run.offline) registry = await refreshRegistry(registry, deps, now, run.resolve, { probeCodes: [...run.globeCodes] });
  let checks = 0;
  const unreachable = new Set<string>();
  for (const d of disasters) {
    const input = { countries: d.countries, appeals: d.appeals, researched: cache[d.id]?.donation ?? [] };
    if (run.offline || checks >= MAX_DONATION_CHECKS || Date.now() > (run.deadline ?? Infinity)) {
      d.donate = buildDonations(input, registry, now);
      continue;
    }
    const before = Object.keys(registry.verdicts).length;
    d.donate = await prepareDonations(input, registry, deps, now, { maxChecks: 3, unreachable });
    checks += Math.max(0, Object.keys(registry.verdicts).length - before);
  }

  const file: DisastersFile = { updated: now, fetched, disasters };
  writeCompactJson(outPath, file);
  if (!run.offline) {
    writeCompactJson(paths.snapshot, next);
    writeRegistry(registry, paths.registry);
    writeJson(paths.attempts, attempts);
  }
  writeGeocodeCache(geocodeCache, paths.geocode);
  writeResearchCache(pruneResearchCache(cache, disasters.map((d) => d.id), now), paths.research);
  const bytes = fs.statSync(outPath).size;
  log(
    `Disasters: wrote ${disasters.length} (${disasters.filter((d) => d.research).length} researched, ${disasters.reduce((n, d) => n + d.donate.length, 0)} donation links, ${geocoder.lookups} new geocoder lookups) in ${Math.round(bytes / 1024)} KB`,
  );
  return file;
}
