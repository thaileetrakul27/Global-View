// Where help is needed and where to send it, from three official sources
// that cover every country without the site choosing anyone:
//   IFRC GO      the Red Cross and Red Crescent movement's operations
//                platform: each country's own national society and the
//                active appeals (DREF and Emergency Appeals) with funding;
//   OCHA FTS     the UN's Financial Tracking Service: humanitarian
//                response plans with what they need and what they have.
// Every source is optional: when one fails the previous run's data for
// that source is kept.
import type { CountryResolver } from "./alerts";
import type { FetchDeps } from "./googlenews";
import { USER_AGENT } from "./googlenews";

export const GO_API = "https://goadmin.ifrc.org/api/v2";
export const FTS_API = "https://api.hpc.tools/v1/public";

/** A country's own Red Cross or Red Crescent society. */
export interface Society {
  name: string;
  /** The society's own website, when IFRC lists one. */
  url: string | null;
  /** Its page in IFRC's directory. */
  directory: string | null;
}

/** An active IFRC appeal. Amounts are Swiss francs, as IFRC reports them. */
export interface Appeal {
  /** Appeal code, e.g. MDRZW030. */
  code: string;
  country: string;
  name: string;
  /** "DREF" (the quick-release fund) or "Emergency Appeal". */
  kind: string;
  /** IFRC's disaster category, e.g. "Flood". */
  disaster: string;
  requested: number;
  funded: number;
  /** People the operation aims to reach, when stated. */
  people: number | null;
  start: string;
  end: string;
  /** The operation's page on IFRC GO, or the country's page when it has none. */
  url: string;
}

/** A UN-coordinated humanitarian response plan. Amounts are US dollars. */
export interface Plan {
  id: number;
  name: string;
  /** Countries the plan covers. */
  countries: string[];
  required: number;
  /** Funding reported to FTS so far; null when the funding call failed. */
  funded: number | null;
  end: string;
  url: string;
}

export interface HelpFile {
  updated: string;
  /** When each source was last fetched successfully. */
  sources: { societies: string | null; appeals: string | null; plans: string | null };
  societies: Record<string, Society>;
  appeals: Appeal[];
  plans: Plan[];
}

