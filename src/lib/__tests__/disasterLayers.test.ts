import { describe, expect, it } from "vitest";
import type { Disaster, Position } from "../data";
import {
  AREA_ALTITUDE,
  CLICKABLE_AREA_MAX_KM2,
  COUNTRY_FOCUS_ALTITUDE,
  MIN_EFFECT_KM,
  UNMAPPED_FOCUS_ALTITUDE,
  activeRings,
  circleRing,
  clusterMarkers,
  fanOffsets,
  meanPosition,
  haloRadiusKm,
  insidePolygon,
  placeLabelFit,
  FOCUS_MAX_ALTITUDE,
  FOCUS_MIN_ALTITUDE,
  MARKER_ALTITUDE,
  MARKER_SIZE,
  PATH_ALTITUDE,
  PLACE_ALTITUDE,
  RING_ALTITUDE,
  buildAreaItems,
  buildMarkerItems,
  buildPathItems,
  buildPlaceItems,
  buildRingItems,
  centredWaveKm,
  disasterBounds,
  disasterExtentKm,
  disasterFocus,
  distanceKm,
  geometryAreaKm2,
  highlightTarget,
  isClockwise,
  lngRange,
  markerLabel,
  orderTrack,
  rgba,
  seedOf,
  windForGlobe,
  zoneIntensity,
} from "../disasterLayers";

/** A square ring around a point, anticlockwise as GeoJSON writes outer rings. */
function square(lng: number, lat: number, half: number): Position[] {
  return [
    [lng - half, lat - half],
    [lng + half, lat - half],
    [lng + half, lat + half],
    [lng - half, lat + half],
    [lng - half, lat - half],
  ];
}

function make(over: Partial<Disaster> & { id: string }): Disaster {
  return {
    type: "flood",
    title: "Flood in Libya",
    severity: 1,
    countries: ["LY"],
    lat: 32.4,
    lng: 15.1,
    precision: "area",
    started: "2026-10-13T00:00:00Z",
    updated: "2026-10-15T00:00:00Z",
    areas: [],
    places: [],
    figures: [],
    sources: [],
    appeals: [],
    donate: [],
    reportedBy: ["gdacs"],
    members: [],
    ...over,
  };
}

describe("geometry helpers", () => {
  it("measures a one-degree square at the equator as about 12,360 km²", () => {
    const area = geometryAreaKm2({ type: "Polygon", coordinates: [square(0.5, 0, 0.5)] });
    expect(area).toBeGreaterThan(12200);
    expect(area).toBeLessThan(12500);
  });

  it("subtracts holes and adds the parts of a multipolygon", () => {
    const outer = square(0, 0, 1);
    const hole = square(0, 0, 0.5).reverse();
    const holed = geometryAreaKm2({ type: "Polygon", coordinates: [outer, hole] });
    const full = geometryAreaKm2({ type: "Polygon", coordinates: [outer] });
    expect(holed / full).toBeCloseTo(0.75, 2);
    const two = geometryAreaKm2({ type: "MultiPolygon", coordinates: [[outer], [square(10, 0, 1)]] });
    expect(two / full).toBeCloseTo(2, 2);
  });

  it("winds outer rings clockwise and holes anticlockwise for the globe", () => {
    const outer = square(0, 0, 1);
    expect(isClockwise(outer)).toBe(false);
    const wound = windForGlobe([outer, square(0, 0, 0.5)]);
    expect(isClockwise(wound[0])).toBe(true);
    expect(isClockwise(wound[1])).toBe(false);
    // Already-correct rings are left alone.
    expect(windForGlobe(wound)[0]).toBe(wound[0]);
  });

  it("judges winding across the antimeridian", () => {
    const ring: Position[] = [[179, -1], [-179, -1], [-179, 1], [179, 1], [179, -1]];
    expect(isClockwise(ring)).toBe(false);
    expect(isClockwise([...ring].reverse())).toBe(true);
  });

  it("drops rings too short to be polygons", () => {
    expect(windForGlobe([[[0, 0], [1, 1], [0, 0]]])).toEqual([]);
  });

  it("measures great-circle distance", () => {
    expect(distanceKm({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })).toBeCloseTo(111.2, 0);
    expect(distanceKm({ lat: 0, lng: 179.5 }, { lat: 0, lng: -179.5 })).toBeCloseTo(111.2, 0);
  });

  it("gives stable seeds in 0..1 and rgba strings", () => {
    expect(seedOf("a")).toBe(seedOf("a"));
    expect(seedOf("a")).not.toBe(seedOf("b"));
    expect(seedOf("anything")).toBeGreaterThanOrEqual(0);
    expect(seedOf("anything")).toBeLessThan(1);
    expect(rgba("#1e6fd9", 0.5)).toBe("rgba(30, 111, 217, 0.5)");
    expect(rgba("#000000", 2)).toBe("rgba(0, 0, 0, 1)");
  });
});

