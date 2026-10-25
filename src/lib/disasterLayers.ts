// Pure builders for the globe's disaster layers: which items each layer
// draws, how high and how big they are, and where the camera should look.
// Nothing here touches three.js or the DOM, so all of it is unit tested.

import type { AreaGeometry, Disaster, DisasterArea, DisasterType, Position, Severity } from "./data";
import { DISASTER_META, SEVERITY_LABEL } from "./disasterMeta";

export const EARTH_RADIUS_KM = 6371;

/** Areas bigger than this (continental droughts) let clicks through to the countries below. */
export const CLICKABLE_AREA_MAX_KM2 = 1.5e6;

/**
 * Smallest radius, km, at which each kind of disaster's effect is drawn. A
 * 5,000-acre fire is a few km across: a dozen pixels even at the closest
 * fly-to (about 0.65 km a pixel), too small for flames to read; 40 km
 * spans over 120 px there. Such a disaster gets a soft halo of
 * this radius under its true footprint (see haloRadiusKm), and a disaster
 * with no mapped area gets the halo alone, so every disaster shows its hazard.
 */
export const MIN_EFFECT_KM: Record<DisasterType, number> = {
  earthquake: 35,
  tsunami: 50,
  cyclone: 60,
  storm: 50,
  flood: 40,
  landslide: 40,
  wildfire: 40,
  volcano: 40,
  drought: 150,
  heatwave: 150,
  coldwave: 150,
  dust: 100,
};

/** An area's kind, plus the halo drawn around small or unmapped disasters. */
export type AreaKind = DisasterArea["kind"] | "halo";

/**
 * Effect altitudes in globe radii. Countries sit at 0.005, so effects float
 * a hair above them: any higher and, seen from close up, they would drift
 * off the coastlines below through perspective. They are drawn without a
 * depth test (hidden past the horizon in the shader), so they still show
 * over a selected country lifted to 0.012. Stronger zones of the same
 * disaster sit on top of weaker ones.
 */
export const AREA_ALTITUDE: Record<AreaKind, number> = {
  halo: 0.0052,
  place: 0.0055,
  affected: 0.0058,
  shaking: 0.0061,
  wind: 0.0064,
};
/** Extra lift per intensity step, so inner zones draw over outer ones. */
const LEVEL_STEP = 0.00005;
/** Draw order of transparent effects: lower draws first. */
const KIND_ORDER: Record<AreaKind, number> = { halo: -50, place: -40, affected: -30, shaking: -20, wind: -10 };

/** Tracks and rings are depth tested, so they clear a selected country (0.012). */
export const PATH_ALTITUDE = 0.0135;
export const RING_ALTITUDE = 0.014;
/** HTML always draws on top; staying low keeps it registered with the map below. */
export const PLACE_ALTITUDE = 0.0068;
export const MARKER_ALTITUDE = 0.007;

/** Marker diameter in CSS pixels by severity. */
export const MARKER_SIZE: Record<Severity, number> = { 1: 22, 2: 26, 3: 32 };

/** Camera altitude limits when flying to a disaster, before the screen-shape scale. */
export const FOCUS_MIN_ALTITUDE = 0.1;
export const FOCUS_MAX_ALTITUDE = 2.2;
/** Lowest camera for a disaster located only to its country: show the country, not a patch of it. */
export const COUNTRY_FOCUS_ALTITUDE = 0.5;
/** Lowest camera for a disaster with no mapped area, framing its halo with some context. */
export const UNMAPPED_FOCUS_ALTITUDE = 0.3;

/** A place this close to the marker gets its label pushed clear of the marker chip. */
const NEAR_MARKER_KM = 30;

const RAD = Math.PI / 180;

export interface LatLng {
  lat: number;
  lng: number;
}

// --- Geometry helpers ------------------------------------------------------

/** A geometry's polygons, each a list of rings ([lng, lat]), outer ring first. */
export function geometryPolygons(g: AreaGeometry): Position[][][] {
  return g.type === "Polygon" ? [g.coordinates] : g.coordinates;
}

