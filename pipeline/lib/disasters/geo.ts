// Small geometry helpers for the disaster map: distances, bounding boxes,
// GeoJSON validation, simplification to a byte budget, areas, centroids,
// point-in-polygon tests and "which country is this point in".
//
// Conventions:
// - Positions are GeoJSON order, [longitude, latitude], in degrees.
// - Longitudes are continuous within a ring. A ring that crosses the
//   antimeridian may use longitudes beyond +-180 (e.g. 179 -> 181) rather
//   than jumping from 179 to -179. toAreaGeometry converts jumping rings to
//   this form and circlePolygon produces it; every helper here accepts it.
// - Planar maths is done in degrees; areas and centroids use the Lambert
//   cylindrical equal-area projection (x = longitude, y = sin latitude), so
//   they stay accurate for country-sized shapes at any latitude.
import fs from "node:fs";
import type { AreaGeometry, MultiPolygonGeometry, PolygonGeometry, Position } from "./types";

/** Mean Earth radius (IUGG), in kilometres. */
export const EARTH_RADIUS_KM = 6371.0088;

const RAD = Math.PI / 180;
const KM_PER_DEG = EARTH_RADIUS_KM * RAD;

/** Largest radius circlePolygon draws, so a circle never wraps both poles. */
const MAX_CIRCLE_KM = 9000;

// ---------------------------------------------------------------------------
// Basics
// ---------------------------------------------------------------------------

/** Great-circle distance between two points, in kilometres. */
export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLng = (b.lng - a.lng) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Brings any longitude into [-180, 180). */
export function normaliseLng(lng: number): number {
  const out = ((((lng + 180) % 360) + 360) % 360) - 180;
  return out === 0 ? 0 : out; // never -0
}

/** A longitude difference folded into [-180, 180] only when it is wider than half the world. */
function shortDelta(d: number): number {
  if (d > 180) return d - 360;
  if (d < -180) return d + 360;
  return d;
}

/** Every polygon of a geometry as a list of rings (outer ring first, then holes). */
function polygonsOf(geom: AreaGeometry): Position[][][] {
  return geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
}

/** [minLng, minLat, maxLng, maxLat] over every position of the geometry. */
export function bboxOf(geom: AreaGeometry): [number, number, number, number] {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const poly of polygonsOf(geom)) {
    for (const ring of poly) {
      for (const [lng, lat] of ring) {
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    }
  }
  return [minLng, minLat, maxLng, maxLat];
}

/** Bounding box of one ring. */
function ringBbox(ring: Position[]): [number, number, number, number] {
  return bboxOf({ type: "Polygon", coordinates: [ring] });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Appends the first position when a ring is not closed. Returns a new array. */
export function closeRing(ring: Position[]): Position[] {
  if (ring.length === 0) return [];
  const first = ring[0];
  const last = ring[ring.length - 1];
  const out = ring.map((p) => [p[0], p[1]] as Position);
  if (first[0] !== last[0] || first[1] !== last[1]) out.push([first[0], first[1]]);
  return out;
}

/** Reads one [lng, lat, ...] position, or null when it is not two finite, in-range numbers. */
function parsePosition(p: unknown): Position | null {
  if (!Array.isArray(p) || p.length < 2) return null;
  const [lng, lat] = p;
  if (typeof lng !== "number" || typeof lat !== "number") return null;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  if (lat < -90 || lat > 90 || lng < -540 || lng > 540) return null;
  return [lng, lat];
}

/** Drops positions equal to the one before them. */
function dedupe(ring: Position[]): Position[] {
  return ring.filter((p, i) => i === 0 || p[0] !== ring[i - 1][0] || p[1] !== ring[i - 1][1]);
}

/**
 * Makes a closed ring's longitudes continuous when it jumps across the
 * antimeridian (179 -> -179 becomes 179 -> 181). A ring that circles a pole
 * does not close when unwrapped, so it is left as it is.
 */
function unwrapRing(ring: Position[]): Position[] {
  const jumps = ring.some((p, i) => i > 0 && Math.abs(p[0] - ring[i - 1][0]) > 180);
  if (!jumps) return ring;
  const out: Position[] = [[ring[0][0], ring[0][1]]];
  for (let i = 1; i < ring.length; i++) {
    out.push([out[i - 1][0] + shortDelta(ring[i][0] - ring[i - 1][0]), ring[i][1]]);
  }
  return Math.abs(out[out.length - 1][0] - out[0][0]) < 1e-9 ? out : ring;
}

/** A validated, closed ring with at least three distinct corners, or null. */
function parseRing(raw: unknown): Position[] | null {
  if (!Array.isArray(raw)) return null;
  const positions = raw.map(parsePosition);
  if (positions.some((p) => p === null)) return null;
  const ring = unwrapRing(closeRing(dedupe(positions as Position[])));
  return ring.length >= 4 ? ring : null;
}

/** A validated polygon (outer ring plus valid holes), or null when the outer ring is invalid. */
function parsePolygon(raw: unknown): Position[][] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const outer = parseRing(raw[0]);
  if (!outer) return null;
  const holes = raw.slice(1).map(parseRing).filter((r): r is Position[] => r !== null);
  return [outer, ...holes];
}

