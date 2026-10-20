import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { loadGlobeFeatures } from "../countries";
import type { FetchDeps } from "../googlenews";
import { USER_AGENT } from "../googlenews";
import { buildResolver } from "../resolve";
import {
  CURRENT_MAX_DAYS,
  LIST_QUERIES,
  MAX_AREA_BYTES,
  MAX_PAGES,
  REQUEST_PACE_MS,
  RETRY_DELAY_MS,
  buildTrack,
  chainLines,
  classifyFeature,
  cleanSummary,
  countFeatures,
  dedupeEvents,
  fetchGdacs,
  fetchJson,
  fetchList,
  fitAreas,
  gdacsTime,
  includeEvent,
  listUrl,
  matchName,
  parseGeometry,
  parseList,
  parseListFeature,
  queryWindow,
  resolveCountries,
  resolvePlaceName,
  sourceIdOf,
  splitWindow,
  tidySeverity,
  tidyTitle,
  toSourceEvent,
  type GdacsListEvent,
  type GdacsType,
} from "./gdacs";
import { circlePolygon } from "./geo";
import type { Area, AreaGeometry, Position, SourceEvent } from "./types";

// ---------------------------------------------------------------------------
// Fixtures: trimmed real GDACS responses from 19 October 2026
// ---------------------------------------------------------------------------

/** Reads a fixture next to this file. */
function fixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

interface RawFeature {
  type: string;
  geometry: unknown;
  bbox?: number[];
  properties: Record<string, unknown>;
}

/** The fixture list as raw features, copied so tests can change them freely. */
function rawList(): { type: string; features: RawFeature[] } {
  return fixture("gdacs-list.json") as { type: string; features: RawFeature[] };
}

const NOW = "2026-10-19T21:30:00.000Z";
const resolve = buildResolver(loadGlobeFeatures());
const events = parseList(rawList())!;
const byId = (id: string): GdacsListEvent => {
  const e = events.find((x) => sourceIdOf(x) === id);
  if (!e) throw new Error(`no fixture event ${id}`);
  return e;
};

const GEOMETRY_FIXTURES: Record<GdacsType, string> = {
  TC: "gdacs-geometry-tc.json",
  EQ: "gdacs-geometry-eq.json",
  FL: "gdacs-geometry-fl.json",
  WF: "gdacs-geometry-wf.json",
  DR: "gdacs-geometry-dr.json",
  VO: "gdacs-geometry-vo.json",
};
/** Events whose own real geometry is in the fixtures (others reuse their type's sample). */
const OWN_GEOMETRY: Record<string, string> = { "TC-1001337": "gdacs-geometry-tc-trudy.json" };

/** The events the inclusion rules keep from the fixture list at NOW. */
const EXPECTED_IDS = [
  "TC-1001338", // Red, current
  "TC-1001337", // Green, current
  "TC-1001335", // Orange, current
  "EQ-1570339", // Orange M7.7, 10 days ago: major quakes stay 21 days
  "EQ-1572503", // M6.0 Vanuatu
  "EQ-1571161", // M6.1 Panama
  "EQ-1571305", // M6.8 at sea
  "EQ-1571917", // M6.9 Russia
  "EQ-1572122", // M5.7 on land (Pakistan)
  "FL-1104235", // current
  "FL-1104121", // Orange, 13 days since last update
  "WF-1032653", // 87,349 ha
  "WF-1032785", // 27,117 ha
  // WF-1032552 (13,755 ha) is under the 20,000 ha minimum for Green fires.
  "DR-1018332", // Orange, current
  "DR-1027450", // Orange, updated 3 days ago though not flagged current
  "VO-1000152", // Orange, 10 days ago
  "VO-1000149", // Green, 29 days ago
];

/** A list event with overrides, for hand-made edge cases. */
function eventWith(base: string, over: Partial<GdacsListEvent>): GdacsListEvent {
  return { ...byId(base), ...over };
}

/** Days before NOW, as ISO. */
function daysAgo(days: number): string {
  return new Date(Date.parse(NOW) - days * 86_400_000).toISOString();
}

/** JSON size of all areas' geometries. */
function bytesOf(areas: Area[]): number {
  return areas.reduce((s, a) => s + JSON.stringify(a.geometry).length, 0);
}

interface FakeOptions {
  /** Every list request answers 503. */
  failList?: boolean;
  /** List requests this returns true for answer 503. */
  failListWhen?: (u: URL) => boolean;
  /** Event ids ("EQ-1570339") whose geometry answers 503. */
  failGeometry?: string[];
  /** Rows the list serves; the fixture's by default. */
  rows?: RawFeature[];
  /** Simulates GDACS's unreliable paging: pages after the first start this many rows late, skipping a block. */
  pageSkip?: number;
}

/**
 * A fake GDACS server. The list filters rows as the real one does (type,
 * level, severity minimum, active period overlapping the whole-day window),
 * sorts them by todate, newest first, and serves pages of 100 (204 past the
 * end). Geometry comes from the fixtures by type.
 */
function fakeGdacs(opts: FakeOptions = {}) {
  const urls: string[] = [];
  const rows = opts.rows ?? rawList().features;
  const fetchFn = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const u = new URL(url);
    if (u.pathname.includes("geteventlist")) {
      if (opts.failList || opts.failListWhen?.(u)) return new Response("Service Unavailable", { status: 503 });
      const q = u.searchParams;
      const page = Number(q.get("pagenumber"));
      const types = (q.get("eventlist") ?? "").split(";");
      const levels = (q.get("alertlevel") ?? "").split(";");
      const min = q.has("severity") ? Number(q.get("severity")) : -Infinity;
      const [from, to] = [q.get("fromdate") ?? "", q.get("todate") ?? ""];
      const matches = rows
        .filter((f) => {
          const p = f.properties;
          const sev = Number((p.severitydata as { severity?: number } | undefined)?.severity ?? 0);
          return (
            types.includes(String(p.eventtype)) &&
            levels.includes(String(p.alertlevel)) &&
            sev >= min &&
            String(p.fromdate).slice(0, 10) <= to &&
            String(p.todate).slice(0, 10) >= from
          );
        })
        .sort((a, b) => String(b.properties.todate).localeCompare(String(a.properties.todate)));
      const start = (page - 1) * 100 + (page > 1 ? (opts.pageSkip ?? 0) : 0);
      const features = matches.slice(start, start + 100);
      return features.length > 0 ? Response.json({ type: "FeatureCollection", features }) : new Response(null, { status: 204 });
    }
    if (u.pathname.includes("getgeometry")) {
      const type = u.searchParams.get("eventtype") as GdacsType;
      const id = `${type}-${u.searchParams.get("eventid")}`;
      if (opts.failGeometry?.includes(id)) return new Response("Service Unavailable", { status: 503 });
      return Response.json(fixture(OWN_GEOMETRY[id] ?? GEOMETRY_FIXTURES[type]));
    }
    return new Response("Not found", { status: 404 });
  });
  const deps: FetchDeps = {
    fetch: fetchFn as unknown as typeof fetch,
    sleep: vi.fn(async () => {}),
    log: vi.fn(),
  };
  const geometryCalls = () => urls.filter((u) => u.includes("getgeometry"));
  const listCalls = () => urls.filter((u) => u.includes("geteventlist"));
  return { deps, urls, geometryCalls, listCalls, fetchFn };
}