describe("buildAreaItems", () => {
  const quake = make({
    id: "q",
    type: "earthquake",
    title: "M5.7 earthquake near Khuzdar, Pakistan",
    severity: 2,
    lat: 28,
    lng: 66,
    areas: [
      { kind: "shaking", level: 4, geometry: { type: "Polygon", coordinates: [square(66, 28, 0.8)] } },
      { kind: "shaking", level: 6, geometry: { type: "Polygon", coordinates: [square(66, 28, 0.2)] } },
      { kind: "shaking", level: 5, geometry: { type: "Polygon", coordinates: [square(66, 28, 0.4)] } },
    ],
  });

  it("makes one item per area, weakest zone first and strongest highest", () => {
    const items = buildAreaItems([quake]);
    expect(items.map((i) => i.level)).toEqual([4, 5, 6]);
    expect(items[0].altitude).toBe(AREA_ALTITUDE.shaking);
    expect(items[2].altitude).toBeGreaterThan(items[1].altitude);
    expect(items[2].renderOrder).toBeGreaterThan(items[0].renderOrder);
    expect(items[2].intensity).toBeGreaterThan(items[0].intensity);
    expect(new Set(items.map((i) => i.key)).size).toBe(3);
  });

  it("centres every area of a disaster on its position with one shared extent", () => {
    const items = buildAreaItems([quake]);
    expect(items.every((i) => i.center.lat === 28 && i.center.lng === 66)).toBe(true);
    expect(new Set(items.map((i) => i.extentKm)).size).toBe(1);
    expect(items[0].extentKm).toBeGreaterThan(100);
  });

  it("keeps effects just above the countries and orders kinds place < affected < shaking < wind", () => {
    expect(AREA_ALTITUDE.place).toBeGreaterThan(0.005);
    expect(AREA_ALTITUDE.wind).toBeLessThan(0.007);
    expect(AREA_ALTITUDE.place).toBeLessThan(AREA_ALTITUDE.affected);
    expect(AREA_ALTITUDE.affected).toBeLessThan(AREA_ALTITUDE.shaking);
    expect(AREA_ALTITUDE.shaking).toBeLessThan(AREA_ALTITUDE.wind);
  });

  it("winds polygons for the globe and marks circles around places as approximate", () => {
    const d = make({ id: "f", areas: [{ kind: "place", geometry: { type: "Polygon", coordinates: [square(15, 32, 0.3)] } }] });
    const [item] = buildAreaItems([d]);
    expect(isClockwise(item.polygons[0][0])).toBe(true);
    expect(item.approximate).toBe(true);
    expect(item.clickable).toBe(true);
  });

  it("lets clicks through continent-sized areas", () => {
    const d = make({ id: "dr", type: "drought", areas: [{ kind: "affected", geometry: { type: "Polygon", coordinates: [square(20, 0, 8)] } }] });
    const [item] = buildAreaItems([d]);
    expect(item.areaKm2).toBeGreaterThan(CLICKABLE_AREA_MAX_KM2);
    expect(item.clickable).toBe(false);
  });

  it("skips degenerate rings", () => {
    const d = make({ id: "x", type: "drought", areas: [{ kind: "affected", geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [0, 0]]] } }] });
    expect(buildAreaItems([d]).map((i) => i.kind)).toEqual(["halo"]);
  });

  it("cuts each wind band's stronger neighbour out of it, so nested zones shade once", () => {
    const storm = make({
      id: "c",
      type: "cyclone",
      severity: 3,
      lat: 15,
      lng: 140,
      areas: [
        { kind: "wind", level: 60, geometry: { type: "Polygon", coordinates: [square(140, 15, 6)] } },
        { kind: "wind", level: 90, geometry: { type: "Polygon", coordinates: [square(140, 15, 3)] } },
        { kind: "wind", level: 120, geometry: { type: "Polygon", coordinates: [square(140, 15, 1)] } },
      ],
    });
    const items = buildAreaItems([storm]);
    expect(items.map((i) => [i.level, i.fill[0].length, i.polygons[0].length])).toEqual([
      [60, 2, 1],
      [90, 2, 1],
      [120, 1, 1],
    ]);
    // The hole runs the opposite way to the outer ring.
    expect(isClockwise(items[0].fill[0][0])).toBe(true);
    expect(isClockwise(items[0].fill[0][1])).toBe(false);
  });

  it("leaves a stronger zone that pokes outside the weaker one overlapping", () => {
    const q = make({
      id: "q",
      type: "earthquake",
      severity: 2,
      areas: [
        { kind: "shaking", level: 4, geometry: { type: "Polygon", coordinates: [square(66, 28, 1)] } },
        { kind: "shaking", level: 5, geometry: { type: "Polygon", coordinates: [square(66.8, 28, 0.5)] } },
      ],
      lat: 28,
      lng: 66,
    });
    expect(buildAreaItems([q])[0].fill[0]).toHaveLength(1);
  });
});