/** Every valid polygon in a GeoJSON geometry, Feature or GeometryCollection; other types give none. */
function parsePolygons(raw: unknown, depth = 0): Position[][][] {
  if (!raw || typeof raw !== "object" || depth > 4) return [];
  const g = raw as { type?: unknown; coordinates?: unknown; geometry?: unknown; geometries?: unknown };
  if (g.type === "Feature") return parsePolygons(g.geometry, depth + 1);
  if (g.type === "GeometryCollection" && Array.isArray(g.geometries)) {
    return g.geometries.flatMap((x) => parsePolygons(x, depth + 1));
  }
  if (g.type === "Polygon") {
    const poly = parsePolygon(g.coordinates);
    return poly ? [poly] : [];
  }
  if (g.type === "MultiPolygon" && Array.isArray(g.coordinates)) {
    return g.coordinates.map(parsePolygon).filter((p): p is Position[][] => p !== null);
  }
  return [];
}

/**
 * Validates untrusted GeoJSON into an AreaGeometry. Accepts Polygon and
 * MultiPolygon (and, for convenience, a Feature or GeometryCollection
 * holding them). Positions must be finite numbers with a latitude in
 * [-90, 90]; altitude is dropped, rings are closed and de-duplicated, and a
 * ring with fewer than three corners or a bad number is dropped (with its
 * holes, if it is an outer ring). Points, lines and anything else give null.
 * A Polygon stays a Polygon and a MultiPolygon stays a MultiPolygon.
 */
export function toAreaGeometry(geojsonGeometry: unknown): AreaGeometry | null {
  const polys = parsePolygons(geojsonGeometry);
  if (polys.length === 0) return null;
  const g = geojsonGeometry as { type?: unknown; geometry?: { type?: unknown } | null };
  const type = g.type === "Feature" ? g.geometry?.type : g.type;
  if (polys.length === 1 && type !== "MultiPolygon") return { type: "Polygon", coordinates: polys[0] };
  return { type: "MultiPolygon", coordinates: polys };
}

// ---------------------------------------------------------------------------
// Simplification
// ---------------------------------------------------------------------------

/** Rounds to 3 decimals (about 100 m), never returning -0. */
function round3(n: number): number {
  return Math.round(n * 1000) / 1000 || 0;
}

