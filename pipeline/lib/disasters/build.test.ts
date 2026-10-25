import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AiClient, ResearchResult, Usage, WebResearchOptions } from "../ai";
import { loadGlobeFeatures } from "../countries";
import { buildResolver } from "../resolve";
import { DEFAULT_BUDGET, emptyLedger, record, type Ledger } from "../spend";
import {
  MAX_PLACE_AREAS,
  MIN_SEVERITY,
  articleHosts,
  cachePaths,
  directAttemptKey,
  donationAttemptKey,
  donationInput,
  hasFootprint,
  isSignificant,
  keepsPreviousMap,
  locateNewsEvents,
  locatePlaces,
  nearEnough,
  pruneAttempts,
  readAttempts,
  readDisastersFile,
  readPressLanguages,
  readPressNames,
  readSnapshots,
  relatedHeadlines,
  researchSaysOver,
  trimSeaAreas,
  updateDisasters,
  withPlaces,
  withResearch,
  type DisasterRun,
  type Snapshots,
} from "./build";
import { GOFUNDME_FEED, GOFUNDME_INDEX, hubSlugOf, localVerdictKey, parseFeed, parseHub, type GoFundMeCache } from "./direct";
import { emptyRegistry, searchDomains, urlKey, type DonationRegistry } from "./donate";
import { LAND_SHAPES_PATH, circlePolygon, dropSeaParts, loadCountryShapes, pointInGeometry } from "./geo";
import type { GeoHit, Geocoder } from "./geocode";
import {
  MAX_DONATION_BACKFILL,
  directSearchSchema,
  directSearchSystemPrompt,
  donationSearchSchema,
  membersHash,
  type DirectSearchParse,
  type DonationSearchParse,
  type ResearchEntry,
  type ResearchParse,
} from "./research";
import type { Disaster, DisastersFile, SourceEvent } from "./types";

const NOW = "2026-10-20T12:00:00.000Z";

function dis(p: Partial<Disaster> = {}): Disaster {
  return {
    id: "d1",
    type: "flood",
    title: "Flood in Bangladesh",
    severity: 1,
    countries: ["BD"],
    lat: 24.9,
    lng: 91.9,
    precision: "area",
    started: "2026-10-15T00:00:00.000Z",
    updated: "2026-10-18T00:00:00.000Z",
    areas: [],
    places: [],
    figures: [{ label: "People affected", value: "10,000", sourceName: "IFRC", sourceUrl: "https://go.ifrc.org/emergencies/1" }],
    sources: [{ name: "IFRC GO emergency", url: "https://go.ifrc.org/emergencies/1" }],
    appeals: [],
    donate: [],
    reportedBy: ["ifrc"],
    members: ["ifrc:1"],
    ...p,
  };
}

function entry(p: Partial<ResearchEntry> = {}): ResearchEntry {
  return {
    at: "2026-10-19T00:00:00.000Z",
    model: "claude-haiku-5-5",
    searches: 3,
    summary: "Flash floods hit Sylhet and Sunamganj.",
    ongoing: true,
    places: [{ name: "Sylhet", country: "BD", kind: "city", impact: "streets under water" }],
    figures: [
      { label: "Deaths", value: "4", sourceName: "Daily Star", sourceUrl: "https://www.thedailystar.net/a" },
      { label: "people affected", value: "12,000", sourceName: "x", sourceUrl: "https://x.example" },
    ],
    donation: [],
    sources: [{ name: "Floods in Sylhet", url: "https://www.thedailystar.net/a", title: "Floods in Sylhet" }],
    membersHash: "h",
    ...p,
  };
}

const hit = (name: string, lat: number, lng: number, kind: GeoHit["kind"] = "city"): GeoHit => ({ name, displayName: `${name}, Bangladesh`, lat, lng, kind, country: "BD", bbox: [lng - 0.1, lat - 0.1, lng + 0.1, lat + 0.1] });

function geocoder(hits: Record<string, GeoHit | null>): Geocoder & { geocode: ReturnType<typeof vi.fn> } {
  return { geocode: vi.fn(async (name: string) => hits[name] ?? null), lookups: 0, deferred: 0 } as unknown as Geocoder & { geocode: ReturnType<typeof vi.fn> };
}

describe("caches", () => {
  it("read snapshots, attempts and the disasters file, tolerating missing or broken files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gv-build-"));
    const f = (n: string, body: string) => {
      fs.writeFileSync(path.join(dir, n), body);
      return path.join(dir, n);
    };
    expect(readSnapshots(f("s.json", JSON.stringify({ gdacs: { fetched: NOW, events: [{ sourceId: "a" }, null] }, usgs: { events: [] } })))).toEqual({ gdacs: { fetched: NOW, events: [{ sourceId: "a" }] } });
    expect(readSnapshots(f("bad.json", "{"))).toEqual({});
    expect(readAttempts(f("a.json", JSON.stringify({ d1: NOW, d2: 5 })))).toEqual({ d1: NOW });
    expect(readAttempts(path.join(dir, "missing.json"))).toEqual({});
    expect(readDisastersFile(f("d.json", JSON.stringify({ updated: NOW, disasters: [] })))?.disasters).toEqual([]);
    expect(readDisastersFile(f("x.json", JSON.stringify({ nope: 1 })))).toBeNull();
  });

  it("forgets failed research attempts after a day", () => {
    expect(pruneAttempts({ old: "2026-10-19T11:00:00.000Z", fresh: "2026-10-20T01:00:00.000Z" }, NOW)).toEqual({ fresh: "2026-10-20T01:00:00.000Z" });
  });
});

describe("donationInput", () => {
  it("gives donate.ts the disaster's countries, appeals, researched pages, title and every globe country's name", () => {
    const page = { url: "https://bdrcs.org/donate/sylhet-floods", org: "BDRCS", kind: "society" as const, note: "Sylhet floods", specific: true };
    const d = dis({ title: "Drought in Uganda, Kenya", countries: ["UG", "KE"] });
    // Every country's name, not only the disaster's: a campaign naming another country is told apart by it.
    const names = { UG: "Uganda", KE: "Kenya", SD: "Sudan", SS: "South Sudan" };
    expect(donationInput(d, entry({ donation: [page] }), names)).toEqual({
      countries: ["UG", "KE"],
      appeals: [],
      researched: [page],
      title: "Drought in Uganda, Kenya",
      countryNames: names,
    });
    expect(donationInput(dis(), undefined, {})).toMatchObject({ researched: [], title: "Flood in Bangladesh", countryNames: {} });
  });
});

describe("relatedHeadlines", () => {
  it("keeps disaster headlines from or about the disaster's countries, newest first", () => {
    const a = (country: string, en: string, published: string, about: string[] = []) => ({ country, title: en, en, outlet: "O", url: `https://n.example/${en}`, published, about });
    const out = relatedHeadlines(dis(), [
      a("BD", "Floods hit Sylhet", "2026-10-19T00:00:00Z"),
      a("IN", "Bangladesh flood toll rises", "2026-10-20T00:00:00Z", ["BD"]),
      a("BD", "Cricket team wins", "2026-10-20T00:00:00Z"),
      a("TH", "Floods in Chiang Mai", "2026-10-20T00:00:00Z"),
    ]);
    expect(out.map((h) => h.title)).toEqual(["Bangladesh flood toll rises", "Floods hit Sylhet"]);
    expect(relatedHeadlines(dis({ countries: [] }), [])).toEqual([]);
  });
});

