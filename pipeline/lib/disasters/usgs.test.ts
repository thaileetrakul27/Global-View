import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { FetchDeps } from "../googlenews";
import { USER_AGENT } from "../googlenews";
import { circlePolygon, geometryAreaKm2, loadCountryShapes, pointInGeometry, type CountryShape } from "./geo";
import type { Area, AreaGeometry, Place, Position, SourceEvent } from "./types";
import {
  AREA_BUDGET_BYTES,
  DETAIL_GAP_MS,
  MAX_DETAIL_FETCHES,
  MAX_FAILED_DETAILS,
  PAGER_SOURCE,
  USGS_FEEDS,
  carryOver,
  contourRings,
  contoursToAreas,
  emptyExtras,
  eventUpdated,
  extrasFromPrevious,
  fallbackDetail,
  fetchDetail,
  fetchUsgs,
  findPrevious,
  fitAreas,
  formatPeople,
  getJson,
  isHighAlert,
  isIncluded,
  isPreviousUsgs,
  isUsgsUrl,
  keptWithoutCountry,
  levelGeometry,
  loadDetails,
  locationPhrase,
  mergeFeeds,
  nestedLevels,
  outerWinding,
  pacer,
  pagerCities,
  pagerExposure,
  pagerUrls,
  parseUsgsFeed,
  pickLevels,
  primaryCountry,
  quakeTitle,
  severityOf,
  severityText,
  shakeMapUrl,
  shakingLabel,
  signedArea2,
  stableSourceId,
  toSourceEvent,
  wantsDetail,
  type QuakeExtras,
  type UsgsQuake,
} from "./usgs";

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

/** Reads a trimmed real USGS response saved under fixtures/. */
function fixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", name), "utf8"));
}

const SIGNIFICANT = fixture("usgs-significant.json");
const WEEK = fixture("usgs-week.json");
const DETAIL_PK = fixture("usgs-detail-us6000u2y1.json");
const CONT_PK = fixture("usgs-cont-mmi-us6000u2y1.json");
const CONT_RU = fixture("usgs-cont-mmi-us6000u2mq.json");
const CONT_PA = fixture("usgs-cont-mmi-us6000u18k.json");
/** The M6.6 Panama aftershock: its MMI IV contour runs off the grid, leaving only small closed IV patches. */
const CONT_PA_66 = fixture("usgs-cont-mmi-us6000u19w.json");
const CITIES_PA = fixture("usgs-pager-cities-us6000u18k.json");
const CITIES_PK = fixture("usgs-pager-cities-us6000u2y1.json");
const EXPOSURE_PA = fixture("usgs-pager-exposures-us6000u18k.json");
const EXPOSURE_PK = fixture("usgs-pager-exposures-us6000u2y1.json");

const PK_DETAIL_URL = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/us6000u2y1.geojson";
const PK_CONT_URL =
  "https://earthquake.usgs.gov/pdl/products/urn:usgs-product:us:shakemap:us6000u2y1:1792300250267/contents/download/cont_mmi.json";
const PK_PAGER = "https://earthquake.usgs.gov/pdl/products/urn:usgs-product:us:losspager:us6000u2y1:1792300326905/contents/json";
const PK_UPDATED = "1792300436039";

/** When the saved week feed was generated. */
const NOW = new Date(1792445633000).toISOString();
const DAY = 86_400_000;

const shapes = loadCountryShapes();

/** A quake with sensible defaults, as parseUsgsFeed returns it. */
function quake(over: Partial<UsgsQuake> = {}): UsgsQuake {
  const id = over.id ?? "us7000test";
  const time = over.time ?? Date.parse(NOW) - DAY;
  return {
    id,
    ids: [id],
    mag: 6.2,
    place: "20 km SW of Chiang Rai, Thailand",
    time,
    updated: time + 3_600_000,
    url: `https://earthquake.usgs.gov/earthquakes/eventpage/${id}`,
    detail: `https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/${id}.geojson`,
    alert: null,
    tsunami: false,
    sig: 500,
    felt: null,
    type: "earthquake",
    lat: 19.8,
    lng: 99.7,
    depthKm: 10,
    ...over,
  };
}

/** A GeoJSON feed feature for a synthetic quake. */
function feature(over: { id: string; mag?: number; time?: number; updated?: number; alert?: string | null; sig?: number; lat?: number; lng?: number; type?: string }) {
  const time = over.time ?? Date.parse(NOW) - DAY;
  return {
    type: "Feature",
    id: over.id,
    properties: {
      mag: over.mag ?? 6.1,
      place: "10 km N of Somewhere, Thailand",
      time,
      updated: over.updated ?? time + 1000,
      url: `https://earthquake.usgs.gov/earthquakes/eventpage/${over.id}`,
      detail: `https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/${over.id}.geojson`,
      alert: over.alert ?? null,
      tsunami: 0,
      sig: over.sig ?? 580,
      felt: null,
      ids: `,${over.id},`,
      type: over.type ?? "earthquake",
    },
    geometry: { type: "Point", coordinates: [over.lng ?? 99.7, over.lat ?? 19.8, 10] },
  };
}

function featureCollection(features: unknown[]) {
  return { type: "FeatureCollection", metadata: {}, features };
}

/** A route answers with a JSON body, an HTTP status, or a thrown error. */
type Route = unknown | { status: number } | Error;

/** Fake FetchDeps answering from a URL map; unknown URLs give 404. */
function fakeDeps(routes: Record<string, Route>) {
  const calls: string[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    expect((init?.headers as Record<string, string>)["User-Agent"]).toBe(USER_AGENT);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const route = routes[url];
    if (route === undefined) return new Response("not found", { status: 404 });
    if (route instanceof Error) throw route;
    if (route && typeof route === "object" && "status" in route && Object.keys(route).length === 1) {
      return new Response("error", { status: (route as { status: number }).status });
    }
    return new Response(JSON.stringify(route), { status: 200 });
  });
  const sleep = vi.fn(async (ms: number) => void ms);
  const log = vi.fn((msg: string) => void msg);
  const deps: FetchDeps = { fetch: fetch as unknown as typeof globalThis.fetch, sleep, log };
  return { deps, fetch, sleep, log, calls };
}

/** Routes serving the Pakistan quake's detail, ShakeMap and PAGER files. */
const PK_ROUTES: Record<string, Route> = {
  [PK_DETAIL_URL]: DETAIL_PK,
  [PK_CONT_URL]: CONT_PK,
  [`${PK_PAGER}/cities.json`]: CITIES_PK,
  [`${PK_PAGER}/exposures.json`]: EXPOSURE_PK,
};

/** Every polygon of a geometry. */
function polygons(g: AreaGeometry): Position[][][] {
  return g.type === "Polygon" ? [g.coordinates] : g.coordinates;
}

/** A square ring from (x0, y0) of side s, clockwise when cw is true. */
function square(x0: number, y0: number, s: number, cw: boolean): Position[] {
  const ccw: Position[] = [
    [x0, y0],
    [x0 + s, y0],
    [x0 + s, y0 + s],
    [x0, y0 + s],
    [x0, y0],
  ];
  return cw ? [...ccw].reverse() : ccw;
}

