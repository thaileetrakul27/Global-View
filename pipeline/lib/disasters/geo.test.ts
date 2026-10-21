import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  dropSeaParts,
  landShare,
  onLand,
  EARTH_RADIUS_KM,
  LAND_SHAPES_PATH,
  bboxOf,
  centroidOf,
  circlePolygon,
  closeRing,
  countryAt,
  countryCentroid,
  fitGeometry,
  geometryAreaKm2,
  haversineKm,
  loadCountryShapes,
  mergeGeometries,
  nearestCountry,
  normaliseLng,
  pointInGeometry,
  simplifyGeometry,
  toAreaGeometry,
  type CountryShape,
} from "./geo";
import type { AreaGeometry, MultiPolygonGeometry, PolygonGeometry, Position } from "./types";

// ---------------------------------------------------------------------------
// Helpers for building test shapes
// ---------------------------------------------------------------------------

/** A closed, counter-clockwise rectangle ring. */
function rect(minLng: number, minLat: number, maxLng: number, maxLat: number): Position[] {
  return [
    [minLng, minLat],
    [maxLng, minLat],
    [maxLng, maxLat],
    [minLng, maxLat],
    [minLng, minLat],
  ];
}

function poly(...rings: Position[][]): PolygonGeometry {
  return { type: "Polygon", coordinates: rings };
}

function multi(...polys: Position[][][]): MultiPolygonGeometry {
  return { type: "MultiPolygon", coordinates: polys };
}

/** Every ring of a geometry. */
function ringsOf(geom: AreaGeometry): Position[][] {
  return geom.type === "Polygon" ? geom.coordinates : geom.coordinates.flat();
}

/** Asserts that every ring is closed and has at least four positions. */
function expectValidRings(geom: AreaGeometry) {
  for (const ring of ringsOf(geom)) {
    expect(ring.length).toBeGreaterThanOrEqual(4);
    expect(ring[ring.length - 1]).toEqual(ring[0]);
  }
}

/** Twice the signed planar area; positive means counter-clockwise. */
function signedArea2(ring: Position[]): number {
  let s = 0;
  for (let i = 1; i < ring.length; i++) s += ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1];
  return s;
}

/** A wiggly ring with many vertices: a circle with a small radial ripple. */
function wigglyRing(lng: number, lat: number, radiusDeg: number, n: number): Position[] {
  const ring: Position[] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    const r = radiusDeg * (1 + 0.002 * Math.sin(i * 7));
    ring.push([lng + r * Math.cos(a), lat + r * Math.sin(a)]);
  }
  return closeRing(ring);
}

const shapes = loadCountryShapes();
const shape = (code: string) => shapes.find((s) => s.code === code)!;

// ---------------------------------------------------------------------------
// Basics
// ---------------------------------------------------------------------------

