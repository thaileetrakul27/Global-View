// Shape of the slimmed Natural Earth features served from /geo/countries.geojson.
export interface CountryProperties {
  /** ISO 3166-1 alpha-2 code where one exists, otherwise a Natural Earth code. */
  code: string;
  /** Short display name, e.g. "Thailand". */
  name: string;
  /** Long administrative name, e.g. "Kingdom of Thailand" style from Natural Earth. */
  admin: string;
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
