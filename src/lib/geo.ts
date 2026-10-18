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