describe("halos", () => {
  const fire = (areas: Disaster["areas"]) => make({ id: "w", type: "wildfire", lat: 46, lng: -118.9, precision: "exact", areas });

  it("gives a small fire a soft, outline-free halo under its true footprint", () => {
    const d = fire([{ kind: "affected", geometry: { type: "Polygon", coordinates: [square(-118.9, 46, 0.02)] } }]);
    expect(haloRadiusKm(d)).toBe(MIN_EFFECT_KM.wildfire);
    const items = buildAreaItems([d]);
    expect(items.map((i) => i.kind)).toEqual(["halo", "affected"]);
    const [halo, area] = items;
    expect(halo.softEdgeKm).toBe(MIN_EFFECT_KM.wildfire);
    expect(halo.outline).toBe(false);
    expect(area.outline).toBe(true);
    expect(halo.altitude).toBeLessThan(area.altitude);
    expect(halo.renderOrder).toBeLessThan(area.renderOrder);
    // Both share the halo's reach, so centred patterns run on across the edge.
    expect(area.extentKm).toBe(halo.extentKm);
    expect(halo.extentKm).toBeGreaterThanOrEqual(MIN_EFFECT_KM.wildfire);
  });

  it("draws the halo as a circle of the right radius around the disaster", () => {
    const ring = circleRing({ lat: 46, lng: -118.9 }, 25);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(isClockwise(ring)).toBe(true);
    for (const [lng, lat] of ring) expect(distanceKm({ lat: 46, lng: -118.9 }, { lat, lng })).toBeCloseTo(25, 3);
    const across = circleRing({ lat: 0, lng: 179.9 }, 50);
    expect(Math.max(...across.map((p) => p[0])) - Math.min(...across.map((p) => p[0]))).toBeLessThan(2);
  });

  it("counts scattered specks as small, and leaves big areas alone", () => {
    const specks = make({
      id: "s",
      areas: [{ kind: "affected", geometry: { type: "MultiPolygon", coordinates: [[square(15, 32, 0.02)], [square(16, 32, 0.02)]] } }],
    });
    expect(haloRadiusKm(specks)).toBe(MIN_EFFECT_KM.flood);
    const big = make({ id: "b", areas: [{ kind: "affected", geometry: { type: "Polygon", coordinates: [square(15, 32, 1)] } }] });
    expect(haloRadiusKm(big)).toBe(0);
    expect(buildAreaItems([big]).map((i) => i.kind)).toEqual(["affected"]);
  });

  it("gives a disaster with no mapped area a halo of its own, wide for a heatwave", () => {
    const heat = make({ id: "h", type: "heatwave", precision: "country", lat: 25.4, lng: 68.4 });
    const [item] = buildAreaItems([heat]);
    expect(item.kind).toBe("halo");
    expect(item.softEdgeKm).toBe(150);
    expect(item.center).toEqual({ lat: 25.4, lng: 68.4 });
    expect(MIN_EFFECT_KM.landslide).toBeLessThan(MIN_EFFECT_KM.heatwave);
  });

  it("skips a disaster without a position", () => {
    expect(buildAreaItems([make({ id: "n", lat: Number.NaN })])).toEqual([]);
  });
});