/** Planar distance in degrees from p to the segment a-b. */
function segmentDistanceDeg(p: Position, a: Position, b: Position): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Ramer-Douglas-Peucker on an open polyline; keeps both ends. Iterative, so long rings cannot overflow the stack. */
function rdp(line: Position[], tolerance: number): Position[] {
  if (line.length <= 2) return line;
  const keep = new Array<boolean>(line.length).fill(false);
  keep[0] = keep[line.length - 1] = true;
  const stack: [number, number][] = [[0, line.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    let worst = -1;
    let worstDist = tolerance;
    for (let i = start + 1; i < end; i++) {
      const d = segmentDistanceDeg(line[i], line[start], line[end]);
      if (d > worstDist) {
        worst = i;
        worstDist = d;
      }
    }
    if (worst > 0) {
      keep[worst] = true;
      stack.push([start, worst], [worst, end]);
    }
  }
  return line.filter((_, i) => keep[i]);
}

/**
 * Simplifies a closed ring. It is split at the corner farthest from its
 * start so neither half has a zero-length anchor, then each half goes
 * through RDP. The result is still closed.
 */
function simplifyRing(ring: Position[], tolerance: number): Position[] {
  if (tolerance <= 0 || ring.length < 5) return ring;
  const open = ring.slice(0, -1);
  let far = 0;
  let farDist = -1;
  open.forEach((p, i) => {
    const d = Math.hypot(p[0] - open[0][0], p[1] - open[0][1]);
    if (d > farDist) {
      far = i;
      farDist = d;
    }
  });
  if (far === 0) return [open[0], open[0]];
  const first = rdp(open.slice(0, far + 1), tolerance);
  const second = rdp([...open.slice(far), open[0]], tolerance);
  return [...first, ...second.slice(1)];
}

/** Twice the signed planar area of a ring in square degrees (shoelace). */
function planarArea2(ring: Position[]): number {
  let sum = 0;
  for (let i = 1; i < ring.length; i++) {
    sum += ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1];
  }
  return sum;
}

/** Simplifies, rounds and re-closes a ring; null when it collapses or is smaller than minSize degrees. */
function cleanRing(ring: Position[], tolerance: number, minSize: number): Position[] | null {
  const rounded = simplifyRing(ring, tolerance).map((p) => [round3(p[0]), round3(p[1])] as Position);
  const out = closeRing(dedupe(rounded));
  if (out.length < 4) return null;
  const [minLng, minLat, maxLng, maxLat] = ringBbox(out);
  if (Math.max(maxLng - minLng, maxLat - minLat) < minSize) return null;
  if (Math.abs(planarArea2(out)) < 1e-9) return null;
  return out;
}

/**
 * Simplifies every ring with Ramer-Douglas-Peucker at toleranceDeg, rounds
 * coordinates to 3 decimals and keeps rings closed with at least four
 * positions. Rings that collapse, have no area, or whose bounding box is
 * smaller than the tolerance (and never smaller than 0.001 degrees) are
 * dropped; an outer ring takes its holes with it. A tolerance of 0 only
 * rounds. Returns null when nothing is left. Keeps the input's type.
 */
export function simplifyGeometry(geom: AreaGeometry, toleranceDeg: number): AreaGeometry | null {
  const tolerance = Math.max(0, toleranceDeg);
  const minSize = Math.max(tolerance, 0.001);
  const polys: Position[][][] = [];
  for (const poly of polygonsOf(geom)) {
    const outer = poly[0] ? cleanRing(poly[0], tolerance, minSize) : null;
    if (!outer) continue;
    const holes = poly.slice(1).map((h) => cleanRing(h, tolerance, minSize));
    polys.push([outer, ...holes.filter((h): h is Position[] => h !== null)]);
  }
  if (polys.length === 0) return null;
  if (geom.type === "Polygon") return { type: "Polygon", coordinates: polys[0] };
  return { type: "MultiPolygon", coordinates: polys };
}

/** Size of a value once written as JSON, in bytes (coordinates are ASCII). */
function jsonBytes(value: unknown): number {
  return JSON.stringify(value).length;
}

/** First tolerance fitGeometry tries, in degrees (about 550 m). */
const FIT_START_TOLERANCE = 0.005;
/** Doublings fitGeometry tries before giving up: 0.005 * 2^20 is far wider than the world. */
const FIT_MAX_STEPS = 20;

