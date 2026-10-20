// Shape of the slimmed Natural Earth features served from /geo/countries.geojson.
export interface CountryProperties {
  /** ISO 3166-1 alpha-2 code where one exists, otherwise a Natural Earth code. */
  code: string;
  /** Short display name, e.g. "Thailand". */
  name: string;
  /** Longer administrative name from Natural Earth, e.g. "United States of America". */
  admin: string;
  /** ISO 3166-1 alpha-3 code, used for links to humanitarian pages. */
  iso3?: string;
}

export interface CountryFeature {
  type: "Feature";
  properties: CountryProperties;
  geometry: {
    type: "Polygon" | "MultiPolygon";
    coordinates: number[][][] | number[][][][];
  };
}

export interface CountryCollection {
  type: "FeatureCollection";
  features: CountryFeature[];
}

/** Loads the country shapes the globe draws. Runs only in the browser. */
export async function loadCountries(): Promise<CountryFeature[]> {
  const res = await fetch("/geo/countries.geojson");
  if (!res.ok) throw new Error(`Could not load country shapes (${res.status})`);
  const data = (await res.json()) as CountryCollection;
  return data.features;
}

export interface Focus {
  lat: number;
  lng: number;
  /** Camera altitude in globe radii, as react-globe.gl expects. */
  altitude: number;
}

/**
 * Where the camera should look to frame a country. Uses the bounding box of
 * the country's largest polygon so overseas territories (France, the US) and
 * the antimeridian (Russia) do not drag the centre into the ocean.
 */
export function countryFocus(feature: CountryFeature): Focus {
  const polygons: number[][][][] =
    feature.geometry.type === "Polygon"
      ? [feature.geometry.coordinates as number[][][]]
      : (feature.geometry.coordinates as number[][][][]);

  let best = { area: -1, minLat: 0, maxLat: 0, minLng: 0, maxLng: 0 };
  for (const polygon of polygons) {
    const ring = polygon[0]; // outer ring
    let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
    for (const [lng, lat] of ring) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
    }
    const area = (maxLat - minLat) * (maxLng - minLng);
    if (area > best.area) best = { area, minLat, maxLat, minLng, maxLng };
  }

  const lat = (best.minLat + best.maxLat) / 2;
  const lng = (best.minLng + best.maxLng) / 2;
  // Longitude degrees shrink towards the poles; scale them so the span is
  // roughly comparable to latitude degrees.
  const lngSpan = (best.maxLng - best.minLng) * Math.cos((lat * Math.PI) / 180);
  const span = Math.max(best.maxLat - best.minLat, lngSpan);
  const altitude = Math.min(2.2, Math.max(0.7, 0.45 + span / 40));
  return { lat, lng, altitude };
}

/** Lower-case, accent-stripped text for matching. */
function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Finds countries whose name matches the query. Names that start with the
 * query rank first, then words that start with it, then anything containing it.
 */
export function searchCountries(
  countries: CountryFeature[],
  query: string,
  limit = 8,
): CountryFeature[] {
  const q = fold(query);
  if (!q) return [];
  const scored: { rank: number; f: CountryFeature }[] = [];
  for (const f of countries) {
    const name = fold(f.properties.name);
    const admin = fold(f.properties.admin);
    let rank = Infinity;
    if (name.startsWith(q)) rank = 0;
    else if (name.split(/\s+/).some((w) => w.startsWith(q))) rank = 1;
    else if (admin.split(/\s+/).some((w) => w.startsWith(q))) rank = 2;
    else if (name.includes(q) || admin.includes(q)) rank = 3;
    if (rank < Infinity) scored.push({ rank, f });
  }
  scored.sort(
    (a, b) =>
      a.rank - b.rank || a.f.properties.name.localeCompare(b.f.properties.name),
  );
  return scored.slice(0, limit).map((s) => s.f);
}

// --- Detailed shapes near the camera -----------------------------------------