async function getJson<T>(url: string, deps: FetchDeps): Promise<T> {
  const res = await deps.fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: AbortSignal.timeout(45_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return (await res.json()) as T;
}

/** One attempt, then a second after `delayMs`; null when both fail. */
async function attempt<T>(label: string, fn: () => Promise<T>, deps: FetchDeps, delayMs: number): Promise<T | null> {
  for (let i = 1; i <= 2; i++) {
    try {
      return await fn();
    } catch (err) {
      deps.log(`${label} attempt ${i}: ${err instanceof Error ? err.message : String(err)}`);
      if (i === 1) await deps.sleep(delayMs);
    }
  }
  deps.log(`${label}: both attempts failed; previous data kept`);
  return null;
}

interface GoCountry {
  iso: string | null;
  record_type: number;
  society_name: string;
  society_url: string;
  url_ifrc: string;
}

interface GoAppeal {
  code: string;
  name: string;
  atype_display: string;
  dtype: { name: string } | null;
  amount_requested: number | null;
  amount_funded: number | null;
  num_beneficiaries: number | null;
  start_date: string;
  end_date: string;
  event: number | null;
  country: { iso: string | null; id: number };
}

/** Maps IFRC GO's country list onto national societies, keyed by country code. */
export function toSocieties(rows: GoCountry[]): Record<string, Society> {
  const out: Record<string, Society> = {};
  for (const r of rows) {
    if (r.record_type !== 1 || !r.iso || !r.society_name) continue;
    out[r.iso.toUpperCase()] = {
      name: r.society_name,
      url: r.society_url?.trim() || null,
      directory: r.url_ifrc?.trim() || null,
    };
  }
  return out;
}

/** Keeps the active appeals that name a country and have not ended. */
export function toAppeals(rows: GoAppeal[], now: string): Appeal[] {
  const nowMs = Date.parse(now);
  const out: Appeal[] = [];
  for (const r of rows) {
    const code = r.country?.iso?.toUpperCase();
    const end = Date.parse(r.end_date);
    if (!code || !r.code || Number.isNaN(end) || end < nowMs) continue;
    out.push({
      code: r.code,
      country: code,
      name: r.name.trim(),
      kind: r.atype_display,
      disaster: r.dtype?.name ?? "Other",
      requested: r.amount_requested ?? 0,
      funded: r.amount_funded ?? 0,
      people: r.num_beneficiaries || null,
      start: new Date(r.start_date).toISOString(),
      end: new Date(end).toISOString(),
      url: r.event ? `https://go.ifrc.org/emergencies/${r.event}` : `https://go.ifrc.org/countries/${r.country.id}`,
    });
  }
  // Largest first, so the appeal that matters most leads a country's list.
  return out.sort((a, b) => b.requested - a.requested || a.start.localeCompare(b.start));
}

export async function fetchSocieties(deps: FetchDeps, delayMs = 5_000): Promise<Record<string, Society> | null> {
  return attempt("IFRC societies", async () => toSocieties((await getJson<{ results: GoCountry[] }>(`${GO_API}/country/?limit=500`, deps)).results), deps, delayMs);
}

export async function fetchAppeals(now: string, deps: FetchDeps, delayMs = 5_000): Promise<Appeal[] | null> {
  return attempt("IFRC appeals", async () => toAppeals((await getJson<{ results: GoAppeal[] }>(`${GO_API}/appeal/?limit=1000&status=0`, deps)).results, now), deps, delayMs);
}

interface FtsPlan {
  id: number;
  planVersion: { name: string; endDate: string };
  locations: { iso3: string | null; adminLevel: number }[];
  revisedRequirements: number | null;
  origRequirements: number | null;
}

interface FtsFlow {
  data?: { report1?: { fundingTotals?: { total?: number } } };
}

/** The plans still running that cover a country the globe can show. */
export function toPlans(rows: FtsPlan[], resolve: CountryResolver, now: string): Omit<Plan, "funded">[] {
  const nowMs = Date.parse(now);
  const out: Omit<Plan, "funded">[] = [];
  for (const r of rows) {
    const end = Date.parse(r.planVersion?.endDate ?? "");
    if (Number.isNaN(end) || end < nowMs) continue;
    const countries: string[] = [];
    for (const l of r.locations ?? []) {
      const code = l.adminLevel === 0 && l.iso3 ? resolve.byIso3(l.iso3) : undefined;
      if (code && !countries.includes(code)) countries.push(code);
    }
    const required = r.revisedRequirements ?? r.origRequirements ?? 0;
    if (!countries.length || !required) continue;
    const year = new Date(end).getUTCFullYear();
    out.push({ id: r.id, name: r.planVersion.name.replace(/\s+/g, " ").trim(), countries, required, end: new Date(end).toISOString(), url: `https://fts.unocha.org/plans/${r.id}/summary/${year}` });
  }
  return out.sort((a, b) => b.required - a.required);
}

/**
 * Fetches this year's and last year's plans, then one funding total per
 * plan. A plan whose funding call fails is kept with funded = null.
 */
export async function fetchPlans(resolve: CountryResolver, now: string, deps: FetchDeps, delayMs = 5_000, pauseMs = 300): Promise<Plan[] | null> {
  const year = new Date(now).getUTCFullYear();
  const listed = await attempt(
    "OCHA plans",
    async () => {
      const rows: FtsPlan[] = [];
      for (const y of [year - 1, year]) rows.push(...(await getJson<{ data: FtsPlan[] }>(`${FTS_API}/plan/year/${y}`, deps)).data);
      const seen = new Set<number>();
      return toPlans(rows.filter((r) => !seen.has(r.id) && seen.add(r.id)), resolve, now);
    },
    deps,
    delayMs,
  );
  if (!listed) return null;
  const plans: Plan[] = [];
  for (const p of listed) {
    let funded: number | null = null;
    try {
      const flow = await getJson<FtsFlow>(`${FTS_API}/fts/flow?planId=${p.id}&groupby=plan`, deps);
      funded = flow.data?.report1?.fundingTotals?.total ?? 0;
    } catch (err) {
      deps.log(`OCHA funding for plan ${p.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    plans.push({ ...p, funded });
    await deps.sleep(pauseMs);
  }
  return plans;
}

/** Merges fresh results over the previous file, source by source. */
export function buildHelp(
  previous: HelpFile | null,
  fresh: { societies: Record<string, Society> | null; appeals: Appeal[] | null; plans: Plan[] | null },
  now: string,
): HelpFile {
  const prev = previous?.sources ?? { societies: null, appeals: null, plans: null };
  return {
    updated: now,
    sources: {
      societies: fresh.societies ? now : prev.societies,
      appeals: fresh.appeals ? now : prev.appeals,
      plans: fresh.plans ? now : prev.plans,
    },
    societies: fresh.societies ?? previous?.societies ?? {},
    appeals: fresh.appeals ?? previous?.appeals ?? [],
    plans: fresh.plans ?? previous?.plans ?? [],
  };
}