/** Keeps the largest polygons that fit in maxBytes (always at least the largest one). */
function keepLargest(geom: AreaGeometry, maxBytes: number): AreaGeometry {
  const polys = polygonsOf(geom)
    .map((coords) => ({ coords, area: polygonAreaKm2(coords), bytes: jsonBytes(coords) }))
    .sort((a, b) => b.area - a.area);
  let total = jsonBytes({ type: "MultiPolygon", coordinates: [] });
  const kept: Position[][][] = [];
  for (const p of polys) {
    const next = total + p.bytes + (kept.length > 0 ? 1 : 0);
    if (kept.length > 0 && next > maxBytes) continue;
    kept.push(p.coords);
    total = next;
  }
  return geom.type === "Polygon" ? geom : { type: "MultiPolygon", coordinates: kept };
}

/**
 * Simplifies a geometry until its JSON is at most maxBytes. Starts at a
 * tolerance of 0.005 degrees and doubles it. If the next step would make
 * the geometry vanish, the coarsest non-null version is used, and if that is
 * still too big its smallest polygons are dropped (the largest is always
 * kept, so the result can exceed maxBytes only when one polygon cannot be
 * made small enough). A shape too small for 0.005 degrees is only rounded.
 * Returns null only when the geometry is degenerate at every tolerance.
 */
export function fitGeometry(geom: AreaGeometry, maxBytes: number): AreaGeometry | null {
  let best = simplifyGeometry(geom, FIT_START_TOLERANCE) ?? simplifyGeometry(geom, 0);
  if (!best) return null;
  let tolerance = FIT_START_TOLERANCE;
  for (let step = 0; step < FIT_MAX_STEPS && jsonBytes(best) > maxBytes; step++) {
    tolerance *= 2;
    const next = simplifyGeometry(geom, tolerance);
    if (!next) break;
    best = next;
  }
  return jsonBytes(best) > maxBytes ? keepLargest(best, maxBytes) : best;
}

// ---------------------------------------------------------------------------
// Area and centroid
// ---------------------------------------------------------------------------

/**
 * Area of one ring on the sphere, in km2 (Chamberlain and Duquette's
 * formula, the equal-area shoelace with a term for rings that circle a
 * pole). A result larger than a hemisphere is taken to mean the other side.
 */
function ringAreaKm2(ring: Position[]): number {
  let sum = 0;
  for (let i = 1; i < ring.length; i++) {
    const [lng1, lat1] = ring[i - 1];
    const [lng2, lat2] = ring[i];
    sum += shortDelta(lng2 - lng1) * RAD * (2 + Math.sin(lat1 * RAD) + Math.sin(lat2 * RAD));
  }
  const sphere = 4 * Math.PI * EARTH_RADIUS_KM ** 2;
  const area = (Math.abs(sum) * EARTH_RADIUS_KM ** 2) / 2;
  return area > sphere / 2 ? sphere - area : area;
}

/** Area of one polygon (outer ring minus holes), in km2. */
function polygonAreaKm2(poly: Position[][]): number {
  if (poly.length === 0) return 0;
  const holes = poly.slice(1).reduce((sum, ring) => sum + ringAreaKm2(ring), 0);
  return Math.max(0, ringAreaKm2(poly[0]) - holes);
}

/** Area of a geometry on the sphere, in km2. Accurate to well under 1% for country-sized shapes. */
export function geometryAreaKm2(geom: AreaGeometry): number {
  return polygonsOf(geom).reduce((sum, poly) => sum + polygonAreaKm2(poly), 0);
}

/** Signed area and area-weighted centre of a ring in equal-area space (x = lng, y = sin lat). */
function ringMoments(ring: Position[]): { a: number; x: number; y: number } {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 1; i < ring.length; i++) {
    const x0 = ring[i - 1][0];
    const y0 = Math.sin(ring[i - 1][1] * RAD);
    const x1 = ring[i][0];
    const y1 = Math.sin(ring[i][1] * RAD);
    const cross = x0 * y1 - x1 * y0;
    a += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  return a === 0 ? { a: 0, x: 0, y: 0 } : { a: a / 2, x: cx / (3 * a), y: cy / (3 * a) };
}