/** Longitudes made continuous (no ±360 jumps), so planar maths works across the antimeridian. */
function unwrapRing(ring: Position[]): Position[] {
  const out: Position[] = [];
  let prev: number | null = null;
  for (const [lng0, lat] of ring) {
    let lng = lng0;
    if (prev !== null) {
      while (lng - prev > 180) lng -= 360;
      while (lng - prev < -180) lng += 360;
    }
    out.push([lng, lat]);
    prev = lng;
  }
  return out;
}

/** Twice the signed planar area; positive for clockwise rings (lng right, lat up). */
function ringTwiceArea(ring: Position[]): number {
  const r = unwrapRing(ring);
  let s = 0;
  for (let i = 0; i < r.length; i++) {
    const [x1, y1] = r[i];
    const [x2, y2] = r[(i + 1) % r.length];
    s += (x2 - x1) * (y2 + y1);
  }
  return s;
}

/** True when a ring runs clockwise on a map with north up. */
export function isClockwise(ring: Position[]): boolean {
  return ringTwiceArea(ring) > 0;
}

/**
 * Winds a polygon the way d3-geo (and so three-globe's polygon meshes)
 * expects: outer ring clockwise, holes anticlockwise. GeoJSON's own rule is
 * the reverse, and a ring wound the "wrong" way is read as the whole globe
 * minus the polygon.
 */
export function windForGlobe(polygon: Position[][]): Position[][] {
  if ((polygon[0]?.length ?? 0) < 4) return [];
  return polygon
    .filter((ring) => ring.length >= 4)
    .map((ring, i) => (isClockwise(ring) === (i === 0) ? ring : ring.slice().reverse()));
}

/** Area of one ring on the sphere, km², ignoring winding. */
function ringAreaKm2(ring: Position[]): number {
  // Spherical excess of the ring (Chamberlain and Duquette, 2007).
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const [lng1, lat1] = ring[i];
    const [lng2, lat2] = ring[(i + 1) % ring.length];
    let dLng = lng2 - lng1;
    if (dLng > 180) dLng -= 360;
    if (dLng < -180) dLng += 360;
    s += dLng * RAD * (2 + Math.sin(lat1 * RAD) + Math.sin(lat2 * RAD));
  }
  return Math.abs((s * EARTH_RADIUS_KM * EARTH_RADIUS_KM) / 2);
}

/** Surface area of a geometry in km²: outer rings minus holes. */
export function geometryAreaKm2(g: AreaGeometry): number {
  let total = 0;
  for (const polygon of geometryPolygons(g)) {
    polygon.forEach((ring, i) => (total += i === 0 ? ringAreaKm2(ring) : -ringAreaKm2(ring)));
  }
  return Math.max(0, total);
}

/** Great-circle distance in km. */
export function distanceKm(a: LatLng, b: LatLng): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLng = (b.lng - a.lng) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Every [lng, lat] point of a disaster's areas. */
function areaPoints(d: Disaster): Position[] {
  const out: Position[] = [];
  for (const a of d.areas) for (const polygon of geometryPolygons(a.geometry)) for (const p of polygon[0] ?? []) out.push(p);
  return out;
}

/** How far the disaster's areas reach from its position, km. Never less than 5 km. */
export function disasterExtentKm(d: Disaster): number {
  let max = 0;
  for (const [lng, lat] of areaPoints(d)) max = Math.max(max, distanceKm(d, { lat, lng }));
  return Math.max(5, max);
}

/**
 * Radius of the soft halo drawn around a disaster, km (see MIN_EFFECT_KM),
 * or 0 when its largest mapped area is big enough to show the effect: at
 * least as big as a disc three quarters of that radius. Scattered specks
 * spread over a wide box still count as small.
 */
export function haloRadiusKm(d: Disaster): number {
  const min = MIN_EFFECT_KM[d.type] ?? 30;
  let largest = 0;
  for (const a of d.areas) largest = Math.max(largest, geometryAreaKm2(a.geometry));
  return Math.sqrt(largest / Math.PI) < min * 0.75 ? min : 0;
}

