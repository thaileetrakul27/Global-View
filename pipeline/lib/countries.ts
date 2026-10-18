// Reads data/countries.json and decides which countries a run covers.
import fs from "node:fs";

export interface Edition {
  /** Interface language, e.g. "th" or "en-GB". */
  hl: string;
  /** Country, e.g. "TH". */
  gl: string;
  /** Edition id, e.g. "TH:th". */
  ceid: string;
}

/**
 * local: the country's own Google News edition, what its public reads.
 * world: no edition exists, so a Google News search for coverage about it.
 */
export type CoverageKind = "local" | "world";

export interface CountryConfig {
  /** ISO 3166-1 alpha-2 code used by the website. */
  code: string;
  name: string;
  enabled: boolean;
  kind: CoverageKind;
  /** Present for local coverage. */
  edition?: Edition;
  /** Present for world coverage: the search query. */
  query?: string;
}

interface RawCountry {
  code: string;
  name: string;
  enabled: boolean;
  edition: Edition;
}

/** Loads and normalises the hand-written country list (local editions). */
export function loadCountryConfig(path = "data/countries.json"): CountryConfig[] {
  const parsed = JSON.parse(fs.readFileSync(path, "utf8")) as { countries: RawCountry[] };
  return parsed.countries.map((c) => ({ ...c, code: c.code.toUpperCase(), kind: "local" as const }));
}

export interface GlobeFeature {
  code: string;
  /** Short name, e.g. "Dem. Rep. Congo". */
  name: string;
  /** Full name, e.g. "Democratic Republic of the Congo". */
  admin: string;
  /** ISO 3166-1 alpha-3 code, e.g. "COD", where the map data has one. */
  iso3?: string;
}

export function loadGlobeFeatures(path = "public/geo/countries.geojson"): GlobeFeature[] {
  const geo = JSON.parse(fs.readFileSync(path, "utf8")) as { features: { properties: GlobeFeature }[] };
  return geo.features.map((f) => f.properties);
}

/** Country codes present in the globe's shapes, so every entry can be clicked. */
export function loadGlobeCodes(path = "public/geo/countries.geojson"): Set<string> {
  return new Set(loadGlobeFeatures(path).map((f) => f.code));
}

export interface WorldQueries {
  skip: string[];
  queries: Record<string, string>;
}

export function loadWorldQueries(path = "pipeline/config/world-queries.json"): WorldQueries {
  const parsed = JSON.parse(fs.readFileSync(path, "utf8")) as WorldQueries;
  return { skip: parsed.skip.map((c) => c.toUpperCase()), queries: parsed.queries };
}

/** Full names that read oddly in a search query. */
const NAME_PREFIXES = /^(The |Republic of |United Republic of |Kingdom of )/;

/**
 * Every globe country without a local edition gets world coverage: a search
 * for its name, or a hand-written query where the name is ambiguous.
 */
export function worldCountries(local: CountryConfig[], globe: GlobeFeature[], wq: WorldQueries): CountryConfig[] {
  const covered = new Set(local.map((c) => c.code));
  const skip = new Set(wq.skip);
  return globe
    .filter((f) => !covered.has(f.code) && !skip.has(f.code))
    .map((f) => {
      const name = f.admin.replace(NAME_PREFIXES, "");
      return { code: f.code, name, enabled: true, kind: "world" as const, query: wq.queries[f.code] ?? `"${name}"` };
    })
    .sort((a, b) => a.code.localeCompare(b.code));
}

/**
 * The countries a run should cover: every enabled one, local first, or
 * exactly the codes asked for with --countries (even if disabled, so a
 * single country can be tested before switching it on). Unknown codes are
 * an error.
 */
export function selectCountries(all: CountryConfig[], codes?: string[]): CountryConfig[] {
  if (!codes) return all.filter((c) => c.enabled);
  return codes.map((code) => {
    const found = all.find((c) => c.code === code);
    if (!found) throw new Error(`Country ${code} is not in data/countries.json or on the globe`);
    return found;
  });
}
