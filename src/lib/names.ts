// Short display names where the map data's label is abbreviated or formal.
const SHORT: Record<string, string> = {
  US: "United States",
  CD: "DR Congo",
  CG: "Congo-Brazzaville",
  CF: "Central African Republic",
  SS: "South Sudan",
  GQ: "Equatorial Guinea",
  EH: "Western Sahara",
  BA: "Bosnia and Herzegovina",
  DO: "Dominican Republic",
  SB: "Solomon Islands",
  FK: "Falkland Islands",
  CYN: "Northern Cyprus",
  SZ: "Eswatini",
  TF: "French Southern Territories",
  AE: "UAE",
};

/** The name to show for a country, given the map's own label. */
export function displayName(code: string, mapName: string | undefined): string {
  return SHORT[code] ?? mapName ?? code;
}

/** "Thailand's", but "Philippines'" for a name that ends in s. */
export function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}