// ---------------------------------------------------------------------------
// Parsing the list
// ---------------------------------------------------------------------------

describe("gdacsTime", () => {
  it("reads GDACS's zone-less times as UTC", () => {
    expect(gdacsTime("2026-10-19T18:00:00")).toBe("2026-10-19T18:00:00.000Z");
  });
  it("keeps an explicit zone", () => {
    expect(gdacsTime("2026-10-19T18:00:00+02:00")).toBe("2026-10-19T16:00:00.000Z");
    expect(gdacsTime("2026-10-19T18:00:00Z")).toBe("2026-10-19T18:00:00.000Z");
  });
  it("gives null for empty or invalid times", () => {
    expect(gdacsTime("")).toBeNull();
    expect(gdacsTime("not a date")).toBeNull();
  });
});

describe("parseList", () => {
  it("parses every feature of a real page", () => {
    const raw = rawList();
    expect(events).toHaveLength(raw.features.length);
    expect(countFeatures(raw)).toBe(raw.features.length);
  });

  it("maps the fields of a real cyclone entry", () => {
    const e = byId("TC-1001338");
    expect(e).toMatchObject({
      type: "TC",
      eventId: "1001338",
      episodeId: "22",
      name: "Tropical Cyclone CHAMPI-26",
      eventName: "CHAMPI-26",
      alert: "Red",
      iso3: "GUM",
      country: "Guam, Northern Mariana Islands, Japan",
      from: "2026-10-14T12:00:00.000Z",
      to: "2026-10-19T18:00:00.000Z",
      modified: "2026-10-19T21:00:58.000Z",
      current: true,
      severity: 268.5168,
      severityUnit: "km/h",
      glide: "TC-2026-000192-GUM",
      lat: 15.4,
      lng: 136.7,
      geometryUrl: "https://www.gdacs.org/gdacsapi/api/polygons/getgeometry?eventtype=TC&eventid=1001338&episodeid=22",
      reportUrl: "https://www.gdacs.org/report.aspx?eventid=1001338&episodeid=22&eventtype=TC",
    });
    expect(e.affected).toEqual([
      { iso3: "GUM", name: "Guam" },
      { iso3: "JPN", name: "Japan" },
    ]);
  });

  it("collapses the doubled spaces GDACS puts in names", () => {
    expect(byId("VO-1000152").name).toBe("Eruption Kanlaon");
  });

  it("skips malformed features and keeps the rest", () => {
    const good = rawList().features[0];
    const bad = (props: Record<string, unknown>, geometry: unknown = good.geometry) => ({
      ...good,
      geometry,
      properties: { ...good.properties, ...props },
    });
    const parsed = parseList({
      type: "FeatureCollection",
      features: [
        good,
        bad({ eventtype: "XX" }),
        bad({ eventid: "" }),
        bad({ alertlevel: "Purple" }),
        bad({ fromdate: "nope", todate: "nope" }),
        { ...bad({}, null), bbox: undefined },
        bad({}, { type: "Point", coordinates: [10, 95] }),
        null,
        "feature",
      ],
    });
    expect(parsed).toHaveLength(1);
  });

  it("uses the bbox centre when the point is missing", () => {
    const f = { ...rawList().features[0], geometry: null, bbox: [10, 20, 12, 24] };
    expect(parseListFeature(f)).toMatchObject({ lng: 11, lat: 22 });
  });

  it("builds GDACS URLs when the feed's are missing or not on gdacs.org", () => {
    const f = rawList().features[0];
    f.properties.url = { geometry: "https://evil.example/geo", report: "" };
    const e = parseListFeature(f)!;
    expect(e.geometryUrl).toBe("https://www.gdacs.org/gdacsapi/api/polygons/getgeometry?eventtype=TC&eventid=1001338&episodeid=22");
    expect(e.reportUrl).toBe("https://www.gdacs.org/report.aspx?eventtype=TC&eventid=1001338&episodeid=22");
  });

  it("falls back to fromdate when todate is missing", () => {
    const f = rawList().features[0];
    f.properties.todate = "";
    expect(parseListFeature(f)?.to).toBe("2026-10-14T12:00:00.000Z");
  });

  it("returns null for anything that is not a FeatureCollection", () => {
    expect(parseList(null)).toBeNull();
    expect(parseList({})).toBeNull();
    expect(parseList({ type: "Feature" })).toBeNull();
    expect(parseList("<html>")).toBeNull();
    expect(countFeatures(null)).toBe(0);
  });
});

describe("dedupeEvents", () => {
  it("drops the real duplicate GDACS paging produced", () => {
    const deduped = dedupeEvents(events);
    expect(deduped).toHaveLength(events.length - 1);
    expect(deduped.filter((e) => sourceIdOf(e) === "DR-1018344")).toHaveLength(1);
  });

  it("keeps the latest episode, comparing episode ids as numbers", () => {
    const a = eventWith("FL-1104235", { episodeId: "3" });
    const b = eventWith("FL-1104235", { episodeId: "10" });
    expect(dedupeEvents([b, a])[0].episodeId).toBe("10");
    expect(dedupeEvents([a, b])[0].episodeId).toBe("10");
  });

  it("prefers the later todate within the same episode, keeping first-seen order", () => {
    const early = eventWith("FL-1104235", { to: "2026-10-18T00:00:00.000Z" });
    const late = eventWith("FL-1104235", { to: "2026-10-19T00:00:00.000Z" });
    const other = byId("TC-1001338");
    const out = dedupeEvents([early, other, late]);
    expect(out.map(sourceIdOf)).toEqual(["FL-1104235", "TC-1001338"]);
    expect(out[0].to).toBe("2026-10-19T00:00:00.000Z");
  });
});

