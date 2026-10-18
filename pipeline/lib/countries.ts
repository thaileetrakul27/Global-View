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

export interface CountryConfig {
  /** ISO 3166-1 alpha-2 code used by the website. */
  code: string;
  name: string;
  enabled: boolean;
  edition: Edition;
}

/** Loads and normalises the hand-written country list. */
export function loadCountryConfig(path = "data/countries.json"): CountryConfig[] {
  const parsed = JSON.parse(fs.readFileSync(path, "utf8")) as { countries: CountryConfig[] };
  return parsed.countries.map((c) => ({ ...c, code: c.code.toUpperCase() }));
}

/**
 * The countries a run should cover: every enabled one, or exactly the codes
 * asked for with --countries (even if disabled, so a single country can be
 * tested before switching it on). Unknown codes are an error.
 */
export function selectCountries(all: CountryConfig[], codes?: string[]): CountryConfig[] {
  if (!codes) return all.filter((c) => c.enabled);
  return codes.map((code) => {
    const found = all.find((c) => c.code === code);
    if (!found) throw new Error(`Country ${code} is not in data/countries.json`);
    return found;
  });
}

/** Country codes present in the globe's shapes, so every entry can be clicked. */
export function loadGlobeCodes(path = "public/geo/countries.geojson"): Set<string> {
  const geo = JSON.parse(fs.readFileSync(path, "utf8")) as {
    features: { properties: { code: string } }[];
  };
  return new Set(geo.features.map((f) => f.properties.code));
}
