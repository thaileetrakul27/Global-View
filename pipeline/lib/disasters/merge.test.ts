import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { circlePolygon } from "./geo";
import {
  aftershockKm,
  groupSequences,
  sameShock,
  quakeMagnitude,
  withAftershocks,
  APART_KM,
  FAMILY_OF,
  MAJOR_QUAKE_DAYS,
  MAX_AREA_BYTES,
  MAX_SOURCES,
  ONGOING_DAYS,
  assignIds,
  buildDisaster,
  byPrecision,
  byPriority,
  capAreas,
  carryOver,
  clusterEvents,
  compareDisasters,
  distanceKm,
  freshId,
  glideKey,
  insideAreas,
  isApart,
  isOngoing,
  matchScore,
  mergeAppeals,
  mergeEvents,
  mergeFigures,
  mergePlaces,
  mergeSources,
  ongoingDays,
  periodsOverlap,
  pickSummary,
  pickTitle,
  pickTrack,
  ruleMatch,
  sameName,
  shareCountry,
  sharesGlide,
  sourceOfKey,
  uniqueEvents,
} from "./merge";
import { DISASTER_TYPES, memberKey } from "./types";
import type { AppealRef, Area, Disaster, SourceEvent } from "./types";

// ---------------------------------------------------------------------------
// Builders. Positions, times and ids below are taken from the real GDACS,
// USGS, EONET and IFRC GO feeds of 19 October 2026 (see fixtures/).
// ---------------------------------------------------------------------------

const NOW = "2026-10-19T22:00:00Z";
const DAY = 24 * 60 * 60 * 1000;

/** ISO time `days` before NOW. */
function daysAgo(days: number): string {
  return new Date(Date.parse(NOW) - days * DAY).toISOString();
}

/** A SourceEvent with sensible defaults for the fields a test does not care about. */
function ev(p: Partial<SourceEvent> & Pick<SourceEvent, "source" | "sourceId" | "type">): SourceEvent {
  return {
    title: `${p.source} ${p.sourceId}`,
    severity: 1,
    countries: [],
    lat: 0,
    lng: 0,
    precision: "exact",
    started: daysAgo(1),
    updated: daysAgo(0.5),
    areas: [],
    links: [{ name: `${p.source} page`, url: `https://example.org/${p.source}/${p.sourceId}` }],
    ...p,
  };
}

/** A minimal Disaster for lifecycle and id tests. */
function dis(p: Partial<Disaster> & Pick<Disaster, "id">): Disaster {
  return {
    type: "flood",
    title: p.id,
    severity: 1,
    countries: [],
    lat: 0,
    lng: 0,
    precision: "exact",
    started: daysAgo(2),
    updated: daysAgo(1),
    areas: [],
    places: [],
    figures: [],
    sources: [],
    appeals: [],
    donate: [],
    reportedBy: [],
    members: [],
    ...p,
  };
}

function appeal(code: string, end: string): AppealRef {
  return { code, name: `Appeal ${code}`, kind: "DREF", requested: 100000, funded: 0, url: `https://go.ifrc.org/appeal/${code}`, end };
}

// Real events: the M7.7 Panama quake of 9 October and its M5.8 aftershock 40 minutes later.
const panamaGdacs = ev({
  source: "gdacs",
  sourceId: "EQ-1570339",
  type: "earthquake",
  title: "Earthquake in Panama",
  severity: 2,
  severityText: "Magnitude 7.7M, Depth:10km",
  countries: ["PA"],
  lat: 7.5868,
  lng: -80.769,
  started: "2026-10-09T17:56:06Z",
  updated: "2026-10-10T02:00:00Z",
  summary: "GDACS orange alert for the earthquake in Panama.",
  links: [{ name: "GDACS report", url: "https://www.gdacs.org/report.aspx?eventid=1570339&eventtype=EQ" }],
});
const panamaUsgs = ev({
  source: "usgs",
  sourceId: "us6000u18k",
  type: "earthquake",
  title: "M7.7 earthquake 12 km WSW of Pitaloza Arriba, Panama",
  severity: 3,
  severityText: "Magnitude 7.7, depth 10 km, PAGER red",
  countries: ["PA", "CR"],
  lat: 7.5868,
  lng: -80.769,
  started: "2026-10-09T17:56:06.036Z",
  updated: "2026-10-12T08:30:00Z",
  links: [{ name: "USGS event page", url: "https://earthquake.usgs.gov/earthquakes/eventpage/us6000u18k" }],
});
const panamaAftershock = ev({
  source: "usgs",
  sourceId: "us6000u18x",
  type: "earthquake",
  title: "M5.8 earthquake 1 km S of El Cacao, Panama",
  severity: 1,
  countries: ["PA"],
  lat: 7.4362,
  lng: -80.4012,
  started: "2026-10-09T18:37:46.146Z",
  updated: "2026-10-10T01:00:00Z",
});

// Two Vanuatu quakes 20 km and 11 hours apart, each reported by GDACS and USGS.
const vanuatu = [
  ev({ source: "gdacs", sourceId: "EQ-1572503", type: "earthquake", countries: ["VU"], lat: -14.0533, lng: 165.6761, started: "2026-10-19T07:49:04Z", updated: "2026-10-19T08:30:00Z" }),
  ev({ source: "gdacs", sourceId: "EQ-1572622", type: "earthquake", countries: ["VU"], lat: -14.0266, lng: 165.4974, started: "2026-10-19T18:55:37Z", updated: "2026-10-19T19:30:00Z" }),
  ev({ source: "usgs", sourceId: "us6000u3bc", type: "earthquake", countries: ["VU"], lat: -14.0533, lng: 165.6761, started: "2026-10-19T07:49:04.900Z", updated: "2026-10-19T09:00:00Z" }),
  ev({ source: "usgs", sourceId: "us6000u3ge", type: "earthquake", countries: ["VU"], lat: -14.0266, lng: 165.4974, started: "2026-10-19T18:55:37.471Z", updated: "2026-10-19T20:00:00Z" }),
];

// Typhoon Champi as EONET and GDACS list it.
const champiEonet = ev({
  source: "eonet",
  sourceId: "EONET_25339",
  type: "cyclone",
  title: "Super Typhoon Champi",
  severity: 3,
  severityText: "Winds up to 241 km/h",
  countries: [],
  lat: 14.8,
  lng: 137.6,
  started: "2026-10-15T12:00:00Z",
  updated: "2026-10-19T12:00:00Z",
  name: "CHAMPI",
  track: { past: [[140.1, 12.0], [139.0, 13.2], [138.2, 14.1], [137.6, 14.8]], forecast: [] },
  links: [{ name: "JTWC", url: "https://www.metoc.navy.mil/jtwc/products/wp2826.tcw" }],
});
const champiGdacs = ev({
  source: "gdacs",
  sourceId: "TC-1001338",
  type: "cyclone",
  title: "Tropical Cyclone Champi",
  severity: 3,
  severityText: "Winds up to 259 km/h",
  countries: [],
  lat: 15.4,
  lng: 136.7,
  started: "2026-10-14T12:00:00Z",
  updated: "2026-10-19T18:00:00Z",
  glide: "TC-2026-000192-GUM",
  name: "CHAMPI",
  track: { past: [[140.1, 12.0], [137.6, 14.8]], forecast: [[136.7, 15.4], [134.0, 18.0], [131.5, 21.0]] },
  summary: "Tropical Cyclone CHAMPI-26 can have a high humanitarian impact.",
  links: [{ name: "GDACS report", url: "https://www.gdacs.org/report.aspx?eventid=1001338&eventtype=TC" }],
});

// The monsoon flood in southern India (GDACS) and an IFRC appeal known only by country.
const indiaGdacsFlood = ev({
  source: "gdacs",
  sourceId: "FL-1104121",
  type: "flood",
  title: "Flood in India",
  severity: 2,
  countries: ["IN"],
  lat: 11.3324,
  lng: 78.6099,
  precision: "area",
  started: "2026-08-09T01:00:00Z",
  updated: "2026-10-07T01:00:00Z",
  glide: "FL-2026-000165-IND",
  summary: "GDACS orange flood alert in India.",
  links: [{ name: "GDACS report", url: "https://www.gdacs.org/report.aspx?eventid=1104121&eventtype=FL" }],
});
const indiaIfrcFlood = ev({
  source: "ifrc",
  sourceId: "7990",
  type: "flood",
  title: "India: Monsoon Floods",
  severity: 2,
  severityText: "IFRC Orange",
  countries: ["IN"],
  lat: 22.9,
  lng: 79.6,
  precision: "country",
  started: "2026-08-20T00:00:00Z",
  updated: "2026-09-30T00:00:00Z",
  summary: "Heavy monsoon rains have flooded several states.",
  figures: [{ label: "People targeted", value: "50,000", sourceName: "IFRC GO", sourceUrl: "https://go.ifrc.org/emergencies/7990" }],
  links: [{ name: "IFRC GO emergency", url: "https://go.ifrc.org/emergencies/7990" }],
  appeals: [appeal("MDRIN031", "2027-01-31T00:00:00Z")],
});
// An IFRC flood in Assam, placed by its districts, about 2000 km from the GDACS one.
const assamIfrcFlood = ev({
  source: "ifrc",
  sourceId: "8027",
  type: "flood",
  title: "India: Assam Floods",
  countries: ["IN"],
  lat: 26.2,
  lng: 92.9,
  precision: "area",
  started: "2026-09-25T00:00:00Z",
  updated: "2026-10-15T00:00:00Z",
  places: [{ name: "Dhemaji", country: "IN", lat: 27.48, lng: 94.58, kind: "district", source: "ifrc" }],
});

