import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { FetchDeps } from "../googlenews";
import { USER_AGENT } from "../googlenews";
import { centroidOf, circlePolygon, countryAt, geometryAreaKm2, loadCountryShapes, pointInGeometry } from "./geo";
import type { SourceEvent } from "./types";
import {
  AREA_BUDGET_BYTES,
  EONET_URL,
  FIRE_MAX_AGE_DAYS,
  MIN_FIRE_ACRES,
  MIN_FIRE_RADIUS_KM,
  RETRY_MS,
  STORM_MAX_AGE_DAYS,
  burnedAcres,
  collapse,
  countriesNear,
  countyLabel,
  decodeEntities,
  dedupeEvents,
  eventType,
  eventsFromFeed,
  fetchEonet,
  fireEvent,
  fireLocated,
  fireRadiusKm,
  fireSeverity,
  fireSeverityText,
  fireTitle,
  getJson,
  isPrescribedFire,
  isTropicalCyclone,
  kmToCountries,
  knotsOf,
  knotsToKmh,
  matchName,
  orientPolygons,
  otherEvent,
  parseEonetFeed,
  parseEvent,
  parseGeometry,
  pickCategory,
  polygonAreas,
  quakeSeverityText,
  sourceLinks,
  stormCountries,
  stormEvent,
  stormName,
  stormSeverity,
  stormSeverityText,
  stripGdacsNumber,
  swapAxes,
  swapRawAxes,
  thousands,
  tidyCaps,
  titleCountries,
  titleCountry,
  toSourceEvent,
  volcanoName,
  type EonetEvent,
  type EonetGeometry,
} from "./eonet";

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

/** Reads a trimmed real EONET response saved under fixtures/. */
function fixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", name), "utf8"));
}

/** Open events of the past 30 days: storms with full tracks, wildfires (some prescribed), an iceberg. */
const OPEN = fixture("eonet-open.json");
/** Wildfires from the full open list: big ones, duplicates, prescribed burns, GDACS-sourced ones. */
const FIRES = fixture("eonet-wildfires.json");
/** Open volcanoes. */
const VOLCANOES = fixture("eonet-volcanoes.json");
/** Floods, dust, heat and cold waves, snow, a landslide event and an earthquake (polygons and points). */
const OTHER = fixture("eonet-other.json");
/**
 * Live-data quirks: GDACS flood polygons written [lat, lng] (some only valid
 * swapped, some valid both ways), correct ones, HTML entities in titles,
 * IRWIN placeholder points and man-made events filed under a natural category.
 */
const QUIRKS = fixture("eonet-quirks.json");

/** When eonet-open.json was fetched. */
const OPEN_NOW = "2026-10-19T21:50:00Z";

const shapes = loadCountryShapes();

/** The parsed events of a fixture. */
function events(doc: unknown): EonetEvent[] {
  const out = parseEonetFeed(doc);
  if (!out) throw new Error("fixture did not parse");
  return out;
}

/** One parsed event of a fixture by EONET id. */
function event(doc: unknown, id: string): EonetEvent {
  const e = events(doc).find((x) => x.id === id);
  if (!e) throw new Error(`no ${id} in fixture`);
  return e;
}

/** A hand-made geometry entry. */
function geom(date: string, point: [number, number], magnitude: number | null = null, unit: string | null = null): EonetGeometry {
  return { date: new Date(date).toISOString(), time: Date.parse(date), point, magnitude, unit };
}

/** A hand-made event. */
function makeEvent(over: Partial<EonetEvent> & Pick<EonetEvent, "category" | "geometry">): EonetEvent {
  return { id: "EONET_1", title: "Test event", description: null, closed: null, sources: [], ...over };
}

/** A SourceEvent with just the fields dedupeEvents reads. */
function source(over: Partial<SourceEvent>): SourceEvent {
  return {
    source: "eonet",
    sourceId: "EONET_1",
    type: "wildfire",
    title: "Hawk Fire, Washoe County, Nevada",
    severity: 1,
    countries: ["US"],
    lat: 39.5425,
    lng: -119.952333,
    precision: "exact",
    started: "2026-08-22T14:45:00.000Z",
    updated: "2026-08-22T14:45:00.000Z",
    areas: [],
    links: [],
    ...over,
  };
}

/** A Response-like object for the fake fetch. */
function response(body: string, status = 200): Response {
  return new Response(body, { status });
}

