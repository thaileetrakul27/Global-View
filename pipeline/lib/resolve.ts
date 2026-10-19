// Maps country names and ISO 3166-1 alpha-3 codes from outside sources
// (GDACS, IFRC, USGS, OCHA, geocoders) onto the globe's country codes.
import type { CountryConfig, GlobeFeature } from "./countries";

/** Maps the country names and ISO3 codes that outside sources use onto the globe's codes. */
export interface CountryResolver {
  byIso3: (iso3: string) => string | undefined;
  byName: (name: string) => string | undefined;
}

/** Names outside sources use that differ from the map's labels. */
const ALIASES: Record<string, string> = {
  turkiye: "TR",
  "czech republic": "CZ",
  "ivory coast": "CI",
  "cote d ivoire": "CI",
  "united states": "US",
  usa: "US",
  "united kingdom": "GB",
  uk: "GB",
  "democratic republic of congo": "CD",
  "dr congo": "CD",
  "republic of congo": "CG",
  congo: "CG",
  "viet nam": "VN",
  "lao pdr": "LA",
  "iran islamic republic of": "IR",
  "syrian arab republic": "SY",
  "russian federation": "RU",
  "korea republic of": "KR",
  "korea democratic people s republic of": "KP",
  "north korea": "KP",
  swaziland: "SZ",
  eswatini: "SZ",
  macedonia: "MK",
  "bolivia plurinational state of": "BO",
  "venezuela bolivarian republic of": "VE",
  "tanzania united republic of": "TZ",
  burma: "MM",
  "occupied palestinian territory": "PS",
  "gaza strip": "PS",
  "west bank": "PS",
};

/** Lower-case letters and digits only, accents and "the" removed, so spellings line up. */
export function normaliseName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\bthe\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildResolver(features: GlobeFeature[], configs: CountryConfig[] = []): CountryResolver {
  const iso3 = new Map<string, string>();
  const names = new Map<string, string>();
  for (const f of features) {
    if (f.iso3) iso3.set(f.iso3.toUpperCase(), f.code);
    names.set(normaliseName(f.name), f.code);
    names.set(normaliseName(f.admin), f.code);
  }
  for (const c of configs) names.set(normaliseName(c.name), c.code);
  for (const [alias, code] of Object.entries(ALIASES)) names.set(alias, code);
  return {
    byIso3: (code) => iso3.get(code.toUpperCase()),
    byName: (name) => names.get(normaliseName(name)),
  };
}
