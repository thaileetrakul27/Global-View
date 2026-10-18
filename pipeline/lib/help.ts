// Where help is needed and where to send it, from three official sources
// that cover every country without the site choosing anyone:
//   IFRC GO      the Red Cross and Red Crescent movement's operations
//                platform: each country's own national society and the
//                active appeals (DREF and Emergency Appeals) with funding;
//                it also describes each emergency behind an appeal;
//   OCHA FTS     the UN's Financial Tracking Service: humanitarian
//                response plans with what they need and what they have;
//   donation     the Red Cross Red Crescent donation platform IFRC hosts
//                for national societies, and UN Crisis Relief's per-crisis
//                pages from its sitemap. Both are official, and found by
//                probing a fixed URL pattern, never chosen by hand.
// Every source is optional: when one fails the previous run's data for
// that source is kept.
import type { CountryResolver } from "./alerts";
import type { FetchDeps } from "./googlenews";
import { USER_AGENT } from "./googlenews";

export const GO_API = "https://goadmin.ifrc.org/api/v2";
export const FTS_API = "https://api.hpc.tools/v1/public";
export const RCRC_DONATE = "https://donate.redcrossredcrescent.org";
export const UNCR_SITEMAP = "https://crisisrelief.un.org/sitemap.xml";

/** A country's own Red Cross or Red Crescent society. */
export interface Society {
  name: string;
  /** The society's own website, when IFRC lists one. */
  url: string | null;
  /** Its page in IFRC's directory. */
  directory: string | null;
  /** Its page on the Red Cross Red Crescent donation platform, when it is on it. */
  donate: string | null;
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
  /** The IFRC GO emergency this appeal belongs to, described in `events`. */
  event: number | null;
}

/** An IFRC GO emergency: what is happening, in IFRC's words. */
export interface Emergency {
  id: number;
  name: string;
  /** First part of IFRC's summary, as plain text. */
  summary: string | null;
  /** IFRC's severity: Red, Orange or Yellow. */
  severity: string | null;
  /** Headline numbers IFRC shows, with their source. */
  figures: { number: string; label: string; source: string | null }[];
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
  sources: { societies: string | null; appeals: string | null; plans: string | null; events: string | null; uncr: string | null };
  societies: Record<string, Society>;
  appeals: Appeal[];
  plans: Plan[];
  /** IFRC GO emergencies behind the appeals, by id. */
  events: Record<string, Emergency>;
  /** UN Crisis Relief donation pages, by country code. */
  uncr: Record<string, string>;
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
export function toSocieties(rows: GoCountry[], donate: Record<string, string | null> = {}): Record<string, Society> {
  const out: Record<string, Society> = {};
  for (const r of rows) {
    if (r.record_type !== 1 || !r.iso || !r.society_name) continue;
    const code = r.iso.toUpperCase();
    out[code] = {
      name: r.society_name,
      url: r.society_url?.trim() || null,
      directory: r.url_ifrc?.trim() || null,
      donate: donate[code] ?? null,
    };
  }
  return out;
}

/**
 * Asks the donation platform whether a society is on it: its country page
 * redirects into the country's own path when it is, and to the front page
 * when it is not. A code whose request fails keeps its previous answer.
 */
export async function probeDonate(codes: string[], previous: Record<string, string | null>, deps: FetchDeps, concurrency = 8): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  const queue = [...codes];
  const worker = async () => {
    for (let code = queue.shift(); code; code = queue.shift()) {
      const cc = code.toLowerCase();
      const url = `${RCRC_DONATE}/${cc}/default/`;
      try {
        const res = await deps.fetch(url, { headers: { "User-Agent": USER_AGENT }, redirect: "manual", signal: AbortSignal.timeout(20_000) });
        const target = res.headers.get("location") ?? "";
        out[code] = res.status >= 300 && res.status < 400 && target.includes(`/${cc}/`) ? url : null;
      } catch (err) {
        deps.log(`Donation platform ${code}: ${err instanceof Error ? err.message : String(err)}`);
        out[code] = previous[code] ?? null;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
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
      event: r.event ?? null,
    });
  }
  // Largest first, so the appeal that matters most leads a country's list.
  return out.sort((a, b) => b.requested - a.requested || a.start.localeCompare(b.start));
}

export async function fetchSocieties(previous: Record<string, Society>, deps: FetchDeps, delayMs = 5_000): Promise<Record<string, Society> | null> {
  const rows = await attempt("IFRC societies", () => getJson<{ results: GoCountry[] }>(`${GO_API}/country/?limit=500`, deps), deps, delayMs);
  if (!rows) return null;
  const codes = rows.results.filter((r) => r.record_type === 1 && r.iso && r.society_name).map((r) => r.iso!.toUpperCase());
  const known = Object.fromEntries(Object.entries(previous).map(([code, s]) => [code, s.donate]));
  return toSocieties(rows.results, await probeDonate(codes, known, deps));
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "\u2019", lsquo: "\u2018", rdquo: "\u201d", ldquo: "\u201c", ndash: "\u2013", mdash: "\u2014", hellip: "\u2026" };