/** A previous-run SourceEvent for a quake. */
function previousEvent(over: Partial<SourceEvent> = {}): SourceEvent {
  return {
    source: "usgs",
    sourceId: "us6000u2y1",
    type: "earthquake",
    title: "M5.7 earthquake near Khuzdar, Pakistan",
    severity: 2,
    countries: ["PK"],
    lat: 28.0179,
    lng: 66.1708,
    precision: "exact",
    started: new Date(1792213617657).toISOString(),
    updated: new Date(1792300436039).toISOString(),
    areas: [{ kind: "shaking", level: 5, geometry: circlePolygon(28, 66.2, 20) }],
    places: [
      { name: "Epicentre", country: "PK", lat: 28.0179, lng: 66.1708, kind: "site", source: "usgs" },
      { name: "Khuzdar", country: "PK", lat: 27.8, lng: 66.6167, kind: "city", impact: "Light shaking (intensity IV)", source: "usgs" },
    ],
    figures: [
      { label: "People exposed to strong shaking or worse (estimate)", value: "39,000", sourceName: PAGER_SOURCE, sourceUrl: "https://x/pager" },
      { label: "Felt reports sent to USGS", value: "2", sourceName: "USGS Did You Feel It?", sourceUrl: "https://x/dyfi" },
    ],
    links: [{ name: "USGS event page", url: "https://earthquake.usgs.gov/earthquakes/eventpage/us6000u2y1" }],
    revision: PK_UPDATED,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Network helpers
// ---------------------------------------------------------------------------

describe("getJson", () => {
  it("returns the parsed body on success, sending the user agent and a timeout", async () => {
    const { deps, sleep } = fakeDeps({ "https://earthquake.usgs.gov/a.json": { ok: 1 } });
    expect(await getJson("https://earthquake.usgs.gov/a.json", deps, 1234)).toEqual({ ok: 1 });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries once after the delay and returns the second answer", async () => {
    const { deps, sleep, log } = fakeDeps({});
    let n = 0;
    deps.fetch = vi.fn(async () => (++n === 1 ? new Response("busy", { status: 503 }) : new Response('{"x":2}', { status: 200 }))) as never;
    expect(await getJson("https://earthquake.usgs.gov/b.json", deps, 1234)).toEqual({ x: 2 });
    expect(sleep).toHaveBeenCalledWith(1234);
    expect(log.mock.calls[0][0]).toContain("HTTP 503");
  });

  it("returns null after two failures of any kind, never throwing", async () => {
    const { deps, sleep, log } = fakeDeps({ "https://earthquake.usgs.gov/c.json": new Error("socket hang up") });
    expect(await getJson("https://earthquake.usgs.gov/c.json", deps, 50)).toBeNull();
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(2);

    const bad = fakeDeps({});
    bad.deps.fetch = vi.fn(async () => new Response("<html>", { status: 200 })) as never;
    expect(await getJson("https://earthquake.usgs.gov/d.json", bad.deps, 50)).toBeNull();
  });
});

describe("isUsgsUrl", () => {
  it("accepts https links on usgs.gov hosts only", () => {
    expect(isUsgsUrl("https://earthquake.usgs.gov/pdl/x.json")).toBe(true);
    expect(isUsgsUrl("https://usgs.gov/x")).toBe(true);
    expect(isUsgsUrl("http://earthquake.usgs.gov/x")).toBe(false);
    expect(isUsgsUrl("https://evil.example/usgs.gov")).toBe(false);
    expect(isUsgsUrl("https://notusgs.gov/x")).toBe(false);
    expect(isUsgsUrl("not a url")).toBe(false);
    expect(isUsgsUrl(42)).toBe(false);
  });
});

describe("pacer", () => {
  it("waits the gap before every call but the first", async () => {
    const { deps, sleep } = fakeDeps({});
    const pace = pacer(deps, 300);
    await pace();
    expect(sleep).not.toHaveBeenCalled();
    await pace();
    await pace();
    expect(sleep.mock.calls).toEqual([[300], [300]]);
  });
});

// ---------------------------------------------------------------------------
// Feeds
// ---------------------------------------------------------------------------

describe("parseUsgsFeed", () => {
  it("reads the real significant-quakes feed", () => {
    const quakes = parseUsgsFeed(SIGNIFICANT)!;
    expect(quakes).toHaveLength(15);
    const pk = quakes.find((q) => q.id === "us6000u2y1")!;
    expect(pk).toMatchObject({
      mag: 5.7,
      place: "48 km WNW of Khuzdar, Pakistan",
      time: 1792213617657,
      updated: 1792300436039,
      url: "https://earthquake.usgs.gov/earthquakes/eventpage/us6000u2y1",
      detail: PK_DETAIL_URL,
      alert: "yellow",
      tsunami: false,
      sig: 651,
      felt: 2,
      type: "earthquake",
      lat: 28.0179,
      lng: 66.1708,
      depthKm: 10,
    });
    const ridge = quakes.find((q) => q.id === "us6000u214")!;
    expect(ridge.tsunami).toBe(true);
    expect(ridge.ids).toEqual(["attmuiel", "us6000u214", "pt26286001"]);
  });

  it("reads the real week feed, where most quakes have no alert or felt reports", () => {
    const quakes = parseUsgsFeed(WEEK)!;
    expect(quakes.length).toBeGreaterThan(10);
    const tonga = quakes.find((q) => q.id === "us6000u37h")!;
    expect(tonga.alert).toBeNull();
    expect(tonga.felt).toBeNull();
  });

  it("returns null for anything that is not a FeatureCollection", () => {
    expect(parseUsgsFeed(null)).toBeNull();
    expect(parseUsgsFeed("text")).toBeNull();
    expect(parseUsgsFeed({ type: "Feature" })).toBeNull();
    expect(parseUsgsFeed({ type: "FeatureCollection" })).toBeNull();
    expect(parseUsgsFeed({ type: "FeatureCollection", features: [] })).toEqual([]);
  });

  it("skips features without an id, time or usable point, and fills safe defaults", () => {
    const good = feature({ id: "ok1" });
    const odd = {
      ...feature({ id: "ok2", lng: 181 }),
      properties: { time: 1, mag: null, alert: "purple", url: "https://evil.example/x", detail: 5, sig: "high", tsunami: true },
    };
    const quakes = parseUsgsFeed(
      featureCollection([
        good,
        odd,
        { ...good, id: "" },
        { ...good, id: "x1", geometry: { type: "Point", coordinates: ["a", 1] } },
        { ...good, id: "x2", geometry: { type: "Point", coordinates: [10, 95] } },
        { ...good, id: "x3", geometry: { type: "Polygon", coordinates: [] } },
        { ...good, id: "x4", properties: { ...good.properties, time: "yesterday" } },
        null,
      ]),
    )!;
    expect(quakes.map((q) => q.id)).toEqual(["ok1", "ok2"]);
    const q = quakes[1];
    expect(q).toMatchObject({ mag: null, alert: null, sig: 0, tsunami: false, updated: 1, type: "earthquake", place: null, depthKm: 10, lng: -179 });
    expect(q.url).toBe("https://earthquake.usgs.gov/earthquakes/eventpage/ok2");
    expect(q.detail).toBe("https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/ok2.geojson");
  });

  it("skips times a Date cannot hold, so building the report cannot throw (regression)", () => {
    const good = feature({ id: "ok" });
    const quakes = parseUsgsFeed(
      featureCollection([
        { ...good, id: "far-future", properties: { ...good.properties, time: 1e20 } },
        { ...good, id: "bad-updated", properties: { ...good.properties, updated: 1e20 } },
      ]),
    )!;
    expect(quakes.map((q) => q.id)).toEqual(["bad-updated"]);
    expect(quakes[0].updated).toBe(quakes[0].time);
    expect(() => toSourceEvent(quakes[0], "TH", { extras: emptyExtras() })).not.toThrow();
  });
});

describe("mergeFeeds", () => {
  it("keeps one copy of each id, the most recently updated", () => {
    const a = quake({ id: "a", updated: 10, time: 1 });
    const a2 = quake({ id: "a", updated: 20, time: 1, mag: 6.3 });
    const b = quake({ id: "b" });
    const merged = mergeFeeds([[a, b], [a2]]);
    expect(merged).toHaveLength(2);
    expect(merged.find((q) => q.id === "a")!.mag).toBe(6.3);
  });

  it("deduplicates the overlapping real feeds", () => {
    const sig = parseUsgsFeed(SIGNIFICANT)!;
    const week = parseUsgsFeed(WEEK)!;
    const merged = mergeFeeds([sig, week]);
    const ids = merged.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("us6000u2y1");
    expect(merged.length).toBeLessThan(sig.length + week.length);
  });

  it("joins copies listed under different preferred ids when they share any USGS id (regression)", () => {
    // The real Alaska M5.5, known as aka2026tuxgky and us6000u0ju. A feed generated
    // before USGS switched its preferred id still lists it as us6000u0ju.
    const sig = parseUsgsFeed(SIGNIFICANT)!.find((q) => q.id === "aka2026tuxgky")!;
    const stale = { ...sig, id: "us6000u0ju", ids: ["us6000u0ju", "aka2026tuxgky"], updated: sig.updated - 1000 };
    const merged = mergeFeeds([[stale, quake({ id: "other" })], [sig]]);
    expect(merged.map((q) => q.id)).toEqual(["aka2026tuxgky", "other"]);
    expect(merged[0].ids.sort()).toEqual(["aka2026tuxgky", "us6000u0ju"]);
  });
});

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

describe("isIncluded", () => {
  const now = NOW;
  const ago = (days: number) => Date.parse(now) - days * DAY;

  it("takes magnitude 5.5+ for 7 days", () => {
    expect(isIncluded(quake({ mag: 5.5, sig: 0, time: ago(7) }), now)).toBe(true);
    expect(isIncluded(quake({ mag: 5.5, sig: 0, time: ago(7.1) }), now)).toBe(false);
    expect(isIncluded(quake({ mag: 5.4, sig: 0, time: ago(1) }), now)).toBe(false);
  });

  it("takes significance 600+ for 14 days", () => {
    expect(isIncluded(quake({ mag: 4.7, sig: 600, time: ago(14) }), now)).toBe(true);
    expect(isIncluded(quake({ mag: 4.7, sig: 764, time: ago(14.5) }), now)).toBe(false);
    expect(isIncluded(quake({ mag: 4.7, sig: 599, time: ago(2) }), now)).toBe(false);
  });

  it("takes yellow, orange and red PAGER alerts for 21 days, but not green", () => {
    expect(isIncluded(quake({ mag: 5, sig: 0, alert: "yellow", time: ago(21) }), now)).toBe(true);
    expect(isIncluded(quake({ mag: 5, sig: 0, alert: "red", time: ago(20) }), now)).toBe(true);
    expect(isIncluded(quake({ mag: 5, sig: 0, alert: "orange", time: ago(21.5) }), now)).toBe(false);
    expect(isIncluded(quake({ mag: 5, sig: 0, alert: "green", time: ago(10) }), now)).toBe(false);
  });

  it("skips blasts and other non-earthquakes, and copes with an unknown magnitude", () => {
    expect(isIncluded(quake({ type: "explosion", mag: 6, sig: 900 }), now)).toBe(false);
    expect(isIncluded(quake({ mag: null, sig: 650 }), now)).toBe(true);
    expect(isIncluded(quake({ mag: null, sig: 10 }), now)).toBe(false);
  });
});

describe("isHighAlert", () => {
  it("is true only for orange and red", () => {
    expect(isHighAlert(quake({ alert: "red" }))).toBe(true);
    expect(isHighAlert(quake({ alert: "orange" }))).toBe(true);
    expect(isHighAlert(quake({ alert: "yellow" }))).toBe(false);
    expect(isHighAlert(quake({ alert: null }))).toBe(false);
  });
});

describe("keptWithoutCountry", () => {
  it("keeps quakes with a yellow, orange or red PAGER alert, which only land impacts raise", () => {
    expect(keptWithoutCountry(quake({ alert: "yellow" }))).toBe(true);
    expect(keptWithoutCountry(quake({ alert: "orange" }))).toBe(true);
    expect(keptWithoutCountry(quake({ alert: "red" }))).toBe(true);
    expect(keptWithoutCountry(quake({ alert: "green" }))).toBe(false);
    expect(keptWithoutCountry(quake({ alert: null }))).toBe(false);
  });
});

describe("severityOf", () => {
  it("maps PAGER alerts to severities", () => {
    expect(severityOf(quake({ alert: "red", mag: 6 }))).toBe(3);
    expect(severityOf(quake({ alert: "orange", mag: 6 }))).toBe(3);
    expect(severityOf(quake({ alert: "yellow", mag: 6 }))).toBe(2);
    expect(severityOf(quake({ alert: "green", mag: 6 }))).toBe(1);
    expect(severityOf(quake({ alert: null, mag: null }))).toBe(1);
  });

  it("makes magnitude 7+ at least significant", () => {
    expect(severityOf(quake({ alert: "green", mag: 7 }))).toBe(2);
    expect(severityOf(quake({ alert: null, mag: 7.4 }))).toBe(2);
    expect(severityOf(quake({ alert: "red", mag: 7.4 }))).toBe(3);
    expect(severityOf(quake({ alert: null, mag: 6.9 }))).toBe(1);
  });
});

describe("severityText", () => {
  it("gives magnitude and rounded depth", () => {
    expect(severityText(quake({ mag: 6.6, depthKm: 10 }))).toBe("Magnitude 6.6, depth 10 km");
    expect(severityText(quake({ mag: 6, depthKm: 12.647 }))).toBe("Magnitude 6.0, depth 13 km");
    expect(severityText(quake({ mag: 4.15, depthKm: -1.2 }))).toBe("Magnitude 4.2, depth 0 km");
  });

  it("points to tsunami.gov when USGS flags a large quake at sea", () => {
    expect(severityText(quake({ mag: 6.8, depthKm: 10, tsunami: true }))).toBe("Magnitude 6.8, depth 10 km, check tsunami.gov for tsunami alerts");
  });

  it("copes with a missing magnitude or depth", () => {
    expect(severityText(quake({ mag: null, depthKm: 33 }))).toBe("Depth 33 km");
    expect(severityText(quake({ mag: 5.9, depthKm: null }))).toBe("Magnitude 5.9");
    expect(severityText(quake({ mag: null, depthKm: null, tsunami: true }))).toBe("Check tsunami.gov for tsunami alerts");
  });
});

describe("locationPhrase and quakeTitle", () => {
  it("turns an offset from a town into 'near'", () => {
    expect(locationPhrase("48 km WNW of Khuzdar, Pakistan")).toBe("near Khuzdar, Pakistan");
    expect(locationPhrase("0 km NE of Río Grande, Panama")).toBe("near Río Grande, Panama");
    expect(locationPhrase("2.5 km S of Aleneva, Alaska")).toBe("near Aleneva, Alaska");
    expect(quakeTitle(6.6, "12 km W of Río Grande, Panama")).toBe("M6.6 earthquake near Río Grande, Panama");
  });

  it("keeps phrases that already say where", () => {
    expect(locationPhrase("off the coast of Ecuador")).toBe("off the coast of Ecuador");
    expect(locationPhrase("south of the Fiji Islands")).toBe("south of the Fiji Islands");
    expect(locationPhrase("Near the coast of central Chile")).toBe("near the coast of central Chile");
  });

  it("puts 'in the' before regions and sea features, and 'in' before plain names", () => {
    expect(locationPhrase("central Mid-Atlantic Ridge")).toBe("in the central Mid-Atlantic Ridge");
    expect(locationPhrase("Fiji region")).toBe("in the Fiji region");
    expect(locationPhrase("Banda Sea")).toBe("in the Banda Sea");
    expect(locationPhrase("Kermadec Islands, New Zealand")).toBe("in the Kermadec Islands, New Zealand");
    expect(locationPhrase("Greece")).toBe("in Greece");
    expect(quakeTitle(6.8, "central Mid-Atlantic Ridge")).toBe("M6.8 earthquake in the central Mid-Atlantic Ridge");
  });

  it("keeps the distance when the quake is 100 km or more from the town (regression)", () => {
    // Real places from the week feed: these quakes were far out at sea, not "near" the town.
    expect(locationPhrase("203 km WNW of Port-Olry, Vanuatu")).toBe("203 km WNW of Port-Olry, Vanuatu");
    expect(locationPhrase("100 km S of Kokopo, Papua New Guinea")).toBe("100 km S of Kokopo, Papua New Guinea");
    expect(locationPhrase("99.9 km S of Kokopo, Papua New Guinea")).toBe("near Kokopo, Papua New Guinea");
    expect(quakeTitle(6, "186 km NW of Port-Olry, Vanuatu")).toBe("M6.0 earthquake 186 km NW of Port-Olry, Vanuatu");
  });

  it("uses plain 'in' for lowercase regions without a sea feature (regression)", () => {
    expect(locationPhrase("southern Xinjiang, China")).toBe("in southern Xinjiang, China");
    expect(locationPhrase("eastern New Guinea region, Papua New Guinea")).toBe("in the eastern New Guinea region, Papua New Guinea");
    expect(locationPhrase("southern East Pacific Rise")).toBe("in the southern East Pacific Rise");
  });

  it("falls back cleanly without a place or magnitude", () => {
    expect(locationPhrase(null)).toBe("");
    expect(locationPhrase("  ")).toBe("");
    expect(quakeTitle(6, null)).toBe("M6.0 earthquake");
    expect(quakeTitle(null, "Greece")).toBe("Earthquake in Greece");
  });
});

describe("eventUpdated", () => {
  it("uses USGS's update time within two days of the quake", () => {
    const q = quake({ time: 0, updated: 2 * DAY });
    expect(eventUpdated(q)).toBe(new Date(2 * DAY).toISOString());
  });

  it("caps a later update at two days after the quake", () => {
    const q = quake({ time: 1000, updated: 1000 + 9 * DAY });
    expect(eventUpdated(q)).toBe(new Date(1000 + 2 * DAY).toISOString());
  });

  it("never moves backwards when USGS edits the event again after two days (regression)", () => {
    // The real M6.0 La Tronosa quake: last edited 1.8 days after it struck.
    const q = parseUsgsFeed(SIGNIFICANT)!.find((x) => x.id === "us6000u1cf")!;
    const before = eventUpdated(q);
    const after = eventUpdated({ ...q, updated: q.time + 3 * DAY });
    expect(Date.parse(after)).toBeGreaterThanOrEqual(Date.parse(before));
  });
});

describe("primaryCountry", () => {
  it("finds the country the quake is in", () => {
    expect(primaryCountry({ lat: 28.0179, lng: 66.1708 }, shapes)).toBe("PK");
    expect(primaryCountry({ lat: 7.5868, lng: -80.769 }, shapes)).toBe("PA");
  });

  it("falls back to the nearest country within 300 km offshore", () => {
    expect(primaryCountry({ lat: -14.0533, lng: 165.6761 }, shapes)).toBe("VU");
    expect(primaryCountry({ lat: 51.9848, lng: 157.2701 }, shapes)).toBe("RU");
  });

  it("gives null in open ocean", () => {
    expect(primaryCountry({ lat: -0.4085, lng: -19.4308 }, shapes)).toBeNull();
  });
});

describe("wantsDetail", () => {
  it("wants ShakeMap and PAGER for magnitude 6+ or a yellow or worse alert", () => {
    expect(wantsDetail(quake({ mag: 6, alert: null }))).toBe(true);
    expect(wantsDetail(quake({ mag: 5.7, alert: "yellow" }))).toBe(true);
    expect(wantsDetail(quake({ mag: 5.9, alert: "green" }))).toBe(false);
    expect(wantsDetail(quake({ mag: null, alert: null }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Detail record links
// ---------------------------------------------------------------------------

describe("shakeMapUrl and pagerUrls", () => {
  it("find the contour, city and exposure files in a real detail record", () => {
    expect(shakeMapUrl(DETAIL_PK)).toBe(PK_CONT_URL);
    expect(pagerUrls(DETAIL_PK)).toEqual({ cities: `${PK_PAGER}/cities.json`, exposures: `${PK_PAGER}/exposures.json` });
  });

  it("prefer the version USGS weights highest and skip deleted ones", () => {
    const version = (weight: number, status: string, url: string) => ({
      preferredWeight: weight,
      status,
      updateTime: 1,
      contents: { "download/cont_mmi.json": { url } },
    });
    const detail = {
      properties: {
        products: {
          shakemap: [
            version(10, "UPDATE", "https://earthquake.usgs.gov/low.json"),
            version(99, "DELETE", "https://earthquake.usgs.gov/deleted.json"),
            version(50, "UPDATE", "https://earthquake.usgs.gov/high.json"),
          ],
        },
      },
    };
    expect(shakeMapUrl(detail)).toBe("https://earthquake.usgs.gov/high.json");
  });

  it("fall back to PAGER's older file names, and ignore links off usgs.gov", () => {
    const detail = {
      properties: {
        products: {
          losspager: [{ contents: { "cities.json": { url: "https://earthquake.usgs.gov/c.json" }, "json/exposures.json": { url: "https://evil.example/e.json" } } }],
          shakemap: [{ contents: { "download/cont_mmi.json": { url: "https://evil.example/x.json" } } }],
        },
      },
    };
    expect(pagerUrls(detail)).toEqual({ cities: "https://earthquake.usgs.gov/c.json", exposures: null });
    expect(shakeMapUrl(detail)).toBeNull();
  });

  it("return null when the products are missing", () => {
    expect(shakeMapUrl(null)).toBeNull();
    expect(shakeMapUrl({ properties: {} })).toBeNull();
    expect(shakeMapUrl({ properties: { products: { shakemap: "x" } } })).toBeNull();
    expect(pagerUrls({})).toEqual({ cities: null, exposures: null });
  });
});

// ---------------------------------------------------------------------------
// ShakeMap contours
// ---------------------------------------------------------------------------

describe("contourRings", () => {
  it("keeps closed lines and drops lines that run off the grid", () => {
    const rings = contourRings(CONT_PK);
    expect(rings.length).toBeGreaterThan(5);
    for (const { ring } of rings) expect(ring[0]).toEqual(ring[ring.length - 1]);
    // MMI 3.0 is a single open line in this file.
    expect(rings.some((r) => r.level === 3)).toBe(false);
    expect(new Set(rings.map((r) => r.level))).toEqual(new Set([3.5, 4, 4.5, 5, 5.5, 6, 6.5]));
  });

  it("reads LineStrings and MultiLineStrings and skips bad input", () => {
    const closed = square(0, 0, 1, true);
    const json = {
      features: [
        { properties: { value: 5 }, geometry: { type: "LineString", coordinates: closed } },
        { properties: { value: 6 }, geometry: { type: "MultiLineString", coordinates: [closed, [[0, 0], [1, 1], [2, 0], [3, 3]]] } },
        { properties: { value: 7 }, geometry: { type: "LineString", coordinates: [[0, 0], ["a", 1], [1, 1], [0, 0]] } },
        { properties: {}, geometry: { type: "LineString", coordinates: closed } },
        { properties: { value: 8 }, geometry: { type: "Polygon", coordinates: [closed] } },
        { properties: { value: 9 }, geometry: { type: "LineString", coordinates: [[0, 0], [1, 0], [0, 0]] } },
        null,
      ],
    };
    expect(contourRings(json).map((r) => r.level)).toEqual([5, 6]);
    expect(contourRings(null)).toEqual([]);
    expect(contourRings({ features: "x" })).toEqual([]);
  });

  it("makes a ring that crosses the antimeridian continuous", () => {
    const ring: Position[] = [
      [179.5, 0],
      [-179.5, 0],
      [-179.5, 1],
      [179.5, 1],
      [179.5, 0],
    ];
    const [r] = contourRings({ features: [{ properties: { value: 5 }, geometry: { type: "LineString", coordinates: ring } }] });
    expect(r.ring.map((p) => p[0])).toEqual([179.5, 180.5, 180.5, 179.5, 179.5]);
  });
});

describe("signedArea2 and outerWinding", () => {
  it("is positive for counter-clockwise rings", () => {
    expect(signedArea2(square(0, 0, 1, false))).toBeCloseTo(2);
    expect(signedArea2(square(0, 0, 1, true))).toBeCloseTo(-2);
  });

  it("takes the winding that holds most of the area as the outer one", () => {
    expect(outerWinding([{ level: 4, ring: square(0, 0, 2, true) }, { level: 4, ring: square(0.5, 0.5, 0.5, false) }])).toBe(-1);
    expect(outerWinding([{ level: 4, ring: square(0, 0, 2, false) }, { level: 4, ring: square(0.5, 0.5, 0.5, true) }])).toBe(1);
    expect(outerWinding([])).toBe(-1);
  });

  it("finds ShakeMap's clockwise convention in real files", () => {
    for (const json of [CONT_PK, CONT_RU, CONT_PA]) expect(outerWinding(contourRings(json))).toBe(-1);
  });
});

describe("pickLevels", () => {
  it("keeps whole intensities from IV up", () => {
    expect(pickLevels([3, 3.5, 4, 4.5, 5, 5, 6.5, 7])).toEqual([4, 5, 7]);
  });

  it("keeps half steps when no whole level is present", () => {
    expect(pickLevels([4.5, 5.5, 3])).toEqual([4.5, 5.5]);
    expect(pickLevels([2, 3.5])).toEqual([]);
  });
});

describe("levelGeometry", () => {
  it("puts holes into their outer ring with GeoJSON winding", () => {
    const g = levelGeometry([square(0, 0, 2, true), square(0.5, 0.5, 0.5, false)], -1)!;
    const [poly] = polygons(g);
    expect(poly).toHaveLength(2);
    expect(signedArea2(poly[0])).toBeGreaterThan(0);
    expect(signedArea2(poly[1])).toBeLessThan(0);
    expect(pointInGeometry(0.75, 0.75, g)).toBe(false);
    expect(pointInGeometry(1.75, 1.75, g)).toBe(true);
  });

  it("gives a hole to the smallest outer ring that holds it, and drops orphan holes and specks", () => {
    const big = square(0, 0, 4, true);
    const island = square(1, 1, 2, true);
    const hole = square(1.5, 1.5, 0.5, false);
    const orphan = square(10, 10, 0.5, false);
    const speck = square(20, 20, 0.01, true);
    const g = levelGeometry([big, island, hole, orphan, speck], -1)!;
    const polys = polygons(g);
    expect(polys).toHaveLength(2);
    const holeCounts = polys.map((p) => p.length - 1).sort();
    expect(holeCounts).toEqual([0, 1]);
    const withHole = polys.find((p) => p.length === 2)!;
    expect(geometryAreaKm2({ type: "Polygon", coordinates: [withHole[0]] })).toBeLessThan(60_000);
  });

  it("is null when only holes are left", () => {
    expect(levelGeometry([square(0, 0, 1, false)], -1)).toBeNull();
    expect(levelGeometry([], -1)).toBeNull();
  });
});

describe("nestedLevels", () => {
  const level = (l: number, x0: number, y0: number, s: number): Area => ({
    kind: "shaking",
    level: l,
    geometry: { type: "Polygon", coordinates: [square(x0, y0, s, false)] },
  });

  it("keeps levels that each enclose the next stronger one", () => {
    const areas = [level(4, 0, 0, 4), level(5, 1, 1, 2), level(6, 1.5, 1.5, 1)];
    expect(nestedLevels(areas).map((a) => a.level)).toEqual([4, 5, 6]);
  });

  it("drops a weaker level that is smaller than, or lies beside, the stronger one", () => {
    const speck = level(4, 0.5, 0.5, 0.1); // stray patch: smaller than V
    const beside = level(4, 10, 10, 5); // big, but nowhere near V
    expect(nestedLevels([speck, level(5, 0, 0, 2), level(6, 0.5, 0.5, 1)]).map((a) => a.level)).toEqual([5, 6]);
    expect(nestedLevels([beside, level(5, 0, 0, 2)]).map((a) => a.level)).toEqual([5]);
  });

  it("compares with the next level that was kept", () => {
    const areas = [level(4, 0, 0, 4), level(5, 3.5, 3.5, 0.2), level(6, 1, 1, 1)];
    expect(nestedLevels(areas).map((a) => a.level)).toEqual([4, 6]);
    expect(nestedLevels([])).toEqual([]);
  });
});

describe("fitAreas", () => {
  const ring = (lat: number, km: number): AreaGeometry => circlePolygon(lat, 100, km, 2000);

  it("lightly simplifies areas that already fit, keeping weakest first", () => {
    const areas: Area[] = [
      { kind: "shaking", level: 6, geometry: ring(10, 20) },
      { kind: "shaking", level: 4, geometry: ring(10, 80) },
    ];
    const out = fitAreas(areas, AREA_BUDGET_BYTES);
    expect(out.map((a) => a.level)).toEqual([4, 6]);
    expect(JSON.stringify(out).length).toBeLessThan(JSON.stringify(areas).length);
  });

  it("shares a tight budget between areas", () => {
    const areas: Area[] = [4, 5, 6].map((level) => ({ kind: "shaking", level, geometry: ring(10, 500 / level) }));
    const out = fitAreas(areas, 3000);
    expect(out).toHaveLength(3);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(3000);
  });

  it("drops the weakest levels when nothing else makes them fit", () => {
    const areas: Area[] = [4, 5, 6].map((level) => ({ kind: "shaking", level, geometry: ring(10, 500 / level) }));
    const out = fitAreas(areas, 120);
    expect(out.map((a) => a.level)).toEqual([6]);
    expect(fitAreas([], 1000)).toEqual([]);
  });
});

describe("contoursToAreas", () => {
  it("turns a real ShakeMap into nested shaking areas around the epicentre", () => {
    const areas = contoursToAreas(CONT_PK);
    expect(areas.map((a) => [a.kind, a.level])).toEqual([
      ["shaking", 4],
      ["shaking", 5],
      ["shaking", 6],
    ]);
    const sizes = areas.map((a) => geometryAreaKm2(a.geometry));
    expect(sizes[0]).toBeGreaterThan(sizes[1]);
    expect(sizes[1]).toBeGreaterThan(sizes[2]);
    for (const a of areas) {
      expect(pointInGeometry(66.1708, 28.0179, a.geometry)).toBe(true);
      for (const poly of polygons(a.geometry)) expect(signedArea2(poly[0])).toBeGreaterThan(0);
    }
  });

  it("keeps the large M7.7 Panama ShakeMap under the byte budget, holes included", () => {
    const areas = contoursToAreas(CONT_PA);
    expect(areas.map((a) => a.level)).toEqual([4, 5, 6, 7]);
    expect(JSON.stringify(areas).length).toBeLessThanOrEqual(AREA_BUDGET_BYTES);
    const holes = areas.flatMap((a) => polygons(a.geometry).flatMap((p) => p.slice(1)));
    expect(holes.length).toBeGreaterThan(0);
    for (const h of holes) expect(signedArea2(h)).toBeLessThan(0);
    // Strong shaking reached the Azuero peninsula towns PAGER lists.
    const vi = areas.find((a) => a.level === 6)!;
    expect(pointInGeometry(-80.2833, 7.7667, vi.geometry)).toBe(true); // Las Tablas
  });

  it("leaves out a level whose contour runs off the ShakeMap grid", () => {
    // The deep M6.9 Kamchatka quake's MMI IV contour only exists as open lines.
    expect(contoursToAreas(CONT_RU).map((a) => a.level)).toEqual([5]);
  });

  it("leaves out a level reduced to stray patches by the grid edge, so the levels nest (regression)", () => {
    // Before: an MMI IV "area" of 13 km2 beside an MMI V area of 10,700 km2.
    const areas = contoursToAreas(CONT_PA_66);
    expect(areas.map((a) => a.level)).toEqual([5, 6]);
    const sizes = areas.map((a) => geometryAreaKm2(a.geometry));
    expect(sizes[0]).toBeGreaterThan(sizes[1]);
    expect(pointInGeometry(-81.444, 7.7013, areas[0].geometry)).toBe(true); // the epicentre
  });

  it("fits a smaller budget and is empty for unusable input", () => {
    const small = contoursToAreas(CONT_PA, 4000);
    expect(JSON.stringify(small).length).toBeLessThanOrEqual(4000);
    expect(small.length).toBeGreaterThan(0);
    expect(contoursToAreas(null)).toEqual([]);
    expect(contoursToAreas({ features: [] })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PAGER
// ---------------------------------------------------------------------------

describe("shakingLabel", () => {
  it("names the intensity class", () => {
    expect(shakingLabel(7.72)).toBe("Severe shaking (intensity VIII)");
    expect(shakingLabel(6.4996)).toBe("Strong shaking (intensity VI)");
    expect(shakingLabel(4.38)).toBe("Light shaking (intensity IV)");
    expect(shakingLabel(12)).toBe("Extreme shaking (intensity X)");
    expect(shakingLabel(0)).toBe("Not felt shaking (intensity I)");
  });
});

describe("pagerCities", () => {
  it("lists the most strongly shaken towns, then the biggest cities that felt it", () => {
    const places = pagerCities(CITIES_PA, shapes, "PA");
    expect(places).toHaveLength(12);
    expect(places[0]).toEqual({
      name: "Tonosi",
      country: "PA",
      lat: 7.4,
      lng: -80.44,
      kind: "town",
      impact: "Severe shaking (intensity VIII)",
      source: "usgs",
    });
    const names = places.map((p) => p.name);
    expect(names).toContain("Panama City");
    expect(names).toContain("David");
    expect(places.find((p) => p.name === "Panama City")!.kind).toBe("city");
    expect(places.every((p) => p.source === "usgs" && p.country === "PA")).toBe(true);
  });

  it("lists towns that felt light shaking", () => {
    const places = pagerCities(CITIES_PK, shapes, "PK");
    expect(places).toEqual([
      { name: "Khuzdar", country: "PK", lat: 27.8, lng: 66.6167, kind: "city", impact: "Light shaking (intensity IV)", source: "usgs" },
    ]);
  });

  it("uses the quake's country for places too small for the globe, and skips bad or weak entries", () => {
    const json = {
      all_cities: [
        { name: "Nuku'alofa", lat: -21.13, lon: -175.2, pop: 23000, iscap: true, mmi: 5.1 },
        { name: "Weak", lat: 13.75, lon: 100.5, pop: 5e6, iscap: true, mmi: 3.9 },
        { name: "", lat: 13.75, lon: 100.5, pop: 1, mmi: 6 },
        { name: "NoLat", lon: 100.5, pop: 1, mmi: 6 },
        null,
      ],
    };
    expect(pagerCities(json, shapes, null)).toEqual([]);
    const places = pagerCities(json, shapes, "FJ");
    expect(places.map((p) => [p.name, p.country, p.kind])).toEqual([["Nuku'alofa", "FJ", "city"]]);
    expect(pagerCities(null, shapes, "PA")).toEqual([]);
    expect(pagerCities({ onepager_cities: [{ name: "Bangkok", lat: 13.75, lon: 100.5, pop: 5e6, mmi: 4.2 }] }, shapes, null)[0].country).toBe("TH");
  });
});

describe("formatPeople", () => {
  it("rounds head counts for readers", () => {
    expect(formatPeople(0)).toBe("0");
    expect(formatPeople(999)).toBe("999");
    expect(formatPeople(38_692)).toBe("39,000");
    expect(formatPeople(815_434)).toBe("815,000");
    expect(formatPeople(999_600)).toBe("1.0 million");
    expect(formatPeople(2_680_784)).toBe("2.7 million");
  });
});

describe("pagerExposure", () => {
  it("lists the countries that felt moderate shaking and the people in strong shaking", () => {
    const out = pagerExposure(EXPOSURE_PA, shapes, "https://earthquake.usgs.gov/earthquakes/eventpage/us6000u18k");
    expect(out.countries).toEqual(["PA", "CR"]);
    expect(out.figures).toEqual([
      {
        label: "People exposed to strong shaking or worse (estimate)",
        value: "815,000",
        sourceName: PAGER_SOURCE,
        sourceUrl: "https://earthquake.usgs.gov/earthquakes/eventpage/us6000u18k/pager",
      },
    ]);
  });

  it("reads a single-country quake", () => {
    const out = pagerExposure(EXPOSURE_PK, shapes, "https://x");
    expect(out.countries).toEqual(["PK"]);
    expect(out.figures[0].value).toBe("39,000");
  });

  it("falls back to moderate shaking, skips unknown codes, and is empty for bad input", () => {
    const mmi = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const json = {
      population_exposure: {
        mmi,
        aggregated_exposure: [0, 0, 0, 900, 5000, 0, 0, 0, 0, 0],
        country_exposures: [
          { country_code: "zz", exposure: [0, 0, 0, 0, 4000, 0, 0, 0, 0, 0] },
          { country_code: "th", exposure: [0, 0, 0, 0, 1000, 0, 0, 0, 0, 0] },
          { country_code: "LA", exposure: [0, 0, 0, 900, 999, 0, 0, 0, 0, 0] },
        ],
      },
    };
    const out = pagerExposure(json, shapes, "https://x");
    expect(out.countries).toEqual(["TH"]);
    expect(out.figures[0].label).toBe("People exposed to moderate shaking or worse (estimate)");
    expect(out.figures[0].value).toBe("5,000");
    const fewStrong = { population_exposure: { mmi, aggregated_exposure: [0, 0, 0, 0, 20_000, 400, 100, 0, 0, 0], country_exposures: [] } };
    expect(pagerExposure(fewStrong, shapes, "https://x").figures.map((f) => [f.label, f.value])).toEqual([
      ["People exposed to moderate shaking or worse (estimate)", "21,000"],
    ]);
    const none = { population_exposure: { mmi, aggregated_exposure: [0, 0, 7000, 9000, 600, 4, 0, 0, 0, 0], country_exposures: [] } };
    expect(pagerExposure(none, shapes, "https://x").figures).toEqual([]);
    expect(pagerExposure(null, shapes, "https://x")).toEqual({ countries: [], figures: [] });
    expect(pagerExposure({ population_exposure: { mmi: "x" } }, shapes, "https://x")).toEqual({ countries: [], figures: [] });
  });
});

// ---------------------------------------------------------------------------
// Detail fetching and reuse
// ---------------------------------------------------------------------------

describe("emptyExtras and extrasFromPrevious", () => {
  it("reads back areas, cities, countries and PAGER figures, not the epicentre or felt reports", () => {
    expect(emptyExtras()).toEqual({ areas: [], cities: [], countries: [], figures: [] });
    const prev = previousEvent();
    const x = extrasFromPrevious(prev);
    expect(x.areas).toBe(prev.areas);
    expect(x.cities.map((p) => p.name)).toEqual(["Khuzdar"]);
    expect(x.countries).toEqual(["PK"]);
    expect(x.figures.map((f) => f.sourceName)).toEqual([PAGER_SOURCE]);
    expect(extrasFromPrevious(previousEvent({ places: undefined, figures: undefined })).cities).toEqual([]);
  });

  it("reads missing lists as empty instead of throwing", () => {
    const broken = { ...previousEvent(), areas: undefined, countries: undefined, places: [null], figures: "x" } as unknown as SourceEvent;
    expect(extrasFromPrevious(broken)).toEqual(emptyExtras());
  });
});

describe("isPreviousUsgs", () => {
  it("accepts a well-formed USGS report and rejects anything else read back from disk", () => {
    expect(isPreviousUsgs(previousEvent())).toBe(true);
    expect(isPreviousUsgs(null)).toBe(false);
    expect(isPreviousUsgs("x")).toBe(false);
    expect(isPreviousUsgs({ ...previousEvent(), source: "gdacs" })).toBe(false);
    expect(isPreviousUsgs({ ...previousEvent(), sourceId: 5 })).toBe(false);
    expect(isPreviousUsgs({ ...previousEvent(), started: undefined })).toBe(false);
    expect(isPreviousUsgs({ ...previousEvent(), areas: undefined })).toBe(false);
    expect(isPreviousUsgs({ ...previousEvent(), countries: null })).toBe(false);
    expect(isPreviousUsgs({ ...previousEvent(), links: {} })).toBe(false);
  });
});

describe("stableSourceId", () => {
  it("keeps the previous run's id while it is still one of the event's ids", () => {
    const q = quake({ id: "aka2026tuxgky", ids: ["aka2026tuxgky", "us6000u0ju"] });
    expect(stableSourceId([previousEvent({ sourceId: "us6000u0ju" })], q)).toBe("us6000u0ju");
    expect(stableSourceId([previousEvent({ sourceId: "aka2026tuxgky" })], q)).toBe("aka2026tuxgky");
    expect(stableSourceId([previousEvent({ sourceId: "other" })], q)).toBe("aka2026tuxgky");
    expect(stableSourceId([], q)).toBe("aka2026tuxgky");
  });
});

describe("findPrevious", () => {
  it("matches on the preferred id, then on any other id USGS lists", () => {
    const a = previousEvent({ sourceId: "ak0001" });
    const b = previousEvent({ sourceId: "us0002" });
    expect(findPrevious([a, b], quake({ id: "us0002" }))).toBe(b);
    expect(findPrevious([a, b], quake({ id: "us0003", ids: ["us0003", "ak0001"] }))).toBe(a);
    expect(findPrevious([a, b], quake({ id: "nope" }))).toBeUndefined();
  });
});

describe("fallbackDetail", () => {
  const partial: QuakeExtras = { ...emptyExtras(), cities: [{ name: "X", country: "PK", lat: 1, lng: 1, kind: "town", source: "usgs" }] };

  it("prefers the previous run's extras and revision", () => {
    const prev = previousEvent();
    expect(fallbackDetail(partial, prev)).toEqual({ extras: extrasFromPrevious(prev), revision: PK_UPDATED });
  });

  it("keeps what was read when the previous run had nothing, without a revision", () => {
    const prev = previousEvent({ areas: [], places: [], figures: [] });
    expect(fallbackDetail(partial, prev)).toEqual({ extras: partial });
    expect(fallbackDetail(partial, undefined)).toEqual({ extras: partial });
    expect(fallbackDetail(emptyExtras(), prev).revision).toBe(PK_UPDATED);
  });
});

describe("fetchDetail", () => {
  const pk = () => parseUsgsFeed(SIGNIFICANT)!.find((q) => q.id === "us6000u2y1")!;

  it("reads ShakeMap areas and PAGER cities, countries and figures, pacing every request", async () => {
    const { deps, sleep, calls } = fakeDeps(PK_ROUTES);
    const { extras, complete } = await fetchDetail(pk(), "PK", shapes, deps, pacer(deps, DETAIL_GAP_MS));
    expect(complete).toBe(true);
    expect(calls).toEqual([PK_DETAIL_URL, PK_CONT_URL, `${PK_PAGER}/cities.json`, `${PK_PAGER}/exposures.json`]);
    expect(sleep.mock.calls).toEqual([[300], [300], [300]]);
    expect(extras.areas.map((a) => a.level)).toEqual([4, 5, 6]);
    expect(extras.cities.map((c) => c.name)).toEqual(["Khuzdar"]);
    expect(extras.countries).toEqual(["PK"]);
    expect(extras.figures[0].sourceUrl).toBe("https://earthquake.usgs.gov/earthquakes/eventpage/us6000u2y1/pager");
  });

  it("is incomplete but keeps the rest when the ShakeMap file fails", async () => {
    const { deps } = fakeDeps({ ...PK_ROUTES, [PK_CONT_URL]: { status: 500 } });
    const { extras, complete } = await fetchDetail(pk(), "PK", shapes, deps, pacer(deps, DETAIL_GAP_MS));
    expect(complete).toBe(false);
    expect(extras.areas).toEqual([]);
    expect(extras.cities).toHaveLength(1);
  });

  it("is empty and incomplete when the detail record fails", async () => {
    const { deps, calls } = fakeDeps({});
    const out = await fetchDetail(pk(), "PK", shapes, deps, pacer(deps, DETAIL_GAP_MS));
    expect(out).toEqual({ extras: emptyExtras(), complete: false });
    expect(calls).toEqual([PK_DETAIL_URL, PK_DETAIL_URL]);
  });

  it("never throws when a file cannot be processed", async () => {
    const { deps, log } = fakeDeps(PK_ROUTES);
    const out = await fetchDetail(pk(), "PK", null as unknown as CountryShape[], deps, pacer(deps, DETAIL_GAP_MS));
    expect(out.complete).toBe(false);
    expect(log.mock.calls.some(([m]) => m.includes("detail could not be read"))).toBe(true);
  });

  it("is complete with nothing to add when USGS has no ShakeMap or PAGER yet", async () => {
    const { deps, calls } = fakeDeps({ [PK_DETAIL_URL]: { properties: { products: {} } } });
    const out = await fetchDetail(pk(), "PK", shapes, deps, pacer(deps, DETAIL_GAP_MS));
    expect(out).toEqual({ extras: emptyExtras(), complete: true });
    expect(calls).toHaveLength(1);
  });
});

describe("loadDetails", () => {
  it("reuses the previous run while USGS's update time is unchanged", async () => {
    const { deps, fetch } = fakeDeps(PK_ROUTES);
    const q = quake({ id: "us6000u2y1", updated: Number(PK_UPDATED), alert: "yellow" });
    const prev = previousEvent();
    const out = await loadDetails([{ q, country: "PK" }], [prev], shapes, deps);
    expect(fetch).not.toHaveBeenCalled();
    expect(out.get("us6000u2y1")).toEqual({ extras: extrasFromPrevious(prev), revision: PK_UPDATED });
  });

  it("fetches again when USGS has updated the event, and records the new revision", async () => {
    const { deps, calls } = fakeDeps(PK_ROUTES);
    const q = parseUsgsFeed(SIGNIFICANT)!.find((x) => x.id === "us6000u2y1")!;
    const out = await loadDetails([{ q, country: "PK" }], [previousEvent({ revision: "1" })], shapes, deps);
    expect(calls[0]).toBe(PK_DETAIL_URL);
    expect(out.get("us6000u2y1")!.revision).toBe(PK_UPDATED);
    expect(out.get("us6000u2y1")!.extras.areas.map((a) => a.level)).toEqual([4, 5, 6]);
  });

  it("keeps the previous run's extras when the fetch fails", async () => {
    const { deps } = fakeDeps({});
    const q = quake({ id: "us6000u2y1", updated: 99, alert: "yellow" });
    const prev = previousEvent();
    const out = await loadDetails([{ q, country: "PK" }], [prev], shapes, deps);
    expect(out.get("us6000u2y1")).toEqual({ extras: extrasFromPrevious(prev), revision: PK_UPDATED });
  });

  it("fetches at most MAX_DETAIL_FETCHES events, most significant first, and skips quakes that need no detail", async () => {
    const located = Array.from({ length: 20 }, (_, i) => ({ q: quake({ id: `q${i}`, sig: 600 + i, mag: 6.5 }), country: "TH" }));
    const { deps, calls } = fakeDeps(Object.fromEntries(located.map(({ q }) => [q.detail, { properties: { products: {} } }])));
    located.push({ q: quake({ id: "small", mag: 5.6, alert: "green" }), country: "TH" });
    const out = await loadDetails(located, [], shapes, deps);
    const fetchedIds = [...new Set(calls.map((u) => /detail\/(.+)\.geojson/.exec(u)![1]))];
    expect(fetchedIds).toHaveLength(MAX_DETAIL_FETCHES);
    expect(fetchedIds[0]).toBe("q19");
    expect(fetchedIds).not.toContain("q0");
    expect(out.get("q0")).toEqual({ extras: emptyExtras() });
    expect(out.get("q19")!.revision).toBe(String(located[19].q.updated));
    expect(out.has("small")).toBe(false);
  });

  it("stops fetching after MAX_FAILED_DETAILS events fail in a row, keeping the previous run's extras (regression)", async () => {
    // USGS answering nothing: without the stop, 15 events x 2 attempts x 30 s timeouts.
    const { deps, calls, log } = fakeDeps({});
    const located = Array.from({ length: 8 }, (_, i) => ({ q: quake({ id: `q${i}`, sig: 700 - i, mag: 6.5 }), country: "TH" }));
    const prev = previousEvent({ sourceId: "q7", revision: "old" });
    const out = await loadDetails(located, [prev], shapes, deps);
    const fetchedIds = [...new Set(calls.map((u) => /detail\/(.+)\.geojson/.exec(u)![1]))];
    expect(fetchedIds).toEqual(["q0", "q1", "q2"].slice(0, MAX_FAILED_DETAILS));
    expect(log.mock.calls.some(([m]) => m.includes("failed in a row"))).toBe(true);
    expect(out.get("q7")).toEqual({ extras: extrasFromPrevious(prev), revision: "old" });
    expect(out.get("q5")).toEqual({ extras: emptyExtras() });
  });

  it("starts counting again after a detail fetch works", async () => {
    const located = Array.from({ length: 6 }, (_, i) => ({ q: quake({ id: `q${i}`, sig: 700 - i, mag: 6.5 }), country: "TH" }));
    // q0, q1 fail; q2 works; q3, q4 fail; q5 is still fetched.
    const { deps, calls } = fakeDeps({ [located[2].q.detail]: { properties: { products: {} } } });
    await loadDetails(located, [], shapes, deps);
    expect(new Set(calls.map((u) => /detail\/(.+)\.geojson/.exec(u)![1])).size).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

describe("toSourceEvent", () => {
  it("builds the full report for a quake with detail extras", () => {
    const q = parseUsgsFeed(SIGNIFICANT)!.find((x) => x.id === "us6000u2y1")!;
    const city: Place = { name: "Khuzdar", country: "PK", lat: 27.8, lng: 66.6167, kind: "city", impact: "Light shaking (intensity IV)", source: "usgs" };
    const area: Area = { kind: "shaking", level: 5, geometry: circlePolygon(28, 66.2, 20) };
    const figure = { label: "People exposed", value: "39,000", sourceName: PAGER_SOURCE, sourceUrl: "https://x/pager" };
    const e = toSourceEvent(q, "PK", { extras: { areas: [area], cities: [city], countries: ["PK", "AF"], figures: [figure] }, revision: PK_UPDATED });
    expect(e).toEqual({
      source: "usgs",
      sourceId: "us6000u2y1",
      type: "earthquake",
      title: "M5.7 earthquake near Khuzdar, Pakistan",
      severity: 2,
      severityText: "Magnitude 5.7, depth 10 km",
      countries: ["PK", "AF"],
      lat: 28.0179,
      lng: 66.1708,
      precision: "exact",
      started: new Date(1792213617657).toISOString(),
      updated: new Date(1792300436039).toISOString(),
      areas: [area],
      places: [
        { name: "Epicentre", country: "PK", lat: 28.0179, lng: 66.1708, kind: "site", impact: "48 km WNW of Khuzdar, Pakistan", source: "usgs" },
        city,
      ],
      figures: [
        figure,
        { label: "Felt reports sent to USGS", value: "2", sourceName: "USGS Did You Feel It?", sourceUrl: "https://earthquake.usgs.gov/earthquakes/eventpage/us6000u2y1/dyfi" },
      ],
      links: [{ name: "USGS event page", url: "https://earthquake.usgs.gov/earthquakes/eventpage/us6000u2y1" }],
      revision: PK_UPDATED,
    });
  });

  it("puts the primary country first and adds the tsunami link", () => {
    const e = toSourceEvent(quake({ tsunami: true, felt: 12345 }), "TH", { extras: { ...emptyExtras(), countries: ["MM", "TH"] } });
    expect(e.countries).toEqual(["TH", "MM"]);
    expect(e.links.map((l) => l.url)).toContain("https://www.tsunami.gov/");
    expect(e.figures![0].value).toBe("12,345");
    expect(e.revision).toBeUndefined();
  });

  it("has no epicentre place or country for a severe quake far out at sea", () => {
    const e = toSourceEvent(quake({ alert: "red", felt: null, place: null }), null, { extras: emptyExtras(), revision: "5" });
    expect(e.countries).toEqual([]);
    expect(e.places).toEqual([]);
    expect(e.figures).toBeUndefined();
    expect(e.title).toBe("M6.2 earthquake");
    expect(e.severity).toBe(3);
  });
});

describe("carryOver", () => {
  it("keeps recent previous quakes the working feed does not list", () => {
    const now = NOW;
    const at = (days: number) => new Date(Date.parse(now) - days * DAY).toISOString();
    const prev = [
      previousEvent({ sourceId: "listed", started: at(1) }),
      previousEvent({ sourceId: "minor-13d", severity: 1, started: at(13) }),
      previousEvent({ sourceId: "minor-15d", severity: 1, started: at(15) }),
      previousEvent({ sourceId: "major-20d", severity: 2, started: at(20) }),
      previousEvent({ sourceId: "major-22d", severity: 3, started: at(22) }),
      { ...previousEvent({ sourceId: "other-source", started: at(1) }), source: "gdacs" as const },
    ];
    expect(carryOver(prev, new Set(["listed"]), now).map((e) => e.sourceId)).toEqual(["minor-13d", "major-20d"]);
  });
});

// ---------------------------------------------------------------------------
// fetchUsgs end to end
// ---------------------------------------------------------------------------

describe("fetchUsgs", () => {
  const feedRoutes = { [USGS_FEEDS[0]]: SIGNIFICANT, [USGS_FEEDS[1]]: WEEK };

  it("returns null only when both feeds fail", async () => {
    const { deps, calls, sleep } = fakeDeps({});
    expect(await fetchUsgs(deps, NOW, shapes)).toBeNull();
    expect(calls).toEqual([USGS_FEEDS[0], USGS_FEEDS[0], USGS_FEEDS[1], USGS_FEEDS[1]]);
    expect(sleep).toHaveBeenCalledWith(5000);
  });

  it("treats a body that is not a feed as a failure", async () => {
    const { deps, log } = fakeDeps({ [USGS_FEEDS[0]]: { hello: 1 }, [USGS_FEEDS[1]]: [] });
    expect(await fetchUsgs(deps, NOW, shapes)).toBeNull();
    expect(log.mock.calls.some(([m]) => m.includes("not a GeoJSON FeatureCollection"))).toBe(true);
  });

  /** Every fixture quake's detail record answers "no products yet", except Pakistan's (real files) and Panama's M7.7 (fails). */
  const detailRoutes: Record<string, Route> = Object.fromEntries(
    [...parseUsgsFeed(SIGNIFICANT)!, ...parseUsgsFeed(WEEK)!]
      .filter((q) => q.id !== "us6000u18k")
      .map((q) => [q.detail, { properties: { products: {} } }]),
  );

  it("turns the real feeds into current earthquake reports with ShakeMap areas and PAGER places", async () => {
    const { deps, sleep } = fakeDeps({ ...feedRoutes, ...detailRoutes, ...PK_ROUTES });
    const events = (await fetchUsgs(deps, NOW, shapes))!;
    const ids = events.map((e) => e.sourceId);

    // Recent strong quakes on land or near a coast are in.
    expect(ids).toEqual(expect.arrayContaining(["us6000u2y1", "us6000u18k", "us6000u2mq", "us6000u3bc", "us6000u24c"]));
    // Mid-ocean ridge quakes far from any country are out, as are old or small ones.
    expect(ids).not.toContain("us6000u214");
    expect(ids).not.toContain("us6000u1z5");
    expect(ids).not.toContain("us6000tz1y"); // M4.7 Australia, 17 days ago
    expect(ids).not.toContain("us6000u3db"); // M4.6, too small
    expect(new Set(ids).size).toBe(ids.length);
    // Newest first.
    const started = events.map((e) => e.started);
    expect([...started].sort().reverse()).toEqual(started);

    const pk = events.find((e) => e.sourceId === "us6000u2y1")!;
    expect(pk.areas.map((a) => a.level)).toEqual([4, 5, 6]);
    expect(pk.places!.map((p) => p.name)).toEqual(["Epicentre", "Khuzdar"]);
    expect(pk.countries).toEqual(["PK"]);
    expect(pk.revision).toBe(PK_UPDATED);
    expect(pk.severity).toBe(2);

    const panama = events.find((e) => e.sourceId === "us6000u18k")!;
    expect(panama).toMatchObject({ severity: 3, countries: ["PA"], title: "M7.7 earthquake near Pitaloza Arriba, Panama", areas: [] });
    expect(panama.revision).toBeUndefined(); // its detail could not be read, so the next run tries again

    expect(sleep).toHaveBeenCalledWith(DETAIL_GAP_MS);
    for (const e of events) {
      expect(e.source).toBe("usgs");
      expect(e.type).toBe("earthquake");
      expect(e.precision).toBe("exact");
      expect(e.links[0].name).toBe("USGS event page");
    }
  });

  it("does not fetch details the previous run already has", async () => {
    const { deps, calls } = fakeDeps(feedRoutes);
    const prev = previousEvent();
    const events = (await fetchUsgs(deps, NOW, shapes, [prev]))!;
    expect(calls).not.toContain(PK_DETAIL_URL);
    const pk = events.find((e) => e.sourceId === "us6000u2y1")!;
    expect(pk.areas).toEqual(prev.areas);
    expect(pk.places!.map((p) => p.name)).toEqual(["Epicentre", "Khuzdar"]);
  });

  it("keeps the previous run's quakes the failed feed would have listed", async () => {
    const { deps } = fakeDeps({ [USGS_FEEDS[1]]: WEEK });
    const old = previousEvent({ sourceId: "us6000old", severity: 2, started: new Date(Date.parse(NOW) - 12 * DAY).toISOString() });
    const events = (await fetchUsgs(deps, NOW, shapes, [old]))!;
    expect(events.map((e) => e.sourceId)).toContain("us6000old");
    expect(events.map((e) => e.sourceId)).toContain("us6000u3bc");
  });

  it("does not carry over when both feeds worked", async () => {
    const { deps } = fakeDeps(feedRoutes);
    const old = previousEvent({ sourceId: "us6000old", started: new Date(Date.parse(NOW) - DAY).toISOString() });
    const events = (await fetchUsgs(deps, NOW, shapes, [old]))!;
    expect(events.map((e) => e.sourceId)).not.toContain("us6000old");
  });

  it("keeps severe quakes at sea, drops minor ones, and never assigns Antarctica", async () => {
    const t = Date.parse(NOW) - DAY;
    const feed = featureCollection([
      feature({ id: "sea-red", alert: "red", mag: 7.9, lat: -0.4, lng: -19.4, time: t }),
      feature({ id: "sea-green", alert: "green", mag: 6.8, lat: -0.4, lng: -19.4, time: t }),
      feature({ id: "antarctica", alert: "green", mag: 6.2, lat: -64.5, lng: -62, time: t }),
      feature({ id: "blast", mag: 6, type: "quarry blast", time: t }),
    ]);
    const { deps } = fakeDeps({ [USGS_FEEDS[0]]: feed, [USGS_FEEDS[1]]: featureCollection([]) });
    const events = (await fetchUsgs(deps, NOW, shapes))!;
    expect(events.map((e) => e.sourceId)).toEqual(["sea-red"]);
    expect(events[0].countries).toEqual([]);
  });

  it("keeps a yellow-alert quake on an island state the globe has no shape for (regression)", async () => {
    // The real Tonga quake us6000u37h's position: the nearest globe country, Fiji, is over 800 km away.
    const t = Date.parse(NOW) - DAY;
    const feed = featureCollection([
      feature({ id: "tonga-yellow", alert: "yellow", mag: 7.1, lat: -21.541, lng: -174.2956, time: t }),
      feature({ id: "tonga-green", alert: "green", mag: 6.1, lat: -21.541, lng: -174.2956, time: t - 1000 }),
    ]);
    const { deps } = fakeDeps({ [USGS_FEEDS[0]]: feed, [USGS_FEEDS[1]]: featureCollection([]) });
    const events = (await fetchUsgs(deps, NOW, shapes))!;
    expect(events.map((e) => [e.sourceId, e.severity, e.countries])).toEqual([["tonga-yellow", 2, []]]);
  });

  it("keeps reporting a quake under the previous run's id after USGS switches its preferred id (regression)", async () => {
    const sig = SIGNIFICANT as { features: { id: string; properties: Record<string, unknown> }[] };
    const alaska = sig.features.find((f) => f.id === "aka2026tuxgky")!;
    const now = new Date((alaska.properties.time as number) + DAY).toISOString();
    const { deps } = fakeDeps({ [USGS_FEEDS[0]]: featureCollection([alaska]), [USGS_FEEDS[1]]: featureCollection([]) });
    const prev = previousEvent({ sourceId: "us6000u0ju", started: new Date(alaska.properties.time as number).toISOString() });
    const events = (await fetchUsgs(deps, now, shapes, [prev]))!;
    expect(events.map((e) => e.sourceId)).toEqual(["us6000u0ju"]);
    expect(events[0].links[0].url).toBe("https://earthquake.usgs.gov/earthquakes/eventpage/aka2026tuxgky");
  });

  it("skips malformed previous-run entries instead of throwing (regression)", async () => {
    const { deps } = fakeDeps(feedRoutes);
    const junk = [null, 5, { source: "usgs" }, { ...previousEvent({ sourceId: "us6000old" }), areas: undefined }, previousEvent()];
    const events = (await fetchUsgs(deps, NOW, shapes, junk as unknown as SourceEvent[]))!;
    expect(events.find((e) => e.sourceId === "us6000u2y1")!.areas).toEqual(previousEvent().areas);
  });
});
