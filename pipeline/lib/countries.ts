// Reads data/countries.json and decides which countries a run covers.
import fs from "node:fs";

export interface Axis {
  summary: string;
  left: string;
  right: string;
}

export interface CountryConfig {
  /** ISO 3166-1 alpha-2 code used by the website. */
  code: string;
  /** GDELT's (FIPS) code for the same country. */
  gdelt: string;
  name: string;
  enabled: boolean;
  axis: Axis;
}

interface RawCountry {
  code: string;
  gdelt?: string;
  name: string;
  enabled: boolean;
  axis: Axis;
}

/** Loads and normalises the hand-written country list. */
export function loadCountryConfig(path = "data/countries.json"): CountryConfig[] {
  const parsed = JSON.parse(fs.readFileSync(path, "utf8")) as { countries: RawCountry[] };
  return parsed.countries.map((c) => ({
    code: c.code.toUpperCase(),
    gdelt: (c.gdelt ?? c.code).toUpperCase(),
    name: c.name,
    enabled: c.enabled,
    axis: c.axis,
  }));
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

/** Parses GDELT's LOOKUP-COUNTRIES.TXT into a code -> name map. */
export function loadGdeltCodes(path = "pipeline/data/gdelt-countries.txt"): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
    const [code, name] = line.split("\t");
    if (code && name) map.set(code.trim().toUpperCase(), name.trim());
  }
  return map;
}

/** Codes GDELT does not know, so a typo is caught before any request. */
export function unknownGdeltCodes(countries: CountryConfig[], known: Map<string, string>): CountryConfig[] {
  return countries.filter((c) => !known.has(c.gdelt));
}