describe("insidePolygon", () => {
  it("tests points against rings with holes, across the antimeridian", () => {
    const holed = [square(0, 0, 2), square(0, 0, 1)];
    expect(insidePolygon([1.5, 0], holed)).toBe(true);
    expect(insidePolygon([0, 0], holed)).toBe(false);
    expect(insidePolygon([3, 0], holed)).toBe(false);
    const dateline: Position[] = [[179, -1], [181, -1], [181, 1], [179, 1], [179, -1]];
    expect(insidePolygon([-179.5, 0], [dateline])).toBe(true);
  });
});

describe("zoneIntensity", () => {
  it("grows with shaking level and wind speed", () => {
    expect(zoneIntensity("shaking", 4, 2)).toBeLessThan(zoneIntensity("shaking", 6.5, 2));
    expect(zoneIntensity("wind", 60, 3)).toBeCloseTo(1 / 3, 2);
    expect(zoneIntensity("wind", 120, 3)).toBe(1);
    expect(zoneIntensity("affected", undefined, 1)).toBeLessThan(zoneIntensity("affected", undefined, 3));
  });
});

describe("buildRingItems", () => {
  it("rings minor disasters only while selected or hovered", () => {
    const rings = buildRingItems([make({ id: "q1", type: "earthquake", severity: 1 }), make({ id: "q2", type: "earthquake", severity: 2 })]);
    expect(activeRings(rings, [null, null]).map((r) => r.disasterId)).toEqual(["q2"]);
    const both = activeRings(rings, ["q1", null]);
    expect(both.map((r) => r.disasterId)).toEqual(["q1", "q2"]);
    // Filtered, not rebuilt: running rings keep their objects.
    expect(both[1]).toBe(rings[1]);
  });

  it("rings earthquakes, volcanoes and tsunamis only, faster and bigger when severe", () => {
    const rings = buildRingItems([
      make({ id: "q1", type: "earthquake", severity: 1 }),
      make({ id: "q3", type: "earthquake", severity: 3 }),
      make({ id: "v", type: "volcano", severity: 2 }),
      make({ id: "t", type: "tsunami", severity: 2 }),
      make({ id: "f", type: "flood" }),
    ]);
    expect(rings.map((r) => r.disasterId)).toEqual(["q1", "q3", "v", "t"]);
    expect(rings[1].maxRadius).toBeGreaterThan(rings[0].maxRadius);
    expect(rings[1].period).toBeLessThan(rings[0].period);
    expect(rings[2].color).toBe("#b91c1c");
    expect(rings[3].color).toBe("#1d4ed8");
  });

  it("reaches past a quake's shaken area", () => {
    const q = make({ id: "q", type: "earthquake", severity: 1, lat: 0, lng: 0, areas: [{ kind: "shaking", level: 4, geometry: { type: "Polygon", coordinates: [square(0, 0, 2)] } }] });
    expect(buildRingItems([q])[0].maxRadius).toBeGreaterThan(2.5);
  });
});

