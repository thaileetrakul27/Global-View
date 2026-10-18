import { describe, expect, it } from "vitest";
import { buildResolver } from "./alerts";
import type { FetchDeps } from "./googlenews";
import { buildHelp, fetchAppeals, fetchPlans, fetchSocieties, toAppeals, toPlans, toSocieties, type HelpFile } from "./help";

const now = "2026-10-18T12:00:00.000Z";
const resolve = buildResolver([
  { code: "SD", name: "Sudan", admin: "Sudan", iso3: "SDN" },
  { code: "TD", name: "Chad", admin: "Chad", iso3: "TCD" },
]);

const goCountries = [
  { iso: "SD", record_type: 1, society_name: "Sudanese Red Crescent", society_url: "http://www.srcs.sd/ ", url_ifrc: "https://www.ifrc.org/national-societies-directory/sudanese-red-crescent" },
  { iso: "TD", record_type: 1, society_name: "Red Cross of Chad", society_url: "", url_ifrc: "" },
  { iso: null, record_type: 3, society_name: "", society_url: "", url_ifrc: "" },
];
const goAppeals = [
  { code: "MDRSD030", name: " Sudan - Complex Emergency ", atype_display: "Emergency Appeal", dtype: { name: "Complex Emergency" }, amount_requested: 1e7, amount_funded: 4e6, num_beneficiaries: 50000, start_date: "2026-01-01T00:00:00Z", end_date: "2027-12-31T00:00:00Z", event: 123, country: { iso: "SD", id: 7 } },
  { code: "MDRTD020", name: "Chad - Floods", atype_display: "DREF", dtype: { name: "Flood" }, amount_requested: 90800, amount_funded: 90800, num_beneficiaries: 0, start_date: "2026-10-12T00:00:00Z", end_date: "2026-11-30T00:00:00Z", event: null, country: { iso: "TD", id: 9 } },
  { code: "MDRKE010", name: "Old", atype_display: "DREF", dtype: null, amount_requested: 1, amount_funded: 0, num_beneficiaries: 0, start_date: "2024-01-01T00:00:00Z", end_date: "2025-04-30T00:00:00Z", event: null, country: { iso: "KE", id: 1 } },
  { code: "MDR00001", name: "General", atype_display: "Emergency Appeal", dtype: null, amount_requested: 1e8, amount_funded: 0, num_beneficiaries: 0, start_date: "2012-01-01T00:00:00Z", end_date: "0001-01-01T00:00:00Z", event: null, country: { iso: null, id: 289 } },
];
const ftsPlans = [
  { id: 1500, planVersion: { name: "Sudan Humanitarian Needs and Response Plan 2026", endDate: "2026-12-31" }, locations: [{ iso3: "SDN", adminLevel: 0 }, { iso3: null, adminLevel: 1 }], revisedRequirements: 2.7e9, origRequirements: 2.5e9 },
  { id: 1501, planVersion: { name: "Sudan Emergency: Regional Refugee Response Plan 2026", endDate: "2026-12-31" }, locations: [{ iso3: "TCD", adminLevel: 0 }, { iso3: "SDN", adminLevel: 0 }, { iso3: "ATL", adminLevel: 0 }], revisedRequirements: null, origRequirements: 1.2e9 },
  { id: 1400, planVersion: { name: "Sudan 2025", endDate: "2025-12-31" }, locations: [{ iso3: "SDN", adminLevel: 0 }], revisedRequirements: 1, origRequirements: 1 },
  { id: 1502, planVersion: { name: "Atlantis 2026", endDate: "2026-12-31" }, locations: [{ iso3: "ATL", adminLevel: 0 }], revisedRequirements: 5, origRequirements: 5 },
];

describe("toSocieties", () => {
  it("keeps real countries, trims urls and leaves missing ones null", () => {
    const out = toSocieties(goCountries);
    expect(Object.keys(out)).toEqual(["SD", "TD"]);
    expect(out.SD).toEqual({ name: "Sudanese Red Crescent", url: "http://www.srcs.sd/", directory: "https://www.ifrc.org/national-societies-directory/sudanese-red-crescent" });
    expect(out.TD).toEqual({ name: "Red Cross of Chad", url: null, directory: null });
  });
});