/** The point `km` away from `from` on the given bearing (degrees clockwise from north). */
function destination(from: LatLng, bearing: number, km: number): Position {
  const lat1 = from.lat * RAD;
  const lng1 = from.lng * RAD;
  const ang = km / EARTH_RADIUS_KM;
  const b = bearing * RAD;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(ang) + Math.cos(lat1) * Math.sin(ang) * Math.cos(b));
  const lng2 = lng1 + Math.atan2(Math.sin(b) * Math.sin(ang) * Math.cos(lat1), Math.cos(ang) - Math.sin(lat1) * Math.sin(lat2));
  return [lng2 / RAD, lat2 / RAD];
}

/**
 * A closed ring of `steps` points `km` around a point, clockwise. Longitudes
 * stay continuous across the antimeridian (they may pass 180).
 */
export function circleRing(center: LatLng, km: number, steps = 48): Position[] {
  const ring = Array.from({ length: steps }, (_, i) => destination(center, (i * 360) / steps, km));
  return unwrapRing([...ring, ring[0]]);
}

/** Even-odd test of a [lng, lat] point against a polygon's rings, longitudes taken near the point. */
export function insidePolygon(pt: Position, polygon: Position[][]): boolean {
  const near = (lng: number) => lng + 360 * Math.round((pt[0] - lng) / 360);
  let inside = false;
  for (const ring of polygon) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = [near(ring[i][0]), ring[i][1]];
      const [xj, yj] = [near(ring[j][0]), ring[j][1]];
      if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** A small stable number in 0..1 from a string, so neighbouring effects do not pulse in step. */
export function seedOf(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

/** "#rrggbb" plus alpha as an rgba() string. */
export function rgba(hex: string, alpha: number): string {
  const p = parseInt(hex.slice(1), 16);
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 1000) / 1000;
  return `rgba(${(p >> 16) & 255}, ${(p >> 8) & 255}, ${p & 255}, ${a})`;
}

// --- Area effects ------------------------------------------------------------

/**
 * How intense one zone is within its disaster, 0..1: the shaking level
 * (Modified Mercalli intensity) or the wind speed band. Footprints without
 * levels take the disaster's severity.
 */
export function zoneIntensity(kind: DisasterArea["kind"], level: number | undefined, severity: Severity): number {
  const clamp = (x: number) => Math.max(0.15, Math.min(1, x));
  if (kind === "shaking" && level !== undefined) return clamp((level - 3) / 5); // MMI 4 → 0.2, 8 → 1
  if (kind === "wind" && level !== undefined) return clamp((level - 30) / 90); // 60 → 0.33, 120 → 1
  return clamp(0.25 + 0.3 * (severity - 1)); // 0.25, 0.55, 0.85
}

export interface AreaItem {
  /** Stable key: disaster id and the area's position in its list ("halo" for the halo). */
  key: string;
  disasterId: string;
  title: string;
  type: DisasterType;
  kind: AreaKind;
  level: number | null;
  severity: Severity;
  /** 0..1, see zoneIntensity. */
  intensity: number;
  /** Globe radii above the surface. */
  altitude: number;
  /** Transparent draw order; inner and stronger zones last. */
  renderOrder: number;
  /** The area's own polygons, wound for the globe (see windForGlobe), rings of [lng, lat]. Outlined. */
  polygons: Position[][][];
  /**
   * What gets filled: the polygons with the next stronger zone of the same
   * disaster cut out as holes, so nested zones shade each pixel once.
   */
  fill: Position[][][];
  areaKm2: number;
  /** False for areas so large that clicks should reach the countries below. */
  clickable: boolean;
  /** Where centred effects (pulses, swirls, rings) start: the disaster's position. */
  center: LatLng;
  /** How far the disaster's effect reaches from the centre, km; shared by all its areas. */
  extentKm: number;
  /** A circle drawn around a named place rather than a mapped footprint: dashed edge. */
  approximate: boolean;
  /** Radius of a halo's soft edge in km, measured from the centre; 0 for a hard-edged area. */
  softEdgeKm: number;
  /** False for the halo, which has no edge to draw. */
  outline: boolean;
  /** 0..1 per area, to desynchronise animations. */
  seed: number;
}

/**
 * For each zone that has a level (shaking intensity, wind speed), the outer
 * rings of the next stronger zone that lie wholly inside one of its
 * polygons, cut out of that polygon as holes. Rings that poke outside are
 * left overlapping: that only costs a little extra drawing.
 */
function cutNestedZones(areas: DisasterArea[], wound: Position[][][][]): Position[][][][] {
  return areas.map((area, i) => {
    const fill = wound[i].map((polygon) => [...polygon]);
    if (area.level === undefined) return fill;
    const level = area.level;
    const stronger = areas.filter((a) => a.kind === area.kind && a.level !== undefined && a.level > level).map((a) => a.level!);
    if (!stronger.length) return fill;
    const next = Math.min(...stronger);
    areas.forEach((inner, j) => {
      if (inner.kind !== area.kind || inner.level !== next) return;
      for (const polygon of wound[j]) {
        const ring = polygon[0];
        const host = fill.findIndex((outer) => ring.every((pt) => insidePolygon(pt, outer)));
        // An outer ring is wound clockwise; as a hole it runs the other way.
        if (host >= 0) fill[host].push(ring.slice().reverse());
      }
    });
    return fill;
  });
}

/**
 * One effect item per disaster area, ordered weakest first so stronger zones
 * draw on top, plus a soft halo under disasters too small (or too vaguely
 * located) to show their hazard on their own (see MIN_EFFECT_KM).
 */
export function buildAreaItems(disasters: Disaster[]): AreaItem[] {
  const items: AreaItem[] = [];
  for (const d of disasters) {
    if (!Number.isFinite(d.lat) || !Number.isFinite(d.lng)) continue;
    const center = { lat: d.lat, lng: d.lng };
    const halo = haloRadiusKm(d);
    const extentKm = Math.max(d.areas.length ? disasterExtentKm(d) : 0, halo, 5);

    if (halo) {
      const ring = circleRing(center, halo);
      const polygons = [windForGlobe([ring])];
      const areaKm2 = Math.PI * halo * halo;
      const key = `${d.id}:halo`;
      items.push({
        key,
        disasterId: d.id,
        title: d.title,
        type: d.type,
        kind: "halo",
        level: null,
        severity: d.severity,
        intensity: zoneIntensity("affected", undefined, d.severity),
        altitude: AREA_ALTITUDE.halo,
        renderOrder: KIND_ORDER.halo,
        polygons,
        fill: polygons,
        areaKm2,
        clickable: areaKm2 <= CLICKABLE_AREA_MAX_KM2,
        center,
        extentKm,
        approximate: true,
        softEdgeKm: halo,
        outline: false,
        seed: seedOf(key),
      });
    }

    // Rank each kind's levels so the strongest zone gets the highest lift.
    const levels = [...new Set(d.areas.map((a) => a.level).filter((l): l is number => l !== undefined))].sort((a, b) => a - b);
    const wound = d.areas.map((area) => geometryPolygons(area.geometry).map(windForGlobe).filter((p) => p.length > 0));
    const fills = cutNestedZones(d.areas, wound);
    d.areas.forEach((area, i) => {
      const polygons = wound[i];
      if (!polygons.length) return;
      const rank = area.level !== undefined ? levels.indexOf(area.level) : 0;
      const areaKm2 = geometryAreaKm2(area.geometry);
      const key = `${d.id}:${i}`;
      items.push({
        key,
        disasterId: d.id,
        title: d.title,
        type: d.type,
        kind: area.kind,
        level: area.level ?? null,
        severity: d.severity,
        intensity: zoneIntensity(area.kind, area.level, d.severity),
        altitude: AREA_ALTITUDE[area.kind] + Math.min(rank, 6) * LEVEL_STEP,
        renderOrder: KIND_ORDER[area.kind] + Math.min(rank, 9),
        polygons,
        fill: fills[i],
        areaKm2,
        clickable: areaKm2 <= CLICKABLE_AREA_MAX_KM2,
        center,
        extentKm,
        approximate: area.kind === "place",
        softEdgeKm: 0,
        outline: true,
        seed: seedOf(key),
      });
    });
  }
  return items.sort((a, b) => a.renderOrder - b.renderOrder || a.altitude - b.altitude);
}

// --- Rings -----------------------------------------------------------------

export interface RingItem {
  disasterId: string;
  lat: number;
  lng: number;
  color: string;
  /** Degrees of arc the ring grows to. */
  maxRadius: number;
  /** Degrees per second. */
  speed: number;
  /** Milliseconds between rings. */
  period: number;
  /** True for significant and severe disasters, which ring all the time (see activeRings). */
  steady: boolean;
}

/** Expanding rings: earthquake epicentres, erupting volcanoes and tsunami sources. */
export function buildRingItems(disasters: Disaster[]): RingItem[] {
  const out: RingItem[] = [];
  for (const d of disasters) {
    const sev = d.severity;
    const steady = sev >= 2;
    const color = DISASTER_META[d.type].color;
    if (d.type === "earthquake") {
      // Reach past the shaken area, but stay readable for quakes with no ShakeMap yet.
      const fromArea = d.areas.length ? (disasterExtentKm(d) / 111) * 1.15 : 0;
      const maxRadius = Math.min(6, Math.max([1.2, 2, 3][sev - 1], fromArea));
      out.push({ disasterId: d.id, lat: d.lat, lng: d.lng, color, maxRadius, speed: maxRadius / 2.2, period: [1800, 1300, 900][sev - 1], steady });
    } else if (d.type === "volcano") {
      const maxRadius = 0.6 + 0.4 * sev;
      out.push({ disasterId: d.id, lat: d.lat, lng: d.lng, color, maxRadius, speed: maxRadius / 2.8, period: 2200, steady });
    } else if (d.type === "tsunami") {
      const maxRadius = 3 + 1.5 * sev;
      out.push({ disasterId: d.id, lat: d.lat, lng: d.lng, color, maxRadius, speed: maxRadius / 3.5, period: 1500, steady });
    }
  }
  return out;
}

/**
 * The rings to draw now. Every ring is a new three.js object, so only
 * significant and severe disasters ring all the time; a minor one rings
 * while it is selected or hovered. Their areas pulse in the shader anyway.
 * Items are filtered, not rebuilt, so rings already running carry on.
 */
export function activeRings(rings: RingItem[], focusIds: readonly (string | null)[]): RingItem[] {
  return rings.filter((r) => r.steady || focusIds.includes(r.disasterId));
}

// --- Storm tracks ----------------------------------------------------------

export interface PathItem {
  key: string;
  disasterId: string;
  title: string;
  kind: "past" | "forecast";
  points: LatLng[];
  color: string;
}

const samePoint = (a: Position, b: Position) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
const toLatLng = ([lng, lat]: Position): LatLng => ({ lat, lng });
const near = (p: Position, to: LatLng) => distanceKm(toLatLng(p), to);

/**
 * Chains a track that arrived as unordered two-point segments
 * ([a, b, c, a, ...], where points repeat) back into one line. Returns null
 * when the segments do not form a single unbroken line.
 */
function chainSegments(points: Position[]): Position[] | null {
  if (points.length < 4 || points.length % 2) return null;
  const segs: [Position, Position][] = [];
  for (let i = 0; i < points.length; i += 2) segs.push([points[i], points[i + 1]]);
  const key = (p: Position) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`;
  const degree = new Map<string, number>();
  for (const [a, b] of segs) for (const p of [a, b]) degree.set(key(p), (degree.get(key(p)) ?? 0) + 1);
  const ends = segs.flat().filter((p) => degree.get(key(p)) === 1);
  if (ends.length !== 2 || [...degree.values()].some((n) => n > 2)) return null;
  const line: Position[] = [ends[0]];
  const left = [...segs];
  while (left.length) {
    const tail = line[line.length - 1];
    const i = left.findIndex(([a, b]) => samePoint(a, tail) || samePoint(b, tail));
    if (i < 0) return null;
    const [a, b] = left.splice(i, 1)[0];
    line.push(samePoint(a, tail) ? b : a);
  }
  return line;
}

/**
 * Puts a storm's past track in order, oldest first and ending nearest the
 * storm's current position. Copes with tracks delivered as unordered
 * two-point segments.
 */
export function orderTrack(points: Position[], current: LatLng): Position[] {
  const hasRepeats = points.some((p, i) => points.findIndex((q) => samePoint(p, q)) !== i);
  const line = (hasRepeats && chainSegments(points)) || points;
  if (line.length < 2) return line;
  return near(line[0], current) < near(line[line.length - 1], current) ? [...line].reverse() : line;
}

/** Cyclone and storm tracks: where it has been (solid) and where it is forecast to go (dashed). */
export function buildPathItems(disasters: Disaster[]): PathItem[] {
  const out: PathItem[] = [];
  for (const d of disasters) {
    if (!d.track || (d.type !== "cyclone" && d.type !== "storm")) continue;
    const color = DISASTER_META[d.type].color;
    const past = orderTrack(d.track.past, d);
    if (past.length >= 2) {
      out.push({ key: `${d.id}:past`, disasterId: d.id, title: d.title, kind: "past", points: past.map(toLatLng), color });
    }
    if (d.track.forecast.length) {
      // Start the forecast where the storm is now, so the two lines join.
      const start: Position = past.length ? past[past.length - 1] : [d.lng, d.lat];
      const forecast = d.track.forecast[0] && samePoint(d.track.forecast[0], start) ? d.track.forecast : [start, ...d.track.forecast];
      out.push({ key: `${d.id}:forecast`, disasterId: d.id, title: d.title, kind: "forecast", points: forecast.map(toLatLng), color });
    }
  }
  return out;
}

// --- Markers and places ----------------------------------------------------

export interface MarkerItem {
  kind: "marker";
  disasterId: string;
  type: DisasterType;
  severity: Severity;
  precision: Disaster["precision"];
  lat: number;
  lng: number;
  title: string;
  /** Screen-reader name: "Flood in Libya, minor. Open donation pages". */
  label: string;
  /** Diameter in CSS pixels. */
  size: number;
}

export interface PlaceItem {
  kind: "place";
  key: string;
  disasterId: string;
  /** The disaster's type, for the dot's colour. */
  type: DisasterType;
  name: string;
  /** What happened there, e.g. "streets flooded". */
  impact: string | null;
  lat: number;
  lng: number;
  /** True when the place sits under the marker, so its label must move aside. */
  nearMarker: boolean;
  /** Which side of the dot the label goes: away from the marker, so labels fan out. */
  side: "left" | "right";
}

/** Screen-reader name for a disaster's marker. */
export function markerLabel(d: Pick<Disaster, "title" | "severity">): string {
  return `${d.title}, ${SEVERITY_LABEL[d.severity].toLowerCase()}. Open donation pages`;
}

/** One marker per disaster, most severe last so it draws on top where markers overlap. */
export function buildMarkerItems(disasters: Disaster[]): MarkerItem[] {
  return disasters
    .filter((d) => Number.isFinite(d.lat) && Number.isFinite(d.lng))
    .map(
      (d): MarkerItem => ({
        kind: "marker",
        disasterId: d.id,
        type: d.type,
        severity: d.severity,
        precision: d.precision,
        lat: d.lat,
        lng: d.lng,
        title: d.title,
        label: markerLabel(d),
        size: MARKER_SIZE[d.severity],
      }),
    )
    .sort((a, b) => a.severity - b.severity);
}

/** True when lng lies west of ref, the short way round. */
function westOf(lng: number, ref: number): boolean {
  const d = ((((lng - ref) % 360) + 540) % 360) - 180;
  return d < 0;
}

/** The affected cities and districts of one disaster, as labelled dots. */
export function buildPlaceItems(d: Disaster | null): PlaceItem[] {
  if (!d) return [];
  return d.places
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))
    .map((p, i) => ({
      kind: "place" as const,
      key: `${d.id}:place:${i}`,
      disasterId: d.id,
      type: d.type,
      name: p.name,
      impact: p.impact ?? null,
      lat: p.lat,
      lng: p.lng,
      nearMarker: distanceKm(p, d) < NEAR_MARKER_KM,
      side: distanceKm(p, d) >= NEAR_MARKER_KM && westOf(p.lng, d.lng) ? ("left" as const) : ("right" as const),
    }));
}

// --- Screen layout -----------------------------------------------------------

export interface ScreenMarker {
  id: string;
  /** Screen position, px. */
  x: number;
  y: number;
  /** Diameter, px. */
  size: number;
  /** Higher stays a cluster's head: the selected marker, then the more severe. */
  rank: number;
}

/** Clear space kept between neighbouring markers, px. */
const MARKER_GAP = 3;

/** Overlapping markers merged into one: the head shown, the rest hidden behind its count. */
export interface MarkerClusters {
  /** Head id -> the ids merged into it (never empty). */
  heads: Map<string, string[]>;
  /** Every id merged into a head. */
  merged: Set<string>;
}

/**
 * Merges markers whose chips would overlap on screen. Markers are taken in
 * rank order (the selected one, then the most severe); each one that comes
 * within MARKER_GAP of a head already placed joins that head's cluster,
 * otherwise it becomes a head itself. Heads never overlap each other.
 */
export function clusterMarkers(markers: ScreenMarker[]): MarkerClusters {
  const order = [...markers].sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id));
  const placed: { id: string; x: number; y: number; r: number }[] = [];
  const heads = new Map<string, string[]>();
  const merged = new Set<string>();
  for (const m of order) {
    const r = m.size / 2;
    const head = placed.find((p) => Math.hypot(p.x - m.x, p.y - m.y) < p.r + r + MARKER_GAP);
    if (head) {
      merged.add(m.id);
      heads.set(head.id, [...(heads.get(head.id) ?? []), m.id]);
    } else {
      placed.push({ id: m.id, x: m.x, y: m.y, r });
    }
  }
  return { heads, merged };
}

/**
 * Where a cluster sits: the mean of its members' positions, with longitudes
 * taken relative to the first, so a cluster across the 180° line stays there
 * instead of averaging to the other side of the world.
 */
export function meanPosition(points: readonly LatLng[]): LatLng {
  const lng0 = points[0].lng;
  const wrap = (lng: number) => ((((lng + 180) % 360) + 360) % 360) - 180;
  const lat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const offset = points.reduce((s, p) => s + wrap(p.lng - lng0), 0) / points.length;
  return { lat, lng: wrap(lng0 + offset) };
}

/**
 * Screen offsets that spread each cluster's members in a ring around its
 * head, for when the camera is as close as it goes and zooming cannot pull
 * them apart (disasters placed at the same spot). The ring grows so the
 * markers on it do not touch. Returns [dx, dy] px for each member.
 */
export function fanOffsets(clusters: MarkerClusters, markers: readonly ScreenMarker[]): Map<string, [number, number]> {
  const byId = new Map(markers.map((m) => [m.id, m]));
  const out = new Map<string, [number, number]>();
  for (const [headId, members] of clusters.heads) {
    const head = byId.get(headId);
    if (!head) continue;
    const biggest = Math.max(...members.map((id) => byId.get(id)?.size ?? 0));
    const ring = Math.max(head.size / 2 + biggest / 2 + MARKER_GAP + 2, (members.length * (biggest + MARKER_GAP)) / (2 * Math.PI));
    members.forEach((id, i) => {
      const m = byId.get(id);
      if (!m) return;
      const angle = -Math.PI / 2 + (2 * Math.PI * i) / members.length;
      // From the member's own spot to its place on the ring around the head.
      out.set(id, [head.x + Math.cos(angle) * ring - m.x, head.y + Math.sin(angle) * ring - m.y]);
    });
  }
  return out;
}

/** A cluster tapped at or below this altitude opens its head instead of zooming further. */
export const CLUSTER_MIN_ALTITUDE = FOCUS_MIN_ALTITUDE;
/** Each tap on a cluster brings the camera this much closer. */
export const CLUSTER_ZOOM = 0.45;

/**
 * Where a place's label goes: the preferred side of its dot, unless the
 * label would run past the visible edge there and fits on the other side;
 * when it fits on neither, the side with more room. `room` is the width
 * available on the chosen side, so a long label can be shortened to fit.
 * `x` is the dot's screen position; `bounds` the visible area; `gap` the
 * space between dot and label.
 */
export function placeLabelFit(
  preferred: "left" | "right",
  x: number,
  labelPx: number,
  bounds: { left: number; right: number },
  gap = 13,
  margin = 8,
): { side: "left" | "right"; room: number } {
  const right = bounds.right - margin - (x + gap);
  const left = x - gap - (bounds.left + margin);
  const fits = { right: labelPx <= right, left: labelPx <= left };
  const other = preferred === "right" ? "left" : "right";
  const side = fits[preferred] || (!fits[other] && (preferred === "right" ? right >= left : left >= right)) ? preferred : other;
  return { side, room: Math.max(0, side === "right" ? right : left) };
}

// --- Camera ----------------------------------------------------------------

export interface Bounds {
  minLat: number;
  maxLat: number;
  /** West edge; may be greater than maxLng when the box crosses the antimeridian. */
  minLng: number;
  maxLng: number;
}

/** Smallest longitude range covering every value, crossing the antimeridian when that is shorter. */
export function lngRange(lngs: number[]): { min: number; max: number; span: number } {
  const sorted = [...new Set(lngs.map((l) => ((((l + 180) % 360) + 360) % 360) - 180))].sort((a, b) => a - b);
  if (sorted.length <= 1) return { min: sorted[0] ?? 0, max: sorted[0] ?? 0, span: 0 };
  // The widest gap between neighbours is the part of the circle left out.
  let gap = 360 - (sorted[sorted.length - 1] - sorted[0]);
  let min = sorted[0];
  let max = sorted[sorted.length - 1];
  for (let i = 1; i < sorted.length; i++) {
    const g = sorted[i] - sorted[i - 1];
    if (g > gap) {
      gap = g;
      min = sorted[i];
      max = sorted[i - 1];
    }
  }
  return { min, max, span: 360 - gap };
}

/** Box around a disaster's areas, halo, places and position. */
export function disasterBounds(d: Disaster): Bounds {
  const halo = haloRadiusKm(d);
  const haloPts = halo ? [0, 90, 180, 270].map((b) => toLatLng(destination(d, b, halo))) : [];
  const pts: LatLng[] = [{ lat: d.lat, lng: d.lng }, ...d.places, ...areaPoints(d).map(toLatLng), ...haloPts];
  const lats = pts.map((p) => p.lat);
  const { min, max } = lngRange(pts.map((p) => p.lng));
  return { minLat: Math.min(...lats), maxLat: Math.max(...lats), minLng: min, maxLng: max };
}

export interface Focus extends LatLng {
  /** Camera altitude in globe radii, before the screen-shape scale. */
  altitude: number;
}

/**
 * Where the camera should look to frame a disaster: the middle of its box,
 * high enough that the box fills about half the view. A disaster located
 * only to its country, or with no mapped area, is seen from higher up, so
 * the view shows where it is rather than an empty, close-up patch.
 */
export function disasterFocus(d: Disaster): Focus {
  const b = disasterBounds(d);
  const lat = (b.minLat + b.maxLat) / 2;
  let lngSpan = b.maxLng - b.minLng;
  if (lngSpan < 0) lngSpan += 360;
  let lng = b.minLng + lngSpan / 2;
  if (lng > 180) lng -= 360;
  const span = Math.max(b.maxLat - b.minLat, lngSpan * Math.cos(lat * RAD));
  // The view is about 53 degrees of arc tall per unit of altitude.
  const floor = d.precision === "country" ? COUNTRY_FOCUS_ALTITUDE : d.areas.length ? FOCUS_MIN_ALTITUDE : UNMAPPED_FOCUS_ALTITUDE;
  const altitude = Math.min(FOCUS_MAX_ALTITUDE, Math.max(floor, span / 26));
  return { lat, lng, altitude };
}

/**
 * Wavelength in km of centred patterns (quake pulses, volcanic glow, tsunami
 * rings): a few waves across the disaster, but never so tight that they blur
 * at the closest camera the fly-to uses (about 1.5 km per pixel).
 */
export function centredWaveKm(extentKm: number): number {
  return Math.max(extentKm / 4, 40);
}

/** The highlight each disaster's effects ease towards: 1 selected, 0 normal, -1 dimmed. */
export function highlightTarget(id: string, selectedId: string | null, hoveredId: string | null): number {
  if (selectedId) return id === selectedId ? 1 : id === hoveredId ? 0 : -1;
  return id === hoveredId ? 0.6 : 0;
}