describe("tracks", () => {
  it("chains a track delivered as unordered segments and ends it nearest the storm", () => {
    // Segments of the line 0 → 1 → 2 → 3 (lng), shuffled, as pairs.
    const pts: Position[] = [[2, 0], [3, 0], [0, 0], [1, 0], [1, 0], [2, 0]];
    expect(orderTrack(pts, { lat: 0, lng: 3 })).toEqual([[0, 0], [1, 0], [2, 0], [3, 0]]);
    expect(orderTrack(pts, { lat: 0, lng: -1 })).toEqual([[3, 0], [2, 0], [1, 0], [0, 0]]);
  });

  it("keeps an ordered track and flips one that runs backwards", () => {
    const pts: Position[] = [[0, 0], [1, 0], [2, 0]];
    expect(orderTrack(pts, { lat: 0, lng: 2 })).toEqual(pts);
    expect(orderTrack(pts, { lat: 0, lng: 0 })).toEqual([[2, 0], [1, 0], [0, 0]]);
  });

  it("draws the past solid and joins the forecast to it", () => {
    const storm = make({ id: "c", type: "cyclone", lat: 0, lng: 2, track: { past: [[0, 0], [1, 0], [2, 0]], forecast: [[3, 1], [4, 2]] } });
    const paths = buildPathItems([storm, make({ id: "f", track: { past: [[0, 0], [1, 1]], forecast: [] } })]);
    expect(paths.map((p) => p.kind)).toEqual(["past", "forecast"]);
    expect(paths[1].points[0]).toEqual({ lat: 0, lng: 2 });
    expect(paths[1].points).toHaveLength(3);
    expect(paths[0].color).toBe("#6d28d9");
  });
});

describe("markers and places", () => {
  it("labels markers for screen readers", () => {
    expect(markerLabel({ title: "Flood in Libya", severity: 1 })).toBe("Flood in Libya, minor. Open donation pages");
  });

  it("makes one marker per disaster, sized by severity, most severe drawn last", () => {
    const m = buildMarkerItems([make({ id: "a", severity: 3 }), make({ id: "b", severity: 1, precision: "country" })]);
    expect(m.map((x) => x.disasterId)).toEqual(["b", "a"]);
    expect(m[1].size).toBe(MARKER_SIZE[3]);
    expect(m[1].size).toBeGreaterThan(m[0].size);
    expect(m[0].precision).toBe("country");
  });

  it("lists the selected disaster's places and flags those under the marker", () => {
    const d = make({
      id: "f",
      places: [
        { name: "Misrata", country: "LY", lat: 32.38, lng: 15.09, kind: "city", impact: "streets flooded", source: "research" },
        { name: "Zliten", country: "LY", lat: 32.47, lng: 14.57, kind: "city", source: "research" },
      ],
    });
    const places = buildPlaceItems(d);
    expect(places.map((p) => [p.name, p.nearMarker, p.impact, p.side])).toEqual([
      ["Misrata", true, "streets flooded", "right"],
      ["Zliten", false, null, "left"],
    ]);
    expect(places[0].type).toBe("flood");
    expect(buildPlaceItems(null)).toEqual([]);
  });
});