/** Centre of one polygon (holes subtracted) as an equal-area point and its weight. */
function polygonCentre(poly: Position[][]): { x: number; y: number; w: number } {
  let w = 0;
  let x = 0;
  let y = 0;
  poly.forEach((ring, i) => {
    const m = ringMoments(ring);
    const area = Math.abs(m.a) * (i === 0 ? 1 : -1);
    w += area;
    x += m.x * area;
    y += m.y * area;
  });
  if (w > 1e-12) return { x: x / w, y: y / w, w };
  // No area (a sliver): average the outer ring's corners.
  const pts = poly[0].slice(0, -1).length > 0 ? poly[0].slice(0, -1) : poly[0];
  const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const my = pts.reduce((s, p) => s + Math.sin(p[1] * RAD), 0) / pts.length;
  return { x: mx, y: my, w: 0 };
}

/**
 * Area-weighted centroid of a geometry. Each polygon's centre is found in
 * equal-area space; several polygons are combined as unit vectors, so parts
 * on both sides of the antimeridian (Fiji, Russia) average correctly. The
 * longitude is normalised to [-180, 180).
 */
export function centroidOf(geom: AreaGeometry): { lat: number; lng: number } {
  const centres = polygonsOf(geom).map(polygonCentre);
  if (centres.length === 1) {
    const c = centres[0];
    return { lat: Math.asin(Math.max(-1, Math.min(1, c.y))) / RAD, lng: normaliseLng(c.x) };
  }
  const allZero = centres.every((c) => c.w === 0);
  let vx = 0;
  let vy = 0;
  let vz = 0;
  for (const c of centres) {
    const w = allZero ? 1 : c.w;
    const lat = Math.asin(Math.max(-1, Math.min(1, c.y)));
    const lng = c.x * RAD;
    vx += w * Math.cos(lat) * Math.cos(lng);
    vy += w * Math.cos(lat) * Math.sin(lng);
    vz += w * Math.sin(lat);
  }
  return { lat: Math.atan2(vz, Math.hypot(vx, vy)) / RAD, lng: normaliseLng(Math.atan2(vy, vx) / RAD) };
}

// ---------------------------------------------------------------------------
// Point in polygon
// ---------------------------------------------------------------------------

/** Even-odd ray casting against one ring. */
function inRing(lng: number, lat: number, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** True when the point is inside the polygon's outer ring and outside all its holes. */
function inPolygon(lng: number, lat: number, poly: Position[][]): boolean {
  if (poly.length === 0 || !inRing(lng, lat, poly[0])) return false;
  return !poly.slice(1).some((hole) => inRing(lng, lat, hole));
}

/**
 * True when the point (any longitude) is inside the geometry, holes
 * respected. The point is also tried 360 degrees east and west, so it
 * matches rings that run past +-180.
 */
export function pointInGeometry(lng: number, lat: number, geom: AreaGeometry): boolean {
  const base = normaliseLng(lng);
  const candidates = [base, base + 360, base - 360];
  return polygonsOf(geom).some((poly) => candidates.some((x) => inPolygon(x, lat, poly)));
}

// ---------------------------------------------------------------------------
// Circles and merging
// ---------------------------------------------------------------------------

/** Rounds to 4 decimals (about 10 m), never returning -0. */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000 || 0;
}

/** The point at angular distance d (radians) on bearing theta (radians) from lat/lng; longitude not normalised. */
function destination(lat: number, lng: number, theta: number, d: number): Position {
  const p1 = lat * RAD;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(theta));
  const dl = Math.atan2(Math.sin(theta) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [lng + dl / RAD, p2 / RAD];
}

/**
 * A circle of radiusKm around lat/lng as a polygon with `segments` sides,
 * drawn counter-clockwise. Longitudes are continuous, so a circle across the
 * antimeridian runs past +-180 (e.g. 178 to 182) instead of jumping. A
 * circle that contains a pole becomes a band running once around the world
 * and closed along the pole (latitude +-90), which is what a flat map or a
 * globe needs to fill the cap. The radius is clamped to 0.01..9000 km.
 */