describe("places", () => {
  it("accepts any distance for a country-level disaster and a type limit otherwise", () => {
    expect(nearEnough(dis({ precision: "country" }), { lat: -40, lng: 170 })).toBe(true);
    expect(nearEnough(dis(), { lat: 24.8, lng: 91.8 })).toBe(true);
    expect(nearEnough(dis({ type: "volcano" }), { lat: 27, lng: 91.9 })).toBe(false);
  });

  it("geocodes research places, skipping misses, far-away namesakes and duplicates", async () => {
    const g = geocoder({ Sylhet: hit("Sylhet", 24.9, 91.87), Sunamganj: hit("Sunamganj", 25.07, 91.4), Far: hit("Far", 22.3, 114.2) });
    const out = await locatePlaces(g, dis(), [
      { name: "Sylhet", country: "BD", kind: "city", impact: "flooded" },
      { name: "Sylhet", country: "BD", kind: "city" },
      { name: "Missing", country: "BD", kind: "town" },
      { name: "Far", country: "BD", kind: "city" },
      { name: "Sunamganj", country: "BD", kind: "district" },
    ], "research");
    expect(out.map((l) => l.place.name)).toEqual(["Sylhet", "Sunamganj"]);
    expect(out[0].place).toMatchObject({ impact: "flooded", source: "research", country: "BD" });
    expect(out[0].area.kind).toBe("place");
    expect(g.geocode).toHaveBeenCalledWith("Sylhet", "BD", undefined, "city");
  });

  it("adds place areas only when the disaster has no footprint, and moves a country-level disaster to its places", () => {
    const located = [
      { place: { name: "Sylhet", country: "BD", lat: 24.9, lng: 91.87, kind: "city" as const, source: "research" as const }, area: { kind: "place" as const, geometry: circlePolygon(24.9, 91.87, 12) } },
      { place: { name: "Dhaka", country: "BD", lat: 23.8, lng: 90.4, kind: "city" as const, source: "research" as const }, area: { kind: "place" as const, geometry: circlePolygon(23.8, 90.4, 12) } },
    ];
    const bare = withPlaces(dis({ precision: "country", lat: 23.7, lng: 90.3 }), located);
    expect(bare.places.map((p) => p.name)).toEqual(["Sylhet", "Dhaka"]);
    expect(bare.areas).toHaveLength(2);
    expect(bare.precision).toBe("area");
    expect(bare.lat).toBeCloseTo(24.35, 2);
    const mapped = withPlaces(dis({ areas: [{ kind: "affected", geometry: circlePolygon(24.9, 91.9, 50) }] }), located);
    expect(mapped.areas).toHaveLength(1);
    expect(hasFootprint(mapped)).toBe(true);
    expect(withPlaces(dis(), [])).toEqual(dis());
    const many = Array.from({ length: 15 }, (_, i) => ({ ...located[0], place: { ...located[0].place, name: `P${i}` } }));
    expect(withPlaces(dis(), many).areas.length).toBeLessThanOrEqual(MAX_PLACE_AREAS);
  });
});

describe("research on a disaster", () => {
  it("takes the summary and its source, appends new figures and sources, and records the research", () => {
    const out = withResearch(dis(), entry());
    expect(out.summary).toBe("Flash floods hit Sylhet and Sunamganj.");
    expect(out.summarySource).toEqual({ name: "Floods in Sylhet", url: "https://www.thedailystar.net/a" });
    expect(out.figures.map((f) => f.label)).toEqual(["People affected", "Deaths"]);
    expect(out.sources.map((s) => s.url)).toEqual(["https://go.ifrc.org/emergencies/1", "https://www.thedailystar.net/a"]);
    expect(out.research).toEqual({ at: "2026-10-19T00:00:00.000Z", model: "claude-haiku-5-5", searches: 3, summary: true });
    const keep = withResearch(dis({ summary: "IFRC text" }), entry({ summary: "" }));
    expect(keep.summary).toBe("IFRC text");
  });

  it("drops a non-severe disaster only when newer research says it is over and no appeal is open", () => {
    const over = entry({ ongoing: false, at: "2026-10-19T00:00:00.000Z" });
    expect(researchSaysOver(dis(), over, NOW)).toBe(true);
    expect(researchSaysOver(dis({ severity: 3 }), over, NOW)).toBe(false);
    expect(researchSaysOver(dis({ updated: "2026-10-19T06:00:00.000Z" }), over, NOW)).toBe(false);
    expect(researchSaysOver(dis({ appeals: [{ code: "M", name: "n", kind: "DREF", requested: 1, funded: 0, url: "u", end: "2026-12-01T00:00:00.000Z" }] }), over, NOW)).toBe(false);
    expect(researchSaysOver(dis(), entry(), NOW)).toBe(false);
    expect(researchSaysOver(dis(), undefined, NOW)).toBe(false);
  });
});

describe("locateNewsEvents", () => {
  it("moves news events to their geocoded places and drops those with none", async () => {
    const base: SourceEvent = { source: "news", sourceId: "n1", type: "landslide", title: "Landslides in Nepal", severity: 1, countries: ["BD"], lat: 0, lng: 0, precision: "country", started: NOW, updated: NOW, areas: [], links: [] };
    const placed = { ...base, sourceId: "n0", lat: 10, lng: 10, precision: "area" as const };
    const g = geocoder({ Sylhet: hit("Sylhet", 24.9, 91.87) });
    const out = await locateNewsEvents(
      [
        { ...base, places: [{ name: "Sylhet", country: "BD", lat: 0, lng: 0, kind: "city", source: "news" }] },
        { ...base, sourceId: "n2", places: [{ name: "Nowhere", country: "BD", lat: 0, lng: 0, kind: "city", source: "news" }] },
        placed,
      ],
      g,
    );
    expect(out.map((e) => e.sourceId)).toEqual(["n1", "n0"]);
    expect(out[0]).toMatchObject({ lat: 24.9, lng: 91.87, precision: "area" });
    expect(out[0].places?.[0]).toMatchObject({ name: "Sylhet", source: "news" });
  });
});

describe("locateNewsEvents when the geocoder has to stop", () => {
  const base: SourceEvent = { source: "news", sourceId: "n1", type: "flood", title: "Floods in Sylhet", severity: 1, countries: ["BD"], lat: 0, lng: 0, precision: "country", started: NOW, updated: NOW, areas: [], links: [], places: [{ name: "Sunamganj", country: "BD", lat: 0, lng: 0, kind: "district", source: "news" }] };
  const before: SourceEvent = { ...base, lat: 25.07, lng: 91.4, precision: "area", places: [{ name: "Sunamganj", country: "BD", lat: 25.07, lng: 91.4, kind: "district", source: "news" }] };
  /** A geocoder that knows nothing and leaves every lookup for later, as when Nominatim is down. */
  const stopped = () => {
    let deferred = 0;
    return {
      geocode: vi.fn(async () => {
        deferred++;
        return null;
      }),
      lookups: 0,
      get deferred() {
        return deferred;
      },
    } as unknown as Geocoder;
  };

  it("keeps the previous run's places for the same event", async () => {
    const out = await locateNewsEvents([{ ...base, title: "Floods spread in Sylhet" }], stopped(), [before]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ title: "Floods spread in Sylhet", lat: 25.07, lng: 91.4, precision: "area" });
    expect(out[0].places?.[0].name).toBe("Sunamganj");
  });

  it("still drops an event the geocoder looked up and did not find", async () => {
    expect(await locateNewsEvents([base], geocoder({}), [before])).toEqual([]);
  });

  it("drops a new event it could not place", async () => {
    expect(await locateNewsEvents([{ ...base, sourceId: "n9" }], stopped(), [before])).toEqual([]);
  });
});

describe("withResearch summary credit", () => {
  it("credits research's own summary to the first page it cites, or to nobody", () => {
    const fed = dis({ summary: "IFRC's words.", summarySource: { name: "IFRC GO emergency", url: "https://go.ifrc.org/emergencies/1" } });
    const cited = withResearch(fed, entry());
    expect(cited.summarySource).toEqual({ name: "Floods in Sylhet", url: "https://www.thedailystar.net/a" });
    expect(cited.research?.summary).toBe(true);
    const uncited = withResearch(fed, entry({ sources: [] }));
    expect(uncited.summary).toBe("Flash floods hit Sylhet and Sunamganj.");
    expect(uncited.summarySource).toBeUndefined();
  });

  it("keeps the feed's summary and credit when research wrote none", () => {
    const fed = dis({ summary: "IFRC's words.", summarySource: { name: "IFRC GO emergency", url: "https://go.ifrc.org/emergencies/1" } });
    const out = withResearch(fed, entry({ summary: "" }));
    expect(out.summary).toBe("IFRC's words.");
    expect(out.summarySource?.name).toBe("IFRC GO emergency");
    expect(out.research?.summary).toBeUndefined();
  });
});

describe("cachePaths", () => {
  it("puts every cache under one folder, the usual one by default", () => {
    expect(cachePaths()).toEqual({
      snapshot: "cache/disaster-sources.json",
      attempts: "cache/research-attempts.json",
      registry: "cache/donation-registry.json",
      geocode: "cache/geocode.json",
      research: "cache/research.json",
      gofundme: "cache/gofundme.json",
    });
    expect(cachePaths("/tmp/x").research).toBe("/tmp/x/research.json");
  });
});

describe("significant disasters only", () => {
  it("keeps significant and severe disasters, never minor ones", () => {
    expect(MIN_SEVERITY).toBe(2);
    expect([1, 2, 3].map((severity) => isSignificant({ severity: severity as 1 | 2 | 3 }))).toEqual([false, true, true]);
  });

  it("keeps the previous map only when the run has no report at all and no feed answered", () => {
    // Every feed failed and no snapshot holds a report: an outage.
    expect(keepsPreviousMap(0, false, 5)).toBe(true);
    // Reports, if only minor ones, say what is happening: nothing significant.
    expect(keepsPreviousMap(12, false, 5)).toBe(false);
    // A feed answered with nothing ongoing.
    expect(keepsPreviousMap(0, true, 5)).toBe(false);
    // Nothing to keep.
    expect(keepsPreviousMap(0, false, 0)).toBe(false);
  });
});