describe("camera", () => {
  it("finds the shortest longitude range, across the antimeridian when needed", () => {
    expect(lngRange([10, 20, 15])).toEqual({ min: 10, max: 20, span: 10 });
    const r = lngRange([170, -170, 175]);
    expect(r.min).toBe(170);
    expect(r.max).toBe(-170);
    expect(r.span).toBeCloseTo(20);
  });

  it("frames a disaster's areas, places and position", () => {
    const d = make({
      id: "f",
      lat: 32.4,
      lng: 15.1,
      // Big enough to need no halo.
      areas: [{ kind: "affected", geometry: { type: "Polygon", coordinates: [square(13.3, 32.8, 0.4)] } }],
      places: [{ name: "Zliten", country: "LY", lat: 32.47, lng: 14.57, kind: "city", source: "research" }],
    });
    const b = disasterBounds(d);
    expect(b.minLng).toBeCloseTo(12.9);
    expect(b.maxLng).toBeCloseTo(15.1);
    expect(b.minLat).toBeCloseTo(32.4);
    expect(b.maxLat).toBeCloseTo(33.2);
    const f = disasterFocus(d);
    expect(f.lng).toBeCloseTo(14);
    expect(f.altitude).toBe(FOCUS_MIN_ALTITUDE);
  });

  it("flies higher for bigger disasters, within limits", () => {
    const small = disasterFocus(make({ id: "s", areas: [{ kind: "affected", geometry: { type: "Polygon", coordinates: [square(15, 32, 0.1)] } }] }));
    const mid = disasterFocus(make({ id: "m", lat: 0, lng: 0, areas: [{ kind: "wind", level: 60, geometry: { type: "Polygon", coordinates: [square(0, 0, 10)] } }] }));
    const huge = disasterFocus(make({ id: "h", lat: 0, lng: 0, areas: [{ kind: "affected", geometry: { type: "Polygon", coordinates: [square(0, 0, 60)] } }] }));
    expect(small.altitude).toBe(FOCUS_MIN_ALTITUDE);
    expect(mid.altitude).toBeGreaterThan(FOCUS_MIN_ALTITUDE);
    expect(mid.altitude).toBeLessThan(FOCUS_MAX_ALTITUDE);
    expect(huge.altitude).toBe(FOCUS_MAX_ALTITUDE);
  });

  it("centres boxes that cross the antimeridian on the right side of the globe", () => {
    const d = make({ id: "p", lat: -17, lng: 179, areas: [{ kind: "affected", geometry: { type: "Polygon", coordinates: [[[178, -18], [178, -16], [-178, -16], [-178, -18], [178, -18]]] } }] });
    const f = disasterFocus(d);
    expect(Math.abs(f.lng)).toBeGreaterThan(179);
    expect(f.altitude).toBeLessThan(0.5);
  });

  it("sees a disaster known only by its country, or with no mapped area, from higher up", () => {
    const country = disasterFocus(make({ id: "c", type: "heatwave", precision: "country" }));
    expect(country.altitude).toBeGreaterThanOrEqual(COUNTRY_FOCUS_ALTITUDE);
    const unmapped = disasterFocus(make({ id: "u", type: "landslide", precision: "area" }));
    expect(unmapped.altitude).toBeGreaterThanOrEqual(UNMAPPED_FOCUS_ALTITUDE);
    expect(unmapped.altitude).toBeLessThan(COUNTRY_FOCUS_ALTITUDE);
  });

  it("frames a small disaster's halo, not just its speck", () => {
    const d = make({ id: "w", type: "wildfire", lat: 0, lng: 0, areas: [{ kind: "affected", geometry: { type: "Polygon", coordinates: [square(0, 0, 0.01)] } }] });
    const b = disasterBounds(d);
    expect(b.maxLat - b.minLat).toBeCloseTo((2 * MIN_EFFECT_KM.wildfire) / 111.2, 1);
  });

  it("measures a disaster's reach from its position", () => {
    const d = make({ id: "e", lat: 0, lng: 0, areas: [{ kind: "affected", geometry: { type: "Polygon", coordinates: [square(0, 0, 1)] } }] });
    expect(disasterExtentKm(d)).toBeCloseTo(157, 0);
    expect(disasterExtentKm(make({ id: "n" }))).toBe(5);
  });
});

describe("layer heights", () => {
  it("keeps depth-tested rings and tracks above a selected country, and HTML low to stay registered", () => {
    expect(RING_ALTITUDE).toBeGreaterThan(0.012);
    expect(PATH_ALTITUDE).toBeGreaterThan(0.012);
    expect(MARKER_ALTITUDE).toBeGreaterThan(AREA_ALTITUDE.wind);
    expect(PLACE_ALTITUDE).toBeLessThan(0.01);
  });

  it("spaces centred waves by the disaster's size, never tighter than 40 km", () => {
    expect(centredWaveKm(400)).toBe(100);
    expect(centredWaveKm(20)).toBe(40);
  });
});