/** HTML to plain text: tags out, entities decoded, whitespace collapsed. */
export function stripHtml(html: string): string {
  return html
    .replace(/<\/(p|div|li|br|h\d)>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

/** The opening of a text, cut at a sentence end before `max` characters. */
export function opening(text: string, max = 480): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return end > max / 3 ? cut.slice(0, end + 1) : `${cut.trimEnd()}\u2026`;
}

interface GoEvent {
  id: number;
  name: string;
  summary: string | null;
  ifrc_severity_level_display: string | null;
  key_figures: { number: string; deck: string; source: string | null }[];
}

/** Drops a leading numbered heading such as "1. Situation Overview " pasted in from a report. */
export function dropHeading(text: string): string {
  return text.replace(/^\d+\.\s+(?:[A-Z][\w-]*\s+){1,4}(?=[A-Z])/, "");
}

export function toEmergency(e: GoEvent): Emergency {
  const summary = e.summary ? opening(dropHeading(stripHtml(e.summary))) : "";
  return {
    id: e.id,
    name: e.name.trim(),
    summary: summary || null,
    severity: e.ifrc_severity_level_display || null,
    figures: (e.key_figures ?? []).slice(0, 3).map((f) => ({ number: f.number, label: f.deck, source: f.source || null })),
  };
}

/** One call per emergency behind the appeals; a failed one keeps its previous entry. */
export async function fetchEmergencies(appeals: Appeal[], previous: Record<string, Emergency>, deps: FetchDeps, pauseMs = 200): Promise<Record<string, Emergency>> {
  const out: Record<string, Emergency> = {};
  const ids = [...new Set(appeals.map((a) => a.event).filter((id): id is number => id !== null))];
  for (const id of ids) {
    try {
      out[id] = toEmergency(await getJson<GoEvent>(`${GO_API}/event/${id}/`, deps));
    } catch (err) {
      deps.log(`IFRC emergency ${id}: ${err instanceof Error ? err.message : String(err)}`);
      if (previous[id]) out[id] = previous[id];
    }
    await deps.sleep(pauseMs);
  }
  return out;
}

/** Names UN Crisis Relief uses in its page slugs that the map does not. */
const UNCR_ALIASES: Record<string, string> = { opt: "PS", car: "CF", drc: "CD" };

/**
 * UN Crisis Relief's donation pages from its sitemap: a page whose slug is
 * "donate-<country>-crisis" or "donate-<country>" belongs to that country.
 * Regional and campaign pages match no country and are left out.
 */
export function toUncr(locs: string[], resolve: CountryResolver): Record<string, string> {
  const out: Record<string, string> = {};
  for (const loc of locs) {
    const m = /^https:\/\/crisisrelief\.un\.org\/donate-([a-z0-9-]+?)(?:-crisis)?$/.exec(loc.trim());
    if (!m) continue;
    const words = m[1].replace(/-/g, " ");
    const code = UNCR_ALIASES[words] ?? resolve.byName(words);
    if (code && !(code in out)) out[code] = loc.trim();
  }
  return out;
}

export async function fetchUncr(resolve: CountryResolver, deps: FetchDeps, delayMs = 5_000): Promise<Record<string, string> | null> {
  return attempt(
    "UN Crisis Relief",
    async () => {
      const res = await deps.fetch(UNCR_SITEMAP, { headers: { "User-Agent": USER_AGENT, Accept: "application/xml, text/xml" }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const locs = [...(await res.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
      if (!locs.length) throw new Error("sitemap has no pages");
      return toUncr(locs, resolve);
    },
    deps,
    delayMs,
  );
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
  fresh: {
    societies: Record<string, Society> | null;
    appeals: Appeal[] | null;
    plans: Plan[] | null;
    events: Record<string, Emergency> | null;
    uncr: Record<string, string> | null;
  },
  now: string,
): HelpFile {
  const prev = { societies: null, appeals: null, plans: null, events: null, uncr: null, ...previous?.sources };
  return {
    updated: now,
    sources: {
      societies: fresh.societies ? now : prev.societies,
      appeals: fresh.appeals ? now : prev.appeals,
      plans: fresh.plans ? now : prev.plans,
      events: fresh.events ? now : prev.events,
      uncr: fresh.uncr ? now : prev.uncr,
    },
    societies: fresh.societies ?? previous?.societies ?? {},
    appeals: fresh.appeals ?? previous?.appeals ?? [],
    plans: fresh.plans ?? previous?.plans ?? [],
    events: fresh.events ?? previous?.events ?? {},
    uncr: fresh.uncr ?? previous?.uncr ?? {},
  };
}

/** Fetches every help source in turn, keeping the previous file's data where one fails. */
export async function refreshHelp(previous: HelpFile | null, resolve: CountryResolver, now: string, deps: FetchDeps): Promise<HelpFile> {
  const societies = await fetchSocieties(previous?.societies ?? {}, deps);
  const appeals = await fetchAppeals(now, deps);
  const events = appeals ? await fetchEmergencies(appeals, previous?.events ?? {}, deps) : null;
  const plans = await fetchPlans(resolve, now, deps);
  const uncr = await fetchUncr(resolve, deps);
  return buildHelp(previous, { societies, appeals, plans, events, uncr }, now);
}