export function circlePolygon(lat: number, lng: number, radiusKm: number, segments = 32): PolygonGeometry {
  const n = Math.max(4, Math.round(segments) || 32);
  const centreLat = Math.max(-89.9999, Math.min(89.9999, lat));
  const d = Math.max(0.01, Math.min(MAX_CIRCLE_KM, radiusKm || 0)) / EARTH_RADIUS_KM;
  const ring: Position[] = [];
  for (let i = 0; i <= n; i++) {
    const p = destination(centreLat, lng, (-2 * Math.PI * i) / n, d);
    const lngC = i === 0 ? p[0] : ring[i - 1][0] + shortDelta(p[0] - ring[i - 1][0]);
    ring.push([lngC, p[1]]);
  }
  const rounded = ring.map((p) => [round4(p[0]), round4(p[1])] as Position);
  const first = rounded[0];
  const last = rounded[n];
  if (Math.abs(last[0] - first[0]) > 180) {
    // The ring went once around a pole: close it along that pole.
    const pole = centreLat >= 0 ? 90 : -90;
    return { type: "Polygon", coordinates: [[...rounded, [last[0], pole], [first[0], pole], [first[0], first[1]]]] };
  }
  rounded[n] = [first[0], first[1]];
  return { type: "Polygon", coordinates: [rounded] };
}

/** Puts every polygon of the given geometries into one MultiPolygon (no union; overlaps stay). */
export function mergeGeometries(geoms: AreaGeometry[]): MultiPolygonGeometry {
  return { type: "MultiPolygon", coordinates: geoms.flatMap(polygonsOf) };
}

// ---------------------------------------------------------------------------
// Countries
// ---------------------------------------------------------------------------

/** A globe country with its shape, from public/geo/countries.geojson. */
export interface CountryShape {
  /** Globe country code, e.g. "TH" (or "CYN", "SOL", "XK"). */
  code: string;
  name: string;
  admin: string;
  iso3?: string;
  geometry: AreaGeometry;
  /** [minLng, minLat, maxLng, maxLat] */
  bbox: [number, number, number, number];
}

/** Parsed shapes per file path, so the file is read once per run. */
const shapeCache = new Map<string, CountryShape[]>();

/**
 * Reads the globe's country shapes. Features without a usable Polygon or
 * MultiPolygon are skipped. The result is cached per path and shared, so
 * callers must not change it.
 */
export function loadCountryShapes(path = "public/geo/countries.geojson"): CountryShape[] {
  const cached = shapeCache.get(path);
  if (cached) return cached;
  const raw = JSON.parse(fs.readFileSync(path, "utf8")) as {
    features: { properties: { code: string; name: string; admin: string; iso3?: string }; geometry: unknown }[];
  };
  const shapes: CountryShape[] = [];
  for (const f of raw.features) {
    const geometry = toAreaGeometry(f.geometry);
    if (!geometry || !f.properties?.code) continue;
    const { code, name, admin, iso3 } = f.properties;
    shapes.push({ code, name, admin, ...(iso3 ? { iso3 } : {}), geometry, bbox: bboxOf(geometry) });
  }
  shapeCache.set(path, shapes);
  return shapes;
}

/** True when lat/lng is within dLat/dLng degrees of the box, trying the longitude 360 degrees either way. */
function nearBbox(bbox: [number, number, number, number], lat: number, lng: number, dLat: number, dLng: number): boolean {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  if (lat < minLat - dLat || lat > maxLat + dLat) return false;
  if (dLng >= 180) return true;
  return [lng, lng + 360, lng - 360].some((x) => x >= minLng - dLng && x <= maxLng + dLng);
}

/** Degrees of latitude and longitude that cover km around a latitude (generous near the poles). */
function degreesAround(lat: number, km: number): { dLat: number; dLng: number } {
  const dLat = km / KM_PER_DEG;
  const cos = Math.cos(Math.min(90, Math.abs(lat) + dLat) * RAD);
  return { dLat, dLng: cos < 1e-6 ? 180 : Math.min(180, dLat / cos) };
}

