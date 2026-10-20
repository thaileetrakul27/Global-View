import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_PLACE_AREAS,
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
  withPlaces,
  withResearch,
} from "./build";
import { circlePolygon } from "./geo";
import type { GeoHit, Geocoder } from "./geocode";
import type { ResearchEntry } from "./research";
import type { Disaster, SourceEvent } from "./types";

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
    sources: [{ url: "https://www.thedailystar.net/a", title: "Floods in Sylhet" }],
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
    expect(out.research).toEqual({ at: "2026-10-19T00:00:00.000Z", model: "claude-haiku-5-5", searches: 3 });
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
