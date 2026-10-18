// Long-term needs per country from the World Bank's open data API, which
// republishes the UN agencies' own figures: WHO/UNICEF on water and
// sanitation, FAO on hunger, UNESCO on schooling and literacy, the UN
// inter-agency group on child mortality, and the Bank's own poverty and
// electricity series. One request per indicator; a failed one keeps the
// previous run's figures for that indicator.
import type { CountryResolver } from "./alerts";
import type { FetchDeps } from "./googlenews";
import { USER_AGENT } from "./googlenews";

export const WORLD_BANK_API = "https://api.worldbank.org/v2";

export interface Indicator {
  key: string;
  /** World Bank indicator id. */
  id: string;
  /** "gap": the figure is coverage, so the need is 100 minus it; "rate": the figure is the need itself. */
  kind: "gap" | "rate";
  /** The level at which the need counts as severe (severity 1). */
  serious: number;
  source: string;
}

export const INDICATORS: Indicator[] = [
  { key: "water", id: "SH.H2O.BASW.ZS", kind: "gap", serious: 25, source: "WHO/UNICEF via World Bank" },
  { key: "sanitation", id: "SH.STA.BASS.ZS", kind: "gap", serious: 50, source: "WHO/UNICEF via World Bank" },
  { key: "electricity", id: "EG.ELC.ACCS.ZS", kind: "gap", serious: 50, source: "World Bank" },
  { key: "hunger", id: "SN.ITK.DEFC.ZS", kind: "rate", serious: 20, source: "FAO via World Bank" },
  { key: "poverty", id: "SI.POV.DDAY", kind: "rate", serious: 25, source: "World Bank" },
  { key: "school", id: "SE.PRM.UNER.ZS", kind: "rate", serious: 20, source: "UNESCO via World Bank" },
  { key: "literacy", id: "SE.ADT.LITR.ZS", kind: "gap", serious: 30, source: "UNESCO via World Bank" },
  { key: "mortality", id: "SH.DYN.MORT", kind: "rate", serious: 60, source: "UN IGME via World Bank" },
];

/** Figures older than this many years are too stale to show. */
export const MAX_AGE_YEARS = 15;
/** Needs below this severity are not worth listing. */
export const MIN_SEVERITY = 0.3;
/** Needs kept per country, most severe first. */
export const PER_COUNTRY = 4;

export interface CountryNeed {
  key: string;
  /** The need as a figure: a percentage, or deaths per 1,000 for mortality. */
  value: number;
  year: number;
  /** value divided by the indicator's severe level, capped at 2. */
  severity: number;
}

export interface NeedsFile {
  updated: string;
  /** When each indicator was last fetched successfully. */
  fetched: Record<string, string | null>;
  countries: Record<string, CountryNeed[]>;
}

interface Row {
  countryiso3code: string;
  date: string;
  value: number | null;
}

/** One indicator's latest figure per country, as a need. Aggregates and stale or empty rows are dropped. */
export function toNeeds(rows: Row[], ind: Indicator, resolve: CountryResolver, now: string): Record<string, CountryNeed> {
  const minYear = new Date(now).getUTCFullYear() - MAX_AGE_YEARS;
  const out: Record<string, CountryNeed> = {};
  for (const r of rows) {
    const code = r.countryiso3code ? resolve.byIso3(r.countryiso3code) : undefined;
    const year = Number(r.date);
    if (!code || r.value === null || !Number.isFinite(year) || year < minYear) continue;
    const value = Math.round((ind.kind === "gap" ? 100 - r.value : r.value) * 10) / 10;
    const severity = Math.round(Math.min(value / ind.serious, 2) * 100) / 100;
    if (value <= 0 || severity < MIN_SEVERITY) continue;
    if (!out[code] || out[code].year < year) out[code] = { key: ind.key, value, year, severity };
  }
  return out;
}

export async function fetchIndicator(ind: Indicator, deps: FetchDeps, delayMs = 5_000): Promise<Row[] | null> {
  const url = `${WORLD_BANK_API}/country/all/indicator/${ind.id}?format=json&mrnev=1&per_page=500`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await deps.fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as unknown;
      if (!Array.isArray(body) || !Array.isArray(body[1])) throw new Error("unexpected body");
      return body[1] as Row[];
    } catch (err) {
      deps.log(`World Bank ${ind.key} attempt ${attempt}: ${err instanceof Error ? err.message : String(err)}`);
      if (attempt === 1) await deps.sleep(delayMs);
    }
  }
  deps.log(`World Bank ${ind.key}: both attempts failed; previous figures kept`);
  return null;
}

/** Merges fresh figures over the previous file, indicator by indicator, and ranks each country's needs. */
export function buildNeeds(previous: NeedsFile | null, fresh: Record<string, Record<string, CountryNeed> | null>, now: string): NeedsFile {
  const byCountry: Record<string, CountryNeed[]> = {};
  const fetched: Record<string, string | null> = {};
  for (const ind of INDICATORS) {
    const f = fresh[ind.key];
    fetched[ind.key] = f ? now : (previous?.fetched[ind.key] ?? null);
    const entries: [string, CountryNeed][] = f
      ? Object.entries(f)
      : Object.entries(previous?.countries ?? {}).flatMap(([code, needs]) => needs.filter((n) => n.key === ind.key).map((n): [string, CountryNeed] => [code, n]));
    for (const [code, need] of entries) (byCountry[code] ??= []).push(need);
  }
  const countries: Record<string, CountryNeed[]> = {};
  for (const [code, needs] of Object.entries(byCountry).sort()) {
    const kept = needs.filter((n) => n.severity >= MIN_SEVERITY).sort((a, b) => b.severity - a.severity || a.key.localeCompare(b.key)).slice(0, PER_COUNTRY);
    if (kept.length) countries[code] = kept;
  }
  return { updated: now, fetched, countries };
}

export async function refreshNeeds(previous: NeedsFile | null, resolve: CountryResolver, now: string, deps: FetchDeps, pauseMs = 300): Promise<NeedsFile> {
  const fresh: Record<string, Record<string, CountryNeed> | null> = {};
  for (const ind of INDICATORS) {
    const rows = await fetchIndicator(ind, deps);
    fresh[ind.key] = rows ? toNeeds(rows, ind, resolve, now) : null;
    await deps.sleep(pauseMs);
  }
  return buildNeeds(previous, fresh, now);
}