/**
 * Approximate distance in km from a point to the segment a-b: the closest
 * point is found on a local flat projection centred on the point, then
 * measured with haversine. Good for the tens to hundreds of km used here.
 */
function segmentDistanceKm(lat: number, lng: number, a: Position, b: Position): number {
  const k = Math.cos(lat * RAD);
  const ax = normaliseLng(a[0] - lng) * k;
  const bx = ax + shortDelta(b[0] - a[0]) * k;
  const ay = a[1] - lat;
  const by = b[1] - lat;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  const closestLat = a[1] + t * (b[1] - a[1]);
  const closestLng = a[0] + t * shortDelta(b[0] - a[0]);
  return haversineKm({ lat, lng }, { lat: closestLat, lng: closestLng });
}

/** Shortest approximate distance in km from a point to any ring of a geometry. */
function distanceToBoundaryKm(lat: number, lng: number, geom: AreaGeometry): number {
  let best = Infinity;
  for (const poly of polygonsOf(geom)) {
    for (const ring of poly) {
      for (let i = 1; i < ring.length; i++) {
        const d = segmentDistanceKm(lat, lng, ring[i - 1], ring[i]);
        if (d < best) best = d;
      }
    }
  }
  return best;
}

/** The country containing the point; when shapes overlap, the smallest one (the more specific). */
function containingCountry(lat: number, lng: number, shapes: CountryShape[]): string | null {
  const hits = shapes.filter((s) => nearBbox(s.bbox, lat, lng, 0, 0) && pointInGeometry(lng, lat, s.geometry));
  if (hits.length <= 1) return hits[0]?.code ?? null;
  return hits.reduce((a, b) => (geometryAreaKm2(b.geometry) < geometryAreaKm2(a.geometry) ? b : a)).code;
}

/**
 * The country a point is in ({code, km: 0}), or else the country whose
 * border or coast is nearest, if it is within maxKm. Only shapes whose
 * bounding box is within reach are measured.
 */
export function nearestCountry(lat: number, lng: number, shapes: CountryShape[], maxKm: number): { code: string; km: number } | null {
  const inside = containingCountry(lat, lng, shapes);
  if (inside) return { code: inside, km: 0 };
  const { dLat, dLng } = degreesAround(lat, maxKm);
  let best: { code: string; km: number } | null = null;
  for (const s of shapes) {
    if (!nearBbox(s.bbox, lat, lng, dLat, dLng)) continue;
    const km = distanceToBoundaryKm(lat, lng, s.geometry);
    if (km <= maxKm && (!best || km < best.km)) best = { code: s.code, km };
  }
  return best;
}

/**
 * The globe country code at a point: the country it is inside, else the
 * nearest one whose coast or border is within toleranceKm (so a quake just
 * offshore still belongs to its country). Null out at sea.
 */
export function countryAt(lat: number, lng: number, shapes: CountryShape[], toleranceKm = 30): string | null {
  return nearestCountry(lat, lng, shapes, toleranceKm)?.code ?? null;
}

/**
 * A point inside a polygon on the latitude line `lat`: the middle of the
 * widest stretch where that line is inside (the "interior point" method).
 */
function interiorPointOnLine(poly: Position[][], lat: number): { lat: number; lng: number } | null {
  const xs: number[] = [];
  for (const ring of poly) {
    for (let i = 1; i < ring.length; i++) {
      const [x0, y0] = ring[i - 1];
      const [x1, y1] = ring[i];
      if (y0 > lat !== y1 > lat) xs.push(x0 + ((lat - y0) * (x1 - x0)) / (y1 - y0));
    }
  }
  xs.sort((a, b) => a - b);
  let best: { lat: number; lng: number } | null = null;
  let width = 0;
  for (let i = 0; i + 1 < xs.length; i += 2) {
    if (xs[i + 1] - xs[i] > width) {
      width = xs[i + 1] - xs[i];
      best = { lat, lng: normaliseLng((xs[i] + xs[i + 1]) / 2) };
    }
  }
  return best;
}

