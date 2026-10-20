import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AiClient, ResearchResult, Usage } from "../ai";
import { loadGlobeFeatures } from "../countries";
import { buildResolver } from "../resolve";
import { DEFAULT_BUDGET, emptyLedger, record, type Ledger } from "../spend";
import {
  MAX_PLACE_AREAS,
  cachePaths,
  hasFootprint,
  locateNewsEvents,
  locatePlaces,
  nearEnough,
  pruneAttempts,
  readAttempts,
  readDisastersFile,
  readSnapshots,
  relatedHeadlines,
  researchSaysOver,
  updateDisasters,
  withPlaces,
  withResearch,
  type DisasterRun,
  type Snapshots,
} from "./build";
import { circlePolygon } from "./geo";
import type { GeoHit, Geocoder } from "./geocode";
import type { ResearchEntry, ResearchParse } from "./research";
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
    });
    expect(cachePaths("/tmp/x").research).toBe("/tmp/x/research.json");
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
  function folders(seed: { snapshot?: Snapshots; previous?: DisastersFile; research?: Record<string, ResearchEntry> } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gv-update-"));
    const outDir = path.join(root, "data");
    const cacheDir = path.join(root, "cache");
    fs.mkdirSync(outDir);
    fs.mkdirSync(cacheDir);
    if (seed.snapshot) fs.writeFileSync(path.join(cacheDir, "disaster-sources.json"), JSON.stringify(seed.snapshot));
    if (seed.previous) fs.writeFileSync(path.join(outDir, "disasters.json"), JSON.stringify(seed.previous));
    if (seed.research) fs.writeFileSync(path.join(cacheDir, "research.json"), JSON.stringify(seed.research));
    return { outDir, cacheDir };
  }

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

  it("keeps a failed feed's previous reports", async () => {
    const dirs = folders({ snapshot: { ifrc: { fetched: "2026-10-20T09:00:00.000Z", events: [ifrcEvent()] } } });
    const run = runWith(dirs);
    const file = await updateDisasters(run);
    expect(run.deps.fetch).toHaveBeenCalled();
    expect(file.disasters.map((d) => d.id)).toEqual([ID]);
    expect(file.fetched.ifrc).toBe("2026-10-20T09:00:00.000Z");
    expect(file.fetched.gdacs).toBeNull();
  });

  it("keeps the previous map rather than write an empty one", async () => {
    const previous: DisastersFile = { updated: "2026-10-20T09:00:00.000Z", fetched: { gdacs: null, usgs: null, eonet: null, ifrc: null, news: null }, disasters: [dis({ id: ID })] };
    const dirs = folders({ previous });
    const file = await updateDisasters(runWith(dirs));
    expect(file).toEqual(previous);
    expect(read(dirs.outDir)).toEqual(previous);
  });

  /** A model client that records its usage in the ledger the way pipeline/update.ts does. */
  function recordingAi(ledger: Ledger) {
    const spend = (u: Partial<Usage>) => record(ledger, "research", { model: "claude-haiku-5-5", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0, ...u }, NOW);
    const webResearch = vi.fn(async () => {
      spend({ inputTokens: 30_000, outputTokens: 1_500, webSearches: 4 });
      return COXS.research;
    });
    const parse = vi.fn(async () => {
      spend({ inputTokens: 4_000, outputTokens: 1_000 });
      return COXS.parsed;
    });
    return { ai: { webResearch, parse, calls: 0 } as unknown as AiClient, webResearch, parse };
  }

  it("researches within the budget, saves the research and counts one research per disaster", async () => {
    const dirs = folders({ snapshot: { ifrc: { fetched: "2026-10-20T09:00:00.000Z", events: [ifrcEvent()] } } });
    const ledger = emptyLedger();
    const { ai, webResearch, parse } = recordingAi(ledger);
    const file = await updateDisasters(runWith(dirs, { ai, ledger }));
    expect(webResearch).toHaveBeenCalledTimes(1);
    expect(parse).toHaveBeenCalledTimes(1);
    const month = ledger.months["2026-10"];
    expect(month.researchCalls).toBe(2);
    expect(month.researches).toBe(1);
    const cached = JSON.parse(fs.readFileSync(path.join(dirs.cacheDir, "research.json"), "utf8")) as Record<string, ResearchEntry>;
    expect(Object.keys(cached)).toEqual([ID]);
    const d = file.disasters[0];
    expect(d.research?.searches).toBe(COXS.research.searches);
    expect(d.summary).toBe(cached[ID].summary);
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