describe("includeEvent", () => {
  it("keeps exactly the ongoing events of the real list", () => {
    const kept = dedupeEvents(events)
      .filter((e) => includeEvent(e, NOW))
      .map(sourceIdOf);
    expect(kept.sort()).toEqual([...EXPECTED_IDS].sort());
  });

  it("cyclones: current, or within 3 days; a stale current flag is ignored", () => {
    const tc = (current: boolean, days: number) => eventWith("TC-1001337", { current, to: daysAgo(days) });
    expect(includeEvent(tc(false, 2.9), NOW)).toBe(true);
    expect(includeEvent(tc(false, 3.1), NOW)).toBe(false);
    expect(includeEvent(tc(true, 20), NOW)).toBe(true);
    expect(includeEvent(tc(true, CURRENT_MAX_DAYS + 1), NOW)).toBe(false);
  });

  it("earthquakes: Green needs M6+, or M5.5+ in a country, within 10 days", () => {
    const eq = (severity: number, iso3: string, days = 1) => eventWith("EQ-1572503", { severity, iso3, to: daysAgo(days) });
    expect(includeEvent(eq(6.0, ""), NOW)).toBe(true);
    expect(includeEvent(eq(5.9, ""), NOW)).toBe(false);
    expect(includeEvent(eq(5.5, "PAK"), NOW)).toBe(true);
    expect(includeEvent(eq(5.4, "PAK"), NOW)).toBe(false);
    expect(includeEvent(eq(7.0, "PAK", 10.5), NOW)).toBe(false);
  });

  it("earthquakes: Orange stays 21 days and Red 30, whatever the magnitude", () => {
    const eq = (alert: "Orange" | "Red", days: number) => eventWith("EQ-1570339", { alert, severity: 5, iso3: "", to: daysAgo(days) });
    expect(includeEvent(eq("Orange", 20), NOW)).toBe(true);
    expect(includeEvent(eq("Orange", 22), NOW)).toBe(false);
    expect(includeEvent(eq("Red", 29), NOW)).toBe(true);
    expect(includeEvent(eq("Red", 31), NOW)).toBe(false);
  });

  it("floods: current, or within 14 days", () => {
    const fl = (current: boolean, days: number) => eventWith("FL-1104121", { current, to: daysAgo(days) });
    expect(includeEvent(fl(false, 13), NOW)).toBe(true);
    expect(includeEvent(fl(false, 15), NOW)).toBe(false);
    expect(includeEvent(fl(true, 15), NOW)).toBe(true);
  });

  it("wildfires: Orange/Red, or 20,000 ha burned, within 14 days", () => {
    const wf = (over: Partial<GdacsListEvent>) => eventWith("WF-1032891", { to: daysAgo(1), ...over });
    expect(includeEvent(wf({ severity: 19_999 }), NOW)).toBe(false);
    expect(includeEvent(wf({ severity: 20_000 }), NOW)).toBe(true);
    expect(includeEvent(wf({ alert: "Orange", severity: 50 }), NOW)).toBe(true);
    expect(includeEvent(wf({ alert: "Orange", to: daysAgo(15) }), NOW)).toBe(false);
    // Burned area read from the text when the unit is missing.
    expect(includeEvent(wf({ severityUnit: "", severity: null, severityText: "Green impact for forestfire in 22000 ha" }), NOW)).toBe(true);
  });

  it("volcanoes: within 30 days at any level", () => {
    expect(includeEvent(eventWith("VO-1000149", { to: daysAgo(29.9) }), NOW)).toBe(true);
    expect(includeEvent(eventWith("VO-1000149", { to: daysAgo(30.1) }), NOW)).toBe(false);
  });

  it("droughts: Orange/Red only, current or updated within 21 days", () => {
    const dr = (over: Partial<GdacsListEvent>) => eventWith("DR-1027450", { current: false, to: daysAgo(3), ...over });
    expect(includeEvent(dr({}), NOW)).toBe(true);
    expect(includeEvent(dr({ to: daysAgo(22) }), NOW)).toBe(false);
    expect(includeEvent(dr({ to: daysAgo(22), current: true }), NOW)).toBe(true);
    expect(includeEvent(dr({ alert: "Green", current: true }), NOW)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fields of a SourceEvent
// ---------------------------------------------------------------------------

describe("tidyTitle", () => {
  it("tidies real titles", () => {
    expect(tidyTitle(byId("TC-1001338"))).toBe("Tropical Cyclone Champi");
    expect(tidyTitle(byId("EQ-1570339"))).toBe("Earthquake in Panama");
    expect(tidyTitle(byId("DR-1018332"))).toBe("Drought in Europe");
    expect(tidyTitle(byId("DR-1027450"))).toBe("Drought in East Africa, Central Sahel");
    expect(tidyTitle(byId("VO-1000152"))).toBe("Eruption of Kanlaon");
    expect(tidyTitle(byId("WF-1032653"))).toBe("Forest fires in Australia");
    expect(tidyTitle(byId("FL-1104235"))).toBe("Flood in Spain");
  });

  it("falls back to the name, then to the type and country", () => {
    expect(tidyTitle({ type: "TC", name: "Tropical Cyclone TWENTYEIGHT-26", eventName: "", country: "" })).toBe("Tropical Cyclone Twentyeight");
    expect(tidyTitle({ type: "DR", name: "Drought in Kenya", eventName: "", country: "Kenya" })).toBe("Drought in Kenya");
    expect(tidyTitle({ type: "VO", name: "Eruption  Etna", eventName: "", country: "Italy" })).toBe("Eruption of Etna");
    expect(tidyTitle({ type: "FL", name: "", eventName: "", country: "Spain" })).toBe("Flood in Spain");
    expect(tidyTitle({ type: "EQ", name: "", eventName: "", country: "" })).toBe("Earthquake");
  });
});

describe("matchName", () => {
  it("gives storm and volcano names in capitals", () => {
    expect(matchName(byId("TC-1001338"))).toBe("CHAMPI");
    expect(matchName({ type: "TC", eventName: "TWENTYEIGHT-26" })).toBe("TWENTYEIGHT");
    expect(matchName(byId("VO-1000152"))).toBe("KANLAON");
    expect(matchName({ type: "VO", eventName: "Piton de la Fournaise" })).toBe("PITON DE LA FOURNAISE");
    expect(matchName({ type: "VO", eventName: "Popocatépetl" })).toBe("POPOCATEPETL");
  });

  it("gives nothing for other types or unnamed storms", () => {
    expect(matchName(byId("EQ-1570339"))).toBeUndefined();
    expect(matchName(byId("DR-1018332"))).toBeUndefined();
    expect(matchName({ type: "TC", eventName: "" })).toBeUndefined();
  });
});

describe("tidySeverity", () => {
  it("tidies real severity lines", () => {
    expect(tidySeverity(byId("EQ-1570339"))).toBe("Magnitude 7.7, depth 13 km");
    expect(tidySeverity(byId("EQ-1572503"))).toBe("Magnitude 6.0, depth 10 km");
    expect(tidySeverity(byId("TC-1001338"))).toBe("Hurricane/Typhoon, peak winds 269 km/h");
    expect(tidySeverity(byId("TC-1001335"))).toBe("Tropical Depression, peak winds 250 km/h");
    expect(tidySeverity(byId("WF-1032653"))).toBe("87,349 ha burned");
    expect(tidySeverity(byId("DR-1018332"))).toBe("Agricultural drought over 1,759,971 km² (medium impact)");
  });

  it("drops empty and meaningless lines and keeps unknown ones", () => {
    expect(tidySeverity(byId("FL-1104235"))).toBeUndefined(); // "Magnitude 0 "
    expect(tidySeverity(byId("VO-1000152"))).toBeUndefined(); // ""
    expect(tidySeverity({ type: "FL", severityText: "Severe  flooding" })).toBe("Severe flooding");
    expect(tidySeverity({ type: "TC", severityText: "(maximum wind speed of 100 km/h)" })).toBe("Peak winds 100 km/h");
  });
});

describe("cleanSummary", () => {
  it("drops a description that only repeats the name", () => {
    expect(cleanSummary(byId("EQ-1570339"))).toBeUndefined();
  });

  it("drops sentences that restate the alert level", () => {
    expect(cleanSummary({ name: "x", description: "Orange M 7.7 Earthquake in Panama at: 09 Oct 2026 17:56:06." })).toBeUndefined();
    expect(cleanSummary({ name: "x", description: "Green Tropical Cyclone TRUDY-26 in México from: 13 Oct 2026 to: 19 Oct 2026 ." })).toBeUndefined();
    expect(cleanSummary({ name: "x", description: "<p>The flood caused 2 deaths.</p> The Drought notification level is Red." })).toBe(
      "The flood caused 2 deaths.",
    );
  });

  it("keeps useful sentences, even ones starting with a colour word", () => {
    expect(cleanSummary({ name: "x", description: "Red Cross teams are on site. Roads&nbsp;are &amp; closed." })).toBe(
      "Red Cross teams are on site. Roads are & closed.",
    );
  });

  it("drops a sentence equal to the tidied title", () => {
    expect(cleanSummary({ name: "Tropical Cyclone CHAMPI-26", description: "Tropical Cyclone Champi." }, "Tropical Cyclone Champi")).toBeUndefined();
  });
});

describe("resolvePlaceName", () => {
  it("resolves GDACS's offshore and regional names", () => {
    expect(resolvePlaceName("Vanuatu Islands", resolve)).toBe("VU");
    expect(resolvePlaceName("South Of Fiji Islands", resolve)).toBe("FJ");
    expect(resolvePlaceName("Fiji Islands Region", resolve)).toBe("FJ");
    expect(resolvePlaceName("Off Coast Of Ecuador", resolve)).toBe("EC");
    expect(resolvePlaceName("Iceland Region", resolve)).toBe("IS");
    expect(resolvePlaceName("Southern India", resolve)).toBe("IN");
    expect(resolvePlaceName("Off Coast Of Northern Chile", resolve)).toBe("CL");
    expect(resolvePlaceName("México", resolve)).toBe("MX");
    expect(resolvePlaceName("The Democratic Republic of Congo", resolve)).toBe("CD");
  });

  it("tries the full name before stripping a compass word", () => {
    expect(resolvePlaceName("South Africa", resolve)).toBe("ZA");
  });

  it("gives nothing for places at sea or unknown names", () => {
    expect(resolvePlaceName("Central Mid-Atlantic Ridge", resolve)).toBeUndefined();
    expect(resolvePlaceName("Off East Coast Of Kamchatka", resolve)).toBeUndefined();
    expect(resolvePlaceName("Atlantis", resolve)).toBeUndefined();
    expect(resolvePlaceName("  ", resolve)).toBeUndefined();
  });
});

describe("resolveCountries", () => {
  it("puts the primary country first and drops names the globe lacks", () => {
    expect(resolveCountries(byId("TC-1001338"), resolve)).toEqual(["JP"]); // Guam and the Northern Marianas are not on the map
    expect(resolveCountries(byId("WF-1032785"), resolve)).toEqual(["BW", "ZW"]);
    expect(resolveCountries(byId("EQ-1571305"), resolve)).toEqual([]);
  });

  it("lists every affected country once, in order", () => {
    const codes = resolveCountries(byId("DR-1018332"), resolve);
    expect(codes[0]).toBe("AT");
    expect(codes).toContain("BA");
    expect(codes).toContain("UA");
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("falls back to country names when there is no ISO3", () => {
    expect(resolveCountries({ iso3: "", affected: [], country: "Vanuatu Islands" }, resolve)).toEqual(["VU"]);
    expect(resolveCountries({ iso3: "", affected: [{ iso3: "", name: "Kenya" }], country: "Kenya, Atlantis" }, resolve)).toEqual(["KE"]);
  });
});

describe("toSourceEvent", () => {
  const champiGeometry = parseGeometry("TC", fixture("gdacs-geometry-tc.json"), byId("TC-1001338"))!;

  it("maps a real cyclone with its geometry", () => {
    const s = toSourceEvent(byId("TC-1001338"), resolve, champiGeometry);
    expect(s).toMatchObject({
      source: "gdacs",
      sourceId: "TC-1001338",
      type: "cyclone",
      title: "Tropical Cyclone Champi",
      severity: 3,
      severityText: "Hurricane/Typhoon, peak winds 269 km/h",
      countries: ["JP"],
      lat: 15.4,
      lng: 136.7,
      precision: "exact",
      started: "2026-10-14T12:00:00.000Z",
      updated: "2026-10-19T21:00:58.000Z", // datemodified is later than todate
      links: [{ name: "GDACS report", url: "https://www.gdacs.org/report.aspx?eventid=1001338&episodeid=22&eventtype=TC" }],
      glide: "TC-2026-000192-GUM",
      name: "CHAMPI",
      revision: "22",
    });
    expect(s.areas.map((a) => [a.kind, a.level])).toEqual([
      ["wind", 60],
      ["wind", 90],
      ["wind", 120],
    ]);
    expect(s.track?.forecast.length).toBeGreaterThan(1);
    expect(s).not.toHaveProperty("summary");
  });

  it("uses todate as updated when it is the latest", () => {
    const e = eventWith("FL-1104235", { modified: "2026-10-01T00:00:00.000Z" });
    expect(toSourceEvent(e, resolve).updated).toBe(e.to);
    expect(toSourceEvent(eventWith("FL-1104235", { modified: null }), resolve).updated).toBe(e.to);
  });

  it("sets precision by type and by whether the area is mapped", () => {
    const area: Area = { kind: "affected", geometry: circlePolygon(0, 0, 10) };
    expect(toSourceEvent(byId("FL-1104235"), resolve).precision).toBe("area");
    expect(toSourceEvent(byId("FL-1104235"), resolve, { areas: [area] }).precision).toBe("area");
    expect(toSourceEvent(byId("DR-1018332"), resolve, { areas: [area] }).precision).toBe("area");
    expect(toSourceEvent(byId("WF-1032653"), resolve).precision).toBe("area");
    expect(toSourceEvent(byId("WF-1032653"), resolve, { areas: [area] }).precision).toBe("exact");
    expect(toSourceEvent(byId("EQ-1570339"), resolve, null).precision).toBe("exact");
    expect(toSourceEvent(byId("VO-1000152"), resolve).precision).toBe("exact");
  });

  it("leaves out empty optional fields", () => {
    const s = toSourceEvent(byId("FL-1104235"), resolve, null, "");
    expect(s.areas).toEqual([]);
    for (const key of ["track", "glide", "name", "revision", "severityText", "summary"]) expect(s).not.toHaveProperty(key);
  });

  it("maps every alert level to a severity", () => {
    expect(toSourceEvent(eventWith("FL-1104235", { alert: "Green" }), resolve).severity).toBe(1);
    expect(toSourceEvent(eventWith("FL-1104235", { alert: "Orange" }), resolve).severity).toBe(2);
    expect(toSourceEvent(eventWith("FL-1104235", { alert: "Red" }), resolve).severity).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

describe("classifyFeature", () => {
  it.each([
    ["TC", { Class: "Poly_Green", polygonlabel: "60 km/h" }, { kind: "wind", level: 60 }],
    ["TC", { Class: "Poly_Red", polygonlabel: "120 km/h" }, { kind: "wind", level: 120 }],
    ["TC", { Class: "Poly_Green", polygonlabel: "19/10 18:00", featuretype: "WindRadii" }, null],
    ["TC", { Class: "Point_Polygon_Point_0", polygonlabel: "14/10 12:00 UTC", featuretype: "PointRadii" }, null],
    ["TC", { Class: "Poly_Cones", polygonlabel: "Uncertainty Cones" }, null],
    ["EQ", { Class: "Poly_SMPInt_4", polygonlabel: "Intensity 4" }, { kind: "shaking", level: 4 }],
    ["EQ", { Class: "Poly_SMPInt_5", polygonlabel: "Intensity 4.5" }, { kind: "shaking", level: 4.5 }],
    ["EQ", { Class: "Poly_SMPInt_4", polygonlabel: "Intensity 3.5" }, null],
    ["EQ", { Class: "Poly_Circle", polygonlabel: "100km" }, null],
    ["FL", { Class: "Poly_Affected", polygonlabel: "Affected area" }, { kind: "affected" }],
    ["FL", { Class: "Poly_Global", polygonlabel: "Global area" }, null],
    ["WF", { Class: "Poly_area", polygonlabel: "Affected Area" }, { kind: "affected" }],
    ["DR", { Class: "Poly_area", polygonlabel: "Affected Area" }, { kind: "affected" }],
    ["VO", { Class: "Poly_Circle", polygonlabel: "30Km" }, { kind: "affected" }],
    ["DR", { Class: "Point_Centroid", polygonlabel: "Centroid" }, null],
  ] as const)("%s %o", (type, props, expected) => {
    expect(classifyFeature(type, props)).toEqual(expected);
  });
});

describe("chainLines", () => {
  const p = (lng: number, lat: number): Position => [lng, lat];

  it("joins pieces listed out of time order", () => {
    const pieces = [
      [p(2, 0), p(3, 0)],
      [p(0, 0), p(1, 0)],
      [p(1, 0), p(2, 0)],
    ];
    expect(chainLines(pieces)).toEqual([p(0, 0), p(1, 0), p(2, 0), p(3, 0)]);
  });

  it("joins separate stretches nearest end to nearest start", () => {
    const pieces = [
      [p(10, 0), p(11, 0)],
      [p(0, 0), p(1, 0)],
      [p(1.5, 0), p(2, 0)],
    ];
    expect(chainLines(pieces)).toEqual([p(0, 0), p(1, 0), p(1.5, 0), p(2, 0), p(10, 0), p(11, 0)]);
  });

  it("handles loops, short pieces and nothing", () => {
    expect(chainLines([[p(0, 0), p(1, 0)], [p(1, 0), p(0, 0)]])).toEqual([p(0, 0), p(1, 0), p(0, 0)]);
    expect(chainLines([[p(0, 0)], []])).toEqual([]);
    expect(chainLines([])).toEqual([]);
  });
});

describe("buildTrack", () => {
  /** Line segments of a real geometry fixture. */
  const segmentsOf = (name: string) =>
    (fixture(name) as { features: RawFeature[] }).features
      .filter((f) => (f.geometry as { type: string }).type === "LineString")
      .map((f) => ({ coords: (f.geometry as { coordinates: Position[] }).coordinates, forecast: f.properties.forecast === true }));

  it("splits Champi's real track where the storm is now", () => {
    const t = buildTrack(segmentsOf("gdacs-geometry-tc.json"), { lat: 15.4, lng: 136.7 })!;
    expect(t.past[0]).toEqual([161.2, 9.6]);
    expect(t.past.at(-1)).toEqual([136.7, 15.4]);
    expect(t.forecast[0]).toEqual([136.7, 15.4]);
    expect(t.forecast.at(-1)).toEqual([123.9, 28.9]);
    expect(t.past.length + t.forecast.length - 1).toBe(30); // 29 segments, one shared point
  });

  it("splits Trudy at her listed position although GDACS flags the last observed leg as forecast", () => {
    const t = buildTrack(segmentsOf("gdacs-geometry-tc-trudy.json"), { lat: 19.3, lng: -107.9 })!;
    expect(t.past[0]).toEqual([-96.5, 9.8]);
    expect(t.past.at(-1)).toEqual([-107.9, 19.3]);
    expect(t.past.at(-2)).toEqual([-108.5, 19.5]);
    expect(t.forecast).toEqual([
      [-107.9, 19.3],
      [-108.3, 19.4],
      [-108.9, 19.5],
      [-109.3, 19.8],
      [-109.5, 20.2],
    ]);
  });

  it("falls back to the forecast flags without a nearby position", () => {
    for (const current of [undefined, { lat: -40, lng: 0 }]) {
      const t = buildTrack(segmentsOf("gdacs-geometry-tc-trudy.json"), current)!;
      expect(t.past.at(-1)).toEqual([-108.5, 19.5]);
      expect(t.forecast[0]).toEqual([-108.5, 19.5]);
      expect(t.forecast.at(-1)).toEqual([-109.5, 20.2]);
    }
  });

  it("gives an empty forecast for a storm that has ended", () => {
    const segs = [
      { coords: [[0, 0], [1, 1]] as Position[], forecast: false },
      { coords: [[1, 1], [2, 2]] as Position[], forecast: false },
    ];
    expect(buildTrack(segs, { lat: 2, lng: 2 })).toEqual({ past: [[0, 0], [1, 1], [2, 2]], forecast: [] });
    expect(buildTrack(segs)).toEqual({ past: [[0, 0], [1, 1], [2, 2]], forecast: [] });
  });

  it("matches the position across the antimeridian", () => {
    const segs = [
      { coords: [[178, 10], [179.9, 11]] as Position[], forecast: false },
      { coords: [[179.9, 11], [-178, 12]] as Position[], forecast: true },
    ];
    const t = buildTrack(segs, { lat: 11, lng: -179.95 })!;
    expect(t.past.at(-1)).toEqual([179.9, 11]);
  });

  it("gives nothing without segments", () => {
    expect(buildTrack([])).toBeUndefined();
    expect(buildTrack([], { lat: 0, lng: 0 })).toBeUndefined();
  });
});

describe("fitAreas", () => {
  const ring = (n: number): AreaGeometry => circlePolygon(10, 20, 300, n);

  it("keeps small areas within budget and rounds them", () => {
    const out = fitAreas([{ kind: "affected", geometry: ring(32) }], 60_000);
    expect(out).toHaveLength(1);
    expect(bytesOf(out)).toBeLessThanOrEqual(60_000);
  });

  it("shares the budget between areas", () => {
    const areas: Area[] = [40, 30, 20].map((km, i) => ({ kind: "wind", level: i, geometry: circlePolygon(10, 20, km * 10, 4000) }));
    expect(bytesOf(areas)).toBeGreaterThan(100_000);
    const out = fitAreas(areas, 20_000);
    expect(out.map((a) => a.level)).toEqual([0, 1, 2]);
    expect(bytesOf(out)).toBeLessThanOrEqual(20_000);
  });

  it("stays within a tiny budget even with many areas", () => {
    const areas: Area[] = Array.from({ length: 12 }, (_, i) => ({ kind: "shaking", level: 4 + i / 2, geometry: circlePolygon(0, 0, 400 - i * 30, 512) }));
    const out = fitAreas(areas, 2_000);
    expect(out.length).toBeGreaterThan(0);
    expect(bytesOf(out)).toBeLessThanOrEqual(2_000);
  });

  it("drops areas that vanish and handles none", () => {
    const tiny: Area = { kind: "affected", geometry: { type: "Polygon", coordinates: [[[0, 0], [0.0001, 0], [0, 0.0001], [0, 0]]] } };
    expect(fitAreas([tiny])).toEqual([]);
    expect(fitAreas([])).toEqual([]);
  });
});

describe("parseGeometry", () => {
  it("reads a cyclone's wind buffers and track and ignores per-timestep shapes", () => {
    const g = parseGeometry("TC", fixture("gdacs-geometry-tc.json"), { lat: 15.4, lng: 136.7 })!;
    expect(g.areas.map((a) => [a.kind, a.level])).toEqual([
      ["wind", 60],
      ["wind", 90],
      ["wind", 120],
    ]);
    expect(g.track?.past.at(-1)).toEqual([136.7, 15.4]);
  });

  it("reads an earthquake's shaking bands from intensity 4 up", () => {
    const g = parseGeometry("EQ", fixture("gdacs-geometry-eq.json"))!;
    expect(g.areas.map((a) => a.level)).toEqual([4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5]);
    expect(g.areas.every((a) => a.kind === "shaking")).toBe(true);
    expect(g.track).toBeUndefined();
  });

  it("reads flood, fire, drought and volcano footprints", () => {
    for (const [type, name] of [
      ["FL", "gdacs-geometry-fl.json"],
      ["WF", "gdacs-geometry-wf.json"],
      ["DR", "gdacs-geometry-dr.json"],
      ["VO", "gdacs-geometry-vo.json"],
    ] as const) {
      const g = parseGeometry(type, fixture(name))!;
      expect(g.areas, type).toHaveLength(1);
      expect(g.areas[0].kind, type).toBe("affected");
    }
  });

  it("keeps the flood's affected area, not the much larger global area", () => {
    const g = parseGeometry("FL", fixture("gdacs-geometry-fl.json"))!;
    const coords = JSON.stringify(g.areas[0].geometry.coordinates);
    // The Spanish flood's affected area is near Barcelona (2.4 E, 41.5 N).
    const lngs = [...coords.matchAll(/\[(-?[\d.]+),(-?[\d.]+)\]/g)].map((m) => Number(m[1]));
    expect(Math.min(...lngs)).toBeGreaterThan(-10);
    expect(Math.max(...lngs)).toBeLessThan(5);
  });

  it("fits every real geometry in the byte budget", () => {
    for (const [type, name] of Object.entries(GEOMETRY_FIXTURES)) {
      const g = parseGeometry(type as GdacsType, fixture(name))!;
      expect(bytesOf(g.areas), name).toBeLessThanOrEqual(MAX_AREA_BYTES);
      const small = parseGeometry(type as GdacsType, fixture(name), undefined, 3_000)!;
      expect(bytesOf(small.areas), name).toBeLessThanOrEqual(3_000);
      expect(small.areas.length, name).toBeGreaterThan(0);
    }
  });

  it("merges features that share a kind and level", () => {
    const poly = (lng: number) => ({ type: "Polygon", coordinates: [[[lng, 0], [lng + 1, 0], [lng + 1, 1], [lng, 1], [lng, 0]]] });
    const fc = {
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: poly(0), properties: { Class: "Poly_area" } },
        { type: "Feature", geometry: poly(5), properties: { Class: "Poly_area" } },
        { type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: { Class: "Point_Centroid" } },
        { type: "Feature", geometry: null, properties: { Class: "Poly_area" } },
        { type: "Feature", geometry: { type: "Polygon", coordinates: [[["x", 0]]] }, properties: { Class: "Poly_area" } },
      ],
    };
    const g = parseGeometry("WF", fc)!;
    expect(g.areas).toHaveLength(1);
    expect(g.areas[0].geometry.type).toBe("MultiPolygon");
    expect(g.areas[0].geometry.coordinates).toHaveLength(2);
  });

  it("gives empty areas for a collection with nothing usable, and null for a non-collection", () => {
    expect(parseGeometry("EQ", { type: "FeatureCollection", features: [] })).toEqual({ areas: [] });
    expect(parseGeometry("EQ", null)).toBeNull();
    expect(parseGeometry("EQ", { features: [] })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

describe("fetchJson", () => {
  const depsWith = (...responses: (Response | Error)[]) => {
    const fetchFn = vi.fn(async () => {
      const r = responses.shift();
      if (r instanceof Error) throw r;
      return r!;
    });
    const deps: FetchDeps = { fetch: fetchFn as unknown as typeof fetch, sleep: vi.fn(async () => {}), log: vi.fn() };
    return { deps, fetchFn };
  };

  it("retries once after a 503 and returns the body", async () => {
    const { deps, fetchFn } = depsWith(new Response("busy", { status: 503 }), Response.json({ ok: 1 }));
    expect(await fetchJson("https://www.gdacs.org/x", "x", deps)).toEqual({ body: { ok: 1 } });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(deps.sleep).toHaveBeenCalledWith(RETRY_DELAY_MS);
    expect(deps.log).toHaveBeenCalledTimes(1);
  });

  it("treats 204 and an empty reply as no data, without retrying", async () => {
    const a = depsWith(new Response(null, { status: 204 }));
    expect(await fetchJson("https://www.gdacs.org/x", "x", a.deps)).toEqual({ body: null });
    expect(a.fetchFn).toHaveBeenCalledTimes(1);
    const b = depsWith(new Response("  ", { status: 200 }));
    expect(await fetchJson("https://www.gdacs.org/x", "x", b.deps)).toEqual({ body: null });
  });

  it("returns null without throwing when both attempts fail", async () => {
    const { deps, fetchFn } = depsWith(new TypeError("fetch failed"), new Response("<html>oops", { status: 200 }));
    expect(await fetchJson("https://www.gdacs.org/x", "x", deps, 7)).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(deps.sleep).toHaveBeenCalledWith(7);
    expect(deps.log).toHaveBeenCalledTimes(2);
  });

  it("sends the user agent and a time limit", async () => {
    const { deps, fetchFn } = depsWith(Response.json({}));
    await fetchJson("https://www.gdacs.org/x", "x", deps);
    const init = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)["User-Agent"]).toBe(USER_AGENT);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("queryWindow and listUrl", () => {
  it("asks for each query's window through tomorrow, with the severity minimum when set", () => {
    const [tcfl, eqGreen, eqMajor, wfGreen, wfMajor, vodr] = LIST_QUERIES;
    expect(queryWindow(tcfl, NOW)).toEqual({ from: "2026-10-04", to: "2026-10-20" });
    expect(listUrl(tcfl, queryWindow(tcfl, NOW), 2)).toBe(
      "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=TC;FL&alertlevel=Green;Orange;Red&fromdate=2026-10-04&todate=2026-10-20&pagenumber=2",
    );
    expect(listUrl(eqGreen, queryWindow(eqGreen, NOW), 1)).toContain("eventlist=EQ&alertlevel=Green&fromdate=2026-10-08&todate=2026-10-20&severity=5.5&");
    expect(listUrl(eqMajor, queryWindow(eqMajor, NOW), 1)).toContain("eventlist=EQ&alertlevel=Orange;Red&fromdate=2026-09-18&todate=2026-10-20&pagenumber=1");
    expect(listUrl(wfGreen, queryWindow(wfGreen, NOW), 1)).toContain("eventlist=WF&alertlevel=Green&fromdate=2026-10-04&todate=2026-10-20&severity=20000&");
    expect(listUrl(wfMajor, queryWindow(wfMajor, NOW), 1)).toContain("eventlist=WF&alertlevel=Orange;Red&");
    expect(listUrl(vodr, queryWindow(vodr, NOW), 1)).toContain("eventlist=VO;DR&alertlevel=Green;Orange;Red&fromdate=2026-09-18");
  });
});

describe("splitWindow", () => {
  it("halves a window into whole days that cover it without overlap", () => {
    expect(splitWindow({ from: "2026-10-04", to: "2026-10-20" })).toEqual([
      { from: "2026-10-04", to: "2026-10-12" },
      { from: "2026-10-13", to: "2026-10-20" },
    ]);
    expect(splitWindow({ from: "2026-10-04", to: "2026-10-07" })).toEqual([
      { from: "2026-10-04", to: "2026-10-05" },
      { from: "2026-10-06", to: "2026-10-07" },
    ]);
    expect(splitWindow({ from: "2026-09-28", to: "2026-10-03" })).toEqual([
      { from: "2026-09-28", to: "2026-09-30" },
      { from: "2026-10-01", to: "2026-10-03" },
    ]);
  });

  it("splits two days into single days and cannot split one day", () => {
    expect(splitWindow({ from: "2026-10-19", to: "2026-10-20" })).toEqual([
      { from: "2026-10-19", to: "2026-10-19" },
      { from: "2026-10-20", to: "2026-10-20" },
    ]);
    expect(splitWindow({ from: "2026-10-19", to: "2026-10-19" })).toBeNull();
    expect(splitWindow({ from: "bad", to: "2026-10-19" })).toBeNull();
  });

  it("always makes both parts smaller and covers every day exactly once, so splitting ends", () => {
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const start = Date.parse("2026-09-01");
    for (let span = 1; span <= 40; span++) {
      const [a, b] = splitWindow({ from: day(start), to: day(start + span * 86_400_000) })!;
      for (const part of [a, b]) {
        expect(Date.parse(part.to) - Date.parse(part.from)).toBeLessThan(span * 86_400_000);
        expect(part.from <= part.to).toBe(true);
      }
      expect(a.from).toBe(day(start));
      expect(Date.parse(b.from) - Date.parse(a.to)).toBe(86_400_000);
      expect(b.to).toBe(day(start + span * 86_400_000));
    }
  });
});

/** Synthetic Green wildfires copied from a real fixture row, each active on one day (YYYY-MM-DD). */
function wildfireRows(days: string[]): RawFeature[] {
  const base = rawList().features.find((f) => f.properties.eventid === 1032653)!;
  return days.map((day, i) => ({
    ...base,
    properties: { ...base.properties, eventid: 2_000_000 + i, fromdate: `${day}T00:00:00`, todate: `${day}T00:00:00` },
  }));
}

describe("fetchList", () => {
  const ids = (list: GdacsListEvent[] | null) => new Set((list ?? []).map(sourceIdOf));

  it("reads every query in one short page each and finds every listed event", async () => {
    const fake = fakeGdacs();
    const list = await fetchList(fake.deps, NOW);
    expect(fake.listCalls()).toHaveLength(LIST_QUERIES.length);
    for (const id of EXPECTED_IDS) expect(ids(list), id).toContain(id);
    // The server filters small Green quakes and fires: the M4.8 Tonga quake and the 7,772 ha fire are not listed.
    expect(ids(list)).not.toContain("EQ-1572616");
    expect(ids(list)).not.toContain("WF-1032891");
  });

  it("splits a full window instead of paging, so rows GDACS's paging skips are still found (regression)", async () => {
    // 150 fires over 15 days; real GDACS paging started page 2 a block of rows late.
    const days = Array.from({ length: 150 }, (_, i) => `2026-10-${String(5 + (i % 15)).padStart(2, "0")}`);
    const fake = fakeGdacs({ rows: wildfireRows(days), pageSkip: 20 });
    const list = await fetchList(fake.deps, NOW, [LIST_QUERIES[3]]);
    expect(ids(list).size).toBe(150);
    const windows = fake.listCalls().map((u) => {
      const q = new URL(u).searchParams;
      return `${q.get("fromdate")}..${q.get("todate")} p${q.get("pagenumber")}`;
    });
    expect(windows).toEqual(["2026-10-04..2026-10-20 p1", "2026-10-04..2026-10-12 p1", "2026-10-13..2026-10-20 p1"]);
    expect(fake.deps.sleep).toHaveBeenCalledTimes(2); // paced between requests
  });

  it("pages through a single day that holds more than a page, and stops at a 204", async () => {
    const fake = fakeGdacs({ rows: wildfireRows(Array.from({ length: 250 }, () => "2026-10-19")) });
    const q = { types: ["WF" as const], levels: ["Green" as const], days: 0 };
    const list = await fetchList(fake.deps, NOW, [q]);
    expect(ids(list).size).toBe(250);
    const oneDay = fake.listCalls().filter((u) => u.includes("fromdate=2026-10-19&todate=2026-10-19"));
    expect(oneDay.map((u) => new URL(u).searchParams.get("pagenumber"))).toEqual(["1", "2", "3"]);
    expect(fake.deps.log).toHaveBeenCalledWith(expect.stringContaining("paging"));
  });

  it("stops after MAX_PAGES on a single day", async () => {
    const fake = fakeGdacs({ rows: wildfireRows(Array.from({ length: 100 * MAX_PAGES + 50 }, () => "2026-10-19")) });
    await fetchList(fake.deps, NOW, [{ types: ["WF"], levels: ["Green"], days: 0 }]);
    expect(fake.listCalls().filter((u) => u.includes("fromdate=2026-10-19&todate=2026-10-19"))).toHaveLength(MAX_PAGES);
  });

  it("fails as a whole when a request fails twice or is not a FeatureCollection", async () => {
    const fake = fakeGdacs({ failList: true });
    expect(await fetchList(fake.deps, NOW)).toBeNull();
    expect(fake.listCalls()).toHaveLength(2);

    const html: FetchDeps = { fetch: vi.fn(async () => Response.json({ error: "x" })) as unknown as typeof fetch, sleep: vi.fn(async () => {}), log: vi.fn() };
    expect(await fetchList(html, NOW)).toBeNull();
  });

  it("fails as a whole when one part of a split window fails", async () => {
    const days = Array.from({ length: 150 }, (_, i) => `2026-10-${String(5 + (i % 15)).padStart(2, "0")}`);
    const fake = fakeGdacs({ rows: wildfireRows(days), failListWhen: (u) => u.searchParams.get("fromdate") === "2026-10-13" });
    expect(await fetchList(fake.deps, NOW, [LIST_QUERIES[3]])).toBeNull();
  });
});

describe("fetchGdacs", () => {
  it("returns the ongoing events with their geometry", async () => {
    const fake = fakeGdacs();
    const out = (await fetchGdacs(fake.deps, NOW, resolve))!;
    expect(out.map((e) => e.sourceId).sort()).toEqual([...EXPECTED_IDS].sort());
    expect(out.every((e) => e.source === "gdacs")).toBe(true);
    expect(fake.geometryCalls()).toHaveLength(EXPECTED_IDS.length);
    expect(fake.deps.sleep).toHaveBeenCalledWith(REQUEST_PACE_MS);
    for (const e of out) expect(bytesOf(e.areas), e.sourceId).toBeLessThanOrEqual(MAX_AREA_BYTES);

    const trudy = out.find((e) => e.sourceId === "TC-1001337")!;
    expect(trudy.track?.past.at(-1)).toEqual([-107.9, 19.3]);
    expect(trudy.revision).toBe("26");
    const panama = out.find((e) => e.sourceId === "EQ-1570339")!;
    expect(panama.areas.map((a) => a.level)).toEqual([4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5]);
  });

  it("reuses previous geometry for the same event and episode", async () => {
    const first = (await fetchGdacs(fakeGdacs().deps, NOW, resolve))!;
    const fake = fakeGdacs();
    const second = (await fetchGdacs(fake.deps, NOW, resolve, first))!;
    // Trudy's fixture has only a track, so every event had something to reuse.
    expect(fake.geometryCalls()).toHaveLength(0);
    expect(second).toEqual(first);
  });

  it("fetches again when the episode changed", async () => {
    const first = (await fetchGdacs(fakeGdacs().deps, NOW, resolve))!;
    const stale = first.map((e) => (e.sourceId === "EQ-1570339" ? { ...e, revision: "1" } : e));
    const fake = fakeGdacs();
    await fetchGdacs(fake.deps, NOW, resolve, stale);
    expect(fake.geometryCalls()).toEqual([expect.stringContaining("eventid=1570339")]);
  });

  it("keeps the previous areas, and their revision, when a geometry fetch fails", async () => {
    const first = (await fetchGdacs(fakeGdacs().deps, NOW, resolve))!;
    const old = first.find((e) => e.sourceId === "EQ-1570339")!;
    const previous = [{ ...old, revision: "1" }];
    const fake = fakeGdacs({ failGeometry: ["EQ-1570339", "FL-1104235"] });
    const out = (await fetchGdacs(fake.deps, NOW, resolve, previous))!;
    const eq = out.find((e) => e.sourceId === "EQ-1570339")!;
    expect(eq.areas).toEqual(old.areas);
    expect(eq.revision).toBe("1"); // so the next run tries the new episode again
    const fl = out.find((e) => e.sourceId === "FL-1104235")!;
    expect(fl.areas).toEqual([]);
    expect(fl.precision).toBe("area");
    expect(fl.revision).toBe("2");
  });

  it("ignores previous events from other sources", async () => {
    const first = (await fetchGdacs(fakeGdacs().deps, NOW, resolve))!;
    const fromUsgs: SourceEvent[] = first.map((e) => ({ ...e, source: "usgs" }));
    const fake = fakeGdacs();
    await fetchGdacs(fake.deps, NOW, resolve, fromUsgs);
    expect(fake.geometryCalls()).toHaveLength(EXPECTED_IDS.length);
  });

  it("returns null when every list query comes back empty, so an empty list never replaces the previous events (regression)", async () => {
    const fake = fakeGdacs({ rows: [] });
    expect(await fetchGdacs(fake.deps, NOW, resolve)).toBeNull();
    expect(fake.listCalls()).toHaveLength(LIST_QUERIES.length);
    expect(fake.geometryCalls()).toHaveLength(0);
    expect(fake.deps.log).toHaveBeenCalledWith(expect.stringContaining("came back empty"));
  });

  it("does not throw on malformed previous entries read from a file (regression)", async () => {
    const first = (await fetchGdacs(fakeGdacs().deps, NOW, resolve))!;
    const panama = first.find((e) => e.sourceId === "EQ-1570339")!;
    const junk = [
      null,
      { source: "gdacs" },
      { ...panama, sourceId: "FL-1104235", areas: undefined, track: { past: "x" } },
      { ...panama, areas: null },
    ] as unknown as SourceEvent[];
    const fake = fakeGdacs();
    const out = (await fetchGdacs(fake.deps, NOW, resolve, junk))!;
    expect(out.map((e) => e.sourceId).sort()).toEqual([...EXPECTED_IDS].sort());
    expect(fake.geometryCalls()).toHaveLength(EXPECTED_IDS.length); // nothing usable to reuse
    expect(await fetchGdacs(fakeGdacs().deps, NOW, resolve, null as unknown as SourceEvent[])).toHaveLength(EXPECTED_IDS.length);
  });

  it("returns null when the list fails, without fetching geometry", async () => {
    const fake = fakeGdacs({ failList: true });
    expect(await fetchGdacs(fake.deps, NOW, resolve)).toBeNull();
    expect(fake.geometryCalls()).toHaveLength(0);
    expect(fake.deps.log).toHaveBeenCalledWith(expect.stringContaining("previous events kept"));
  });
});