describe("toAppeals", () => {
  it("keeps running appeals with a country, largest first, linking the operation or the country page", () => {
    const out = toAppeals(goAppeals, now);
    expect(out.map((a) => a.code)).toEqual(["MDRSD030", "MDRTD020"]);
    expect(out[0]).toMatchObject({ country: "SD", name: "Sudan - Complex Emergency", kind: "Emergency Appeal", disaster: "Complex Emergency", requested: 1e7, funded: 4e6, people: 50000, url: "https://go.ifrc.org/emergencies/123" });
    expect(out[1]).toMatchObject({ country: "TD", disaster: "Flood", people: null, url: "https://go.ifrc.org/countries/9", end: "2026-11-30T00:00:00.000Z" });
  });
});

describe("toPlans", () => {
  it("keeps running plans covering countries the globe shows, largest first", () => {
    const out = toPlans(ftsPlans, resolve, now);
    expect(out.map((p) => p.id)).toEqual([1500, 1501]);
    expect(out[0]).toMatchObject({ countries: ["SD"], required: 2.7e9, end: "2026-12-31T00:00:00.000Z", url: "https://fts.unocha.org/plans/1500/summary/2026" });
    expect(out[1]).toMatchObject({ countries: ["TD", "SD"], required: 1.2e9 });
  });
});

describe("fetchers", () => {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const deps = (f: (url: string) => Promise<Response>): FetchDeps => ({ fetch: f as unknown as typeof fetch, sleep: async () => {}, log: () => {} });

  it("fetchSocieties and fetchAppeals parse the GO lists, and return null on failure", async () => {
    expect(Object.keys((await fetchSocieties(deps(async () => json({ results: goCountries })), 0)) ?? {})).toEqual(["SD", "TD"]);
    expect((await fetchAppeals(now, deps(async () => json({ results: goAppeals })), 0))?.length).toBe(2);
    expect(await fetchSocieties(deps(async () => new Response("", { status: 500 })), 0)).toBeNull();
    expect(await fetchAppeals(now, deps(async () => Promise.reject(new Error("offline"))), 0)).toBeNull();
  });

  it("fetchPlans lists two years, dedupes, and adds one funding total per plan", async () => {
    const calls: string[] = [];
    const fetch = async (url: string) => {
      calls.push(url);
      if (url.includes("/plan/year/2025")) return json({ data: [ftsPlans[2], ftsPlans[0]] });
      if (url.includes("/plan/year/2026")) return json({ data: ftsPlans });
      if (url.includes("planId=1500")) return json({ data: { report1: { fundingTotals: { total: 8.1e8 } } } });
      return new Response("", { status: 500 });
    };
    const out = await fetchPlans(resolve, now, deps(fetch), 0, 0);
    expect(out?.map((p) => [p.id, p.funded])).toEqual([
      [1500, 8.1e8],
      [1501, null],
    ]);
    expect(calls.filter((u) => u.includes("groupby=plan"))).toHaveLength(2);
  });

  it("fetchPlans returns null when the listing fails", async () => {
    expect(await fetchPlans(resolve, now, deps(async () => new Response("", { status: 503 })), 0, 0)).toBeNull();
  });
});

describe("buildHelp", () => {
  it("takes fresh data where it exists and keeps the previous source otherwise", () => {
    const previous: HelpFile = {
      updated: "2026-10-17T00:00:00.000Z",
      sources: { societies: "2026-10-17T00:00:00.000Z", appeals: "2026-10-16T00:00:00.000Z", plans: null },
      societies: { SD: { name: "Old", url: null, directory: null } },
      appeals: [],
      plans: [],
    };
    const plans = toPlans(ftsPlans, resolve, now).map((p) => ({ ...p, funded: 1 }));
    const out = buildHelp(previous, { societies: null, appeals: toAppeals(goAppeals, now), plans }, now);
    expect(out.sources).toEqual({ societies: "2026-10-17T00:00:00.000Z", appeals: now, plans: now });
    expect(out.societies.SD.name).toBe("Old");
    expect(out.appeals).toHaveLength(2);
    expect(out.plans).toHaveLength(2);
  });
  it("starts from nothing when there is no previous file", () => {
    expect(buildHelp(null, { societies: null, appeals: null, plans: null }, now)).toEqual({
      updated: now,
      sources: { societies: null, appeals: null, plans: null },
      societies: {},
      appeals: [],
      plans: [],
    });
  });
});