describe("direct giving helpers", () => {
  it("keys a failed direct search apart from the research and the donation search", () => {
    expect(directAttemptKey("d1")).toBe("direct:d1");
    expect(new Set([directAttemptKey("d1"), donationAttemptKey("d1"), "d1"]).size).toBe(3);
  });

  it("takes the news hosts from the site's articles, not Google's or Bing's own links", () => {
    const a = (url: string) => ({ url });
    expect([...articleHosts([a("https://www.jamaica-gleaner.com/article/1"), a("https://news.google.com/rss/articles/x"), a("https://www.bing.com/news/apiclick"), a("nope"), a("https://radiojamaicanewsonline.com/x")])]).toEqual([
      "jamaica-gleaner.com",
      "radiojamaicanewsonline.com",
    ]);
  });

  it("reads each country's name in its press language, and none from a missing file", () => {
    const names = readPressNames();
    expect(names.AT).toBe("Österreich");
    expect(names.AF).toBe("افغانستان");
    expect(Object.keys(names).length).toBeGreaterThan(50);
    expect(readPressNames("/nonexistent/languages.json")).toEqual({});
  });

  it("reads each country's press language, and none from a missing file", () => {
    const langs = readPressLanguages();
    expect(langs.MA).toBe("fr");
    expect(langs.AE).toBe("ar");
    expect(langs.BR).toBe("pt");
    expect(readPressLanguages("/nonexistent/languages.json")).toEqual({});
  });
});