describe("screen layout", () => {
  it("leaves markers with clear space between them alone", () => {
    const out = clusterMarkers([
      { id: "a", x: 0, y: 0, size: 26, rank: 2 },
      { id: "b", x: 40, y: 0, size: 26, rank: 1 },
    ]);
    expect(out.heads.size).toBe(0);
    expect(out.merged.size).toBe(0);
  });

  it("merges overlapping markers into the most important one, with a count", () => {
    const out = clusterMarkers([
      { id: "minor", x: 10, y: 0, size: 22, rank: 1 },
      { id: "severe", x: 0, y: 0, size: 32, rank: 3 },
      { id: "touching", x: 0, y: 28, size: 22, rank: 2 },
      { id: "apart", x: 200, y: 0, size: 22, rank: 1 },
    ]);
    expect(out.heads.get("severe")?.sort()).toEqual(["minor", "touching"]);
    expect([...out.merged].sort()).toEqual(["minor", "touching"]);
    expect(out.heads.has("apart")).toBe(false);
  });

  it("keeps the selected marker as the head, whatever its severity", () => {
    const out = clusterMarkers([
      { id: "selected", x: 0, y: 0, size: 22, rank: 10 },
      { id: "severe", x: 5, y: 5, size: 32, rank: 3 },
    ]);
    expect(out.heads.get("selected")).toEqual(["severe"]);
    expect(out.merged.has("selected")).toBe(false);
  });

  it("never lets two heads overlap", () => {
    // A row of touching markers: every other one becomes a head.
    const row = Array.from({ length: 6 }, (_, i) => ({ id: `m${i}`, x: i * 20, y: 0, size: 22, rank: 1 }));
    const { heads, merged } = clusterMarkers(row);
    const shown = row.filter((m) => !merged.has(m.id));
    for (const a of shown) for (const b of shown) if (a !== b) expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(22 + 3);
    expect([...heads.values()].flat().length).toBe(merged.size);
  });

  it("centres a cluster on its members, also across the 180° line", () => {
    expect(meanPosition([{ lat: 10, lng: 20 }, { lat: 20, lng: 40 }])).toEqual({ lat: 15, lng: 30 });
    const fiji = meanPosition([{ lat: -17.9, lng: 179.6 }, { lat: -18.3, lng: -179.6 }]);
    expect(fiji.lat).toBeCloseTo(-18.1, 9);
    expect(Math.abs(fiji.lng)).toBeCloseTo(180, 9);
  });

  it("fans a cluster's members out in a ring around its head, none touching", () => {
    // Three disasters at the very same spot as the head.
    const markers = ["h", "a", "b", "c"].map((id) => ({ id, x: 100, y: 100, size: 26, rank: id === "h" ? 3 : 1 }));
    const clusters = clusterMarkers(markers);
    const offsets = fanOffsets(clusters, markers);
    expect([...offsets.keys()].sort()).toEqual(["a", "b", "c"]);
    const spots = [{ x: 100, y: 100 }, ...[...offsets.values()].map(([dx, dy]) => ({ x: 100 + dx, y: 100 + dy }))];
    for (const p of spots) for (const q of spots) if (p !== q) expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThanOrEqual(26);
    // The first one goes straight up.
    expect(offsets.get(clusters.heads.get("h")![0])![0]).toBeCloseTo(0, 9);
  });

  it("puts a place label on the side where it fits, else where there is more room", () => {
    const screen = { left: 0, right: 375 };
    expect(placeLabelFit("right", 100, 120, screen).side).toBe("right");
    expect(placeLabelFit("right", 300, 120, screen).side).toBe("left");
    expect(placeLabelFit("left", 60, 120, screen).side).toBe("right");
    // Fits neither side: the roomier one, with its width to shorten the label to.
    const tight = placeLabelFit("right", 250, 400, screen);
    expect(tight.side).toBe("left");
    expect(tight.room).toBe(250 - 13 - 8);
    expect(placeLabelFit("right", 100, 120, screen).room).toBe(375 - 8 - 113);
  });
});

describe("highlightTarget", () => {
  it("lifts the selected disaster, dims the others and lightly lifts a hovered one", () => {
    expect(highlightTarget("a", "a", null)).toBe(1);
    expect(highlightTarget("b", "a", null)).toBe(-1);
    expect(highlightTarget("b", "a", "b")).toBe(0);
    expect(highlightTarget("b", null, "b")).toBeGreaterThan(0);
    expect(highlightTarget("b", null, null)).toBe(0);
  });
});