/** Fake network deps: each call returns (or throws) the next item of `replies`. */
function fakeDeps(replies: (Response | Error)[]) {
  const queue = [...replies];
  const fetch = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(async () => {
    const next = queue.shift();
    if (!next) throw new Error("no more replies");
    if (next instanceof Error) throw next;
    return next;
  });
  const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
  const log = vi.fn<(msg: string) => void>();
  return { fetch, sleep, log } satisfies FetchDeps;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe("collapse", () => {
  it("trims and folds whitespace, including non-breaking spaces", () => {
    expect(collapse("  Popocatepetl Volcano, Mexico ")).toBe("Popocatepetl Volcano, Mexico");
    expect(collapse("RX  NKRD")).toBe("RX NKRD");
  });

  it("gives an empty string for anything that is not a string", () => {
    expect(collapse(null)).toBe("");
    expect(collapse(42)).toBe("");
  });
});

describe("decodeEntities", () => {
  it("decodes the entities EONET leaves in titles", () => {
    expect(decodeEntities("Flood in Cote d&#039;Ivoire 1104194")).toBe("Flood in Cote d'Ivoire 1104194");
    expect(decodeEntities("Flood in Bosnia &amp; Herzegovina")).toBe("Flood in Bosnia & Herzegovina");
    expect(decodeEntities("&quot;A&quot; &lt;b&gt; &#x27;c&#X27; &apos;d&apos;")).toBe(`"A" <b> 'c' 'd'`);
  });

  it("decodes once and keeps unknown or invalid entities", () => {
    expect(decodeEntities("&amp;#039;")).toBe("&#039;");
    expect(decodeEntities("&bogus; &#0; AT&T")).toBe("&bogus; &#0; AT&T");
  });
});

describe("pickCategory", () => {
  it("files any event that is also man-made as man-made", () => {
    expect(pickCategory(["dustHaze", "manmade"])).toBe("manmade");
    expect(pickCategory(["floods", "manmade"])).toBe("manmade");
  });

  it("takes the first category that is not skipped", () => {
    expect(pickCategory(["floods", "landslides"])).toBe("floods");
    expect(pickCategory(["seaLakeIce", "snow"])).toBe("snow");
    expect(pickCategory(["waterColor"])).toBe("waterColor");
    expect(pickCategory([])).toBe("");
  });
});

describe("swapRawAxes and swapAxes", () => {
  it("swaps every position of raw polygon coordinates, keeping extra values", () => {
    expect(swapRawAxes([[[1, 2], [3, 4, 9]]])).toEqual([[[2, 1], [4, 3, 9]]]);
    expect(swapRawAxes("nope")).toBe("nope");
    expect(swapRawAxes([[[1]], "x"])).toEqual([[[1]], "x"]);
  });

  it("swaps a geometry and validates the result", () => {
    const g = swapAxes({ type: "Polygon", coordinates: [[[10, 20], [12, 20], [12, 22], [10, 20]]] });
    expect(g).toEqual({ type: "Polygon", coordinates: [[[20, 10], [20, 12], [22, 12], [20, 10]]] });
    // Longitudes past 90 cannot be latitudes.
    expect(swapAxes({ type: "Polygon", coordinates: [[[100, 10], [120, 10], [120, 20], [100, 10]]] })).toBeNull();
    const multi = swapAxes({ type: "MultiPolygon", coordinates: [[[[1, 2], [3, 2], [3, 4], [1, 2]]]] });
    expect(multi?.type).toBe("MultiPolygon");
  });
});

describe("parseGeometry", () => {
  it("reads a point with its magnitude", () => {
    const g = parseGeometry({ magnitudeValue: 140, magnitudeUnit: "kts", date: "2026-10-19T12:00:00Z", type: "Point", coordinates: [137.6, 14.8] });
    expect(g).toEqual({ date: "2026-10-19T12:00:00.000Z", time: Date.parse("2026-10-19T12:00:00Z"), point: [137.6, 14.8], magnitude: 140, unit: "kts" });
  });

  it("reads a polygon as its centroid plus the polygon", () => {
    const ring = [[10, 10], [12, 10], [12, 12], [10, 12], [10, 10]];
    const g = parseGeometry({ magnitudeValue: null, magnitudeUnit: null, date: "2026-10-16T20:00:00Z", type: "Polygon", coordinates: [ring] });
    expect(g?.polygon?.type).toBe("Polygon");
    expect(g?.point[0]).toBeCloseTo(11, 1);
    expect(g?.point[1]).toBeCloseTo(11, 1);
    expect(g?.magnitude).toBeNull();
    expect(g?.unit).toBeNull();
  });

  it("brings a longitude past 180 back into range", () => {
    expect(parseGeometry({ date: "2026-10-19T00:00:00Z", type: "Point", coordinates: [190, 10] })?.point).toEqual([-170, 10]);
  });

  it("reads a polygon written [lat, lng] swapped when only that is valid", () => {
    // GDACS flood in Japan: [35.27, 139.67] cannot be [lng, lat].
    const raw = (QUIRKS as { events: { id: string; geometry: unknown[] }[] }).events.find((e) => e.id === "EONET_24723")!;
    const g = parseGeometry(raw.geometry[0]);
    expect(g?.polygon).toBeDefined();
    expect(countryAt(g!.point[1], g!.point[0], shapes)).toBe("JP");
    expect(g!.point[0]).toBeCloseTo(139.67, 1);
  });

  it("rejects bad dates, coordinates and geometry types", () => {
    expect(parseGeometry({ date: "soon", type: "Point", coordinates: [1, 2] })).toBeNull();
    expect(parseGeometry({ date: "2026-10-19T00:00:00Z", type: "Point", coordinates: [1, 95] })).toBeNull();
    expect(parseGeometry({ date: "2026-10-19T00:00:00Z", type: "Point", coordinates: ["1", 2] })).toBeNull();
    expect(parseGeometry({ date: "2026-10-19T00:00:00Z", type: "LineString", coordinates: [[1, 2], [3, 4]] })).toBeNull();
    expect(parseGeometry({ date: "2026-10-19T00:00:00Z", type: "Polygon", coordinates: [[[1, 2], [3, 4]]] })).toBeNull();
    expect(parseGeometry(null)).toBeNull();
  });
});

describe("parseEvent", () => {
  it("sorts the geometry oldest first and keeps sources with a URL", () => {
    const e = parseEvent({
      id: "EONET_9",
      title: "Hurricane Test",
      description: "",
      closed: null,
      categories: [{ id: "severeStorms", title: "Severe Storms" }],
      sources: [{ id: "JTWC", url: "https://example.org/a" }, { id: "X" }],
      geometry: [
        { date: "2026-10-19T12:00:00Z", type: "Point", coordinates: [2, 2], magnitudeValue: 50, magnitudeUnit: "kts" },
        { date: "2026-10-19T06:00:00Z", type: "Point", coordinates: [1, 1], magnitudeValue: 40, magnitudeUnit: "kts" },
        { date: "bad", type: "Point", coordinates: [0, 0] },
      ],
    });
    expect(e?.geometry.map((g) => g.point)).toEqual([[1, 1], [2, 2]]);
    expect(e?.sources).toEqual([{ id: "JTWC", url: "https://example.org/a" }]);
    expect(e?.description).toBeNull();
    expect(e?.category).toBe("severeStorms");
  });

  it("reads the closed date", () => {
    const e = event(OTHER, "EONET_25413");
    expect(e.closed).toBe("2026-10-18T00:00:00.000Z");
  });

  it("decodes HTML entities in titles", () => {
    expect(event(QUIRKS, "EONET_24836").title).toBe("Flood in Cote d'Ivoire 1104194");
    expect(event(QUIRKS, "EONET_20543").title).toBe("Flood in Bosnia & Herzegovina 1103946");
    expect(event(QUIRKS, "EONET_21426").title).toBe("Wildfire DEVIL'S CANYON, Franklin, Washington");
  });

  it("files real man-made events as man-made even when a natural category comes first", () => {
    expect(event(QUIRKS, "EONET_103").category).toBe("manmade"); // Explosion at Tianjin: dustHaze, manmade
    expect(event(QUIRKS, "EONET_3436").category).toBe("manmade"); // Agricultural burning: wildfires, manmade
  });

  it("keeps GDACS floods whose polygons are only valid read [lat, lng]", () => {
    expect(event(QUIRKS, "EONET_24723").geometry).toHaveLength(1); // Japan
    expect(event(QUIRKS, "EONET_24832").geometry).toHaveLength(1); // Mexico
  });

  it("rejects events without an id, title, category or usable geometry", () => {
    const ok = { id: "E", title: "T", categories: [{ id: "floods" }], geometry: [{ date: "2026-10-19T00:00:00Z", type: "Point", coordinates: [1, 1] }] };
    expect(parseEvent(ok)).not.toBeNull();
    expect(parseEvent({ ...ok, id: "" })).toBeNull();
    expect(parseEvent({ ...ok, title: null })).toBeNull();
    expect(parseEvent({ ...ok, categories: [] })).toBeNull();
    expect(parseEvent({ ...ok, geometry: [] })).toBeNull();
    expect(parseEvent("nope")).toBeNull();
  });
});

describe("parseEonetFeed", () => {
  it("reads every event of the real open feed", () => {
    const list = events(OPEN);
    expect(list).toHaveLength(11);
    const champi = list.find((e) => e.id === "EONET_25339");
    expect(champi?.title).toBe("Super Typhoon Champi");
    expect(champi?.geometry).toHaveLength(17);
    expect(champi?.sources[0].id).toBe("JTWC");
  });

  it("skips bad events and is null without an events list", () => {
    expect(parseEonetFeed({ events: [{ id: "x" }, ...((OPEN as { events: unknown[] }).events.slice(0, 1))] })).toHaveLength(1);
    expect(parseEonetFeed({ title: "EONET Events" })).toBeNull();
    expect(parseEonetFeed(null)).toBeNull();
    expect(parseEonetFeed("<html>")).toBeNull();
  });

  it("is null when events are listed but none can be read (a changed format), and empty for an empty list", () => {
    expect(parseEonetFeed({ events: [{ id: "x" }, { id: "y", geometries: [] }] })).toBeNull();
    expect(parseEonetFeed({ events: [] })).toEqual([]);
  });

  it("reads every quirk event", () => {
    expect(events(QUIRKS)).toHaveLength(17);
  });
});

// ---------------------------------------------------------------------------
// Types and names
// ---------------------------------------------------------------------------

describe("isTropicalCyclone", () => {
  it("knows the words agencies use for tropical cyclones", () => {
    for (const t of ["Super Typhoon Champi", "Tropical Cyclone Wati", "Hurricane Trudy", "Tropical Storm Hanna", "Tropical Depression 28W", "Very Severe Cyclonic Storm Biparjoy", "Subtropical Storm Alex"]) {
      expect(isTropicalCyclone(t)).toBe(true);
    }
  });

  it("leaves other storms out", () => {
    expect(isTropicalCyclone("Severe Storms, Texas")).toBe(false);
    expect(isTropicalCyclone("Extratropical Cyclone over the North Sea")).toBe(false);
    expect(isTropicalCyclone("Storm Ciaran")).toBe(false);
  });
});

describe("eventType", () => {
  it("maps every natural category", () => {
    expect(eventType("severeStorms", "Hurricane Trudy")).toBe("cyclone");
    expect(eventType("severeStorms", "Derecho, Midwest")).toBe("storm");
    expect(eventType("wildfires", "Wildfire Bull, Washoe, Nevada")).toBe("wildfire");
    expect(eventType("volcanoes", "Kilauea Volcano, Hawaii")).toBe("volcano");
    expect(eventType("floods", "Flood in Spain 1104235")).toBe("flood");
    expect(eventType("landslides", "Sichuan, China Landslides")).toBe("landslide");
    expect(eventType("drought", "Drought in Southern Africa")).toBe("drought");
    expect(eventType("dustHaze", "Saharan Dust Storm")).toBe("dust");
    expect(eventType("snow", "Snowfall in Lesotho")).toBe("coldwave");
    expect(eventType("earthquakes", "Iran Earthquake 7.3M")).toBe("earthquake");
  });

  it("tells heat from cold by the title", () => {
    expect(eventType("tempExtremes", "Central Asia Heatwave")).toBe("heatwave");
    expect(eventType("tempExtremes", "Southwest U.S. Heat Wave")).toBe("heatwave");
    expect(eventType("tempExtremes", "Morocco Cold Wave")).toBe("coldwave");
    expect(eventType("tempExtremes", "Cold Snap in the Northeast U.S.")).toBe("coldwave");
    expect(eventType("tempExtremes", "Mongolia Extreme Cold (Dzud)")).toBe("coldwave");
    expect(eventType("tempExtremes", "Iceland Record Temperatures")).toBe("heatwave");
  });

  it("skips ice, water colour, man-made and unknown categories", () => {
    expect(eventType("seaLakeIce", "Iceberg D35")).toBeNull();
    expect(eventType("waterColor", "Algal bloom")).toBeNull();
    expect(eventType("manmade", "Oil spill")).toBeNull();
    expect(eventType("somethingNew", "X")).toBeNull();
  });
});

describe("matchName", () => {
  it("upper-cases and drops accents and punctuation", () => {
    expect(matchName("Man-yi")).toBe("MAN YI");
    expect(matchName("Puracé")).toBe("PURACE");
    expect(matchName("  ")).toBe("");
  });
});

describe("stormName", () => {
  it("takes the proper name from a storm title", () => {
    expect(stormName("Super Typhoon Champi")).toBe("CHAMPI");
    expect(stormName("Tropical Cyclone Wati")).toBe("WATI");
    expect(stormName("Hurricane Trudy")).toBe("TRUDY");
    expect(stormName("Tropical Storm Hanna")).toBe("HANNA");
    expect(stormName("Severe Tropical Cyclone Alfred")).toBe("ALFRED");
    expect(stormName("Very Severe Cyclonic Storm Biparjoy")).toBe("BIPARJOY");
    expect(stormName("Post-Tropical Cyclone Fiona")).toBe("FIONA");
    expect(stormName("Remnants of Ida")).toBe("IDA");
    expect(stormName("Typhoon Man-yi")).toBe("MAN YI");
    expect(stormName("Cyclone Gabrielle (2023)")).toBe("GABRIELLE");
    expect(stormName("Tropical Depression Twenty-Eight")).toBe("TWENTY EIGHT");
  });

  it("is undefined when the title has no name", () => {
    expect(stormName("Tropical Storm")).toBeUndefined();
    expect(stormName("Hurricane")).toBeUndefined();
  });
});

describe("volcanoName", () => {
  it("takes the name before 'Volcano'", () => {
    expect(volcanoName("Kilauea Volcano, Hawaii")).toBe("KILAUEA");
    expect(volcanoName("Nevados del Chillan Volcano, Chile")).toBe("NEVADOS DEL CHILLAN");
    expect(volcanoName("Popocatepetl Volcano, Mexico")).toBe("POPOCATEPETL");
    expect(volcanoName("Puracé Volcano, Colombia")).toBe("PURACE");
  });

  it("falls back to the text before the first comma", () => {
    expect(volcanoName("Etna, Italy")).toBe("ETNA");
  });
});

describe("stripGdacsNumber", () => {
  it("drops the GDACS event number EONET appends", () => {
    expect(stripGdacsNumber("Flood in Spain 1104235")).toBe("Flood in Spain");
    expect(stripGdacsNumber("Wildfire in United States 1023255 (Palisades Wildfire, Los Angeles, California)")).toBe(
      "Wildfire in United States (Palisades Wildfire, Los Angeles, California)",
    );
  });

  it("leaves other numbers alone", () => {
    expect(stripGdacsNumber("Wildfire Buckhorn 2, Cassia, Idaho")).toBe("Wildfire Buckhorn 2, Cassia, Idaho");
    expect(stripGdacsNumber("KALKASKA-RX 61150021 Fletcher Unit 2 Prescribed Fire")).toBe("KALKASKA-RX 61150021 Fletcher Unit 2 Prescribed Fire");
  });
});

// ---------------------------------------------------------------------------
// Storms
// ---------------------------------------------------------------------------

describe("knotsToKmh and knotsOf", () => {
  it("converts knots to rounded km/h", () => {
    expect(knotsToKmh(140)).toBe(259);
    expect(knotsToKmh(50)).toBe(93);
    expect(knotsToKmh(0)).toBe(0);
  });

  it("reads only magnitudes given in knots", () => {
    expect(knotsOf(geom("2026-10-19T00:00:00Z", [0, 0], 45, "kts"))).toBe(45);
    expect(knotsOf(geom("2026-10-19T00:00:00Z", [0, 0], 45, "acres"))).toBeNull();
    expect(knotsOf(geom("2026-10-19T00:00:00Z", [0, 0]))).toBeNull();
  });
});

describe("stormSeverity", () => {
  it("rates by peak winds: hurricane strength is 2, 113 kt and up is 3", () => {
    expect(stormSeverity(null)).toBe(1);
    expect(stormSeverity(63)).toBe(1);
    expect(stormSeverity(64)).toBe(2);
    expect(stormSeverity(112)).toBe(2);
    expect(stormSeverity(113)).toBe(3);
    expect(stormSeverity(160)).toBe(3);
  });
});

describe("stormSeverityText", () => {
  it("gives the latest winds and the peak when it was stronger", () => {
    expect(stormSeverityText(140, 140)).toBe("Winds up to 259 km/h");
    expect(stormSeverityText(50, 105)).toBe("Winds up to 93 km/h (peak 194 km/h)");
    expect(stormSeverityText(50, null)).toBe("Winds up to 93 km/h");
  });

  it("is undefined without winds", () => {
    expect(stormSeverityText(null, 100)).toBeUndefined();
  });
});

describe("stormCountries", () => {
  it("names the country at the centre first, then countries the track crossed", () => {
    // Over Luzon, then onto the coast of Vietnam.
    expect(stormCountries([[121, 15.5], [108, 15]], shapes)).toEqual(["VN", "PH"]);
  });

  it("names the nearest country within 500 km of a storm at sea", () => {
    expect(stormCountries([[-108.3, 19.6]], shapes)).toEqual(["MX"]);
  });

  it("is empty far out at sea", () => {
    expect(stormCountries([[-150, 0]], shapes)).toEqual([]);
    expect(stormCountries([], shapes)).toEqual([]);
  });
});

describe("stormEvent", () => {
  it("turns Super Typhoon Champi into a severe cyclone with its whole track", () => {
    const e = stormEvent(event(OPEN, "EONET_25339"), "cyclone", OPEN_NOW, shapes);
    expect(e).toMatchObject({
      source: "eonet",
      sourceId: "EONET_25339",
      type: "cyclone",
      title: "Super Typhoon Champi",
      name: "CHAMPI",
      severity: 3,
      severityText: "Winds up to 259 km/h",
      lat: 14.8,
      lng: 137.6,
      precision: "exact",
      started: "2026-10-15T12:00:00.000Z",
      updated: "2026-10-19T12:00:00.000Z",
      countries: [],
      areas: [],
      links: [{ name: "Joint Typhoon Warning Center", url: "https://www.metoc.navy.mil/jtwc/products/wp2926.tcw" }],
    });
    expect(e?.track?.past).toHaveLength(17);
    expect(e?.track?.past[0]).toEqual([157.4, 11]);
    expect(e?.track?.past[16]).toEqual([137.6, 14.8]);
    expect(e?.track?.forecast).toEqual([]);
  });

  it("reports a weakening hurricane's current and peak winds", () => {
    const e = stormEvent(event(OPEN, "EONET_25290"), "cyclone", OPEN_NOW, shapes);
    expect(e?.severity).toBe(2);
    expect(e?.severityText).toBe("Winds up to 93 km/h (peak 194 km/h)");
    expect(e?.countries[0]).toBe("MX");
    expect(e?.name).toBe("TRUDY");
  });

  it("rates a storm by its peak even after it weakens", () => {
    const e = stormEvent(event(OPEN, "EONET_25340"), "cyclone", OPEN_NOW, shapes);
    expect(e?.severity).toBe(2);
    expect(e?.severityText).toBe("Winds up to 83 km/h (peak 120 km/h)");
  });

  it("drops storms EONET has not placed for 3 days", () => {
    const simon = event(OPEN, "EONET_25094"); // last fix 2026-10-16T18:00Z
    expect(stormEvent(simon, "cyclone", OPEN_NOW, shapes)).toBeNull();
    expect(stormEvent(simon, "cyclone", "2026-10-19T17:59:00Z", shapes)).not.toBeNull();
    const at = new Date(Date.parse("2026-10-16T18:00:00Z") + STORM_MAX_AGE_DAYS * 86_400_000 + 60_000).toISOString();
    expect(stormEvent(simon, "cyclone", at, shapes)).toBeNull();
  });

  it("gives non-tropical storms no name and handles missing winds", () => {
    const ev = makeEvent({ category: "severeStorms", title: "Storm Ciaran", geometry: [geom("2026-10-19T00:00:00Z", [-5, 50])] });
    const e = stormEvent(ev, "storm", OPEN_NOW, shapes);
    expect(e?.type).toBe("storm");
    expect(e?.severity).toBe(1);
    expect(e?.severityText).toBeUndefined();
    expect(e?.name).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Wildfires
// ---------------------------------------------------------------------------

describe("isPrescribedFire", () => {
  it("catches prescribed burns in every title style IRWIN uses", () => {
    for (const t of [
      "Prescribed Fire Newman Piles RX, Coconino, Arizona",
      "Prescribed Fire Bridger Trail Unit - KPERP Rx NKRD CY26, Coconino, Arizona",
      "Prescribed Fire McCRAKEN RX-WRD CY26, Coconino, Arizona",
      "APQ Area 5A RX 0615 Prescribed Fire, Polk, Florida",
      "KALKASKA-RX 61150021 Fletcher Unit 2 Prescribed Fire, Kalkaska, Michigan",
      "RX WINN BU 24, Winn, Louisiana",
      "Sunfish Rx, Cook, Minnesota",
    ]) {
      expect(isPrescribedFire(t)).toBe(true);
    }
  });

  it("leaves wildfires alone, even with 'rx' inside a word", () => {
    for (const t of ["Wildfire Bull, Washoe, Nevada", "Wildfire MARX, Kern, California", "Wildfire Proxy Canyon, Elko, Nevada", "Wildfire RXR, Elko, Nevada"]) {
      expect(isPrescribedFire(t)).toBe(false);
    }
  });
});

describe("burnedAcres", () => {
  it("reads acres and converts hectares", () => {
    expect(burnedAcres(geom("2026-10-19T00:00:00Z", [0, 0], 15470, "acres"))).toBe(15470);
    expect(burnedAcres(geom("2026-10-19T00:00:00Z", [0, 0], 1000, "hectare"))).toBeCloseTo(2471.05, 1);
  });

  it("is null when the size is missing or in another unit", () => {
    expect(burnedAcres(geom("2026-10-19T00:00:00Z", [0, 0]))).toBeNull();
    expect(burnedAcres(geom("2026-10-19T00:00:00Z", [0, 0], 50, "kts"))).toBeNull();
    expect(burnedAcres(geom("2026-10-19T00:00:00Z", [0, 0], -1, "acres"))).toBeNull();
  });
});

describe("fireSeverity", () => {
  it("is 2 from 100,000 acres and 3 from 500,000", () => {
    expect(fireSeverity(null)).toBe(1);
    expect(fireSeverity(99_999)).toBe(1);
    expect(fireSeverity(100_000)).toBe(2);
    expect(fireSeverity(499_999)).toBe(2);
    expect(fireSeverity(500_000)).toBe(3);
  });
});

describe("fireRadiusKm", () => {
  it("gives a circle as large as the burned area", () => {
    const r = fireRadiusKm(15470);
    expect(Math.PI * r * r).toBeCloseTo(15470 * 0.0040469, 1);
  });

  it("never goes below the minimum radius", () => {
    expect(fireRadiusKm(1)).toBe(MIN_FIRE_RADIUS_KM);
    expect(fireRadiusKm(0)).toBe(MIN_FIRE_RADIUS_KM);
  });
});

describe("thousands and fireSeverityText", () => {
  it("groups digits", () => {
    expect(thousands(0)).toBe("0");
    expect(thousands(999)).toBe("999");
    expect(thousands(1000)).toBe("1,000");
    expect(thousands(1234567.4)).toBe("1,234,567");
  });

  it("states the burned area in km² and acres", () => {
    expect(fireSeverityText(15470)).toBe("63 km² burned (15,470 acres)");
  });
});

describe("tidyCaps", () => {
  it("title-cases names written in capitals", () => {
    expect(tidyCaps("SAN FRANCISCO 2")).toBe("San Francisco 2");
    expect(tidyCaps("BIG GRASS")).toBe("Big Grass");
    expect(tidyCaps("MIAMI-DADE")).toBe("Miami-Dade");
  });

  it("keeps mixed case and short codes", () => {
    expect(tidyCaps("Hatch Grade")).toBe("Hatch Grade");
    expect(tidyCaps("PK")).toBe("PK");
    expect(tidyCaps("McCRAKEN")).toBe("McCRAKEN");
  });
});

describe("countyLabel", () => {
  it("adds County, or Parish in Louisiana", () => {
    expect(countyLabel("Cassia", "Idaho")).toBe("Cassia County");
    expect(countyLabel("Morehouse", "Louisiana")).toBe("Morehouse Parish");
    expect(countyLabel("MIAMI-DADE", "Florida")).toBe("Miami-Dade County");
  });

  it("leaves Alaska's boroughs and names that already say what they are", () => {
    expect(countyLabel("Yukon-Koyukuk", "Alaska")).toBe("Yukon-Koyukuk");
    expect(countyLabel("Los Angeles County", "California")).toBe("Los Angeles County");
  });
});

describe("fireTitle", () => {
  it("rewrites IRWIN titles as 'NAME Fire, COUNTY County, STATE'", () => {
    expect(fireTitle("Wildfire Buckhorn 2, Cassia, Idaho")).toBe("Buckhorn 2 Fire, Cassia County, Idaho");
    expect(fireTitle("Wildfire BOUQUET, Los Angeles, California")).toBe("Bouquet Fire, Los Angeles County, California");
    expect(fireTitle("Wildfire Round Prarie, Morehouse, Louisiana")).toBe("Round Prarie Fire, Morehouse Parish, Louisiana");
    expect(fireTitle("Wildfire PK, Sheridan, Wyoming")).toBe("PK Fire, Sheridan County, Wyoming");
  });

  it("reads the older 'NAME Wildfire' style and complexes", () => {
    expect(fireTitle("Rattlesnake Wildfire, Ferry, Washington")).toBe("Rattlesnake Fire, Ferry County, Washington");
    expect(fireTitle("Rattlesnake Fire Wildfire, Pittsburg, Oklahoma")).toBe("Rattlesnake Fire, Pittsburg County, Oklahoma");
    expect(fireTitle("Incident Complex ROWE CREEK COMPLEX, Wheeler, Oregon")).toBe("Rowe Creek Complex, Wheeler County, Oregon");
  });

  it("uses the IRWIN title GDACS-sourced fires carry in brackets", () => {
    expect(fireTitle("Wildfire in United States 1023255 (Palisades Wildfire, Los Angeles, California)")).toBe(
      "Palisades Fire, Los Angeles County, California",
    );
  });

  it("only strips the GDACS number from other titles", () => {
    expect(fireTitle("Wildfire in Australia 1023712")).toBe("Wildfire in Australia");
    expect(fireTitle("Wildfire SWF-049, Slave Lake, Alberta")).toBe("Wildfire SWF-049, Slave Lake, Alberta");
    expect(fireTitle("Wildfire Somewhere")).toBe("Wildfire Somewhere");
  });
});

describe("fireLocated", () => {
  it("needs a country, and the US for a title that ends in a US state", () => {
    expect(fireLocated("Wildfire Bull, Washoe, Nevada", ["US"])).toBe(true);
    expect(fireLocated("Wildfire Bull, Washoe, Nevada", [])).toBe(false);
    expect(fireLocated("MOXEE ORCHARD Wildfire, Yakima, Washington", ["GH"])).toBe(false);
    expect(fireLocated("Wildfire SWF-049, Slave Lake, Alberta", ["CA"])).toBe(true);
    expect(fireLocated("Wildfire in Australia", ["AU"])).toBe(true);
    expect(fireLocated("Wildfire in Australia", [])).toBe(false);
  });

  it("expects Puerto Rico's own globe shape for Puerto Rico fires", () => {
    expect(fireLocated("Wildfire Cerro, Cabo Rojo, Puerto Rico", ["PR"])).toBe(true);
    expect(fireLocated("Wildfire Cerro, Cabo Rojo, Puerto Rico", ["US"])).toBe(false);
  });
});

describe("fireEvent", () => {
  it("draws a large fire as a circle of its burned area", () => {
    const e = fireEvent(event(FIRES, "EONET_21827"), "2026-07-25T00:00:00Z", shapes); // Big Grass, 280,000 acres
    expect(e).toMatchObject({
      type: "wildfire",
      title: "Big Grass Fire, Malheur County, Oregon",
      severity: 2,
      severityText: "1,133 km² burned (280,000 acres)",
      countries: ["US"],
      precision: "exact",
      links: [{ name: "IRWIN wildfire report", url: expect.stringMatching(/^https:\/\/irwin\.doi\.gov\//) }],
    });
    expect(e?.areas).toHaveLength(1);
    expect(e?.areas[0].kind).toBe("affected");
    expect(geometryAreaKm2(e!.areas[0].geometry)).toBeGreaterThan(1133 * 0.97);
    expect(geometryAreaKm2(e!.areas[0].geometry)).toBeLessThan(1133 * 1.03);
    expect(pointInGeometry(e!.lng, e!.lat, e!.areas[0].geometry)).toBe(true);
    expect(e?.places).toBeUndefined();
  });

  it("rates the largest fires severe", () => {
    expect(fireEvent(event(FIRES, "EONET_18654"), "2026-03-14T00:00:00Z", shapes)?.severity).toBe(3); // Morrill, 572,804 acres
    expect(fireEvent(event(FIRES, "EONET_23452"), "2026-08-25T00:00:00Z", shapes)?.severity).toBe(1); // Ross, 80,000 acres
  });

  it("keeps the nearest-town description as the summary", () => {
    const e = fireEvent(event(FIRES, "EONET_24487"), "2026-09-15T00:00:00Z", shapes);
    expect(e?.title).toBe("Davis Coulee Fire, Big Horn County, Montana");
    expect(e?.summary).toBe("9 Miles SW from Crow Agency, MT");
  });

  it("keeps a fire of exactly 5,000 acres and drops smaller ones", () => {
    expect(MIN_FIRE_ACRES).toBe(5000);
    expect(fireEvent(event(OPEN, "EONET_24963"), "2026-10-01T00:00:00Z", shapes)?.title).toBe("Hatch Grade Fire, Walla Walla County, Washington");
    expect(fireEvent(event(OPEN, "EONET_25238"), "2026-10-11T00:00:00Z", shapes)).toBeNull(); // Buckhorn 2, 2,000 acres
  });

  it("drops prescribed burns whatever their size", () => {
    expect(fireEvent(event(OPEN, "EONET_25310"), "2026-10-15T00:00:00Z", shapes)).toBeNull();
    expect(fireEvent(event(OPEN, "EONET_25234"), "2026-10-10T00:00:00Z", shapes)).toBeNull(); // 5,019 acres
    expect(fireEvent(event(FIRES, "EONET_20570"), "2026-06-16T00:00:00Z", shapes)).toBeNull();
  });

  it("drops fires with no report for 10 days", () => {
    const davis = event(FIRES, "EONET_24487"); // 2026-09-14T11:43Z
    expect(FIRE_MAX_AGE_DAYS).toBe(10);
    expect(fireEvent(davis, "2026-09-24T11:00:00Z", shapes)).not.toBeNull();
    expect(fireEvent(davis, "2026-09-24T12:00:00Z", shapes)).toBeNull();
  });

  it("keeps a fire with no reported size, without an area", () => {
    const e = fireEvent(event(FIRES, "EONET_12346"), "2025-01-08T00:00:00Z", shapes); // Palisades via GDACS
    expect(e?.title).toBe("Palisades Fire, Los Angeles County, California");
    expect(e?.areas).toEqual([]);
    expect(e?.severity).toBe(1);
    expect(e?.severityText).toBeUndefined();
    expect(e?.countries).toEqual(["US"]);
    const au = fireEvent(event(FIRES, "EONET_13370"), "2025-04-28T00:00:00Z", shapes);
    expect(au?.title).toBe("Wildfire in Australia");
    expect(au?.countries).toEqual(["AU"]);
    expect(au?.links[0].name).toBe("GDACS");
  });

  it("drops IRWIN fires with a placeholder point and keeps the real record", () => {
    const now = "2026-06-05T00:00:00Z";
    expect(fireEvent(event(QUIRKS, "EONET_20391"), now, shapes)).toBeNull(); // [1, 3], the Gulf of Guinea
    const real = fireEvent(event(QUIRKS, "EONET_21040"), now, shapes);
    expect(real?.title).toBe("Moxee Orchard Fire, Yakima County, Washington");
    expect(real?.countries).toEqual(["US"]);
    // Kopshesut came as [189, 7], the mid-Pacific; given a size that would be kept.
    const kop = event(QUIRKS, "EONET_20386");
    const big = { ...kop, geometry: kop.geometry.map((g) => ({ ...g, magnitude: 6000 })) };
    expect(fireEvent(big, now, shapes)).toBeNull();
    expect(eventsFromFeed([event(QUIRKS, "EONET_20391"), event(QUIRKS, "EONET_21040")], now, shapes).map((e) => e.sourceId)).toEqual(["EONET_21040"]);
  });

  it("reads a title with HTML entities", () => {
    expect(fireTitle(event(QUIRKS, "EONET_21426").title)).toBe("Devil's Canyon Fire, Franklin County, Washington");
  });

  it("converts hectares and uses the latest reported size", () => {
    const ev = makeEvent({
      category: "wildfires",
      title: "Wildfire SWF-049, Slave Lake, Alberta",
      geometry: [geom("2026-10-10T00:00:00Z", [-114.8, 55.3], 1000, "hectare"), geom("2026-10-12T00:00:00Z", [-114.8, 55.3], 50_000, "hectare")],
    });
    const e = fireEvent(ev, "2026-10-13T00:00:00Z", shapes);
    expect(e?.severity).toBe(2); // 123,553 acres
    expect(e?.countries).toEqual(["CA"]);
    expect(e?.started).toBe("2026-10-10T00:00:00.000Z");
    expect(e?.updated).toBe("2026-10-12T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// Volcanoes and everything else
// ---------------------------------------------------------------------------

describe("titleCountry", () => {
  it("reads the country a title ends with", () => {
    expect(titleCountry("Kanlaon Volcano, Philippines", shapes)).toBe("PH");
    expect(titleCountry("Ivao Group Volcano, Russia", shapes)).toBe("RU");
    expect(titleCountry("Flood in Spain 1104235", shapes)).toBe("ES");
    expect(titleCountry("Flood in Türkiye 1104230", shapes)).toBe("TR");
  });

  it("is null when the title names no country", () => {
    expect(titleCountry("Kilauea Volcano, Hawaii", shapes)).toBeNull();
    expect(titleCountry("Saharan Dust Storm", shapes)).toBeNull();
  });
});

describe("titleCountries", () => {
  it("lists every country a GDACS title names, in order", () => {
    expect(titleCountries("Flood in India, Nepal 1104198", shapes)).toEqual(["IN", "NP"]);
    expect(titleCountries("Flood in Kenya, Mongolia 1103868", shapes)).toEqual(["KE", "MN"]);
    expect(titleCountries("Fires in Sudan and Chad", shapes)).toEqual(["SD", "TD"]);
    expect(titleCountries("Dust Storm, Saudi Arabia/Iraq", shapes)).toEqual(["SA", "IQ"]);
  });

  it("reads GDACS long forms and names with 'and' in them", () => {
    expect(titleCountries("Flood in Islamic Republic of Iran 1104147", shapes)).toEqual(["IR"]);
    expect(titleCountries("Flood in The Republic of North Macedonia 1103974", shapes)).toEqual(["MK"]);
    expect(titleCountries("Flood in United Republic of Tanzania", shapes)).toEqual(["TZ"]);
    expect(titleCountries("Flood in Democratic Republic of the Congo", shapes)).toEqual(["CD"]);
    expect(titleCountries("Flood in Republic of the Congo", shapes)).toEqual(["CG"]);
    expect(titleCountries("Flood in Bosnia & Herzegovina 1103946", shapes)).toEqual(["BA"]);
    expect(titleCountries("Flood in Trinidad and Tobago", shapes)).toEqual(["TT"]);
  });

  it("reads the country before a bracketed IRWIN title", () => {
    expect(titleCountries("Wildfire in United States 1023255 (Palisades Wildfire, Los Angeles, California)", shapes)).toEqual(["US"]);
  });

  it("is empty when no country is named", () => {
    expect(titleCountries("Kilauea Volcano, Hawaii", shapes)).toEqual([]);
    expect(titleCountries("Dust storms in Middle East", shapes)).toEqual([]);
  });
});

describe("kmToCountries", () => {
  it("is 0 inside, the distance outside, and Infinity for codes with no shape", () => {
    expect(kmToCountries(13.75, 100.5, ["TH"], shapes)).toBe(0);
    expect(kmToCountries(13.75, 100.5, ["VN", "TH"], shapes)).toBe(0);
    const km = kmToCountries(13.75, 100.5, ["VN"], shapes);
    expect(km).toBeGreaterThan(200);
    expect(km).toBeLessThan(800);
    expect(kmToCountries(13.75, 100.5, ["ZZ"], shapes)).toBe(Infinity);
    expect(kmToCountries(13.75, 100.5, [], shapes)).toBe(Infinity);
  });
});

describe("orientPolygons", () => {
  /** The centre of an event's latest polygon after orientation, as a country code. */
  const countryOf = (id: string) => {
    const g = orientPolygons(event(QUIRKS, id), shapes).geometry.at(-1)!;
    const c = centroidOf(g.polygon!);
    expect(g.point[0]).toBeCloseTo(c.lng, 6);
    expect(g.point[1]).toBeCloseTo(c.lat, 6);
    return countryAt(c.lat, c.lng, shapes);
  };

  it("swaps real GDACS flood polygons written [lat, lng] back into their country", () => {
    // As given these read as Iran, Antarctica, the Norwegian Sea, the Atlantic and Russia.
    expect(countryOf("EONET_24834")).toBe("UA");
    expect(countryOf("EONET_24876")).toBe("CR");
    expect(countryOf("EONET_24877")).toBe("IN");
    expect(countryOf("EONET_24836")).toBe("CI");
    expect(countryOf("EONET_24193")).toBe("IR");
  });

  it("leaves correct polygons, and ones swapped while parsing, as they are", () => {
    for (const id of ["EONET_25157", "EONET_24723", "EONET_24832"]) {
      const ev = event(QUIRKS, id);
      expect(orientPolygons(ev, shapes).geometry[0].polygon).toBe(ev.geometry[0].polygon);
    }
    expect(countryOf("EONET_25157")).toBe("SI");
    const spain = event(OTHER, "EONET_25413");
    expect(orientPolygons(spain, shapes).geometry[0].polygon).toBe(spain.geometry[0].polygon);
  });

  it("keeps the given order when both readings fall in the named country", () => {
    const ev = event(QUIRKS, "EONET_24760"); // Nigeria: [5.7, 6.7] and [6.7, 5.7] are both in Nigeria
    expect(orientPolygons(ev, shapes).geometry[0].polygon).toBe(ev.geometry[0].polygon);
  });

  it("does nothing for point events or titles that name no country", () => {
    const point = event(VOLCANOES, "EONET_12367");
    expect(orientPolygons(point, shapes)).toBe(point);
    const ring: [number, number][] = [[46.9, 35.5], [47.1, 35.5], [47.1, 35.7], [46.9, 35.5]];
    const unnamed = makeEvent({ category: "floods", title: "Floods", geometry: [{ ...geom("2026-10-19T00:00:00Z", [47, 35.6]), polygon: { type: "Polygon", coordinates: [ring] } }] });
    expect(orientPolygons(unnamed, shapes)).toBe(unnamed);
  });
});

describe("polygonAreas", () => {
  it("draws the latest polygon as the affected area", () => {
    const e = event(OTHER, "EONET_25413");
    const areas = polygonAreas(e);
    expect(areas).toHaveLength(1);
    expect(areas[0].kind).toBe("affected");
  });

  it("fits a huge polygon into the byte budget", () => {
    const big = circlePolygon(20, 30, 800, 6000);
    const e = makeEvent({ category: "floods", geometry: [{ ...geom("2026-10-19T00:00:00Z", [30, 20]), polygon: big }] });
    const areas = polygonAreas(e);
    expect(JSON.stringify(areas[0].geometry).length).toBeLessThanOrEqual(AREA_BUDGET_BYTES);
    expect(geometryAreaKm2(areas[0].geometry)).toBeGreaterThan(Math.PI * 800 * 800 * 0.95);
  });

  it("is empty for point events and for polygons too small to draw", () => {
    expect(polygonAreas(event(VOLCANOES, "EONET_12367"))).toEqual([]);
    expect(polygonAreas(event(OTHER, "EONET_25291"))).toEqual([]); // a 0.003 km² speck in Libya
  });
});

describe("quakeSeverityText", () => {
  it("states a magnitude when EONET gives one", () => {
    expect(quakeSeverityText(geom("2026-10-19T00:00:00Z", [0, 0], 7.5, "Mw/Mww"))).toBe("Magnitude 7.5");
    expect(quakeSeverityText(geom("2026-10-19T00:00:00Z", [0, 0], 6, "Mb"))).toBe("Magnitude 6.0");
    expect(quakeSeverityText(geom("2026-10-19T00:00:00Z", [0, 0]))).toBeUndefined();
    expect(quakeSeverityText(geom("2026-10-19T00:00:00Z", [0, 0], 30, "kts"))).toBeUndefined();
  });
});

describe("otherEvent", () => {
  it("rates volcanoes 2 and names them for matching", () => {
    const e = otherEvent(event(VOLCANOES, "EONET_12367"), "volcano", shapes);
    expect(e).toMatchObject({ type: "volcano", title: "Kilauea Volcano, Hawaii", name: "KILAUEA", severity: 2, countries: ["US"], lat: 19.421, lng: -155.287, areas: [] });
    expect(e.links.map((l) => l.name)).toEqual(["NASA Earth Observatory", "Smithsonian Global Volcanism Program"]);
  });

  it("puts the title's country first", () => {
    expect(otherEvent(event(VOLCANOES, "EONET_20392"), "volcano", shapes).countries[0]).toBe("RU");
    expect(otherEvent(event(VOLCANOES, "EONET_15811"), "volcano", shapes).countries).toEqual(["PH"]);
  });

  it("tidies the title's spacing", () => {
    expect(otherEvent(event(VOLCANOES, "EONET_13342"), "volcano", shapes).title).toBe("Popocatepetl Volcano, Mexico");
  });

  it("maps a GDACS-sourced flood polygon", () => {
    const e = otherEvent(event(OTHER, "EONET_25413"), "flood", shapes);
    expect(e.title).toBe("Flood in Spain");
    expect(e.severity).toBe(1);
    expect(e.countries).toEqual(["ES"]);
    expect(e.areas).toHaveLength(1);
    expect(e.lat).toBeCloseTo(41.5, 1);
    expect(e.lng).toBeCloseTo(2.38, 1);
  });

  it("maps a dust storm's box even far from land", () => {
    const e = otherEvent(event(OTHER, "EONET_3621"), "dust", shapes);
    expect(e.areas).toHaveLength(1);
    expect(e.countries).toEqual([]);
    expect(geometryAreaKm2(e.areas[0].geometry)).toBeGreaterThan(1_000_000);
  });

  it("keeps a non-empty description as the summary", () => {
    const e = otherEvent(event(OTHER, "EONET_3437"), "heatwave", shapes);
    expect(e.summary).toMatch(/^During the middle of February/);
    expect(e.countries).toEqual(["AF"]);
    expect(otherEvent(event(OTHER, "EONET_3410"), "coldwave", shapes).summary).toBeUndefined();
  });

  it("puts the country at the position first when the title names it too", () => {
    const e = otherEvent(orientPolygons(event(QUIRKS, "EONET_24877"), shapes), "flood", shapes);
    expect(e.title).toBe("Flood in India, Nepal");
    expect(e.countries).toEqual(["IN", "NP"]);
    expect(otherEvent(event(QUIRKS, "EONET_20543"), "flood", shapes)).toMatchObject({ title: "Flood in Bosnia & Herzegovina", countries: ["BA"] });
  });

  it("states an earthquake's magnitude when given", () => {
    const ev = makeEvent({ category: "earthquakes", title: "Test Earthquake", geometry: [geom("2026-10-19T00:00:00Z", [119.84, -0.18], 7.5, "Mw")] });
    const e = otherEvent(ev, "earthquake", shapes);
    expect(e.severityText).toBe("Magnitude 7.5");
    expect(e.countries).toEqual(["ID"]);
  });
});

// ---------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------

describe("countriesNear", () => {
  it("names the country at a point", () => {
    expect(countriesNear(13.75, 100.5, shapes, 200)).toEqual(["TH"]);
  });

  it("names the nearest country within reach, else none", () => {
    expect(countriesNear(19.6, -108.3, shapes, 500)).toEqual(["MX"]);
    expect(countriesNear(19.6, -108.3, shapes, 100)).toEqual([]);
    expect(countriesNear(0, -150, shapes, 500)).toEqual([]);
  });

  it("never names Antarctica", () => {
    expect(countriesNear(-80, 0, shapes, 500)).toEqual([]);
  });
});

describe("sourceLinks", () => {
  it("keeps https pages once each, with readable names", () => {
    expect(
      sourceLinks([
        { id: "JTWC", url: "https://www.metoc.navy.mil/jtwc/products/wp2926.tcw" },
        { id: "SIVolcano", url: "http://volcano.si.edu/volcano.cfm?vn=266030" },
        { id: "NEW_SOURCE", url: "https://example.org/x" },
        { id: "JTWC", url: "https://www.metoc.navy.mil/jtwc/products/wp2926.tcw" },
        { id: "EO", url: "not a url" },
      ]),
    ).toEqual([
      { name: "Joint Typhoon Warning Center", url: "https://www.metoc.navy.mil/jtwc/products/wp2926.tcw" },
      { name: "NEW SOURCE", url: "https://example.org/x" },
    ]);
  });

  it("skips the http-only links of real events", () => {
    const fuego = event(VOLCANOES, "EONET_980");
    expect(fuego.sources).toHaveLength(7);
    const links = sourceLinks(fuego.sources);
    expect(links.every((l) => l.url.startsWith("https://"))).toBe(true);
    expect(links.length).toBeLessThan(7);
  });
});

describe("toSourceEvent", () => {
  it("sends each category to its rules", () => {
    expect(toSourceEvent(event(OPEN, "EONET_25339"), OPEN_NOW, shapes)?.type).toBe("cyclone");
    expect(toSourceEvent(event(VOLCANOES, "EONET_15811"), OPEN_NOW, shapes)?.type).toBe("volcano");
    expect(toSourceEvent(event(OTHER, "EONET_3873"), OPEN_NOW, shapes)?.type).toBe("coldwave");
    expect(toSourceEvent(event(OTHER, "EONET_3046"), OPEN_NOW, shapes)?.type).toBe("flood");
    expect(toSourceEvent(event(OPEN, "EONET_25310"), OPEN_NOW, shapes)).toBeNull(); // prescribed
  });

  it("skips sea ice", () => {
    expect(toSourceEvent(event(OPEN, "EONET_25268"), OPEN_NOW, shapes)).toBeNull();
  });

  it("skips man-made events filed under a natural category too", () => {
    for (const id of ["EONET_103", "EONET_3436", "EONET_3750"]) {
      expect(toSourceEvent(event(QUIRKS, id), "2018-08-01T00:00:00Z", shapes)).toBeNull();
    }
  });

  it("places every real GDACS flood in the country its title names", () => {
    const floods = ["EONET_24723", "EONET_24832", "EONET_24834", "EONET_24876", "EONET_24877", "EONET_24836", "EONET_20543", "EONET_24193", "EONET_25157", "EONET_24760"];
    const want = ["JP", "MX", "UA", "CR", "IN", "CI", "BA", "IR", "SI", "NG"];
    const got = floods.map((id) => {
      const e = toSourceEvent(event(QUIRKS, id), OPEN_NOW, shapes)!;
      expect(e.type).toBe("flood");
      expect(e.countries[0]).toBe(countryAt(e.lat, e.lng, shapes));
      return e.countries[0];
    });
    expect(got).toEqual(want);
  });

  it("gives every event the common fields", () => {
    const e = toSourceEvent(event(OTHER, "EONET_3990"), OPEN_NOW, shapes);
    expect(e).toMatchObject({ source: "eonet", sourceId: "EONET_3990", precision: "exact", countries: ["ID"], type: "earthquake" });
    expect(e?.links.length).toBeGreaterThan(0);
  });
});

describe("dedupeEvents", () => {
  it("keeps one copy of an incident listed twice, preferring the newer EONET id on a tie", () => {
    const a = source({ sourceId: "EONET_23218" });
    const b = source({ sourceId: "EONET_23460" });
    expect(dedupeEvents([a, b]).map((e) => e.sourceId)).toEqual(["EONET_23460"]);
    expect(dedupeEvents([b, a]).map((e) => e.sourceId)).toEqual(["EONET_23460"]);
  });

  it("prefers the more recently updated copy", () => {
    const a = source({ sourceId: "EONET_9", updated: "2026-08-23T00:00:00.000Z" });
    const b = source({ sourceId: "EONET_10" });
    expect(dedupeEvents([a, b]).map((e) => e.sourceId)).toEqual(["EONET_9"]);
  });

  it("keeps different incidents", () => {
    const a = source({ sourceId: "EONET_1" });
    const b = source({ sourceId: "EONET_2", lat: 40 });
    const c = source({ sourceId: "EONET_3", title: "Other Fire, Washoe County, Nevada" });
    expect(dedupeEvents([a, b, c])).toHaveLength(3);
  });

  it("merges the real Hawk fire duplicates", () => {
    const now = "2026-08-25T00:00:00Z";
    const out = eventsFromFeed([event(FIRES, "EONET_23218"), event(FIRES, "EONET_23460")], now, shapes);
    expect(out.map((e) => e.sourceId)).toEqual(["EONET_23460"]);
    expect(out[0].title).toBe("Hawk Fire, Washoe County, Nevada");
  });
});

describe("eventsFromFeed", () => {
  it("keeps the current storms of the real open feed and nothing else", () => {
    const out = eventsFromFeed(events(OPEN), OPEN_NOW, shapes);
    expect(out.map((e) => e.sourceId)).toEqual(["EONET_25340", "EONET_25339", "EONET_25290"]);
  });

  it("skips events closed before now and keeps ones closing later", () => {
    const spain = event(OTHER, "EONET_25413"); // closed 2026-10-18
    expect(eventsFromFeed([spain], OPEN_NOW, shapes)).toEqual([]);
    expect(eventsFromFeed([spain], "2026-10-17T00:00:00Z", shapes).map((e) => e.sourceId)).toEqual(["EONET_25413"]);
  });

  it("is empty for an empty feed", () => {
    expect(eventsFromFeed([], OPEN_NOW, shapes)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

describe("getJson", () => {
  it("sends the user agent and a timeout and parses the body", async () => {
    const deps = fakeDeps([response('{"events":[]}')]);
    expect(await getJson(EONET_URL, deps)).toEqual({ events: [] });
    const [url, init] = deps.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(EONET_URL);
    expect((init.headers as Record<string, string>)["User-Agent"]).toBe(USER_AGENT);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it("retries once after a failure", async () => {
    const deps = fakeDeps([new Error("socket hang up"), response('{"ok":1}')]);
    expect(await getJson(EONET_URL, deps)).toEqual({ ok: 1 });
    expect(deps.fetch).toHaveBeenCalledTimes(2);
    expect(deps.sleep).toHaveBeenCalledWith(RETRY_MS);
  });

  it("is null when both attempts fail, on bad status or bad JSON", async () => {
    const deps = fakeDeps([response("busy", 503), response("<html>not json")]);
    expect(await getJson(EONET_URL, deps)).toBeNull();
    expect(deps.fetch).toHaveBeenCalledTimes(2);
    expect(deps.sleep).toHaveBeenCalledTimes(1);
    expect(deps.log).toHaveBeenCalledTimes(2);
  });
});

describe("fetchEonet", () => {
  it("reads the feed and returns its current events", async () => {
    const deps = fakeDeps([response(JSON.stringify(OPEN))]);
    const out = await fetchEonet(deps, OPEN_NOW, shapes);
    expect(out?.map((e) => e.sourceId)).toEqual(["EONET_25340", "EONET_25339", "EONET_25290"]);
    expect(deps.fetch.mock.calls[0][0]).toBe("https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=30");
  });

  it("is null when the feed cannot be read", async () => {
    const deps = fakeDeps([new Error("down"), new Error("still down")]);
    expect(await fetchEonet(deps, OPEN_NOW, shapes)).toBeNull();
  });

  it("is null when the response has no events list", async () => {
    const deps = fakeDeps([response('{"error":"maintenance"}')]);
    expect(await fetchEonet(deps, OPEN_NOW, shapes)).toBeNull();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("no events list"));
  });

  it("is null when the feed lists events in a format it cannot read", async () => {
    const changed = { events: [{ id: "EONET_1", title: "Hurricane X", categories: [{ id: "severeStorms" }], geometries: [] }] };
    const deps = fakeDeps([response(JSON.stringify(changed))]);
    expect(await fetchEonet(deps, OPEN_NOW, shapes)).toBeNull();
  });

  it("returns an empty list for a feed with no events", async () => {
    const deps = fakeDeps([response('{"events":[]}')]);
    expect(await fetchEonet(deps, OPEN_NOW, shapes)).toEqual([]);
  });

  it("never throws, even when fetch throws synchronously", async () => {
    const deps: FetchDeps = {
      fetch: (() => {
        throw new Error("boom");
      }) as unknown as typeof fetch,
      sleep: async () => {},
      log: () => {},
    };
    await expect(fetchEonet(deps, OPEN_NOW, shapes)).resolves.toBeNull();
    await expect(fetchEonet(fakeDeps([response('{"events":[]}')]), "not a date", shapes)).resolves.toEqual([]);
  });
});