describe("haversineKm", () => {
  it("measures one degree of latitude as about 111.2 km", () => {
    expect(haversineKm({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(111.195, 2);
  });
  it("measures London to Paris as about 344 km", () => {
    const km = haversineKm({ lat: 51.5074, lng: -0.1278 }, { lat: 48.8566, lng: 2.3522 });
    expect(km).toBeGreaterThan(340);
    expect(km).toBeLessThan(347);
  });
  it("takes the short way across the antimeridian", () => {
    expect(haversineKm({ lat: 0, lng: 179.5 }, { lat: 0, lng: -179.5 })).toBeCloseTo(111.195, 2);
  });
  it("is zero for the same point and half the circumference for antipodes", () => {
    expect(haversineKm({ lat: 10, lng: 20 }, { lat: 10, lng: 20 })).toBe(0);
    expect(haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 180 })).toBeCloseTo(Math.PI * EARTH_RADIUS_KM, 3);
  });
});

describe("normaliseLng", () => {
  it("brings longitudes into [-180, 180)", () => {
    expect(normaliseLng(190)).toBe(-170);
    expect(normaliseLng(-190)).toBe(170);
    expect(normaliseLng(180)).toBe(-180);
    expect(normaliseLng(540)).toBe(-180);
    expect(normaliseLng(12.5)).toBe(12.5);
  });
  it("never returns -0", () => {
    expect(Object.is(normaliseLng(-0), 0)).toBe(true);
    expect(Object.is(normaliseLng(-360), 0)).toBe(true);
  });
});

describe("bboxOf", () => {
  it("covers a polygon", () => {
    expect(bboxOf(poly(rect(1, 2, 3, 4)))).toEqual([1, 2, 3, 4]);
  });
  it("covers every part of a multipolygon", () => {
    expect(bboxOf(multi([rect(1, 2, 3, 4)], [rect(-10, -5, -8, 0)]))).toEqual([-10, -5, 3, 4]);
  });
  it("keeps longitudes beyond 180", () => {
    expect(bboxOf(poly(rect(178, -1, 182, 1)))).toEqual([178, -1, 182, 1]);
  });
});

describe("closeRing", () => {
  it("appends the first position to an open ring", () => {
    expect(closeRing([[0, 0], [1, 0], [1, 1]])).toEqual([[0, 0], [1, 0], [1, 1], [0, 0]]);
  });
  it("leaves a closed ring the same length", () => {
    expect(closeRing(rect(0, 0, 1, 1))).toEqual(rect(0, 0, 1, 1));
  });
  it("returns a copy and never changes its input", () => {
    const input: Position[] = [[0, 0], [1, 0], [1, 1]];
    const out = closeRing(input);
    out[0][0] = 99;
    expect(input).toEqual([[0, 0], [1, 0], [1, 1]]);
  });
  it("handles an empty ring", () => {
    expect(closeRing([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("toAreaGeometry", () => {
  it("accepts a valid polygon and drops altitude", () => {
    const out = toAreaGeometry({ type: "Polygon", coordinates: [[[0, 0, 5], [1, 0, 5], [1, 1, 5], [0, 0, 5]]] });
    expect(out).toEqual(poly([[0, 0], [1, 0], [1, 1], [0, 0]]));
  });
  it("closes open rings and removes repeated positions", () => {
    const out = toAreaGeometry({ type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 0], [1, 1], [0, 1]]] });
    expect(out).toEqual(poly(rect(0, 0, 1, 1)));
  });
  it("keeps a multipolygon a multipolygon, even with one part", () => {
    const out = toAreaGeometry({ type: "MultiPolygon", coordinates: [[rect(0, 0, 1, 1)]] });
    expect(out).toEqual(multi([rect(0, 0, 1, 1)]));
  });
  it("keeps valid holes and drops invalid ones", () => {
    const hole = rect(0.2, 0.2, 0.4, 0.4);
    const out = toAreaGeometry({ type: "Polygon", coordinates: [rect(0, 0, 1, 1), hole, [[0.5, 0.5], [0.6, 0.6]], [[0.7, "x"], [0.8, 0.8], [0.7, 0.9]]] });
    expect(out).toEqual(poly(rect(0, 0, 1, 1), hole));
  });
  it("drops a polygon whose outer ring is invalid, keeping the other parts", () => {
    const out = toAreaGeometry({ type: "MultiPolygon", coordinates: [[[[0, 0], [NaN, 1], [1, 1], [0, 0]]], [rect(5, 5, 6, 6)]] });
    expect(out).toEqual(multi([rect(5, 5, 6, 6)]));
  });
  it("rejects numbers given as strings, infinities and latitudes beyond the poles", () => {
    expect(toAreaGeometry({ type: "Polygon", coordinates: [[["0", "0"], ["1", "0"], ["1", "1"], ["0", "0"]]] })).toBeNull();
    expect(toAreaGeometry({ type: "Polygon", coordinates: [[[0, 0], [Infinity, 0], [1, 1], [0, 0]]] })).toBeNull();
    expect(toAreaGeometry({ type: "Polygon", coordinates: [[[0, 0], [1, 95], [1, 1], [0, 0]]] })).toBeNull();
  });
  it("rejects rings with fewer than three corners", () => {
    expect(toAreaGeometry({ type: "Polygon", coordinates: [[[0, 0], [1, 1], [0, 0]]] })).toBeNull();
  });
  it("drops points, lines, junk and empty input", () => {
    expect(toAreaGeometry({ type: "Point", coordinates: [100, 13] })).toBeNull();
    expect(toAreaGeometry({ type: "LineString", coordinates: [[0, 0], [1, 1]] })).toBeNull();
    expect(toAreaGeometry({ type: "MultiPolygon", coordinates: "nope" })).toBeNull();
    expect(toAreaGeometry({ type: "Polygon", coordinates: [] })).toBeNull();
    expect(toAreaGeometry(null)).toBeNull();
    expect(toAreaGeometry("Polygon")).toBeNull();
    expect(toAreaGeometry(42)).toBeNull();
  });
  it("reads a Feature's geometry and the polygons of a GeometryCollection", () => {
    expect(toAreaGeometry({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [rect(0, 0, 1, 1)] } })).toEqual(poly(rect(0, 0, 1, 1)));
    expect(toAreaGeometry({ type: "Feature", properties: {}, geometry: { type: "MultiPolygon", coordinates: [[rect(0, 0, 1, 1)]] } })).toEqual(multi([rect(0, 0, 1, 1)]));
    const gc = {
      type: "GeometryCollection",
      geometries: [{ type: "Point", coordinates: [0, 0] }, { type: "Polygon", coordinates: [rect(0, 0, 1, 1)] }, { type: "MultiPolygon", coordinates: [[rect(2, 2, 3, 3)]] }],
    };
    expect(toAreaGeometry(gc)).toEqual(multi([rect(0, 0, 1, 1)], [rect(2, 2, 3, 3)]));
    expect(toAreaGeometry({ type: "GeometryCollection", geometries: [{ type: "Point", coordinates: [0, 0] }] })).toBeNull();
  });
  it("makes a ring that jumps across the antimeridian continuous", () => {
    const out = toAreaGeometry({ type: "Polygon", coordinates: [[[179, -1], [-179, -1], [-179, 1], [179, 1], [179, -1]]] });
    expect(out).toEqual(poly([[179, -1], [181, -1], [181, 1], [179, 1], [179, -1]]));
  });
  it("leaves a ring that circles a pole as it is", () => {
    const ring: Position[] = [[-180, -60], [0, -60], [180, -60], [180, -90], [-180, -90], [-180, -60]];
    expect(toAreaGeometry({ type: "Polygon", coordinates: [ring] })).toEqual(poly(ring));
  });
  it("does not alias its input", () => {
    const input = { type: "Polygon", coordinates: [rect(0, 0, 1, 1)] };
    const out = toAreaGeometry(input) as PolygonGeometry;
    out.coordinates[0][0][0] = 99;
    expect(input.coordinates[0][0][0]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Simplification
// ---------------------------------------------------------------------------

describe("simplifyGeometry", () => {
  it("removes vertices within the tolerance and keeps the ring closed", () => {
    const ring = wigglyRing(10, 10, 2, 400);
    const out = simplifyGeometry(poly(ring), 0.05) as PolygonGeometry;
    expect(out.type).toBe("Polygon");
    expect(out.coordinates[0].length).toBeLessThan(100);
    expectValidRings(out);
    const before = geometryAreaKm2(poly(ring));
    expect(Math.abs(geometryAreaKm2(out) - before) / before).toBeLessThan(0.05);
  });
  it("rounds coordinates to three decimals without -0", () => {
    const out = simplifyGeometry(poly([[0.12345, -0.0001], [1.98765, 0], [1.5, 1.23456], [0.12345, -0.0001]]), 0) as PolygonGeometry;
    expect(out.coordinates[0]).toEqual([[0.123, 0], [1.988, 0], [1.5, 1.235], [0.123, 0]]);
    expect(Object.is(out.coordinates[0][0][1], 0)).toBe(true);
  });
  it("never leaves fewer than four positions per ring", () => {
    // A triangle with a near-collinear extra corner: RDP may drop the extra corner but must keep three.
    const out = simplifyGeometry(poly([[0, 0], [1, 0.0001], [2, 0], [1, 1], [0, 0]]), 0.01) as PolygonGeometry;
    expect(out.coordinates[0]).toEqual([[0, 0], [2, 0], [1, 1], [0, 0]]);
  });
  it("drops rings smaller than the tolerance and holes with them", () => {
    const big = rect(0, 0, 1, 1);
    const tiny = rect(5, 5, 5.004, 5.004);
    const out = simplifyGeometry(multi([big], [tiny]), 0.005) as MultiPolygonGeometry;
    expect(out).toEqual(multi([big]));
    expect(simplifyGeometry(poly(tiny), 0.005)).toBeNull();
  });
  it("keeps large holes and drops tiny ones", () => {
    const big = rect(0, 0, 1, 1);
    const hole = rect(0.2, 0.2, 0.6, 0.6);
    const pinhole = rect(0.8, 0.8, 0.8004, 0.8004);
    expect(simplifyGeometry(poly(big, hole, pinhole), 0.005)).toEqual(poly(big, hole));
  });
  it("drops slivers that collapse and rings with no area", () => {
    expect(simplifyGeometry(poly([[0, 0], [1, 0.001], [2, 0], [1, -0.001], [0, 0]]), 0.01)).toBeNull();
    expect(simplifyGeometry(poly([[0, 0], [1, 0], [2, 0], [0, 0]]), 0)).toBeNull();
  });
  it("keeps a multipolygon a multipolygon", () => {
    expect(simplifyGeometry(multi([rect(0, 0, 1, 1)]), 0.01)?.type).toBe("MultiPolygon");
  });
  it("keeps every real country's rings closed at several tolerances", () => {
    for (const tolerance of [0, 0.01, 0.1, 0.5]) {
      for (const s of shapes) {
        const out = simplifyGeometry(s.geometry, tolerance);
        if (out) expectValidRings(out);
      }
    }
    // Large countries survive even a coarse tolerance.
    expect(simplifyGeometry(shape("BR").geometry, 0.5)).not.toBeNull();
  });
  it("keeps a real country's outline close to the original", () => {
    const th = shape("TH").geometry;
    const out = simplifyGeometry(th, 0.05)!;
    const [a, b, c, d] = bboxOf(th);
    const [e, f, g, h] = bboxOf(out);
    for (const [x, y] of [[a, e], [b, f], [c, g], [d, h]]) expect(Math.abs(x - y)).toBeLessThan(0.06);
  });
});

describe("fitGeometry", () => {
  it("brings a real country under each byte budget", () => {
    const ru = shape("RU").geometry;
    for (const budget of [1500, 4000, 8000]) {
      const out = fitGeometry(ru, budget)!;
      expect(JSON.stringify(out).length).toBeLessThanOrEqual(budget);
      expectValidRings(out);
    }
  });
  it("keeps a coarse shape's area roughly right", () => {
    const ca = shape("CA").geometry;
    const out = fitGeometry(ca, 3000)!;
    const ratio = geometryAreaKm2(out) / geometryAreaKm2(ca);
    expect(ratio).toBeGreaterThan(0.85);
    expect(ratio).toBeLessThan(1.15);
  });
  it("only lightly simplifies a geometry already under budget", () => {
    const th = shape("TH").geometry;
    const out = fitGeometry(th, 60_000)!;
    expect(out).toEqual(simplifyGeometry(th, 0.005));
  });
  it("fits a detailed generated flood extent under 60 KB", () => {
    const parts = Array.from({ length: 60 }, (_, i) => [wigglyRing(90 + (i % 10) * 0.3, 22 + Math.floor(i / 10) * 0.3, 0.1, 300)]);
    const big = multi(...parts);
    expect(JSON.stringify(big).length).toBeGreaterThan(300_000);
    const out = fitGeometry(big, 60_000)!;
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(60_000);
    expect(ringsOf(out).length).toBe(60);
    expectValidRings(out);
  });
  it("drops the smallest parts when simplifying alone cannot fit", () => {
    // 300 small squares that all vanish at the same tolerance (0.04), so the
    // coarsest version (0.02) still holds all of them and is too big.
    const parts = Array.from({ length: 300 }, (_, i) => [rect(i * 0.1, 0, i * 0.1 + 0.05 + (i === 7 ? 0.002 : 0), 0.05)]);
    const out = fitGeometry(multi(...parts), 2000) as MultiPolygonGeometry;
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(2000);
    expect(out.coordinates.length).toBeGreaterThan(5);
    expect(out.coordinates.length).toBeLessThan(300);
    // The largest part (number 7) is kept first.
    expect(out.coordinates[0][0][1][0]).toBeCloseTo(0.752, 3);
  });
  it("returns the coarsest version when one polygon cannot get small enough", () => {
    const out = fitGeometry(poly(rect(0, 0, 10, 10)), 10)!;
    expect(out).toEqual(poly(rect(0, 0, 10, 10)));
  });
  it("only rounds a shape too small for the starting tolerance", () => {
    const small = rect(1, 1, 1.003, 1.003);
    expect(fitGeometry(poly(small), 60_000)).toEqual(poly(small));
  });
  it("returns null for a degenerate geometry", () => {
    expect(fitGeometry(poly([[0, 0], [1, 0], [2, 0], [0, 0]]), 60_000)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Area and centroid
// ---------------------------------------------------------------------------

describe("geometryAreaKm2", () => {
  it("is exact for a one-degree box on the equator", () => {
    const exact = EARTH_RADIUS_KM ** 2 * (Math.PI / 180) * Math.sin(Math.PI / 180);
    expect(geometryAreaKm2(poly(rect(0, 0, 1, 1)))).toBeCloseTo(exact, 3);
  });
  it("shrinks boxes towards the poles", () => {
    const exact = EARTH_RADIUS_KM ** 2 * (Math.PI / 180) * (Math.sin((61 * Math.PI) / 180) - Math.sin((60 * Math.PI) / 180));
    expect(geometryAreaKm2(poly(rect(10, 60, 11, 61)))).toBeCloseTo(exact, 3);
  });
  it("does not depend on ring direction", () => {
    const ring = rect(0, 0, 2, 3);
    expect(geometryAreaKm2(poly([...ring].reverse()))).toBeCloseTo(geometryAreaKm2(poly(ring)), 6);
  });
  it("subtracts holes and adds parts", () => {
    const outer = geometryAreaKm2(poly(rect(0, 0, 2, 2)));
    const hole = geometryAreaKm2(poly(rect(0.5, 0.5, 1, 1)));
    expect(geometryAreaKm2(poly(rect(0, 0, 2, 2), rect(0.5, 0.5, 1, 1)))).toBeCloseTo(outer - hole, 3);
    expect(geometryAreaKm2(multi([rect(0, 0, 2, 2)], [rect(0.5, 0.5, 1, 1)]))).toBeCloseTo(outer + hole, 3);
  });
  it("is within a few percent of real country areas", () => {
    expect(geometryAreaKm2(shape("TH").geometry) / 513_120).toBeCloseTo(1, 1);
    expect(Math.abs(geometryAreaKm2(shape("TH").geometry) / 513_120 - 1)).toBeLessThan(0.03);
    expect(Math.abs(geometryAreaKm2(shape("AU").geometry) / 7_692_024 - 1)).toBeLessThan(0.03);
    expect(Math.abs(geometryAreaKm2(shape("CA").geometry) / 9_984_670 - 1)).toBeLessThan(0.03);
  });
  it("measures circles, including across the antimeridian and over a pole", () => {
    const cap = (r: number) => 2 * Math.PI * EARTH_RADIUS_KM ** 2 * (1 - Math.cos(r / EARTH_RADIUS_KM));
    expect(Math.abs(geometryAreaKm2(circlePolygon(13.75, 100.5, 50)) / cap(50) - 1)).toBeLessThan(0.01);
    expect(Math.abs(geometryAreaKm2(circlePolygon(-17, 179.5, 200)) / cap(200) - 1)).toBeLessThan(0.01);
    expect(Math.abs(geometryAreaKm2(circlePolygon(89, 0, 300)) / cap(300) - 1)).toBeLessThan(0.01);
    expect(Math.abs(geometryAreaKm2(circlePolygon(-88, 45, 500)) / cap(500) - 1)).toBeLessThan(0.01);
  });
});

describe("centroidOf", () => {
  it("finds the centre of a square", () => {
    const c = centroidOf(poly(rect(10, -2, 12, 2)));
    expect(c.lng).toBeCloseTo(11, 6);
    expect(c.lat).toBeCloseTo(0, 6);
  });
  it("weights by real area, so a tall box's centre sits below its middle latitude", () => {
    // Equal-area centre of 0..80 N: asin((sin 0 + sin 80) / 2) = 29.5 degrees.
    expect(centroidOf(poly(rect(0, 0, 10, 80))).lat).toBeCloseTo(29.5, 0);
  });
  it("moves away from a hole", () => {
    const c = centroidOf(poly(rect(0, -1, 4, 1), rect(0.5, -0.5, 1.5, 0.5)));
    expect(c.lng).toBeGreaterThan(2);
  });
  it("averages parts on both sides of the antimeridian correctly", () => {
    const c = centroidOf(multi([rect(178, -17, 180, -16)], [rect(-180, -17, -178, -16)]));
    expect(Math.abs(Math.abs(c.lng) - 180)).toBeLessThan(0.01);
    expect(c.lat).toBeCloseTo(-16.5, 1);
  });
  it("weights parts by their area", () => {
    const c = centroidOf(multi([rect(0, 0, 3, 3)], [rect(10, 0, 11, 1)]));
    expect(c.lng).toBeGreaterThan(1.5);
    expect(c.lng).toBeLessThan(3);
  });
  it("normalises longitudes of continuous rings past 180", () => {
    const c = centroidOf(poly(rect(179, -1, 183, 1)));
    expect(c.lng).toBeCloseTo(-179, 6);
  });
  it("falls back to the average corner for a shape with no area", () => {
    const c = centroidOf(poly([[0, 0], [2, 0], [4, 0], [0, 0]]));
    expect(c.lng).toBeCloseTo(2, 6);
    expect(c.lat).toBeCloseTo(0, 6);
  });
});

// ---------------------------------------------------------------------------
// Point in polygon
// ---------------------------------------------------------------------------

describe("pointInGeometry", () => {
  const withHole = poly(rect(0, 0, 10, 10), rect(4, 4, 6, 6));
  it("finds points inside and outside", () => {
    expect(pointInGeometry(1, 1, withHole)).toBe(true);
    expect(pointInGeometry(11, 1, withHole)).toBe(false);
    expect(pointInGeometry(1, -1, withHole)).toBe(false);
  });
  it("respects holes", () => {
    expect(pointInGeometry(5, 5, withHole)).toBe(false);
    expect(pointInGeometry(3.9, 5, withHole)).toBe(true);
  });
  it("checks every part of a multipolygon", () => {
    const m = multi([rect(0, 0, 1, 1)], [rect(20, 20, 21, 21)]);
    expect(pointInGeometry(20.5, 20.5, m)).toBe(true);
    expect(pointInGeometry(10, 10, m)).toBe(false);
  });
  it("matches rings that run past 180 from either side", () => {
    const across = poly(rect(178, -1, 182, 1));
    expect(pointInGeometry(-179.5, 0, across)).toBe(true);
    expect(pointInGeometry(180.5, 0, across)).toBe(true);
    expect(pointInGeometry(179, 0.5, across)).toBe(true);
    expect(pointInGeometry(-170, 0, across)).toBe(false);
  });
  it("respects the real South Africa's hole around Lesotho", () => {
    const za = shape("ZA").geometry;
    expect(pointInGeometry(28.05, -26.2, za)).toBe(true); // Johannesburg
    expect(pointInGeometry(28.0, -29.4, za)).toBe(false); // Lesotho
  });
});

// ---------------------------------------------------------------------------
// Circles and merging
// ---------------------------------------------------------------------------

describe("circlePolygon", () => {
  it("draws a closed counter-clockwise ring with every corner on the circle", () => {
    const c = circlePolygon(13.75, 100.5, 50);
    const ring = c.coordinates[0];
    expect(c.type).toBe("Polygon");
    expect(ring.length).toBe(33);
    expect(ring[32]).toEqual(ring[0]);
    expect(signedArea2(ring)).toBeGreaterThan(0);
    for (const [lng, lat] of ring) expect(haversineKm({ lat: 13.75, lng: 100.5 }, { lat, lng })).toBeCloseTo(50, 0);
    expect(pointInGeometry(100.5, 13.75, c)).toBe(true);
  });
  it("uses the number of segments asked for", () => {
    expect(circlePolygon(0, 0, 10, 8).coordinates[0].length).toBe(9);
    expect(circlePolygon(0, 0, 10, 1).coordinates[0].length).toBe(5);
  });
  it("runs past 180 instead of jumping across the antimeridian", () => {
    const c = circlePolygon(-17, 179.5, 200);
    const ring = c.coordinates[0];
    for (let i = 1; i < ring.length; i++) expect(Math.abs(ring[i][0] - ring[i - 1][0])).toBeLessThan(10);
    const [minLng, , maxLng] = bboxOf(c);
    expect(minLng).toBeGreaterThan(177);
    expect(maxLng).toBeGreaterThan(180);
    expect(pointInGeometry(-179.5, -17, c)).toBe(true);
    expect(pointInGeometry(179.5, -17, c)).toBe(true);
    expect(pointInGeometry(-175, -17, c)).toBe(false);
    expect(centroidOf(c).lng).toBeCloseTo(179.5, 2);
  });
  it("closes a circle around the north pole along the pole", () => {
    const c = circlePolygon(89, 0, 300);
    const ring = c.coordinates[0];
    expect(ring[ring.length - 1]).toEqual(ring[0]);
    expect(ring.some(([, lat]) => lat === 90)).toBe(true);
    expect(pointInGeometry(100, 89.9, c)).toBe(true);
    expect(pointInGeometry(-170, 89.5, c)).toBe(true);
    expect(pointInGeometry(0, 87.5, c)).toBe(true);
    expect(pointInGeometry(180, 87.5, c)).toBe(false);
  });
  it("closes a circle around the south pole along the pole", () => {
    const c = circlePolygon(-88, 45, 500);
    expect(c.coordinates[0].some(([, lat]) => lat === -90)).toBe(true);
    expect(pointInGeometry(-120, -89.5, c)).toBe(true);
    expect(pointInGeometry(45, -84, c)).toBe(true); // 4 degrees from the centre
    expect(pointInGeometry(45, -82, c)).toBe(false);
    expect(pointInGeometry(-135, -84, c)).toBe(false); // across the pole, 8 degrees away
  });
  it("works near but not around a pole", () => {
    const c = circlePolygon(85, 30, 100);
    expect(c.coordinates[0].every(([, lat]) => lat < 90)).toBe(true);
    expect(pointInGeometry(30, 85, c)).toBe(true);
  });
  it("clamps odd radii instead of failing", () => {
    expect(circlePolygon(0, 0, 0).coordinates[0].length).toBe(33);
    expect(circlePolygon(0, 0, NaN).coordinates[0].length).toBe(33);
    expect(geometryAreaKm2(circlePolygon(0, 0, 50_000))).toBeLessThan(2 * Math.PI * EARTH_RADIUS_KM ** 2);
  });
});

describe("mergeGeometries", () => {
  it("concatenates polygons and multipolygons into one multipolygon", () => {
    const a = poly(rect(0, 0, 1, 1));
    const b = multi([rect(2, 2, 3, 3)], [rect(4, 4, 5, 5), rect(4.2, 4.2, 4.4, 4.4)]);
    expect(mergeGeometries([a, b])).toEqual(multi([rect(0, 0, 1, 1)], [rect(2, 2, 3, 3)], [rect(4, 4, 5, 5), rect(4.2, 4.2, 4.4, 4.4)]));
  });
  it("gives an empty multipolygon for no input", () => {
    expect(mergeGeometries([])).toEqual({ type: "MultiPolygon", coordinates: [] });
  });
});

// ---------------------------------------------------------------------------
// Countries
// ---------------------------------------------------------------------------

describe("loadCountryShapes", () => {
  it("reads every globe country with its properties, geometry and bbox", () => {
    expect(shapes.length).toBe(177);
    const th = shape("TH");
    expect(th).toMatchObject({ code: "TH", name: "Thailand", admin: "Thailand", iso3: "THA" });
    expect(th.bbox).toEqual(bboxOf(th.geometry));
    expect(["CYN", "SOL", "XK"].every((c) => shapes.some((s) => s.code === c))).toBe(true);
  });
  it("caches the parsed file per path", () => {
    expect(loadCountryShapes()).toBe(shapes);
  });
  it("skips features without a usable polygon", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "geo-test-"));
    const file = path.join(dir, "countries.geojson");
    const features = [
      { type: "Feature", properties: { code: "AA", name: "A", admin: "Aland" }, geometry: { type: "Polygon", coordinates: [rect(0, 0, 1, 1)] } },
      { type: "Feature", properties: { code: "BB", name: "B", admin: "Bland" }, geometry: { type: "Point", coordinates: [0, 0] } },
      { type: "Feature", properties: { code: "CC", name: "C", admin: "Cland", iso3: "CCC" }, geometry: null },
    ];
    fs.writeFileSync(file, JSON.stringify({ type: "FeatureCollection", features }));
    const out = loadCountryShapes(file);
    expect(out).toEqual([{ code: "AA", name: "A", admin: "Aland", geometry: poly(rect(0, 0, 1, 1)), bbox: [0, 0, 1, 1] }]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("countryAt", () => {
  it("finds the country a point is in", () => {
    expect(countryAt(13.7563, 100.5018, shapes)).toBe("TH"); // Bangkok
    expect(countryAt(48.8566, 2.3522, shapes)).toBe("FR"); // Paris
    expect(countryAt(-33.87, 151.21, shapes)).toBe("AU"); // Sydney
  });
  it("gives a point just off the Thai coast to Thailand within the tolerance", () => {
    expect(nearestCountry(12.5, 101.2, shapes, 0)).toBeNull(); // really at sea in the map data
    expect(countryAt(12.5, 101.2, shapes)).toBe("TH");
    expect(countryAt(12.5, 101.2, shapes, 10)).toBeNull();
  });
  it("returns null in the middle of the Atlantic", () => {
    expect(countryAt(25, -45, shapes)).toBeNull();
    expect(countryAt(0, -30, shapes)).toBeNull();
  });
  it("respects enclaves (Lesotho inside South Africa)", () => {
    expect(countryAt(-29.4, 28.0, shapes)).toBe("LS");
    expect(countryAt(-26.2, 28.05, shapes)).toBe("ZA");
  });
  it("finds Fiji on both sides of the antimeridian", () => {
    expect(countryAt(-16.3, -179.95, shapes)).toBe("FJ");
    expect(countryAt(-16.3, -179.7, shapes)).toBe("FJ"); // just east of the coast, at sea
    expect(countryAt(-17.8, 178.0, shapes)).toBe("FJ");
  });
  it("picks the smaller shape when two overlap", () => {
    const fake: CountryShape[] = [
      { code: "AA", name: "A", admin: "A", geometry: poly(rect(0, 0, 10, 10)), bbox: [0, 0, 10, 10] },
      { code: "BB", name: "B", admin: "B", geometry: poly(rect(2, 2, 3, 3)), bbox: [2, 2, 3, 3] },
    ];
    expect(countryAt(2.5, 2.5, fake)).toBe("BB");
    expect(countryAt(5, 5, fake)).toBe("AA");
  });
});

describe("nearestCountry", () => {
  it("returns distance zero inside a country", () => {
    expect(nearestCountry(13.7563, 100.5018, shapes, 30)).toEqual({ code: "TH", km: 0 });
  });
  it("measures the distance to the nearest coast", () => {
    const fake: CountryShape[] = [{ code: "AA", name: "A", admin: "A", geometry: poly(rect(0, 0, 1, 1)), bbox: [0, 0, 1, 1] }];
    const out = nearestCountry(0.5, 1.2, fake, 50)!;
    expect(out.code).toBe("AA");
    expect(out.km).toBeCloseTo(0.2 * 111.195, 0);
    expect(nearestCountry(0.5, 1.2, fake, 20)).toBeNull();
  });
  it("picks the nearer of two countries", () => {
    const fake: CountryShape[] = [
      { code: "AA", name: "A", admin: "A", geometry: poly(rect(0, 0, 1, 1)), bbox: [0, 0, 1, 1] },
      { code: "BB", name: "B", admin: "B", geometry: poly(rect(1.3, 0, 2, 1)), bbox: [1.3, 0, 2, 1] },
    ];
    expect(nearestCountry(0.5, 1.2, fake, 50)?.code).toBe("BB");
    expect(nearestCountry(0.5, 1.1, fake, 50)?.code).toBe("AA");
  });
  it("measures across the antimeridian", () => {
    const fake: CountryShape[] = [{ code: "AA", name: "A", admin: "A", geometry: poly(rect(-180, 0, -179, 1)), bbox: [-180, 0, -179, 1] }];
    const out = nearestCountry(0.5, 179.9, fake, 50)!;
    expect(out.code).toBe("AA");
    expect(out.km).toBeCloseTo(0.1 * 111.195, 0);
  });
  it("finds a distant coast with a large reach", () => {
    const out = nearestCountry(9.5, 100.2, shapes, 500)!; // Gulf of Thailand
    expect(out.code).toBe("TH");
    expect(out.km).toBeGreaterThan(30);
    expect(out.km).toBeLessThan(80);
  });
});

describe("countryCentroid", () => {
  it("places France in mainland France, not between it and French Guiana", () => {
    const c = countryCentroid("FR", shapes)!;
    expect(c.lat).toBeGreaterThan(44);
    expect(c.lat).toBeLessThan(49);
    expect(c.lng).toBeGreaterThan(0);
    expect(c.lng).toBeLessThan(5);
    expect(countryAt(c.lat, c.lng, shapes, 0)).toBe("FR");
    // The plain centroid of every part is dragged south-west, out of France.
    const naive = centroidOf(shape("FR").geometry);
    expect(countryAt(naive.lat, naive.lng, shapes, 0)).not.toBe("FR");
  });
  it("places the United States in the contiguous states", () => {
    const c = countryCentroid("US", shapes)!;
    expect(c.lat).toBeGreaterThan(35);
    expect(c.lat).toBeLessThan(42);
    expect(c.lng).toBeGreaterThan(-105);
    expect(c.lng).toBeLessThan(-90);
  });
  it("keeps curved countries' markers on their own land", () => {
    for (const code of ["VN", "HR", "NO", "IL", "HT"]) {
      const c = countryCentroid(code, shapes)!;
      expect(countryAt(c.lat, c.lng, shapes, 0)).toBe(code);
    }
  });
  it("puts every globe country's marker inside that country", () => {
    for (const s of shapes) {
      const c = countryCentroid(s.code, shapes)!;
      expect(countryAt(c.lat, c.lng, shapes, 0), s.code).toBe(s.code);
    }
  });
  it("returns null for an unknown code", () => {
    expect(countryCentroid("ZZ", shapes)).toBeNull();
  });
});

describe("land and sea", () => {
  const shapes = loadCountryShapes();
  const detailed = loadCountryShapes(LAND_SHAPES_PATH);
  type Case = { lat: number; lng: number; places?: { lat: number; lng: number }[]; areas: { geometry: AreaGeometry }[] };
  const fx = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "sea-parts.json"), "utf8")) as Record<
    "china" | "vietnam" | "italy" | "spain",
    Case
  >;
  const parts = (g: AreaGeometry) => (g.type === "Polygon" ? [g.coordinates] : g.coordinates);
  /** The part whose outer ring has a vertex inside the box. */
  const partIn = (g: AreaGeometry, minX: number, minY: number, maxX: number, maxY: number) =>
    parts(g).find((p) => p[0].some(([x, y]) => x > minX && x < maxX && y > minY && y < maxY));

  it("tells land from sea", () => {
    expect(onLand(13.75, 100.5, shapes)).toBe(true); // Bangkok
    expect(onLand(19.2, 109.6, shapes)).toBe(true); // Hainan
    expect(onLand(16.5, 112.0, shapes)).toBe(false); // Paracel waters
    expect(onLand(0, -150, shapes)).toBe(false); // the Pacific
  });

  it("finds land across the antimeridian and at any longitude", () => {
    expect(onLand(66, -172, shapes)).toBe(true); // Chukotka
    expect(onLand(66, 188, shapes)).toBe(true); // the same point, 360 degrees on
    expect(onLand(-16.83, -179.94, detailed)).toBe(true); // Taveuni, Fiji
  });

  it("finds islands in the finer shapes that the coarse ones leave out", () => {
    expect(onLand(38.98, 1.41, shapes)).toBe(false); // Ibiza
    expect(onLand(38.98, 1.41, detailed)).toBe(true);
    expect(onLand(42.78, 10.25, shapes)).toBe(false); // Elba
    expect(onLand(42.78, 10.25, detailed)).toBe(true);
    expect(onLand(16.5, 112.0, detailed)).toBe(false); // Paracel waters
  });

  it("measures how much of a polygon is land", () => {
    const hainan = partIn(fx.china.areas[0].geometry, 109, 18, 110, 19.5)!;
    expect(landShare(hainan, shapes)).toBeGreaterThan(0.5);
    const box: Position[][] = [[[111, 15.5], [113, 15.5], [113, 17.3], [111, 17.3], [111, 15.5]]];
    expect(landShare(box, shapes)).toBe(0);
    expect(landShare(box, detailed)).toBe(0);
    const ibiza = partIn(fx.spain.areas[0].geometry, 1.2, 38.83, 1.65, 39.15)!;
    expect(landShare(ibiza, shapes)).toBe(0);
    expect(landShare(ibiza, detailed)).toBeGreaterThan(0.8);
  });

  it("drops the island waters from Hainan's flood area and keeps the island", () => {
    const geom = fx.china.areas[0].geometry;
    expect(parts(geom)).toHaveLength(13);
    for (const lands of [[shapes], [detailed], [shapes, detailed]]) {
      const out = dropSeaParts(geom, lands, [fx.china])!;
      expect(parts(out)).toHaveLength(1);
      expect(pointInGeometry(109.6, 19.2, out)).toBe(true);
      // Nothing south of 17.5 degrees north (the Paracel and Spratly Islands) is left.
      expect(parts(out).every((p) => p[0].every(([, y]) => y > 17.5))).toBe(true);
    }
  });

  it("leaves a coastal flood on the mainland as it is", () => {
    const geom = fx.vietnam.areas[0].geometry;
    expect(dropSeaParts(geom, [shapes, detailed], [fx.vietnam])).toBe(geom);
  });

  it("keeps a part that holds the disaster's own point, even off the country shapes", () => {
    const islet: AreaGeometry = { type: "Polygon", coordinates: [[[-175.3, -21.2], [-175.1, -21.2], [-175.1, -21.0], [-175.3, -21.0], [-175.3, -21.2]]] };
    expect(dropSeaParts(islet, [shapes], [{ lat: -21.1, lng: -175.2 }])).toBe(islet);
    expect(dropSeaParts(islet, [shapes], [])).toBeNull();
  });

  it("keeps a part that holds one of the disaster's places, not only its position", () => {
    // Italy's flood: its position is on the mainland, its researched places on Elba.
    const geom = fx.italy.areas[0].geometry;
    const elba = partIn(geom, 10.1, 42.7, 10.45, 42.9)!;
    expect(landShare(elba, shapes)).toBe(0);
    expect(fx.italy.places!.every((p) => pointInGeometry(p.lng, p.lat, { type: "Polygon", coordinates: elba }))).toBe(true);
    const out = dropSeaParts(geom, [shapes], [fx.italy, ...fx.italy.places!])!;
    expect(parts(out)).toHaveLength(2); // the mainland piece and Elba; Pianosa and Montecristo go
    expect(parts(out)).toContain(elba);
    // Without its places, the coarse shapes alone lose Elba.
    expect(parts(dropSeaParts(geom, [shapes], [fx.italy])!)).not.toContain(elba);
  });

  it("keeps islands the coarse shapes leave out when the finer shapes have them", () => {
    // Spain's flood: Ibiza and Formentera, with its position on Formentera.
    const geom = fx.spain.areas[0].geometry;
    expect(parts(geom)).toHaveLength(2);
    expect(dropSeaParts(geom, [shapes, detailed], [fx.spain])).toBe(geom);
    expect(dropSeaParts(geom, [shapes, detailed], [])).toBe(geom);
    expect(parts(dropSeaParts(geom, [shapes], [fx.spain])!)).toHaveLength(1);
  });

  it("keeps a part that holds a keep point across the antimeridian", () => {
    // Open sea south of Fiji, so only the keep point can save these.
    const west = circlePolygon(-25, 179.98, 10); // runs past +180
    expect(bboxOf(west)[2]).toBeGreaterThan(180);
    expect(dropSeaParts(west, [shapes, detailed], [{ lat: -25, lng: -179.95 }])).toBe(west);
    const east = circlePolygon(-25, -179.98, 10); // runs past -180
    expect(bboxOf(east)[0]).toBeLessThan(-180);
    expect(dropSeaParts(east, [shapes, detailed], [{ lat: -25, lng: 179.95 }])).toBe(east);
    const ring = toAreaGeometry({ type: "Polygon", coordinates: [[[179.85, -25.2], [-179.8, -25.2], [-179.8, -24.8], [179.85, -24.8], [179.85, -25.2]]] })!;
    expect(bboxOf(ring)[2]).toBeGreaterThan(180);
    expect(dropSeaParts(ring, [shapes, detailed], [{ lat: -25, lng: -179.94 }])).toBe(ring);
    expect(dropSeaParts(ring, [shapes, detailed], [])).toBeNull();
  });
});