/** Clusters as sorted member-key lists, for comparing groupings. */
function groupKeys(events: SourceEvent[]): string[][] {
  return clusterEvents(events)
    .map((g) => g.map(memberKey).sort())
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe("glideKey and sharesGlide", () => {
  it("keeps the event part of a GLIDE number so every country's copy matches", () => {
    expect(glideKey("TC-2026-000192-GUM")).toBe("2026-000192");
    expect(glideKey(" tc-2026-000192-phl ")).toBe("2026-000192");
    expect(glideKey("FL-2026-000165")).toBe("2026-000165");
  });

  it("matches one event's GLIDE number whatever hazard code a feed gave it (regression)", () => {
    // IFRC GO lists the Rasuwa flash flood as FF-2026-000162-NPL; GDACS codes floods FL.
    const gdacs = ev({ source: "gdacs", sourceId: "FL-1104225", type: "flood", glide: "FL-2026-000162-NPL" });
    const ifrc = ev({ source: "ifrc", sourceId: "8073", type: "flood", glide: "FF-2026-000162-NPL" });
    expect(sharesGlide(gdacs, ifrc)).toBe(true);
    expect(sharesGlide(gdacs, { ...ifrc, glide: "FF-2026-000163-NPL" })).toBe(false);
    expect(sharesGlide(gdacs, { ...ifrc, glide: "FF-2025-000162-NPL" })).toBe(false);
  });

  it("keeps other values whole and treats empty as none", () => {
    expect(glideKey("ABC")).toBe("ABC");
    expect(glideKey("")).toBeUndefined();
    expect(glideKey("  ")).toBeUndefined();
    expect(glideKey(undefined)).toBeUndefined();
  });

  it("matches only non-empty equal numbers", () => {
    const a = ev({ source: "gdacs", sourceId: "TC-1", type: "cyclone", glide: "TC-2026-000192-GUM" });
    const b = ev({ source: "ifrc", sourceId: "1", type: "flood", glide: "TC-2026-000192-PHL" });
    const c = ev({ source: "ifrc", sourceId: "2", type: "flood", glide: "" });
    const d = ev({ source: "ifrc", sourceId: "3", type: "flood" });
    expect(sharesGlide(a, b)).toBe(true);
    expect(sharesGlide(a, c)).toBe(false);
    expect(sharesGlide(c, d)).toBe(false);
  });
});

describe("small helpers", () => {
  it("sourceOfKey reads the feed of a member key", () => {
    expect(sourceOfKey("gdacs:TC-1001338")).toBe("gdacs");
    expect(sourceOfKey("news:flood-th-abc:1")).toBe("news");
    expect(sourceOfKey("odd")).toBe("odd");
  });

  it("freshId lower-cases and replaces anything but a-z, 0-9 and dashes", () => {
    expect(freshId({ source: "gdacs", type: "earthquake", sourceId: "EQ-1570339" })).toBe("gdacs-earthquake-eq-1570339");
    expect(freshId({ source: "eonet", type: "wildfire", sourceId: "EONET_25238" })).toBe("eonet-wildfire-eonet-25238");
    expect(freshId({ source: "ifrc", type: "flood", sourceId: "appeal-MDRIN031" })).toBe("ifrc-flood-appeal-mdrin031");
  });

  it("distanceKm is the great-circle distance, Infinity when a position is not a number", () => {
    expect(distanceKm({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })).toBeCloseTo(111.2, 0);
    expect(distanceKm({ lat: 0, lng: 179.9 }, { lat: 0, lng: -179.9 })).toBeLessThan(25);
    expect(distanceKm({ lat: NaN, lng: 0 }, { lat: 0, lng: 0 })).toBe(Infinity);
  });

  it("shareCountry needs a country in common", () => {
    expect(shareCountry(ev({ source: "gdacs", sourceId: "1", type: "flood", countries: ["IN", "NP"] }), ev({ source: "ifrc", sourceId: "1", type: "flood", countries: ["NP"] }))).toBe(true);
    expect(shareCountry(ev({ source: "gdacs", sourceId: "1", type: "flood", countries: ["IN"] }), ev({ source: "ifrc", sourceId: "1", type: "flood", countries: [] }))).toBe(false);
  });

  it("periodsOverlap allows a gap of slack days and rejects bad times", () => {
    const a = ev({ source: "gdacs", sourceId: "1", type: "flood", started: "2026-10-01T00:00:00Z", updated: "2026-10-05T00:00:00Z" });
    const b = ev({ source: "ifrc", sourceId: "1", type: "flood", started: "2026-10-12T00:00:00Z", updated: "2026-10-15T00:00:00Z" });
    expect(periodsOverlap(a, b, 0)).toBe(false);
    expect(periodsOverlap(a, b, 7)).toBe(true);
    expect(periodsOverlap(b, a, 7)).toBe(true);
    expect(periodsOverlap(a, b, Infinity)).toBe(true);
    expect(periodsOverlap(a, { ...b, started: "nonsense" }, 30)).toBe(false);
  });

  it("insideAreas finds a point inside another event's footprint, also past the antimeridian", () => {
    const fiji = { areas: [{ kind: "affected", geometry: circlePolygon(-17.8, 179.9, 100) }] as Area[] };
    expect(insideAreas({ lat: -17.8, lng: -179.8 }, fiji)).toBe(true);
    expect(insideAreas({ lat: -17.8, lng: 175 }, fiji)).toBe(false);
    expect(insideAreas({ lat: NaN, lng: 0 }, fiji)).toBe(false);
    expect(insideAreas({ lat: 0, lng: 0 }, { areas: [] })).toBe(false);
  });

  it("byPrecision puts the most exact report first, byPriority the highest-priority feed", () => {
    const ifrc = ev({ source: "ifrc", sourceId: "1", type: "flood", precision: "area" });
    const gdacs = ev({ source: "gdacs", sourceId: "1", type: "flood", precision: "country" });
    const eonet = ev({ source: "eonet", sourceId: "1", type: "flood", precision: "exact" });
    expect([ifrc, gdacs, eonet].sort(byPrecision).map((e) => e.source)).toEqual(["eonet", "ifrc", "gdacs"]);
    expect([ifrc, gdacs, eonet].sort(byPriority).map((e) => e.source)).toEqual(["gdacs", "eonet", "ifrc"]);
  });

  it("uniqueEvents keeps the most recently updated copy of a member key, sorted by key", () => {
    const old = ev({ source: "usgs", sourceId: "us1", type: "earthquake", updated: daysAgo(3), title: "old" });
    const recent = ev({ source: "usgs", sourceId: "us1", type: "earthquake", updated: daysAgo(1), title: "new" });
    const other = ev({ source: "gdacs", sourceId: "EQ-1", type: "earthquake" });
    const out = uniqueEvents([old, recent, other]);
    expect(out.map(memberKey)).toEqual(["gdacs:EQ-1", "usgs:us1"]);
    expect(out[1].title).toBe("new");
  });
});

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

describe("matchScore", () => {
  it("links the same quake from USGS and GDACS, minutes apart at the same epicentre", () => {
    const score = matchScore(panamaGdacs, panamaUsgs);
    expect(score).not.toBeNull();
    expect(score!).toBeGreaterThanOrEqual(2);
    expect(score!).toBeLessThan(2.01);
  });

  it("does not link quakes more than 150 km or 3 hours apart", () => {
    expect(matchScore(panamaGdacs, { ...panamaUsgs, lat: 9.2, lng: -80.769 })).toBeNull(); // about 180 km north
    expect(matchScore(panamaGdacs, { ...panamaUsgs, started: "2026-10-09T21:30:00Z" })).toBeNull();
    expect(matchScore(vanuatu[0], vanuatu[3])).toBeNull(); // 20 km but 11 hours apart
  });

  it("links a quake known only by country to one in that country within two days", () => {
    const ifrc = ev({ source: "ifrc", sourceId: "8101", type: "earthquake", countries: ["PA"], lat: 8.5, lng: -80.1, precision: "country", started: "2026-10-09T00:00:00Z" });
    expect(matchScore(panamaUsgs, ifrc)).not.toBeNull();
    expect(matchScore(panamaUsgs, { ...ifrc, countries: ["CO"] })).toBeNull();
    expect(matchScore(panamaUsgs, { ...ifrc, started: "2026-10-12T00:00:00Z" })).toBeNull();
  });

  it("scores a quake report without an epicentre by the quake's severity, then time, not by distance", () => {
    const ifrc = ev({ source: "ifrc", sourceId: "8110", type: "earthquake", countries: ["PA"], lat: 7.45, lng: -80.42, precision: "area", started: "2026-10-09T00:00:00Z" });
    const toMain = matchScore(ifrc, panamaUsgs)!;
    const toAftershock = matchScore(ifrc, { ...panamaAftershock, severity: 2 })!;
    expect(distanceKm(ifrc, panamaAftershock)).toBeLessThan(distanceKm(ifrc, panamaUsgs));
    expect(toMain).toBeLessThan(toAftershock);
    expect(toMain).toBeGreaterThanOrEqual(2.5);
    expect(toAftershock).toBeLessThan(3);
    // Same severity: the quake nearer in time to the report wins.
    const early = matchScore(ifrc, { ...panamaAftershock, severity: 3, started: "2026-10-09T02:00:00Z" })!;
    expect(early).toBeLessThan(toMain);
    // Two located reports minutes apart keep their distance score, stronger than any loose link.
    expect(matchScore(panamaGdacs, panamaUsgs)!).toBeLessThan(2.01);
  });

  it("links a tsunami report to its earthquake (one family)", () => {
    const tsunami = ev({ source: "news", sourceId: "tsunami-pa", type: "tsunami", countries: ["PA"], precision: "country", started: "2026-10-09T19:00:00Z" });
    expect(matchScore(panamaUsgs, tsunami)).not.toBeNull();
  });

  it("links storms by name even when their listed positions are far apart", () => {
    expect(sameName(champiEonet, champiGdacs)).toBe(true);
    const farAway = { ...champiEonet, lat: 20.0, lng: 132.0 }; // about 800 km away
    expect(distanceKm(farAway, champiGdacs)).toBeGreaterThan(400);
    expect(matchScore(farAway, champiGdacs)).toBe(1);
  });

  it("does not link storms of the same name years apart (names are reused)", () => {
    const old = { ...champiEonet, started: "2020-10-01T00:00:00Z", updated: "2020-10-08T00:00:00Z" };
    expect(sameName(old, champiGdacs)).toBe(false);
  });

  it("links volcanoes by name whatever their dates (EONET keeps the first report's date)", () => {
    const eonet = ev({ source: "eonet", sourceId: "EONET_15811", type: "volcano", name: "KANLAON", lat: 10.4096, lng: 123.13, started: "2025-09-10T00:00:00Z", updated: "2025-09-10T00:00:00Z" });
    const gdacs = ev({ source: "gdacs", sourceId: "VO-1000152", type: "volcano", name: "KANLAON", lat: 10.412, lng: 123.132, started: "2026-10-10T05:58:00Z", updated: "2026-10-10T05:58:00Z" });
    expect(matchScore(eonet, gdacs)).toBe(1);
    expect(matchScore({ ...eonet, name: undefined }, { ...gdacs, name: undefined })).not.toBeNull(); // 0.3 km apart
    expect(matchScore({ ...eonet, name: undefined, lat: 10.8 }, { ...gdacs, name: undefined })).toBeNull(); // about 43 km
  });

  it("links unnamed storms within 400 km while both are active", () => {
    const a = ev({ source: "gdacs", sourceId: "TC-1001336", type: "cyclone", lat: 22.5, lng: 139.7 });
    const near = ev({ source: "eonet", sourceId: "EONET_1", type: "storm", lat: 24.5, lng: 140.5 });
    const far = ev({ source: "eonet", sourceId: "EONET_2", type: "storm", lat: 27.5, lng: 140.5 });
    expect(matchScore(a, near)).not.toBeNull();
    expect(matchScore(a, far)).toBeNull();
    expect(matchScore(a, { ...near, started: daysAgo(30), updated: daysAgo(20) })).toBeNull();
  });

  it("links floods in one country that are close, inside the other's footprint, or placed only by country", () => {
    expect(matchScore(indiaGdacsFlood, indiaIfrcFlood)).not.toBeNull(); // country-level IFRC
    expect(matchScore(indiaGdacsFlood, assamIfrcFlood)).toBeNull(); // about 2000 km
    const big = { ...indiaGdacsFlood, areas: [{ kind: "affected", geometry: circlePolygon(11.3, 78.6, 700) }] as Area[] };
    const kerala = ev({ source: "eonet", sourceId: "EONET_9", type: "flood", countries: ["IN"], lat: 9.6, lng: 76.5, started: daysAgo(10) });
    const farInside = { ...kerala, lat: 15.9, lng: 76.0 }; // about 580 km away but inside the footprint
    expect(matchScore(big, kerala)).not.toBeNull();
    expect(distanceKm(farInside, big)).toBeGreaterThan(400);
    expect(matchScore(big, farInside)).not.toBeNull();
    expect(matchScore(indiaGdacsFlood, farInside)).toBeNull(); // no footprint, too far
  });

  it("needs a shared country and overlapping periods for floods", () => {
    expect(matchScore(indiaGdacsFlood, { ...indiaIfrcFlood, countries: ["BD"] })).toBeNull();
    expect(matchScore(indiaGdacsFlood, { ...indiaIfrcFlood, started: "2026-11-01T00:00:00Z", updated: "2026-11-05T00:00:00Z" })).toBeNull();
    // A landslide is in the flood family.
    expect(matchScore(indiaGdacsFlood, { ...indiaIfrcFlood, type: "landslide" })).not.toBeNull();
  });

  it("links wildfires only within 30 km", () => {
    const gdacs = ev({ source: "gdacs", sourceId: "WF-1032653", type: "wildfire", countries: ["AU"], lat: -17.0276, lng: 142.8894 });
    const near = ev({ source: "eonet", sourceId: "EONET_7", type: "wildfire", countries: ["AU"], lat: -17.15, lng: 142.95 });
    const far = ev({ source: "eonet", sourceId: "EONET_8", type: "wildfire", countries: ["AU"], lat: -17.5, lng: 142.95 });
    expect(matchScore(gdacs, near)).not.toBeNull();
    expect(matchScore(gdacs, far)).toBeNull();
    expect(matchScore(gdacs, { ...near, precision: "country" })).toBeNull();
  });

  it("links country-wide events (drought, heat, cold, dust) by country and period", () => {
    const drought = ev({ source: "gdacs", sourceId: "DR-1027450", type: "drought", countries: ["CD", "SS"], precision: "area", started: "2026-06-21T00:00:00Z", updated: "2026-10-17T00:00:00Z" });
    const ifrc = ev({ source: "ifrc", sourceId: "8055", type: "drought", countries: ["SS"], precision: "country", started: "2026-09-01T00:00:00Z", updated: "2026-10-01T00:00:00Z" });
    const heat = ev({ source: "news", sourceId: "heat-ss", type: "heatwave", countries: ["SS"], precision: "country" });
    const ifrcHeat = ev({ source: "ifrc", sourceId: "9001", type: "heatwave", countries: ["SS"], precision: "country", started: daysAgo(3), updated: daysAgo(2) });
    const cold = ev({ source: "news", sourceId: "cold-ss", type: "coldwave", countries: ["SS"], precision: "country" });
    expect(matchScore(drought, ifrc)).not.toBeNull();
    expect(matchScore(heat, ifrcHeat)).not.toBeNull();
    expect(matchScore(drought, heat)).toBeNull(); // a heatwave is not part of a drought
    expect(matchScore(drought, cold)).toBeNull(); // different family
    expect(matchScore(drought, { ...ifrc, countries: ["KE"] })).toBeNull();
    const dustA = ev({ source: "eonet", sourceId: "EONET_3", type: "dust", countries: ["IQ"], started: daysAgo(2), updated: daysAgo(2) });
    const dustB = ev({ source: "news", sourceId: "dust-iq", type: "dust", countries: ["IQ"], precision: "country", started: daysAgo(10), updated: daysAgo(9) });
    expect(matchScore(dustA, dustB)).toBeNull(); // a week apart: two dust storms
  });

  it("never links two reports from one feed unless they share a GLIDE number", () => {
    const a = ev({ source: "gdacs", sourceId: "FL-1", type: "flood", countries: ["TH"], lat: 13.7, lng: 100.5 });
    const b = ev({ source: "gdacs", sourceId: "FL-2", type: "flood", countries: ["TH"], lat: 14.0, lng: 100.6 });
    expect(matchScore(a, b)).toBeNull();
    expect(matchScore({ ...a, glide: "FL-2026-000200-THA" }, { ...b, glide: "FL-2026-000200-THA" })).toBe(0);
  });

  it("links any types sharing a GLIDE number (a cyclone and the floods it caused)", () => {
    const flood = ev({ source: "ifrc", sourceId: "8110", type: "flood", glide: "TC-2026-000192-PHL" });
    expect(matchScore(champiGdacs, flood)).toBe(0);
  });

  it("ruleMatch applies the given family's rule", () => {
    expect(ruleMatch(panamaGdacs, panamaUsgs, "quake")).toBe(true);
    expect(ruleMatch(indiaGdacsFlood, assamIfrcFlood, "water")).toBe(false);
  });
});

describe("isApart", () => {
  it("is true for two located reports of one family beyond the family's limit", () => {
    expect(distanceKm(indiaGdacsFlood, assamIfrcFlood)).toBeGreaterThan(APART_KM.water);
    expect(isApart(indiaGdacsFlood, assamIfrcFlood)).toBe(true);
  });

  it("is false when one is placed only by country, they share a GLIDE number, or storms move", () => {
    expect(isApart(indiaGdacsFlood, indiaIfrcFlood)).toBe(false);
    expect(isApart(indiaGdacsFlood, { ...assamIfrcFlood, glide: "FL-2026-000165-IND" })).toBe(false);
    expect(isApart({ ...champiEonet, name: undefined, lat: 40, lng: 150 }, { ...champiGdacs, name: undefined })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

describe("clusterEvents", () => {
  it("merges the same quake from USGS and GDACS and keeps the aftershock apart", () => {
    expect(groupKeys([panamaAftershock, panamaUsgs, panamaGdacs])).toEqual([["gdacs:EQ-1570339", "usgs:us6000u18k"], ["usgs:us6000u18x"]]);
  });

  it("pairs each of two nearby Vanuatu quakes with its own GDACS report", () => {
    expect(groupKeys(vanuatu)).toEqual([
      ["gdacs:EQ-1572503", "usgs:us6000u3bc"],
      ["gdacs:EQ-1572622", "usgs:us6000u3ge"],
    ]);
  });

  it("never puts two reports from one feed together through a third", () => {
    const usgs = ev({ source: "usgs", sourceId: "us1", type: "earthquake", countries: ["JP"], lat: 38.0, lng: 142.0, started: daysAgo(1) });
    const g1 = ev({ source: "gdacs", sourceId: "EQ-1", type: "earthquake", countries: ["JP"], lat: 38.1, lng: 142.0, started: daysAgo(1) });
    const g2 = ev({ source: "gdacs", sourceId: "EQ-2", type: "earthquake", countries: ["JP"], lat: 38.3, lng: 142.0, started: daysAgo(1) });
    expect(groupKeys([g2, usgs, g1])).toEqual([["gdacs:EQ-1", "usgs:us1"], ["gdacs:EQ-2"]]);
  });

  it("puts IFRC's quake appeal with the main shock even when its districts lie nearer an aftershock (regression)", () => {
    // Real Panama reports: IFRC 8110 is placed at the mean of its districts, 76 km from the
    // M7.7 and 85 km from the M6.0 the next day; here it sits nearer the M5.8 aftershock.
    const ifrc = ev({ source: "ifrc", sourceId: "8110", type: "earthquake", countries: ["PA"], lat: 7.45, lng: -80.42, precision: "area", started: "2026-10-09T00:00:00Z", updated: "2026-10-13T17:59:00Z" });
    const aftershockGdacs = ev({ source: "gdacs", sourceId: "EQ-1570340", type: "earthquake", countries: ["PA"], lat: 7.4362, lng: -80.4012, started: "2026-10-09T18:37:46Z", updated: "2026-10-10T01:00:00Z" });
    const aftershock = { ...panamaAftershock, severity: 2 as const };
    expect(groupKeys([ifrc, aftershock, aftershockGdacs, panamaUsgs, panamaGdacs])).toEqual([
      ["gdacs:EQ-1570339", "ifrc:8110", "usgs:us6000u18k"],
      ["gdacs:EQ-1570340", "usgs:us6000u18x"],
    ]);
  });

  it("keeps two floods 2000 km apart in one country separate, even when a country-level report touches both", () => {
    const news = ev({ source: "news", sourceId: "flood-in-1", type: "flood", countries: ["IN"], precision: "country", started: daysAgo(3), updated: daysAgo(1) });
    const groups = groupKeys([indiaGdacsFlood, assamIfrcFlood, news]);
    expect(groups).toHaveLength(2);
    const withGdacs = groups.find((g) => g.includes("gdacs:FL-1104121"))!;
    expect(withGdacs).not.toContain("ifrc:8027");
    expect(groups.flat().sort()).toEqual(["gdacs:FL-1104121", "ifrc:8027", "news:flood-in-1"]);
  });

  it("lets a GLIDE link join reports a distance link would keep apart", () => {
    const far = { ...assamIfrcFlood, glide: "FL-2026-000165-IND" };
    expect(groupKeys([indiaGdacsFlood, far])).toEqual([["gdacs:FL-1104121", "ifrc:8027"]]);
  });

  it("merges a cyclone with the IFRC flood appeal that shares its GLIDE number", () => {
    const flood = ev({ source: "ifrc", sourceId: "8110", type: "flood", countries: ["PH"], precision: "area", lat: 15.0, lng: 121.0, glide: "TC-2026-000192-PHL" });
    expect(groupKeys([champiEonet, champiGdacs, flood])).toEqual([["eonet:EONET_25339", "gdacs:TC-1001338", "ifrc:8110"]]);
  });

  it("returns nothing for no events", () => {
    expect(clusterEvents([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Building a disaster
// ---------------------------------------------------------------------------

describe("buildDisaster", () => {
  it("combines USGS and GDACS reports of one quake", () => {
    const d = buildDisaster([panamaUsgs, panamaGdacs]);
    expect(d.id).toBe("gdacs-earthquake-eq-1570339");
    expect(d.type).toBe("earthquake");
    expect(d.title).toBe(panamaUsgs.title); // USGS titles quakes
    expect(d.severity).toBe(3);
    expect(d.severityText).toBe(panamaUsgs.severityText);
    expect(d.countries).toEqual(["PA", "CR"]);
    expect([d.lat, d.lng, d.precision]).toEqual([7.5868, -80.769, "exact"]);
    expect(d.started).toBe("2026-10-09T17:56:06Z");
    expect(d.updated).toBe("2026-10-12T08:30:00Z");
    expect(d.summary).toBe(panamaGdacs.summary);
    expect(d.summarySource).toEqual(panamaGdacs.links[0]);
    expect(d.sources.map((s) => s.name)).toEqual(["GDACS report", "USGS event page"]);
    expect(d.reportedBy).toEqual(["gdacs", "usgs"]);
    expect(d.members).toEqual(["gdacs:EQ-1570339", "usgs:us6000u18k"]);
    expect(d.donate).toEqual([]);
    expect(d).not.toHaveProperty("research");
  });

  it("titles a typhoon with EONET's name and takes the longest track", () => {
    const d = buildDisaster([champiGdacs, champiEonet]);
    expect(d.id).toBe("gdacs-cyclone-tc-1001338");
    expect(d.title).toBe("Super Typhoon Champi");
    expect(d.severityText).toBe("Winds up to 259 km/h"); // tie on severity: the lead (GDACS) report's
    expect(d.track).toEqual(champiGdacs.track); // 5 points against 4
    expect([d.lat, d.lng]).toEqual([15.4, 136.7]);
    expect(d.started).toBe("2026-10-14T12:00:00Z");
    expect(d.updated).toBe("2026-10-19T18:00:00Z");
  });

  it("takes GDACS's location for a flood IFRC knows only by country, and IFRC's summary", () => {
    const d = buildDisaster([indiaIfrcFlood, indiaGdacsFlood]);
    expect(d.id).toBe("gdacs-flood-fl-1104121");
    expect(d.title).toBe("Flood in India");
    expect([d.lat, d.lng, d.precision]).toEqual([11.3324, 78.6099, "area"]);
    expect(d.summary).toBe(indiaIfrcFlood.summary);
    expect(d.summarySource).toEqual(indiaIfrcFlood.links[0]);
    expect(d.appeals.map((a) => a.code)).toEqual(["MDRIN031"]);
    expect(d.figures).toEqual(indiaIfrcFlood.figures);
    expect(d.reportedBy).toEqual(["gdacs", "ifrc"]);
  });

  it("prefers a more exact report as the lead, whatever its feed", () => {
    const eonet = ev({ source: "eonet", sourceId: "EONET_4", type: "flood", title: "Floods in Kerala", countries: ["IN"], lat: 9.6, lng: 76.5, precision: "exact" });
    const d = buildDisaster([indiaGdacsFlood, eonet]);
    expect(d.id).toBe("eonet-flood-eonet-4");
    expect([d.lat, d.lng, d.precision]).toEqual([9.6, 76.5, "exact"]);
    expect(d.title).toBe("Floods in Kerala");
    expect(d.reportedBy).toEqual(["gdacs", "eonet"]);
  });

  it("keeps the lead's type when a GLIDE number ties a cyclone to a flood", () => {
    const flood = ev({ source: "ifrc", sourceId: "8110", type: "flood", precision: "area", glide: "TC-2026-000192-PHL" });
    expect(buildDisaster([flood, champiGdacs]).type).toBe("cyclone");
  });

  it("takes the severity text of the most severe report", () => {
    const d = buildDisaster([{ ...panamaGdacs, severity: 1 }, panamaUsgs]);
    expect(d.severity).toBe(3);
    expect(d.severityText).toBe(panamaUsgs.severityText);
    const none = buildDisaster([{ ...panamaGdacs, severity: 3, severityText: undefined }, { ...panamaUsgs, severity: 1 }]);
    expect(none).not.toHaveProperty("severityText");
  });

  it("dedupes places by name and country, figures by label (IFRC first) and links by URL", () => {
    const gdacs = ev({
      source: "gdacs",
      sourceId: "FL-9",
      type: "flood",
      countries: ["TH"],
      places: [{ name: "Chiang Mai", country: "TH", lat: 18.79, lng: 98.98, kind: "city", source: "gdacs" }],
      figures: [{ label: "People affected", value: "10,000", sourceName: "GDACS", sourceUrl: "https://gdacs.org" }],
      links: [{ name: "GDACS report", url: "https://gdacs.org/fl-9" }, { name: "Shared", url: "https://reliefweb.int/x" }],
    });
    const ifrc = ev({
      source: "ifrc",
      sourceId: "9",
      type: "flood",
      countries: ["TH", "LA"],
      precision: "area",
      places: [
        { name: "Chiang  Mai", country: "TH", lat: 18.8, lng: 99.0, kind: "district", source: "ifrc" },
        { name: "Chiang Rai", country: "TH", lat: 19.9, lng: 99.8, kind: "district", source: "ifrc" },
      ],
      figures: [
        { label: "people affected", value: "12,500", sourceName: "IFRC GO", sourceUrl: "https://go.ifrc.org/emergencies/9" },
        { label: "Deaths", value: "4", sourceName: "IFRC GO", sourceUrl: "https://go.ifrc.org/emergencies/9" },
      ],
      links: [{ name: "IFRC GO emergency", url: "https://go.ifrc.org/emergencies/9" }, { name: "Shared", url: "https://reliefweb.int/x" }],
    });
    const d = buildDisaster([ifrc, gdacs]);
    expect(d.places.map((p) => p.name)).toEqual(["Chiang Mai", "Chiang Rai"]);
    expect(d.places[0].source).toBe("gdacs"); // the lead's copy
    expect(d.figures.map((f) => `${f.label}=${f.value}`)).toEqual(["people affected=12,500", "Deaths=4"]);
    expect(d.sources.map((s) => s.url)).toEqual(["https://gdacs.org/fl-9", "https://reliefweb.int/x", "https://go.ifrc.org/emergencies/9"]);
    expect(d.countries).toEqual(["TH", "LA"]);
  });

  it("refuses an empty group", () => {
    expect(() => buildDisaster([])).toThrow();
  });
});

describe("pickTitle, pickTrack, pickSummary and the merge helpers", () => {
  it("pickTitle falls back to the lead's title", () => {
    expect(pickTitle(indiaGdacsFlood, [indiaGdacsFlood, indiaIfrcFlood])).toBe("Flood in India");
    expect(pickTitle(champiGdacs, [champiGdacs])).toBe("Tropical Cyclone Champi");
    expect(pickTitle(panamaGdacs, [panamaGdacs, panamaUsgs])).toBe(panamaUsgs.title);
  });

  it("pickTrack takes the most points, the higher-priority feed on a tie, and skips empty tracks", () => {
    const a = ev({ source: "gdacs", sourceId: "1", type: "cyclone", track: { past: [[1, 1]], forecast: [[2, 2]] } });
    const b = ev({ source: "eonet", sourceId: "1", type: "cyclone", track: { past: [[3, 3], [4, 4]], forecast: [] } });
    const empty = ev({ source: "usgs", sourceId: "1", type: "cyclone", track: { past: [], forecast: [] } });
    expect(pickTrack([a, b])).toBe(a.track);
    expect(pickTrack([empty])).toBeUndefined();
    expect(pickTrack([])).toBeUndefined();
  });

  it("pickSummary prefers IFRC, then GDACS, EONET, USGS and news, and skips blank summaries", () => {
    const news = ev({ source: "news", sourceId: "1", type: "flood", summary: "news" });
    const eonet = ev({ source: "eonet", sourceId: "1", type: "flood", summary: "eonet" });
    const ifrcBlank = ev({ source: "ifrc", sourceId: "1", type: "flood", summary: "  " });
    expect(pickSummary([news, eonet, ifrcBlank]).summary).toBe("eonet");
    expect(pickSummary([news]).summarySource).toEqual(news.links[0]);
    expect(pickSummary([{ ...news, links: [] }])).toEqual({ summary: "news" });
    expect(pickSummary([eonet].map((e) => ({ ...e, summary: undefined })))).toEqual({});
  });

  it("mergeFigures, mergePlaces, mergeSources and mergeAppeals dedupe", () => {
    const fig = (label: string, sourceName: string) => ({ label, value: "1", sourceName, sourceUrl: "https://x" });
    const a = ev({ source: "gdacs", sourceId: "1", type: "flood", figures: [fig("Deaths", "GDACS")] });
    const b = ev({ source: "ifrc", sourceId: "1", type: "flood", figures: [fig("deaths ", "IFRC")], appeals: [appeal("MDR1", NOW)] });
    const c = ev({ source: "news", sourceId: "1", type: "flood", appeals: [appeal("MDR1", NOW), appeal("MDR2", NOW)] });
    expect(mergeFigures([a, b]).map((f) => f.sourceName)).toEqual(["IFRC"]);
    expect(mergeAppeals([b, c]).map((x) => x.code)).toEqual(["MDR1", "MDR2"]);
    const many = ev({ source: "news", sourceId: "2", type: "flood", links: Array.from({ length: 15 }, (_, i) => ({ name: `h${i}`, url: `https://n/${i}` })) });
    expect(mergeSources([a, many])).toHaveLength(MAX_SOURCES);
    expect(mergeSources([a, many])[0]).toEqual(a.links[0]);
    const p = (name: string, country: string) => ({ name, country, lat: 0, lng: 0, kind: "city" as const, source: "news" as const });
    expect(mergePlaces([ev({ source: "news", sourceId: "3", type: "flood", places: [p("São Paulo", "BR"), p("Sao Paulo", "BR"), p("Sao Paulo", "PT")] })])).toHaveLength(2);
  });
});

describe("capAreas", () => {
  /** An area of about `kb` kilobytes of JSON. */
  function bigArea(kb: number, level?: number): Area {
    const segments = Math.round((kb * 1000) / 19);
    return { kind: "affected", ...(level !== undefined ? { level } : {}), geometry: circlePolygon(10, 100, 200, segments) };
  }

  it("keeps every feed's areas while the total fits", () => {
    const gdacs = ev({ source: "gdacs", sourceId: "1", type: "flood", areas: [bigArea(40)] });
    const eonet = ev({ source: "eonet", sourceId: "1", type: "flood", areas: [bigArea(40, 1)] });
    expect(capAreas([gdacs, eonet])).toHaveLength(2);
  });

  it("drops the lowest-priority feed's areas first when the total is over 120 KB", () => {
    const gdacs = ev({ source: "gdacs", sourceId: "1", type: "flood", areas: [bigArea(55), bigArea(10)] });
    const eonet = ev({ source: "eonet", sourceId: "1", type: "flood", areas: [bigArea(50)] });
    const news = ev({ source: "news", sourceId: "1", type: "flood", areas: [bigArea(30)] });
    const out = capAreas([gdacs, eonet, news]);
    expect(out).toEqual([...gdacs.areas, ...eonet.areas]);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(MAX_AREA_BYTES);
    expect(capAreas([gdacs, eonet, news], 70_000)).toEqual(gdacs.areas);
  });

  it("always keeps the first feed's areas", () => {
    const gdacs = ev({ source: "gdacs", sourceId: "1", type: "flood", areas: [bigArea(130)] });
    const eonet = ev({ source: "eonet", sourceId: "1", type: "flood", areas: [bigArea(5)] });
    expect(capAreas([gdacs, eonet])).toEqual(gdacs.areas);
    expect(capAreas([ev({ source: "usgs", sourceId: "1", type: "flood" })])).toEqual([]);
  });

  it("is applied when building a disaster, by feed priority", () => {
    const usgs = ev({ source: "usgs", sourceId: "us1", type: "earthquake", areas: [{ ...bigArea(70), kind: "shaking", level: 6 }] });
    const gdacs = ev({ source: "gdacs", sourceId: "EQ-1", type: "earthquake", areas: [{ ...bigArea(70), kind: "shaking", level: 7 }] });
    const d = buildDisaster([usgs, gdacs]);
    expect(d.areas.map((a) => a.level)).toEqual([7]);
  });
});

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

describe("assignIds", () => {
  it("keeps fresh ids when there is no previous run", () => {
    const d = buildDisaster([panamaGdacs]);
    expect(assignIds([d], null)[0].id).toBe("gdacs-earthquake-eq-1570339");
  });

  it("reuses the id of the previous disaster with the most shared members", () => {
    const now = buildDisaster([panamaGdacs, panamaUsgs, ev({ source: "eonet", sourceId: "EONET_1", type: "earthquake" })]);
    const prev = [dis({ id: "a", members: ["usgs:us6000u18k"] }), dis({ id: "b", members: ["gdacs:EQ-1570339", "eonet:EONET_1"] })];
    expect(assignIds([now], prev)[0].id).toBe("b");
  });

  it("gives a previous id to one disaster only when a group splits, preferring the one whose own id it is", () => {
    const g = buildDisaster([panamaGdacs]);
    const u = buildDisaster([panamaUsgs]);
    const prev = [dis({ id: "gdacs-earthquake-eq-1570339", members: ["gdacs:EQ-1570339", "usgs:us6000u18k"] })];
    const out = assignIds([u, g], prev);
    expect(out.map((d) => d.id)).toEqual(["usgs-earthquake-us6000u18k", "gdacs-earthquake-eq-1570339"]);
  });

  it("adds a suffix when a fresh id is already taken", () => {
    const u = buildDisaster([panamaUsgs]);
    const g = buildDisaster([panamaGdacs]);
    // An odd previous run where USGS's id named a disaster now led by GDACS.
    const prev = [dis({ id: "usgs-earthquake-us6000u18k", members: ["gdacs:EQ-1570339"] })];
    const out = assignIds([u, g], prev);
    expect(out.map((d) => d.id)).toEqual(["usgs-earthquake-us6000u18k-2", "usgs-earthquake-us6000u18k"]);
    expect(new Set(out.map((d) => d.id)).size).toBe(2);
  });

  it("does not reuse the id of a previous disaster that may be carried over", () => {
    const u = buildDisaster([panamaUsgs]);
    const prev = [dis({ id: "usgs-earthquake-us6000u18k", members: ["gdacs:EQ-5"] })];
    expect(assignIds([u], prev)[0].id).toBe("usgs-earthquake-us6000u18k-2");
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("isOngoing", () => {
  it("keeps each type for its window after the last update", () => {
    for (const type of DISASTER_TYPES) {
      const days = ONGOING_DAYS[type];
      expect(isOngoing(dis({ id: type, type, started: daysAgo(days + 5), updated: daysAgo(days) }), NOW)).toBe(true);
      expect(isOngoing(dis({ id: type, type, started: daysAgo(days + 5), updated: daysAgo(days + 0.05) }), NOW)).toBe(false);
    }
  });

  it("uses the documented windows", () => {
    expect(ONGOING_DAYS).toMatchObject({ earthquake: 10, tsunami: 7, cyclone: 3, storm: 4, flood: 21, landslide: 14, wildfire: 10, volcano: 30, drought: 90, heatwave: 7, coldwave: 7, dust: 4 });
  });

  it("keeps a recent disaster with an open appeal after its window", () => {
    const stale = { type: "flood" as const, started: daysAgo(60), updated: daysAgo(40) };
    expect(isOngoing(dis({ id: "x", ...stale, appeals: [appeal("MDR1", daysAgo(-30))] }), NOW)).toBe(true);
    expect(isOngoing(dis({ id: "x", ...stale, appeals: [appeal("MDR1", daysAgo(1))] }), NOW)).toBe(false);
    expect(isOngoing(dis({ id: "x", ...stale, appeals: [appeal("MDR1", "")] }), NOW)).toBe(false);
    expect(isOngoing(dis({ id: "x", ...stale, started: daysAgo(121), appeals: [appeal("MDR1", daysAgo(-30))] }), NOW)).toBe(false);
  });

  it("keeps significant and severe quakes and tsunamis as long as GDACS and USGS list them (regression)", () => {
    // GDACS's Orange M6.3 Vanuatu quake EQ-1570077 was last updated 11 days before the live run.
    const vanuatuOrange = { type: "earthquake" as const, severity: 2 as const, started: daysAgo(12), updated: daysAgo(11) };
    expect(isOngoing(dis({ id: "x", ...vanuatuOrange }), NOW)).toBe(true);
    expect(isOngoing(dis({ id: "x", ...vanuatuOrange, updated: daysAgo(21.05) }), NOW)).toBe(false);
    expect(isOngoing(dis({ id: "x", ...vanuatuOrange, severity: 3, updated: daysAgo(30) }), NOW)).toBe(true);
    expect(isOngoing(dis({ id: "x", ...vanuatuOrange, severity: 3, updated: daysAgo(30.05) }), NOW)).toBe(false);
    expect(isOngoing(dis({ id: "x", ...vanuatuOrange, severity: 1 }), NOW)).toBe(false);
    expect(isOngoing(dis({ id: "x", ...vanuatuOrange, type: "tsunami", severity: 3, updated: daysAgo(25) }), NOW)).toBe(true);
    // Other types keep their own window whatever the severity.
    expect(isOngoing(dis({ id: "x", type: "cyclone", severity: 3, updated: daysAgo(4) }), NOW)).toBe(false);
  });

  it("ongoingDays is the type's window, longer for major quakes", () => {
    expect(ongoingDays({ type: "earthquake" })).toBe(ONGOING_DAYS.earthquake);
    expect(ongoingDays({ type: "earthquake", severity: 1 })).toBe(10);
    expect(ongoingDays({ type: "earthquake", severity: 2 })).toBe(MAJOR_QUAKE_DAYS[2]);
    expect(ongoingDays({ type: "tsunami", severity: 3 })).toBe(MAJOR_QUAKE_DAYS[3]);
    expect(ongoingDays({ type: "drought", severity: 3 })).toBe(90);
    expect(ongoingDays({ type: "flood", severity: 3 })).toBe(21);
  });

  it("is false when the update time cannot be read and there is no appeal", () => {
    expect(isOngoing(dis({ id: "x", updated: "unknown" }), NOW)).toBe(false);
  });

  it("counts an update a little in the future (feed clock skew) as current", () => {
    expect(isOngoing(dis({ id: "x", type: "cyclone", updated: daysAgo(-0.1) }), NOW)).toBe(true);
  });
});

describe("carryOver", () => {
  const prev = [
    dis({ id: "only-gdacs", members: ["gdacs:FL-1"] }),
    dis({ id: "gdacs-and-usgs", type: "earthquake", members: ["gdacs:EQ-2", "usgs:us2"] }),
    dis({ id: "seen-again", members: ["gdacs:FL-3"] }),
    dis({ id: "ended", type: "cyclone", updated: daysAgo(5), members: ["gdacs:TC-4"] }),
    dis({ id: "two-failed", type: "earthquake", members: ["gdacs:EQ-5", "usgs:us5"] }),
    dis({ id: "no-members", members: [] }),
  ];

  it("keeps ongoing disasters a failed feed reported that no fresh report carries on", () => {
    const out = carryOver(prev, new Set(["gdacs"]), new Set(["gdacs:FL-3", "usgs:us2"]), NOW);
    // two-failed: USGS works but no longer lists us5, and GDACS (down) may still list EQ-5.
    expect(out.map((d) => d.id)).toEqual(["only-gdacs", "two-failed"]);
    expect(out[0]).toBe(prev[0]); // unchanged
  });

  it("keeps disasters whose every feed failed", () => {
    const out = carryOver(prev, new Set(["gdacs", "usgs"]), new Set(), NOW);
    expect(out.map((d) => d.id)).toEqual(["only-gdacs", "gdacs-and-usgs", "seen-again", "two-failed"]);
  });

  it("keeps nothing when no feed failed", () => {
    expect(carryOver(prev, new Set(), new Set(), NOW)).toEqual([]);
    expect(carryOver(prev, new Set(["eonet"]), new Set(), NOW)).toEqual([]); // the failed feed reported none of them
  });

  it("keeps a quake whose working feed's report alone is no longer ongoing when GDACS fails (regression)", () => {
    // Live run: GDACS's Orange M6.3 Vanuatu quake EQ-1570077 was merged with USGS us6000u0xi (minor).
    const gdacsQuake = ev({ source: "gdacs", sourceId: "EQ-1570077", type: "earthquake", severity: 2, countries: ["VU"], lat: -15.54, lng: 168.19, started: daysAgo(12), updated: daysAgo(11) });
    const usgsQuake = ev({ source: "usgs", sourceId: "us6000u0xi", type: "earthquake", severity: 1, countries: ["VU"], lat: -15.54, lng: 168.19, started: daysAgo(12), updated: daysAgo(11) });
    const run1 = mergeEvents([gdacsQuake, usgsQuake], null, NOW);
    expect(run1.map((d) => d.members)).toEqual([["gdacs:EQ-1570077", "usgs:us6000u0xi"]]);
    // Run 2: GDACS fails; the USGS report alone is minor and 11 days old.
    const run2 = mergeEvents([usgsQuake], run1, NOW);
    expect(run2).toEqual([]);
    const kept = carryOver(run1, new Set(["gdacs"]), new Set(run2.flatMap((d) => d.members)), NOW);
    expect(kept).toEqual(run1);
    // When this run's disasters still carry the USGS report, the previous one is not kept twice.
    const fresh = mergeEvents([{ ...usgsQuake, updated: daysAgo(1) }], run1, NOW);
    expect(fresh.map((d) => d.id)).toEqual([run1[0].id]);
    expect(carryOver(run1, new Set(["gdacs"]), new Set(fresh.flatMap((d) => d.members)), NOW)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// mergeEvents
// ---------------------------------------------------------------------------

describe("mergeEvents", () => {
  const all = [panamaGdacs, panamaUsgs, panamaAftershock, ...vanuatu, champiEonet, champiGdacs, indiaGdacsFlood, indiaIfrcFlood, assamIfrcFlood];

  it("merges real-world reports into disasters and drops the ones no longer ongoing", () => {
    const out = mergeEvents(all, null, NOW);
    expect(out.map((d) => d.id)).toEqual([
      "gdacs-cyclone-tc-1001338", // severity 3, updated today
      "gdacs-earthquake-eq-1570339", // severity 3 (USGS), updated a week ago
      "gdacs-flood-fl-1104121", // severity 2
      "gdacs-earthquake-eq-1572622",
      "gdacs-earthquake-eq-1572503",
      "ifrc-flood-8027",
    ]);
    // The M5.8 aftershock folds into the M7.7 instead of standing alone.
    expect(out.find((d) => d.id === "gdacs-earthquake-eq-1570339")?.members).toContain("usgs:us6000u18x");
  });

  it("drops events past their window", () => {
    const old = ev({ source: "eonet", sourceId: "EONET_25094", type: "cyclone", title: "Hurricane Simon", started: "2026-10-07T18:00:00Z", updated: "2026-10-16T18:00:00Z" });
    expect(mergeEvents([old], null, NOW)).toEqual([]);
    expect(mergeEvents([old], null, "2026-10-18T00:00:00Z")).toHaveLength(1);
  });

  it("sorts by severity, then most recent update, then id", () => {
    const a = buildDisaster([ev({ source: "gdacs", sourceId: "B", type: "flood", severity: 2, updated: daysAgo(1) })]);
    const b = buildDisaster([ev({ source: "gdacs", sourceId: "A", type: "flood", severity: 2, updated: daysAgo(1) })]);
    const c = buildDisaster([ev({ source: "gdacs", sourceId: "C", type: "flood", severity: 3, updated: daysAgo(3) })]);
    const d = buildDisaster([ev({ source: "gdacs", sourceId: "D", type: "flood", severity: 2, updated: daysAgo(0.5) })]);
    expect([a, b, c, d].sort(compareDisasters).map((x) => x.id)).toEqual(["gdacs-flood-c", "gdacs-flood-d", "gdacs-flood-a", "gdacs-flood-b"]);
  });

  it("gives the same result whatever the input order", () => {
    const expected = JSON.stringify(mergeEvents(all, null, NOW));
    const shuffled = [...all].reverse();
    expect(JSON.stringify(mergeEvents(shuffled, null, NOW))).toBe(expected);
    const rotated = [...all.slice(5), ...all.slice(0, 5)];
    expect(JSON.stringify(mergeEvents(rotated, null, NOW))).toBe(expected);
  });

  it("keeps ids stable across runs, also when a feed joins or leaves", () => {
    // Run 1: only USGS has the quake.
    const run1 = mergeEvents([panamaUsgs], null, "2026-10-09T19:00:00Z");
    expect(run1.map((d) => d.id)).toEqual(["usgs-earthquake-us6000u18k"]);
    // Run 2: GDACS joins and leads the disaster, but the id is kept.
    const run2 = mergeEvents([panamaUsgs, panamaGdacs], run1, "2026-10-09T22:00:00Z");
    expect(run2).toHaveLength(1);
    expect(run2[0].id).toBe("usgs-earthquake-us6000u18k");
    expect(run2[0].reportedBy).toEqual(["gdacs", "usgs"]);
    // Run 3: USGS drops it; the GDACS member carries the id on.
    const run3 = mergeEvents([panamaGdacs], run2, "2026-10-10T04:00:00Z");
    expect(run3.map((d) => d.id)).toEqual(["usgs-earthquake-us6000u18k"]);
    // Run 4: identical input gives identical output.
    expect(mergeEvents([panamaGdacs], run3, "2026-10-10T04:00:00Z")).toEqual(run3);
  });

  it("keeps the flood's id when IFRC's country-level appeal joins the GDACS flood", () => {
    const run1 = mergeEvents([indiaGdacsFlood], null, NOW);
    const run2 = mergeEvents([indiaGdacsFlood, indiaIfrcFlood], run1, NOW);
    expect(run2.map((d) => d.id)).toEqual(["gdacs-flood-fl-1104121"]);
    expect([run2[0].lat, run2[0].lng]).toEqual([indiaGdacsFlood.lat, indiaGdacsFlood.lng]);
    expect(run2[0].members).toEqual(["gdacs:FL-1104121", "ifrc:7990"]);
  });

  it("returns unique ids", () => {
    const out = mergeEvents(all, [dis({ id: "gdacs-earthquake-eq-1572503", members: ["usgs:us6000u3ge"] })], NOW);
    expect(new Set(out.map((d) => d.id)).size).toBe(out.length);
    expect(out.find((d) => d.members.includes("usgs:us6000u3ge"))!.id).toBe("gdacs-earthquake-eq-1572503");
  });

  it("returns an empty list for no events", () => {
    expect(mergeEvents([], null, NOW)).toEqual([]);
  });

  it("keeps a heatwave on the map inside a months-long drought that covers its country (regression)", () => {
    // GDACS DR-1018332 "Drought in Europe": 2025-12-21 to now, over twenty countries.
    const europe = ev({ source: "gdacs", sourceId: "DR-1018332", type: "drought", title: "Drought in Europe", severity: 2, countries: ["AT", "BA", "BE", "ES", "FR", "IT"], lat: 48.76, lng: 13.7, precision: "area", started: "2025-12-21T00:00:00Z", updated: daysAgo(0.5), glide: "DR-2025-000239-ALB" });
    const heat = ev({ source: "news", sourceId: "heatwave-es-1", type: "heatwave", title: "Heatwave in Spain", severity: 2, countries: ["ES"], lat: 40.4, lng: -3.7, precision: "area", started: daysAgo(3), updated: daysAgo(0.2) });
    expect(FAMILY_OF.heatwave).not.toBe(FAMILY_OF.drought);
    const out = mergeEvents([europe, heat], null, NOW);
    expect(out.map((d) => [d.type, d.title])).toEqual([
      ["heatwave", "Heatwave in Spain"],
      ["drought", "Drought in Europe"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Real feeds
// ---------------------------------------------------------------------------

describe("mergeEvents on the live feeds of 19 October 2026", () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "merge-live-events.json"), "utf8")) as {
    now: string;
    events: SourceEvent[];
  };

  it("groups the reports as a reader would", () => {
    expect(groupKeys(fixture.events)).toEqual([
      ["eonet:EONET_25290", "gdacs:TC-1001337"], // Hurricane Trudy
      ["eonet:EONET_25339", "gdacs:TC-1001338"], // Typhoon Champi
      ["eonet:EONET_25340", "gdacs:TC-1001339"], // Cyclone Wati
      ["gdacs:DR-1027449", "ifrc:8066"], // Central America drought and IFRC's Honduras drought
      ["gdacs:DR-1027450", "ifrc:8079"], // East Africa drought and IFRC's Ethiopia drought
      ["gdacs:EQ-1570339", "ifrc:8110", "usgs:us6000u18k"], // the M7.7 Panama quake and IFRC's appeal for it
      ["gdacs:EQ-1570467", "usgs:us6000u1cf"], // M6.0 aftershock the next day
      ["gdacs:EQ-1571161", "usgs:us6000u1wn"], // M6.1 three days later
      ["gdacs:EQ-1572503", "usgs:us6000u3bc"], // M6.0 Vanuatu
      ["gdacs:FL-1104121"], // southern India flood, 2000 km from Assam
      ["gdacs:FL-1104228"], // October flood in Panama, six weeks after IFRC's Bocas del Toro floods
      ["gdacs:VO-1000152"],
      ["ifrc:8037"],
      ["ifrc:8050"], // two IFRC operations in Myanmar stay apart (one feed)
      ["ifrc:8062"],
      ["ifrc:8111"],
      ["usgs:us6000u18x"],
      ["usgs:us6000u19w"],
      ["usgs:us6000u3ga"], // two M5.7 Vanuatu quakes three minutes apart: USGS lists both
      ["usgs:us6000u3ge"],
    ]);
  });

  it("builds ongoing disasters led by the most exact report", () => {
    const out = mergeEvents(fixture.events, null, fixture.now);
    const ids = out.map((d) => d.id);
    expect(ids.slice(0, 4)).toEqual(["gdacs-cyclone-tc-1001338", "gdacs-earthquake-eq-1570339", "gdacs-cyclone-tc-1001337", "gdacs-cyclone-tc-1001339"]);
    // The aftershocks fold into the M7.7's disaster rather than showing as their own.
    expect(ids).not.toContain("usgs-earthquake-us6000u18x");
    expect(ids).not.toContain("usgs-earthquake-us6000u19w");
    const sequence = out.find((d) => d.id === "gdacs-earthquake-eq-1570339")!;
    expect(sequence.members).toEqual(expect.arrayContaining(["usgs:us6000u18x", "usgs:us6000u19w"]));
    expect(sequence.figures.some((f) => f.label === "Aftershocks")).toBe(true);
    const later = mergeEvents(fixture.events, null, "2026-10-31T00:00:00Z").map((d) => d.id);
    // The M7.7 (severe, with an open IFRC appeal) is still on the map then.
    expect(later).toContain("gdacs-earthquake-eq-1570339");
    // IFRC's Assam appeal is old but open, so it stays.
    expect(ids).toContain("ifrc-flood-8037");
    const panama = out.find((d) => d.id === "gdacs-earthquake-eq-1570339")!;
    expect(panama.title).toMatch(/^M7\.7 earthquake/);
    expect(panama.reportedBy).toEqual(["gdacs", "usgs", "ifrc"]);
    expect([panama.lat, panama.lng, panama.precision]).toEqual([7.5868, -80.769, "exact"]);
    expect(panama.appeals.length).toBeGreaterThan(0);
    const champi = out.find((d) => d.id === "gdacs-cyclone-tc-1001338")!;
    expect(champi.title).toBe("Super Typhoon Champi");
    expect(champi.track).toBeDefined();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps every id on a second run over the same feeds", () => {
    const first = mergeEvents(fixture.events, null, fixture.now);
    expect(mergeEvents(fixture.events, first, fixture.now)).toEqual(first);
  });
});

describe("earthquake sequences", () => {
  // The live Panama sequence: an M7.7 main shock and four aftershocks within 80 km.
  const quake = (source: "usgs" | "gdacs", id: string, mag: number, lat: number, lng: number, days: number, severity: 1 | 2 | 3 = 1) =>
    ev({ source, sourceId: id, type: "earthquake", severity, countries: ["PA"], lat, lng, started: daysAgo(days), updated: daysAgo(days), title: `M${mag} earthquake near Río Grande, Panama`, severityText: `Magnitude ${mag}, depth 10 km` });
  const main = quake("usgs", "main", 7.7, 7.6, -81.1, 10, 3);
  const gdacsMain = quake("gdacs", "EQ-1", 7.6, 7.62, -81.12, 10, 3);
  const after1 = quake("usgs", "a1", 6.6, 7.9, -81.4, 9);
  const after2 = quake("usgs", "a2", 6.0, 7.3, -80.9, 6, 2);
  const gdacsAfter2 = quake("gdacs", "EQ-2", 6.0, 7.31, -80.91, 6);
  const far = quake("usgs", "far", 6.1, 9.9, -79.0, 5);

  it("reads magnitudes and the Gardner-Knopoff distance", () => {
    expect(quakeMagnitude(main)).toBe(7.7);
    expect(quakeMagnitude({ title: "M5.8 earthquake in the central Mid-Atlantic Ridge" })).toBe(5.8);
    expect(quakeMagnitude({ title: "Earthquake in Panama" })).toBeNull();
    expect(aftershockKm(6)).toBeCloseTo(53, 0);
    expect(aftershockKm(7.7)).toBeCloseTo(86, 0);
  });

  it("folds aftershocks from any feed into the main shock but keeps the other feed's copy of the main shock", () => {
    const { kept, absorbed } = groupSequences([after1, main, gdacsMain, after2, gdacsAfter2, far]);
    expect(kept.map(memberKeyOf).sort()).toEqual(["gdacs:EQ-1", "usgs:far", "usgs:main"]);
    expect((absorbed.get("usgs:main") ?? []).map(memberKeyOf).sort()).toEqual(["gdacs:EQ-2", "usgs:a1", "usgs:a2"]);
  });

  it("builds one disaster for the sequence with stable members, the latest activity and an aftershock figure", () => {
    const out = mergeEvents([after1, main, gdacsMain, after2, gdacsAfter2, far], null, NOW);
    const seq = out.find((d) => d.members.includes("usgs:main"))!;
    expect(seq.members).toEqual(["gdacs:EQ-1", "gdacs:EQ-2", "usgs:a1", "usgs:a2", "usgs:main"]);
    expect(seq.title).toContain("M7.7");
    expect(seq.updated).toBe(daysAgo(6));
    expect(seq.figures.find((f) => f.label === "Aftershocks")?.value).toBe("2, strongest M6.6");
    expect(out.some((d) => d.members.includes("usgs:far"))).toBe(true);
  });

  it("leaves a disaster without folded reports unchanged", () => {
    const d = dis({ id: "x", members: ["usgs:solo"] });
    expect(withAftershocks(d, [quake("usgs", "solo", 6, 0, 0, 1)], new Map())).toBe(d);
  });

  it("folds aftershocks of the first hours too, telling them from another feed's copy of the main shock (live Panama data)", () => {
    const at = (iso: string) => ({ started: iso, updated: iso });
    const m77 = { ...quake("usgs", "us6000u18k", 7.7, 7.5868, -80.769, 0, 3), ...at("2026-10-09T17:56:06.036Z") };
    const g77 = { ...quake("gdacs", "EQ-1570339", 7.7, 7.5868, -80.769, 0, 3), ...at("2026-10-09T17:56:06.000Z") };
    const a58 = { ...quake("usgs", "us6000u18x", 5.8, 7.4362, -80.4012, 0), ...at("2026-10-09T18:37:46.146Z") };
    const a66 = { ...quake("usgs", "us6000u19w", 6.6, 7.7013, -81.444, 0, 2), ...at("2026-10-09T20:25:40.656Z") };
    const g61 = { ...quake("gdacs", "EQ-1571161", 6.1, 7.7028, -81.4989, 0), ...at("2026-10-12T23:20:36.000Z") };
    const u61 = { ...quake("usgs", "us6000u1wn", 6.1, 7.6896, -81.4896, 0), ...at("2026-10-12T23:20:36.003Z") };
    expect(sameShock(m77, g77)).toBe(true);
    expect(sameShock(m77, a58)).toBe(false);
    expect(sameShock(g61, u61)).toBe(true);
    const { kept, absorbed } = groupSequences([m77, g77, a58, a66, g61, u61]);
    expect(kept.map(memberKeyOf).sort()).toEqual(["gdacs:EQ-1570339", "usgs:us6000u18k"]);
    expect([...absorbed.values()].flat().map(memberKeyOf).sort()).toEqual(["gdacs:EQ-1571161", "usgs:us6000u18x", "usgs:us6000u19w", "usgs:us6000u1wn"]);
    const out = mergeEvents([m77, g77, a58, a66, g61, u61], null, "2026-10-20T12:00:00.000Z");
    expect(out).toHaveLength(1);
    expect(out[0].figures.find((f) => f.label === "Aftershocks")?.value).toBe("3, strongest M6.6");
  });

  it("does not fold a stronger later quake into a weaker earlier one", () => {
    const fore = quake("usgs", "fore", 5.9, 7.6, -81.1, 12);
    const { absorbed, kept } = groupSequences([fore, main]);
    expect(kept.map(memberKeyOf)).toEqual(["usgs:main"]);
    expect((absorbed.get("usgs:main") ?? []).map(memberKeyOf)).toEqual(["usgs:fore"]);
  });
});

function memberKeyOf(e: SourceEvent): string {
  return `${e.source}:${e.sourceId}`;
}