/**
 * Where to put a country's marker: the centroid of its largest polygon (so
 * France sits in mainland France, not in the Atlantic between it and French
 * Guiana). When that centroid falls outside the polygon (a curved country),
 * the middle of the polygon's widest stretch along that latitude is used, so
 * the point is always on the country's land. Null for an unknown code.
 */
export function countryCentroid(code: string, shapes: CountryShape[]): { lat: number; lng: number } | null {
  const shape = shapes.find((s) => s.code === code);
  if (!shape) return null;
  const largest = polygonsOf(shape.geometry).reduce((a, b) => (polygonAreaKm2(b) > polygonAreaKm2(a) ? b : a));
  const poly: PolygonGeometry = { type: "Polygon", coordinates: largest };
  const c = centroidOf(poly);
  if (pointInGeometry(c.lng, c.lat, poly)) return c;
  const [, minLat, , maxLat] = bboxOf(poly);
  const nudge = 1e-7; // keeps the scan line off exact vertices
  return interiorPointOnLine(largest, c.lat + nudge) ?? interiorPointOnLine(largest, (minLat + maxLat) / 2 + nudge) ?? c;
}

// ---------------------------------------------------------------------------
// Land and sea
// ---------------------------------------------------------------------------

/** True when the point lies inside any country shape (no tolerance). */
export function onLand(lat: number, lng: number, shapes: CountryShape[]): boolean {
  const x = normaliseLng(lng);
  return shapes.some((s) => {
    const [minX, minY, maxX, maxY] = s.bbox;
    if (lat < minY || lat > maxY) return false;
    const inBox = (x >= minX && x <= maxX) || (x + 360 >= minX && x + 360 <= maxX) || (x - 360 >= minX && x - 360 <= maxX);
    return inBox && pointInGeometry(x, lat, s.geometry);
  });
}

/** Grid steps across a polygon's bounding box when sampling it for land. */
const LAND_GRID = 12;

/**
 * Share of a polygon that lies on land, from a grid of sample points inside
 * it (its corners when the polygon is too thin for the grid to land in).
 */
export function landShare(poly: Position[][], shapes: CountryShape[]): number {
  const [minX, minY, maxX, maxY] = ringBbox(poly[0]);
  const points: Position[] = [];
  for (let i = 0; i < LAND_GRID; i++) {
    for (let j = 0; j < LAND_GRID; j++) {
      const p: Position = [minX + ((i + 0.5) / LAND_GRID) * (maxX - minX), minY + ((j + 0.5) / LAND_GRID) * (maxY - minY)];
      if (inPolygon(p[0], p[1], poly)) points.push(p);
    }
  }
  const sample = points.length >= 8 ? points : poly[0];
  if (sample.length === 0) return 0;
  return sample.filter(([x, y]) => onLand(y, x, shapes)).length / sample.length;
}

/** A part of an area kept as land when at least this share of it is on land. */
export const MIN_LAND_SHARE = 0.15;

/**
 * The area without the parts that are almost all sea: for floods, fires and
 * other hazards on land, a source's footprint is often an administrative
 * boundary that takes in offshore island districts and their waters (Hainan
 * province reaches the Paracel and Spratly Islands). A part is kept when at
 * least MIN_LAND_SHARE of it is on land, or when it holds `keep` (the
 * disaster's own position), since the country shapes leave out small
 * islands. Null when no part would be left.
 */
export function dropSeaParts(geom: AreaGeometry, shapes: CountryShape[], keep: { lat: number; lng: number } | null): AreaGeometry | null {
  const parts = polygonsOf(geom).filter(
    (poly) => (keep !== null && inPolygon(normaliseLng(keep.lng), keep.lat, poly)) || landShare(poly, shapes) >= MIN_LAND_SHARE,
  );
  if (parts.length === 0) return null;
  if (parts.length === polygonsOf(geom).length) return geom;
  return parts.length === 1 ? { type: "Polygon", coordinates: parts[0] } : { type: "MultiPolygon", coordinates: parts };
}