/** One polygon's bounding box in degrees. Natural Earth splits polygons at the antimeridian, so none wraps. */
export interface Box {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

/** The bounding box of each of a country's polygons (outer rings). */
export function featureBoxes(feature: CountryFeature): Box[] {
  const polygons: number[][][][] =
    feature.geometry.type === "Polygon"
      ? [feature.geometry.coordinates as number[][][]]
      : (feature.geometry.coordinates as number[][][][]);
  return polygons.map((polygon) => {
    const box = { minLat: 90, maxLat: -90, minLng: 180, maxLng: -180 };
    for (const [lng, lat] of polygon[0] ?? []) {
      box.minLat = Math.min(box.minLat, lat);
      box.maxLat = Math.max(box.maxLat, lat);
      box.minLng = Math.min(box.minLng, lng);
      box.maxLng = Math.max(box.maxLng, lng);
    }
    return box;
  });
}

/** Great-circle distance in degrees from a point to the nearest point of a box. */
export function degreesToBox(lat: number, lng: number, box: Box): number {
  const nearLat = Math.min(box.maxLat, Math.max(box.minLat, lat));
  // Longitude difference to the box, the short way round; 0 when inside its range.
  const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
  const toMin = wrap(box.minLng - lng);
  const toMax = wrap(box.maxLng - lng);
  const inside = toMin <= 0 && toMax >= 0;
  const dLng = inside ? 0 : Math.min(Math.abs(toMin), Math.abs(toMax));
  const r = Math.PI / 180;
  const h = Math.sin(((nearLat - lat) * r) / 2) ** 2 + Math.cos(lat * r) * Math.cos(nearLat * r) * Math.sin((dLng * r) / 2) ** 2;
  return (2 * Math.asin(Math.min(1, Math.sqrt(h)))) / r;
}

/**
 * Degrees around the centre of the view whose countries get detailed shapes
 * at a camera altitude (globe radii): what the view shows, with a margin.
 */
export function detailReach(altitude: number): number {
  return Math.min(60, 8 + altitude * 45);
}

/** Codes of the countries with any polygon within `reach` degrees of a point. */
export function countriesNear(boxes: Map<string, Box[]>, lat: number, lng: number, reach: number): string[] {
  const out: string[] = [];
  for (const [code, list] of boxes) if (list.some((b) => degreesToBox(lat, lng, b) <= reach)) out.push(code);
  return out;
}

/**
 * Points along the shortest way between two places on the globe (the great
 * circle), about every stepDeg degrees, both ends included. Reading lines
 * follow these so they lie on the globe instead of arching off it.
 */
export function greatCircle(a: { lat: number; lng: number }, b: { lat: number; lng: number }, stepDeg = 3): { lat: number; lng: number }[] {
  const rad = Math.PI / 180;
  const vec = (p: { lat: number; lng: number }) => [Math.cos(p.lat * rad) * Math.cos(p.lng * rad), Math.cos(p.lat * rad) * Math.sin(p.lng * rad), Math.sin(p.lat * rad)];
  const [p, q] = [vec(a), vec(b)];
  const angle = Math.acos(Math.min(1, Math.max(-1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2])));
  // The same place, or exactly opposite (no single shortest way): just the ends.
  if (angle < 1e-9 || Math.PI - angle < 1e-9) return [{ ...a }, { ...b }];
  const steps = Math.max(1, Math.ceil(angle / rad / stepDeg));
  const out: { lat: number; lng: number }[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const k1 = Math.sin((1 - t) * angle) / Math.sin(angle);
    const k2 = Math.sin(t * angle) / Math.sin(angle);
    const [x, y, z] = [0, 1, 2].map((j) => k1 * p[j] + k2 * q[j]);
    out.push({ lat: Math.atan2(z, Math.hypot(x, y)) / rad, lng: Math.atan2(y, x) / rad });
  }
  // Exact ends, so the line starts and stops on the countries' points.
  out[0] = { ...a };
  out[out.length - 1] = { ...b };
  return out;
}