describe("updateDisasters", () => {
  const RESOLVE = buildResolver(loadGlobeFeatures());
  const COXS = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "research-coxs-bazar.json"), "utf8")) as { research: ResearchResult; parsed: ResearchParse };
  const ID = "ifrc-flood-8013";

  /** An IFRC operation in Bangladesh, active two days ago. */
  const ifrcEvent = (over: Partial<SourceEvent> = {}): SourceEvent => ({
    source: "ifrc",
    sourceId: "8013",
    type: "flood",
    title: "Bangladesh: Monsoon Depression in Cox's Bazar",
    severity: 2,
    countries: ["BD"],
    lat: 23.8,
    lng: 90.3,
    precision: "country",
    started: "2026-10-10T00:00:00.000Z",
    updated: "2026-10-18T00:00:00.000Z",
    areas: [],
    summary: "IFRC's own words.",
    links: [{ name: "IFRC GO emergency", url: "https://go.ifrc.org/emergencies/8013" }],
    ...over,
  });

  /** Fresh output and cache folders, optionally seeded. */
  function folders(
    seed: { snapshot?: Snapshots; previous?: DisastersFile; research?: Record<string, ResearchEntry>; registry?: DonationRegistry; attempts?: Record<string, string>; gofundme?: GoFundMeCache } = {},
  ) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gv-update-"));
    const outDir = path.join(root, "data");
    const cacheDir = path.join(root, "cache");
    fs.mkdirSync(outDir);
    fs.mkdirSync(cacheDir);
    if (seed.snapshot) fs.writeFileSync(path.join(cacheDir, "disaster-sources.json"), JSON.stringify(seed.snapshot));
    if (seed.previous) fs.writeFileSync(path.join(outDir, "disasters.json"), JSON.stringify(seed.previous));
    if (seed.research) fs.writeFileSync(path.join(cacheDir, "research.json"), JSON.stringify(seed.research));
    if (seed.registry) fs.writeFileSync(path.join(cacheDir, "donation-registry.json"), JSON.stringify(seed.registry));
    if (seed.attempts) fs.writeFileSync(path.join(cacheDir, "research-attempts.json"), JSON.stringify(seed.attempts));
    if (seed.gofundme) fs.writeFileSync(path.join(cacheDir, "gofundme.json"), JSON.stringify(seed.gofundme));
    return { outDir, cacheDir };
  }

  /** A registry from an earlier run that knows the Bangladesh Red Crescent's site. */
  const REGISTRY: DonationRegistry = {
    ...emptyRegistry(),
    updated: NOW,
    fetched: { societies: NOW, uncr: null },
    societies: { BD: { name: "Bangladesh Red Crescent Society", country: "Bangladesh", url: "https://bdrcs.org/", directory: null, hosts: ["bdrcs.org"], donate: null, checked: NOW } },
  };
  /** A page about the Cox's Bazar floods on the society's site, as the donation search finds it. */
  const EVENT_PAGE = "https://bdrcs.org/donate/coxs-bazar-floods-2026";
  const DONATION_RESEARCH: ResearchResult = {
    text: `Bangladesh Red Crescent Society: Cox's Bazar flood appeal, ${EVENT_PAGE} (for this event).`,
    citations: [{ url: EVENT_PAGE, title: "Cox's Bazar flood appeal", citedText: "donate to the Cox's Bazar flood response" }],
    results: [{ url: EVENT_PAGE, title: "Cox's Bazar flood appeal" }],
    searches: 2,
    okSearches: 2,
  };
  const DONATION_PARSED: DonationSearchParse = {
    pages: [{ url: EVENT_PAGE, org: "Bangladesh Red Crescent Society", kind: "society", note: "Cox's Bazar flood appeal", specific: true }],
  };

  /** A run where every network request fails. */
  function runWith(dirs: { outDir: string; cacheDir: string }, over: Partial<DisasterRun> = {}): DisasterRun {
    return {
      ...dirs,
      now: NOW,
      deps: { fetch: vi.fn(async () => Promise.reject(new Error("network down"))) as unknown as typeof fetch, sleep: vi.fn(async () => {}), log: () => {} },
      ai: null,
      ledger: emptyLedger(),
      budget: { ...DEFAULT_BUDGET },
      articles: [],
      resolve: RESOLVE,
      shapes: [],
      globeCodes: new Set(["BD"]),
      countryNames: { BD: "Bangladesh" },
      log: () => {},
      ...over,
    };
  }

  const read = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, "disasters.json"), "utf8")) as DisastersFile;

  it("rebuilds offline from the cached reports and research, without the network", async () => {
    const dirs = folders({ snapshot: { ifrc: { fetched: "2026-10-20T09:00:00.000Z", events: [ifrcEvent()] } }, research: { [ID]: entry({ sources: [] }) } });
    const run = runWith(dirs, { offline: true });
    const file = await updateDisasters(run);
    expect(run.deps.fetch).not.toHaveBeenCalled();
    expect(file.fetched.ifrc).toBe("2026-10-20T09:00:00.000Z");
    expect(read(dirs.outDir).disasters.map((d) => d.id)).toEqual([ID]);
    const d = file.disasters[0];
    // Research's summary, credited to nobody since it cites no page.
    expect(d.summary).toBe("Flash floods hit Sylhet and Sunamganj.");
    expect(d.summarySource).toBeUndefined();
    expect(d.research?.summary).toBe(true);
    // The global fallbacks are always there.
    expect(d.donate.map((l) => l.org)).toEqual(expect.arrayContaining(["UN Crisis Relief", "IFRC"]));
    // Offline runs leave the feed snapshot alone.
    expect(JSON.parse(fs.readFileSync(path.join(dirs.cacheDir, "disaster-sources.json"), "utf8")).ifrc.fetched).toBe("2026-10-20T09:00:00.000Z");
  });

  it("rebuilds donation lists from cached verdicts with the rules on the disaster's countries (live run 39617028266)", async () => {
    // The Venezuela earthquake's donation search found IFRC's campaign for it, another
    // quake's campaign and a Syria appeal; each passed a live check in an earlier run.
    const campaign = "https://donate.redcrossredcrescent.org/ifrc/venezuela-earthquake/~mi-donativo?_cv=1";
    const colombia = "https://donate.redcrossredcrescent.org/ifrc/colombia-earthquake/";
    const syria = "https://www.ifrc.org/appeals?ac=MDRSY003";
    const pages = [campaign, colombia, syria].map((url) => ({ url, org: "IFRC", kind: "society" as const, note: "Earthquake appeal", specific: true }));
    const quake = ifrcEvent({ sourceId: "7990", type: "earthquake", title: "Venezuela Earthquake", countries: ["VE"], lat: 10.5, lng: -66.9 });
    const passed = (url: string) => ({ ok: true, reason: "donation word", checked: NOW, chain: [url] });
    const registry: DonationRegistry = { ...emptyRegistry(), verdicts: Object.fromEntries([campaign, colombia, syria].map((u) => [urlKey(u), passed(u)])) };
    const dirs = folders({ snapshot: { ifrc: { fetched: "2026-10-20T09:00:00.000Z", events: [quake] } }, research: { "ifrc-earthquake-7990": entry({ donation: pages }) }, registry });
    const file = await updateDisasters(runWith(dirs, { offline: true, globeCodes: new Set(["VE", "CO"]), countryNames: { VE: "Venezuela", CO: "Colombia" } }));
    const urls = file.disasters[0].donate.map((l) => l.url);
    expect(file.disasters[0].donate[0]).toMatchObject({ url: campaign, org: "IFRC", kind: "agency", via: "research", forEvent: true });
    expect(urls).not.toContain(colombia);
    expect(urls).not.toContain(syria);
  });

  it("tells land from sea with the run's finer shapes, when it has them", async () => {
    // Spain's flood over Ibiza and Formentera: the coarse shapes have neither island.
    const spain = (JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "sea-parts.json"), "utf8")) as { spain: { lat: number; lng: number; areas: Disaster["areas"] } }).spain;
    const event = ifrcEvent({ title: "Spain: Floods", countries: ["ES"], lat: spain.lat, lng: spain.lng, precision: "area", areas: spain.areas });
    const snapshot: Snapshots = { ifrc: { fetched: "2026-10-20T09:00:00.000Z", events: [event] } };
    const parts = (file: DisastersFile) => file.disasters[0].areas.map((a) => (a.geometry.type === "Polygon" ? 1 : a.geometry.coordinates.length));
    const shapes = loadCountryShapes();
    expect(parts(await updateDisasters(runWith(folders({ snapshot }), { offline: true, shapes })))).toEqual([1]);
    expect(parts(await updateDisasters(runWith(folders({ snapshot }), { offline: true, shapes, landShapes: loadCountryShapes(LAND_SHAPES_PATH) })))).toEqual([2]);
  });

  it("keeps a failed feed's previous reports", async () => {
    const dirs = folders({ snapshot: { ifrc: { fetched: "2026-10-20T09:00:00.000Z", events: [ifrcEvent()] } } });
    const run = runWith(dirs);
    const file = await updateDisasters(run);
    expect(run.deps.fetch).toHaveBeenCalled();
    expect(file.disasters.map((d) => d.id)).toEqual([ID]);
    expect(file.fetched.ifrc).toBe("2026-10-20T09:00:00.000Z");
    expect(file.fetched.gdacs).toBeNull();
  });

  it("keeps the previous map's ongoing disasters rather than write an empty one, and still saves the geocoder's answers", async () => {
    // A flood seen two days ago is still ongoing; one last seen in August is over; a minor one an older file listed goes.
    const over = dis({ id: "ifrc-flood-1", severity: 2, started: "2026-08-01T00:00:00.000Z", updated: "2026-08-10T00:00:00.000Z" });
    const minor = dis({ id: "ifrc-flood-2", severity: 1 });
    const previous: DisastersFile = { updated: "2026-10-20T09:00:00.000Z", fetched: { gdacs: null, usgs: null, eonet: null, ifrc: null, news: null }, disasters: [dis({ id: ID, severity: 2 }), over, minor] };
    const dirs = folders({ previous });
    // A news disaster whose place Nominatim does not know: the answer is cached.
    const articles = ["Daily Star", "Prothom Alo", "bdnews24"].map((outlet, i) => ({ country: "BD", title: `Floods hit Sunamganj ${i}`, en: `Floods hit Sunamganj ${i}`, outlet, url: `https://x.example/${i}`, published: NOW }));
    const ai = {
      calls: 0,
      webResearch: vi.fn(async () => null),
      parse: vi.fn(async () => ({
        events: [{ type: "flood", title: "Floods in Sunamganj", country: "BD", countryName: "Bangladesh", places: [{ name: "Sunamganj", admin: "Sylhet", kind: "district", impact: "flooded" }], headlineIds: [0, 1, 2], ongoing: true }],
      })),
    } as unknown as AiClient;
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("nominatim")) return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      throw new Error("network down");
    });
    const run = runWith(dirs, { ai, articles, deps: { fetch: fetchMock as unknown as typeof fetch, sleep: vi.fn(async () => {}), log: () => {} } });
    const file = await updateDisasters(run);
    expect(file.disasters.map((d) => d.id)).toEqual([ID]);
    expect(read(dirs.outDir).disasters.map((d) => d.id)).toEqual([ID]);
    expect(ai.parse).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("nominatim"))).toBe(true);
    const geocodes = JSON.parse(fs.readFileSync(path.join(dirs.cacheDir, "geocode.json"), "utf8")) as Record<string, unknown>;
    expect(Object.keys(geocodes).length).toBeGreaterThan(0);
  });

  it("writes an empty map when the feeds answered and nothing is ongoing", async () => {
    const previous: DisastersFile = { updated: "2026-10-20T09:00:00.000Z", fetched: { gdacs: null, usgs: null, eonet: null, ifrc: null, news: null }, disasters: [dis({ id: ID, updated: "2026-08-01T00:00:00.000Z", started: "2026-07-01T00:00:00.000Z" })] };
    const dirs = folders({ previous });
    const file = await updateDisasters(runWith(dirs, { offline: true }));
    expect(file.disasters).toEqual([]);
  });

  it("writes an empty map, not the previous one, when the reports hold only minor disasters", async () => {
    // A significant flood on the last map; this run every feed failed, and the snapshot's last reports are all minor.
    const previous: DisastersFile = { updated: "2026-10-20T09:00:00.000Z", fetched: { gdacs: null, usgs: null, eonet: null, ifrc: null, news: null }, disasters: [dis({ id: ID, severity: 2 })] };
    const dirs = folders({ previous, snapshot: { ifrc: { fetched: "2026-10-20T09:00:00.000Z", events: [ifrcEvent({ severity: 1 })] } } });
    expect((await updateDisasters(runWith(dirs))).disasters).toEqual([]);
    expect(read(dirs.outDir).disasters).toEqual([]);
  });

  it("leaves minor disasters off the map and unresearched, but keeps their reports for when they grow", async () => {
    const dirs = folders({ snapshot: { ifrc: { fetched: "2026-10-20T09:00:00.000Z", events: [ifrcEvent({ severity: 1 }), ifrcEvent({ sourceId: "8014", title: "Bangladesh: Floods", severity: 2 })] } } });
    const ledger = emptyLedger();
    const { ai, webResearch } = recordingAi(ledger);
    const file = await updateDisasters(runWith(dirs, { ai, ledger }));
    expect(file.disasters.map((d) => d.id)).toEqual(["ifrc-flood-8014"]);
    expect(webResearch.mock.calls.every(([opts]) => opts.user.includes("Bangladesh: Floods"))).toBe(true);
    expect(Object.keys(readCache(dirs.cacheDir))).toEqual(["ifrc-flood-8014"]);
    const snapshot = JSON.parse(fs.readFileSync(path.join(dirs.cacheDir, "disaster-sources.json"), "utf8")) as Snapshots;
    expect(snapshot.ifrc?.events.map((e) => e.sourceId)).toEqual(["8013", "8014"]);
  });

  /** A direct search that worked and found nothing. */
  const NO_DIRECT = { research: { text: "Direct pages: none found", citations: [], results: [], searches: 1, okSearches: 1 }, parsed: { pages: [] } };

  /** True for the direct search's call: its own system prompt, on the whole web. */
  const isDirect = (opts: WebResearchOptions) => opts.system.startsWith(directSearchSystemPrompt(NOW).split("\n")[0]);

  /**
   * A model client that records its usage in the ledger the way
   * pipeline/update.ts does. A search limited to allowed domains is the
   * donation search, one with the direct search's prompt the direct
   * search; their answers can be replaced (null for a failed call), and so
   * can the research's parsed notes.
   */
  function recordingAi(
    ledger: Ledger,
    donation: { research: ResearchResult | null; parsed: DonationSearchParse | null } = { research: DONATION_RESEARCH, parsed: DONATION_PARSED },
    researched: ResearchParse = COXS.parsed,
    direct: { research: ResearchResult | null; parsed: DirectSearchParse | null } = NO_DIRECT,
  ) {
    const spend = (u: Partial<Usage>) => record(ledger, "research", { model: "claude-haiku-5-5", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0, ...u }, NOW);
    const webResearch = vi.fn(async (opts: WebResearchOptions) => {
      if (opts.allowedDomains) {
        spend({ inputTokens: 8_000, outputTokens: 600, webSearches: 2 });
        return donation.research;
      }
      if (isDirect(opts)) {
        spend({ inputTokens: 8_000, outputTokens: 600, webSearches: 2 });
        return direct.research;
      }
      spend({ inputTokens: 30_000, outputTokens: 1_500, webSearches: 4 });
      return COXS.research;
    });
    const parse = vi.fn(async (opts: { schema: unknown }) => {
      spend({ inputTokens: 4_000, outputTokens: 1_000 });
      return opts.schema === donationSearchSchema ? donation.parsed : opts.schema === directSearchSchema ? direct.parsed : researched;
    });
    return { ai: { webResearch, parse, calls: 0 } as unknown as AiClient, webResearch, parse };
  }

  /** The calls of each kind a recording client got. */
  const callsOf = (webResearch: ReturnType<typeof recordingAi>["webResearch"]) => {
    const all = webResearch.mock.calls.map(([opts]) => opts);
    return { donation: all.filter((o) => o.allowedDomains), direct: all.filter(isDirect), research: all.filter((o) => !o.allowedDomains && !isDirect(o)) };
  };

  const readCache = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, "research.json"), "utf8")) as Record<string, ResearchEntry>;

  it("researches within the budget, then searches official sites for the event's donation pages and the web for direct ones, counting one research", async () => {
    const dirs = folders({ snapshot: { ifrc: { fetched: "2026-10-20T09:00:00.000Z", events: [ifrcEvent()] } } });
    const ledger = emptyLedger();
    const { ai, webResearch, parse } = recordingAi(ledger);
    const file = await updateDisasters(runWith(dirs, { ai, ledger }));
    expect(webResearch).toHaveBeenCalledTimes(3);
    expect(webResearch.mock.calls[0][0].allowedDomains).toBeUndefined();
    // No registry yet: the official sites that need none.
    expect(webResearch.mock.calls[1][0].allowedDomains).toEqual(searchDomains(["BD"], emptyRegistry()));
    expect(webResearch.mock.calls[1][0]).toMatchObject({ maxSearches: 3, purpose: "research" });
    // The direct search, on the whole web.
    expect(isDirect(webResearch.mock.calls[2][0])).toBe(true);
    expect(webResearch.mock.calls[2][0]).toMatchObject({ maxSearches: 3, purpose: "research" });
    expect(webResearch.mock.calls[2][0].allowedDomains).toBeUndefined();
    // It found nothing, so it needed no parse.
    expect(parse).toHaveBeenCalledTimes(2);
    const month = ledger.months["2026-10"];
    expect(month.researchCalls).toBe(5);
    // The donation and direct searches are part of the same research for the cost average.
    expect(month.researches).toBe(1);
    const cached = readCache(dirs.cacheDir);
    expect(Object.keys(cached)).toEqual([ID]);
    expect(cached[ID].donationSearched).toBe(NOW);
    expect(cached[ID].directSearched).toBe(NOW);
    expect(cached[ID].donation[0]).toEqual({ url: EVENT_PAGE, org: "Bangladesh Red Crescent Society", kind: "society", note: "Cox's Bazar flood appeal", specific: true });
    const d = file.disasters[0];
    expect(d.research?.searches).toBe(COXS.research.searches);
    expect(d.summary).toBe(cached[ID].summary);
    // The page is not on this disaster's allowlist without the society in the registry, so it is not shown.
    expect(d.donate.map((l) => l.url)).not.toContain(EVENT_PAGE);
  });

  it("shows a checked page about the event first, taking the society's site from the cached registry", async () => {
    const dirs = folders({ snapshot: { ifrc: { fetched: "2026-10-20T09:00:00.000Z", events: [ifrcEvent()] } }, registry: REGISTRY });
    const ledger = emptyLedger();
    const { ai, webResearch } = recordingAi(ledger);
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === EVENT_PAGE) return new Response("<h1>Cox's Bazar floods</h1><a>Donate now</a>", { status: 200, headers: { "content-type": "text/html" } });
      throw new Error("network down");
    });
    const file = await updateDisasters(runWith(dirs, { ai, ledger, deps: { fetch: fetchMock as unknown as typeof fetch, sleep: vi.fn(async () => {}), log: () => {} } }));
    expect(webResearch.mock.calls[1][0].allowedDomains?.[0]).toBe("bdrcs.org");
    expect(fetchMock.mock.calls.some(([u]) => String(u) === EVENT_PAGE)).toBe(true);
    const [first] = file.disasters[0].donate;
    expect(first).toMatchObject({ url: EVENT_PAGE, org: "Bangladesh Red Crescent Society", via: "research", forEvent: true });
    // The general fallbacks are still there.
    expect(file.disasters[0].donate.map((l) => l.org)).toEqual(expect.arrayContaining(["UN Crisis Relief", "IFRC"]));
  });

  it("lists the direct search's GlobalGiving project and live-checked local page before the official links", async () => {
    const GG = "https://www.globalgiving.org/projects/bangladesh-flood-relief-2026/";
    const LOCAL = "https://www.coxsbazar-youth.org.bd/flood-relief/donate";
    const NEWS = "https://www.thedailystar.net/news/how-to-help-flood-victims";
    const found: ResearchResult = {
      text: `GlobalGiving: ${GG}. Cox's Bazar Youth Forum: ${LOCAL}. The Daily Star: ${NEWS}.`,
      citations: [],
      results: [
        { url: GG, title: "Bangladesh Flood Relief 2026 - GlobalGiving" },
        { url: LOCAL, title: "Donate | Cox's Bazar Youth Forum" },
        { url: NEWS, title: "How to help" },
      ],
      searches: 2,
      okSearches: 2,
    };
    const parsed: DirectSearchParse = {
      pages: [
        { url: GG, org: "GlobalGiving", kind: "globalgiving", note: "Flood relief" },
        { url: LOCAL, org: "Cox's Bazar Youth Forum", kind: "local", note: "Food and shelter for flooded families" },
        { url: NEWS, org: "The Daily Star", kind: "local", note: "" },
      ],
    };
    const dirs = folders({ snapshot: { ifrc: { fetched: "2026-10-20T09:00:00.000Z", events: [ifrcEvent()] } } });
    const ledger = emptyLedger();
    const { ai } = recordingAi(ledger, undefined, undefined, { research: found, parsed });
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === LOCAL) {
        const page = `<title>Flood relief | Cox's Bazar Youth Forum</title><meta property="og:site_name" content="Cox's Bazar Youth Forum"><h1>Cox's Bazar flood relief</h1><a>Donate now</a>`;
        return new Response(page, { status: 200, headers: { "content-type": "text/html" } });
      }
      throw new Error("network down");
    });
    // The site's own articles make the Daily Star a news site.
    const articles = [{ country: "BD", title: "Floods", outlet: "The Daily Star", url: "https://www.thedailystar.net/news/floods", published: NOW }];
    const file = await updateDisasters(
      runWith(dirs, { ai, ledger, articles, countryNames: { BD: "Bangladesh" }, deps: { fetch: fetchMock as unknown as typeof fetch, sleep: vi.fn(async () => {}), log: () => {} } }),
    );
    const donate = file.disasters[0].donate;
    expect(donate.slice(0, 2)).toEqual([
      { label: "Bangladesh Flood Relief 2026", url: GG, org: "GlobalGiving", kind: "project", note: "GlobalGiving vets its local partners", via: "research", forEvent: true },
      {
        // The page's own name and title, never the model's.
        label: "Flood relief",
        url: LOCAL,
        org: "Cox's Bazar Youth Forum",
        kind: "local",
        note: "A local group's own page. Global View checked it is live and names Cox's Bazar, but cannot vouch for the group.",
        via: "research",
        forEvent: true,
      },
    ]);
    expect(donate.map((l) => l.url)).not.toContain(NEWS);
    expect(fetchMock.mock.calls.some(([u]) => String(u) === NEWS || String(u) === GG)).toBe(false);
    // The verdict is cached with the registry's, for this disaster.
    const registry = JSON.parse(fs.readFileSync(path.join(dirs.cacheDir, "donation-registry.json"), "utf8")) as DonationRegistry;
    expect(registry.verdicts[localVerdictKey(ID, LOCAL)]).toMatchObject({ ok: true, place: "Cox's Bazar" });
  });

  it("matches a local group's page written only in Bengali by the place's own name from the geocoder's cache", async () => {
    const LOCAL = "https://www.coxsbazar-youth.org.bd/bonna";
    const found: ResearchResult = { text: `Cox's Bazar Youth Forum: ${LOCAL}.`, citations: [], results: [{ url: LOCAL, title: "" }], searches: 1, okSearches: 1 };
    const parsed: DirectSearchParse = { pages: [{ url: LOCAL, org: "Cox's Bazar Youth Forum", kind: "local", note: "" }] };
    // IFRC names Cox's Bazar; the geocoder's cache holds its own name, as Nominatim's namedetails give it.
    const coxs = { name: "Cox's Bazar", country: "BD", lat: 21.45, lng: 91.97, kind: "district" as const, source: "ifrc" as const };
    const dirs = folders({ snapshot: { ifrc: { fetched: "2026-10-20T09:00:00.000Z", events: [ifrcEvent({ places: [coxs] })] } } });
    const cached = { name: "Cox's Bazar", displayName: "Cox's Bazar, Chattogram Division, Bangladesh", lat: 21.45, lng: 91.97, kind: "district", country: "BD", bbox: [91.9, 21.4, 92.0, 21.5], local: ["কক্সবাজার জেলা"] };
    fs.writeFileSync(path.join(dirs.cacheDir, "geocode.json"), JSON.stringify({ "BD|cox s bazar||district": { hit: cached, at: NOW } }));
    const ledger = emptyLedger();
    const { ai } = recordingAi(ledger, undefined, undefined, { research: found, parsed });
    const page = `<title>বন্যার্তদের জন্য দান করুন | কক্সবাজার যুব ফোরাম</title><meta property="og:site_name" content="কক্সবাজার যুব ফোরাম"><h1>কক্সবাজারে বন্যা</h1><p>কক্সবাজার জেলার বন্যার্ত পরিবারের জন্য দান করুন</p>`;
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === LOCAL) return new Response(page, { status: 200, headers: { "content-type": "text/html" } });
      throw new Error("network down");
    });
    const file = await updateDisasters(runWith(dirs, { ai, ledger, countryNames: { BD: "Bangladesh" }, deps: { fetch: fetchMock as unknown as typeof fetch, sleep: vi.fn(async () => {}), log: () => {} } }));
    expect(file.disasters[0].donate.find((l) => l.kind === "local")).toMatchObject({ url: LOCAL, org: "কক্সবাজার যুব ফোরাম", label: "বন্যার্তদের জন্য দান করুন" });
    const registry = JSON.parse(fs.readFileSync(path.join(dirs.cacheDir, "donation-registry.json"), "utf8")) as DonationRegistry;
    expect(registry.verdicts[localVerdictKey(ID, LOCAL)]).toMatchObject({ ok: true, place: "কক্সবাজার" });
  });

  it("tries a failed direct search again only after a day, keeping the research and the donation search", async () => {
    const dirs = folders({ snapshot: { ifrc: { fetched: "2026-10-20T09:00:00.000Z", events: [ifrcEvent()] } } });
    const ledger = emptyLedger();
    const failing = recordingAi(ledger, undefined, undefined, { research: null, parsed: null });
    await updateDisasters(runWith(dirs, { ai: failing.ai, ledger }));
    expect(callsOf(failing.webResearch).direct).toHaveLength(1);
    const cached = readCache(dirs.cacheDir)[ID];
    expect(cached.donationSearched).toBe(NOW);
    expect(cached.directSearched).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path.join(dirs.cacheDir, "research-attempts.json"), "utf8"))).toEqual({ [directAttemptKey(ID)]: NOW });
    const again = recordingAi(ledger);
    await updateDisasters(runWith(dirs, { ai: again.ai, ledger }));
    expect(again.webResearch).not.toHaveBeenCalled();
    const later = recordingAi(ledger);
    await updateDisasters(runWith(dirs, { ai: later.ai, ledger, now: "2026-10-21T12:30:00.000Z" }));
    const calls = callsOf(later.webResearch);
    expect([calls.research.length, calls.donation.length, calls.direct.length]).toEqual([0, 0, 1]);
    expect(readCache(dirs.cacheDir)[ID].directSearched).toBe("2026-10-21T12:30:00.000Z");
  });

  it("lists GoFundMe's verified page for a matching disaster from its cache when offline, without a key", async () => {
    const pages = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "gofundme-pages.json"), "utf8")) as { hubs: Record<string, string>; feed: { funds: unknown } };
    const quake = ifrcEvent({ sourceId: "7990", type: "earthquake", title: "Venezuela Earthquake", countries: ["VE"], lat: 10.5, lng: -66.9 });
    const gofundme: GoFundMeCache = {
      index: { fetched: NOW, slugs: ["venezuela-earthquake-relief"] },
      hubs: {
        "venezuela-earthquake-relief": {
          slug: "venezuela-earthquake-relief",
          ...parseHub(pages.hubs["venezuela-earthquake-relief"]),
          // As if GoFundMe had opened the page the day after this quake began.
          published: "2026-10-11T00:00:00.000Z",
          fundraisers: parseFeed(pages.feed.funds),
          fetched: NOW,
          feedFetched: NOW,
          seen: NOW,
          failure: null,
        },
      },
    };
    const dirs = folders({ snapshot: { ifrc: { fetched: "2026-10-20T09:00:00.000Z", events: [quake] } }, gofundme });
    const run = runWith(dirs, { offline: true, globeCodes: new Set(["VE", "CO"]), countryNames: { VE: "Venezuela", CO: "Colombia" } });
    const file = await updateDisasters(run);
    expect(run.deps.fetch).not.toHaveBeenCalled();
    const donate = file.disasters[0].donate;
    expect(donate.slice(0, 4).map((l) => [l.kind, l.via, l.url])).toEqual([
      ["fundraiser", "platform", "https://www.gofundme.com/c/act/venezuela-earthquake-relief"],
      ["fundraiser", "platform", "https://www.gofundme.com/f/emergency-relief-for-venezuela-earthquake-victims"],
      ["project", "platform", "https://give.allhandsandhearts.org/campaign/815562/donate?c_src=Venezuela_earthquake"],
      ["project", "platform", "https://give.mercychefs.com/campaign/815706/donate?c_src=Venezuela_earthquake"],
    ]);
    expect(donate[0]).toMatchObject({ label: "Verified fundraisers for Venezuela earthquakes", note: "Verified by GoFundMe's Trust & Safety team", forEvent: true });
    // The official links follow, as before.
    expect(donate.slice(4).map((l) => l.org)).toEqual(expect.arrayContaining(["UN Crisis Relief", "IFRC"]));
  });

  it("reads GoFundMe's pages on a run without a key, and saves them", async () => {
    const pages = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "gofundme-pages.json"), "utf8")) as { index: string; hubs: Record<string, string>; feed: { funds: unknown } };
    // Two days before GoFundMe published its page for the Venezuela earthquakes.
    const quake = ifrcEvent({ sourceId: "7990", type: "earthquake", title: "Venezuela Earthquake", countries: ["VE"], lat: 10.5, lng: -66.9, started: "2026-06-24T00:00:00.000Z" });
    const dirs = folders({ snapshot: { ifrc: { fetched: "2026-10-20T09:00:00.000Z", events: [quake] } } });
    const fetchMock = vi.fn(async (u: string | URL | Request) => {
      const url = String(u);
      const html = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/html" } });
      if (url === GOFUNDME_INDEX) return html(pages.index);
      const slug = hubSlugOf(url);
      if (slug && pages.hubs[slug]) return html(pages.hubs[slug]);
      if (url.startsWith(GOFUNDME_FEED)) return new Response(JSON.stringify(pages.feed.funds), { status: 200, headers: { "content-type": "application/json" } });
      throw new Error("network down");
    });
    const file = await updateDisasters(runWith(dirs, { ai: null, globeCodes: new Set(["VE"]), countryNames: { VE: "Venezuela", CO: "Colombia" }, deps: { fetch: fetchMock as unknown as typeof fetch, sleep: vi.fn(async () => {}), log: () => {} } }));
    expect(file.disasters[0].donate[0]).toMatchObject({ kind: "fundraiser", url: "https://www.gofundme.com/c/act/venezuela-earthquake-relief" });
    const saved = JSON.parse(fs.readFileSync(path.join(dirs.cacheDir, "gofundme.json"), "utf8")) as GoFundMeCache;
    expect(saved.index.fetched).toBe(NOW);
    expect(saved.hubs["venezuela-earthquake-relief"].feedFetched).toBe(NOW);
  });

  /** Seven IFRC operations in Bangladesh, each with a fresh research entry from before the donation search. */
  function researchedEarlier() {
    const events = Array.from({ length: 7 }, (_, i) => ifrcEvent({ sourceId: String(9000 + i), title: `Bangladesh: Floods ${i}`, updated: `2026-10-${String(11 + i).padStart(2, "0")}T00:00:00.000Z` }));
    const research = Object.fromEntries(
      events.map((e) => [`ifrc-flood-${e.sourceId}`, entry({ at: "2026-10-20T10:00:00.000Z", membersHash: membersHash({ members: [`ifrc:${e.sourceId}`], reportedBy: ["ifrc"], countries: ["BD"] }) })]),
    );
    return { events, research };
  }

  it("backfills the donation and direct searches for at most six disasters researched earlier, newest first, without counting a research", async () => {
    const { events, research } = researchedEarlier();
    const dirs = folders({ snapshot: { ifrc: { fetched: "2026-10-20T09:00:00.000Z", events } }, research, registry: REGISTRY });
    const ledger = emptyLedger();
    const { ai, webResearch, parse } = recordingAi(ledger);
    await updateDisasters(runWith(dirs, { ai, ledger }));
    const calls = callsOf(webResearch);
    expect([calls.research.length, calls.donation.length, calls.direct.length]).toEqual([0, MAX_DONATION_BACKFILL, MAX_DONATION_BACKFILL]);
    expect(calls.donation.every((opts) => opts.allowedDomains?.includes("bdrcs.org"))).toBe(true);
    // The direct searches found nothing and needed no parse.
    expect(parse).toHaveBeenCalledTimes(MAX_DONATION_BACKFILL);
    const cached = readCache(dirs.cacheDir);
    expect(Object.keys(cached).filter((id) => cached[id].donationSearched === NOW)).toHaveLength(MAX_DONATION_BACKFILL);
    expect(Object.keys(cached).filter((id) => cached[id].directSearched === NOW)).toHaveLength(MAX_DONATION_BACKFILL);
    // The oldest is left for the next run.
    expect(cached["ifrc-flood-9000"].donationSearched).toBeUndefined();
    expect(cached["ifrc-flood-9000"].directSearched).toBeUndefined();
    // The research itself is kept, with the event's page added first.
    expect(cached["ifrc-flood-9006"].summary).toBe(research["ifrc-flood-9006"].summary);
    expect(cached["ifrc-flood-9006"].donation[0].url).toBe(EVENT_PAGE);
    const month = ledger.months["2026-10"];
    expect(month.researchCalls).toBe(3 * MAX_DONATION_BACKFILL);
    expect(month.researches).toBe(0);
  });

  it("backfills only the search an entry lacks", async () => {
    const { events, research } = researchedEarlier();
    const searched = Object.fromEntries(Object.entries(research).map(([id, e]) => [id, { ...e, donationSearched: "2026-10-20T10:00:00.000Z" }]));
    const dirs = folders({ snapshot: { ifrc: { fetched: "2026-10-20T09:00:00.000Z", events } }, research: searched, registry: REGISTRY });
    const { ai, webResearch } = recordingAi(emptyLedger());
    await updateDisasters(runWith(dirs, { ai }));
    const calls = callsOf(webResearch);
    expect([calls.donation.length, calls.direct.length]).toEqual([0, MAX_DONATION_BACKFILL]);
  });

  it("starts no backfill once the run's deadline has passed", async () => {
    const { events, research } = researchedEarlier();
    const dirs = folders({ snapshot: { ifrc: { fetched: "2026-10-20T09:00:00.000Z", events } }, research });
    const ledger = emptyLedger();
    const { ai, webResearch } = recordingAi(ledger);
    await updateDisasters(runWith(dirs, { ai, ledger, deadline: 0 }));
    expect(webResearch).not.toHaveBeenCalled();
  });

  it("keeps the research when its donation search fails, and tries the search again only after a day", async () => {
    const dirs = folders({ snapshot: { ifrc: { fetched: "2026-10-20T09:00:00.000Z", events: [ifrcEvent()] } } });
    const ledger = emptyLedger();
    const failing = recordingAi(ledger, { research: null, parsed: null });
    await updateDisasters(runWith(dirs, { ai: failing.ai, ledger }));
    // The research, its donation search and its direct search, which worked.
    expect(failing.webResearch).toHaveBeenCalledTimes(3);
    expect(readCache(dirs.cacheDir)[ID].at).toBe(NOW);
    expect(readCache(dirs.cacheDir)[ID].donationSearched).toBeUndefined();
    expect(readCache(dirs.cacheDir)[ID].directSearched).toBe(NOW);
    const attempts = JSON.parse(fs.readFileSync(path.join(dirs.cacheDir, "research-attempts.json"), "utf8")) as Record<string, string>;
    expect(attempts).toEqual({ [donationAttemptKey(ID)]: NOW });
    // The next run in the same hour: the entry is fresh and the failed search waits.
    const again = recordingAi(ledger);
    await updateDisasters(runWith(dirs, { ai: again.ai, ledger }));
    expect(again.webResearch).not.toHaveBeenCalled();
    // A day later the backfill tries it again.
    const later = recordingAi(ledger);
    await updateDisasters(runWith(dirs, { ai: later.ai, ledger, now: "2026-10-21T12:30:00.000Z" }));
    expect(later.webResearch.mock.calls.some(([opts]) => opts.allowedDomains)).toBe(true);
  });

  it("keeps the pages an earlier donation search found when a re-research's search fails, until a new search works", async () => {
    // Older than the 48 hours a significant disaster's research lasts; its donation search found an event page.
    const OLD_PAGE = "https://bdrcs.org/donate/monsoon-appeal-2026";
    const oldPage = { url: OLD_PAGE, org: "Bangladesh Red Crescent Society", kind: "society" as const, note: "Monsoon appeal", specific: true };
    const earlier = entry({ at: "2026-10-18T00:00:00.000Z", donationSearched: "2026-10-18T00:00:00.000Z", donation: [oldPage] });
    const dirs = folders({ snapshot: { ifrc: { fetched: "2026-10-20T09:00:00.000Z", events: [ifrcEvent()] } }, research: { [ID]: earlier }, registry: REGISTRY });
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === OLD_PAGE || String(url) === EVENT_PAGE) return new Response("<h1>Floods appeal</h1><a>Donate now</a>", { status: 200, headers: { "content-type": "text/html" } });
      throw new Error("network down");
    });
    const deps = { fetch: fetchMock as unknown as typeof fetch, sleep: vi.fn(async () => {}), log: () => {} };
    const ledger = emptyLedger();
    const failing = recordingAi(ledger, { research: null, parsed: null });
    const file = await updateDisasters(runWith(dirs, { ai: failing.ai, ledger, deps }));
    expect(callsOf(failing.webResearch).donation).toHaveLength(1);
    const cached = readCache(dirs.cacheDir)[ID];
    expect(cached.at).toBe(NOW);
    // Carried apart from the new research's own pages.
    expect(cached.earlierSearch).toEqual([oldPage]);
    expect(cached.donation.map((p) => p.url)).not.toContain(OLD_PAGE);
    // Unmarked, so the search is tried again.
    expect(cached.donationSearched).toBeUndefined();
    expect(file.disasters[0].donate[0]).toMatchObject({ url: OLD_PAGE, forEvent: true });
    // A day later the search is tried again; it works, and its pages replace the old ones.
    const later = recordingAi(ledger);
    const next = await updateDisasters(runWith(dirs, { ai: later.ai, ledger, deps, now: "2026-10-21T12:30:00.000Z" }));
    expect(later.webResearch).toHaveBeenCalledTimes(1);
    const after = readCache(dirs.cacheDir)[ID];
    expect(after.donationSearched).toBe("2026-10-21T12:30:00.000Z");
    expect(after.donation[0].url).toBe(EVENT_PAGE);
    expect(after.donation.map((p) => p.url)).not.toContain(OLD_PAGE);
    expect(after.earlierSearch).toBeUndefined();
    expect(next.disasters[0].donate[0]).toMatchObject({ url: EVENT_PAGE, forEvent: true });
  });

  it("keeps a page the new research lists when the earlier search had found it too and a new search works without it", async () => {
    // The earlier search found the society's general page (and, in the second case, marked it as the event's own);
    // the re-research lists it as well; the new search works and finds nothing.
    const GENERAL = "https://bdrcs.org/donate/";
    const researched = { ...COXS.parsed, donation: [{ url: GENERAL, org: "Bangladesh Red Crescent Society", kind: "society" as const, note: "Donate" }] };
    const none = { research: { text: "Donation pages: none found", citations: [], results: [], searches: 1, okSearches: 1 }, parsed: { pages: [] } };
    for (const specific of [false, true]) {
      const earlier = entry({
        at: "2026-10-17T00:00:00.000Z",
        donationSearched: "2026-10-17T00:00:00.000Z",
        donation: [{ url: GENERAL, org: "Bangladesh Red Crescent Society", kind: "society", note: "From the search", specific }],
      });
      const dirs = folders({ snapshot: { ifrc: { fetched: "2026-10-20T09:00:00.000Z", events: [ifrcEvent()] } }, research: { [ID]: earlier }, registry: REGISTRY });
      const fetchMock = vi.fn(async (url: string | URL | Request) => {
        if (String(url) === GENERAL) return new Response("<h1>Donate</h1><a>Donate now</a>", { status: 200, headers: { "content-type": "text/html" } });
        throw new Error("network down");
      });
      const ledger = emptyLedger();
      const { ai, webResearch } = recordingAi(ledger, none, researched);
      const file = await updateDisasters(runWith(dirs, { ai, ledger, deps: { fetch: fetchMock as unknown as typeof fetch, sleep: vi.fn(async () => {}), log: () => {} } }));
      expect(callsOf(webResearch).donation).toHaveLength(1);
      const cached = readCache(dirs.cacheDir)[ID];
      expect(cached.donationSearched).toBe(NOW);
      expect(cached.earlierSearch).toBeUndefined();
      // The research's own copy, unmarked.
      expect(cached.donation).toEqual([{ url: GENERAL, org: "Bangladesh Red Crescent Society", kind: "society", note: "Donate" }]);
      expect(file.disasters[0].donate.find((l) => l.url === GENERAL)).toMatchObject({ via: "research" });
      expect(file.disasters[0].donate.find((l) => l.url === GENERAL)?.forEvent).toBeUndefined();
    }
  });

  it("counts a donation search in which no search worked as failed, and one that searched and found nothing as done", async () => {
    const none = { text: "Donation pages: none found", citations: [], results: [] };
    // Every search came back as an error (a rate limit): tried again after a day, its spend still recorded.
    const limited = folders({ snapshot: { ifrc: { fetched: "2026-10-20T09:00:00.000Z", events: [ifrcEvent()] } } });
    const ledger = emptyLedger();
    const failing = recordingAi(ledger, { research: { ...none, searches: 2, okSearches: 0 }, parsed: DONATION_PARSED });
    await updateDisasters(runWith(limited, { ai: failing.ai, ledger }));
    expect(callsOf(failing.webResearch).donation).toHaveLength(1);
    expect(readCache(limited.cacheDir)[ID].donationSearched).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path.join(limited.cacheDir, "research-attempts.json"), "utf8"))).toEqual({ [donationAttemptKey(ID)]: NOW });
    // The research and its parse, the donation search, and the direct search that found nothing.
    expect(ledger.months["2026-10"].researchCalls).toBe(4);
    // A search that worked and found nothing is a finding.
    const empty = folders({ snapshot: { ifrc: { fetched: "2026-10-20T09:00:00.000Z", events: [ifrcEvent()] } } });
    const emptyRun = emptyLedger();
    const searched = recordingAi(emptyRun, { research: { ...none, searches: 1, okSearches: 1 }, parsed: DONATION_PARSED });
    await updateDisasters(runWith(empty, { ai: searched.ai, ledger: emptyRun }));
    expect(readCache(empty.cacheDir)[ID].donationSearched).toBe(NOW);
  });

  it("runs no donation search for a disaster the research says is over, after its research or as a backfill", async () => {
    const dirs = folders({ snapshot: { ifrc: { fetched: "2026-10-20T09:00:00.000Z", events: [ifrcEvent()] } }, registry: REGISTRY });
    const ledger = emptyLedger();
    const over = recordingAi(ledger, undefined, { ...COXS.parsed, ongoing: false });
    const file = await updateDisasters(runWith(dirs, { ai: over.ai, ledger }));
    expect(over.webResearch).toHaveBeenCalledTimes(1);
    expect(over.webResearch.mock.calls[0][0].allowedDomains).toBeUndefined();
    expect(file.disasters).toEqual([]);
    // Researched earlier, before any donation search, and over by then.
    const { events, research } = researchedEarlier();
    const ended = Object.fromEntries(Object.entries(research).map(([id, e]) => [id, { ...e, ongoing: false }]));
    const dirs2 = folders({ snapshot: { ifrc: { fetched: "2026-10-20T09:00:00.000Z", events } }, research: ended, registry: REGISTRY });
    const ledger2 = emptyLedger();
    const backfill = recordingAi(ledger2);
    expect((await updateDisasters(runWith(dirs2, { ai: backfill.ai, ledger: ledger2 }))).disasters).toEqual([]);
    expect(backfill.webResearch).not.toHaveBeenCalled();
  });

  it("backfills no more disasters than the run's research cap, and none when the cap is 0", async () => {
    for (const cap of [2, 0]) {
      const { events, research } = researchedEarlier();
      const dirs = folders({ snapshot: { ifrc: { fetched: "2026-10-20T09:00:00.000Z", events } }, research, registry: REGISTRY });
      const ledger = emptyLedger();
      const { ai, webResearch } = recordingAi(ledger);
      await updateDisasters(runWith(dirs, { ai, ledger, budget: { ...DEFAULT_BUDGET, maxResearchPerRun: cap } }));
      // Each backfilled disaster gets both its searches.
      expect(callsOf(webResearch).donation).toHaveLength(cap);
      expect(callsOf(webResearch).direct).toHaveLength(cap);
    }
  });

  it("starts no research once the run's deadline has passed", async () => {
    const dirs = folders({ snapshot: { ifrc: { fetched: "2026-10-20T09:00:00.000Z", events: [ifrcEvent()] } } });
    const ledger = emptyLedger();
    const { ai, webResearch } = recordingAi(ledger);
    const file = await updateDisasters(runWith(dirs, { ai, ledger, deadline: 0 }));
    expect(webResearch).not.toHaveBeenCalled();
    expect(file.disasters[0].research).toBeUndefined();
  });

  it("starts no research once the month's budget is spent", async () => {
    const dirs = folders({ snapshot: { ifrc: { fetched: "2026-10-20T09:00:00.000Z", events: [ifrcEvent()] } } });
    const ledger = emptyLedger();
    record(ledger, "translate", { model: "claude-haiku-5-5", inputTokens: 0, outputTokens: 94_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0 }, NOW);
    const { ai, webResearch } = recordingAi(ledger);
    await updateDisasters(runWith(dirs, { ai, ledger }));
    expect(webResearch).not.toHaveBeenCalled();
  });
});

describe("trimSeaAreas", () => {
  const shapes = loadCountryShapes();
  const detailed = loadCountryShapes(LAND_SHAPES_PATH);
  type Case = { lat: number; lng: number; places?: Disaster["places"]; areas: Disaster["areas"] };
  const fx = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "sea-parts.json"), "utf8")) as Record<"china" | "italy" | "spain" | "coxsBazar", Case>;
  /** A flood from one of the fixture's cases. */
  const flood = (c: Case, p: Partial<Disaster> = {}) => dis({ id: "gdacs-flood-1", lat: c.lat, lng: c.lng, places: c.places ?? [], areas: c.areas, ...p });
  const china = (p: Partial<Disaster> = {}) => flood(fx.china, { countries: ["CN"], ...p });
  const parts = (d: Disaster) => d.areas.reduce((n, a) => n + (a.geometry.type === "Polygon" ? 1 : a.geometry.coordinates.length), 0);

  it("drops a flood's parts out at sea", () => {
    const before = china();
    expect(parts(before)).toBe(13);
    expect(parts(trimSeaAreas(before, [shapes]))).toBe(1);
    expect(parts(trimSeaAreas(before, [shapes, detailed]))).toBe(1);
  });

  it("leaves hazards that reach the sea, and runs without shapes, untouched", () => {
    const storm = china({ type: "cyclone" });
    expect(trimSeaAreas(storm, [shapes, detailed])).toBe(storm);
    const before = china();
    expect(trimSeaAreas(before, [])).toBe(before);
    expect(trimSeaAreas(before, [[]])).toBe(before);
  });

  it("never leaves a disaster with no area", () => {
    const sea = china({ lat: 0, lng: -150, areas: [{ kind: "affected", geometry: { type: "Polygon", coordinates: [[[111, 15.5], [113, 15.5], [113, 17.3], [111, 17.3], [111, 15.5]]] } }] });
    expect(trimSeaAreas(sea, [shapes, detailed])).toBe(sea);
  });

  it("keeps the part that holds the disaster's places", () => {
    // Italy's flood is on Elba, which the coarse shapes leave out; its position is on the mainland.
    const before = flood(fx.italy, { countries: ["IT"] });
    const after = trimSeaAreas(before, [shapes]);
    expect(parts(before)).toBe(4);
    expect(parts(after)).toBe(2); // Pianosa and Montecristo go
    expect(after.places.every((p) => after.areas.some((a) => pointInGeometry(p.lng, p.lat, a.geometry)))).toBe(true);
  });

  it("keeps islands the finer shapes have", () => {
    // Spain's flood covers Ibiza and Formentera; its position is on Formentera.
    const before = flood(fx.spain, { countries: ["ES"] });
    expect(parts(before)).toBe(2);
    expect(trimSeaAreas(before, [shapes, detailed])).toBe(before);
    expect(parts(trimSeaAreas(before, [shapes]))).toBe(1);
  });

  it("leaves place areas as they are", () => {
    // Cox's Bazar District's outline is mostly sea by the coarse shapes and
    // does not hold the disaster's position, but it is drawn around a named
    // place, not taken from a source's footprint.
    const district = fx.coxsBazar.areas[0];
    expect(district.kind).toBe("place");
    expect(dropSeaParts(district.geometry, [shapes], [fx.coxsBazar])).toBeNull();
    const land: Disaster["areas"][number] = { kind: "affected", geometry: { type: "Polygon", coordinates: [[[90.3, 23.7], [90.5, 23.7], [90.5, 23.9], [90.3, 23.9], [90.3, 23.7]]] } };
    const before = flood(fx.coxsBazar, { places: [], areas: [land, district] });
    expect(trimSeaAreas(before, [shapes])).toBe(before);
  });
});
