import { describe, expect, it } from "vitest";
import { buildResolver } from "./alerts";
import type { FetchDeps } from "./googlenews";
import {
  buildHelp,
  dropHeading,
  fetchAppeals,
  fetchEmergencies,
  fetchPlans,
  fetchSocieties,
  fetchUncr,
  opening,
  probeDonate,
  refreshHelp,
  stripHtml,
  toAppeals,
  toEmergency,
  toPlans,
  toSocieties,
  toUncr,
  type HelpFile,
} from "./help";

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
    expect(out.SD).toEqual({ name: "Sudanese Red Crescent", url: "http://www.srcs.sd/", directory: "https://www.ifrc.org/national-societies-directory/sudanese-red-crescent", donate: null });
    expect(out.TD).toEqual({ name: "Red Cross of Chad", url: null, directory: null, donate: null });
    expect(toSocieties(goCountries, { SD: "https://donate.redcrossredcrescent.org/sd/default/" }).SD.donate).toBe("https://donate.redcrossredcrescent.org/sd/default/");
  });
});

describe("toAppeals", () => {
  it("keeps running appeals with a country, largest first, linking the operation or the country page", () => {
    const out = toAppeals(goAppeals, now);
    expect(out.map((a) => a.code)).toEqual(["MDRSD030", "MDRTD020"]);
    expect(out[0]).toMatchObject({ country: "SD", name: "Sudan - Complex Emergency", kind: "Emergency Appeal", disaster: "Complex Emergency", requested: 1e7, funded: 4e6, people: 50000, url: "https://go.ifrc.org/emergencies/123" });
    expect(out[1]).toMatchObject({ country: "TD", disaster: "Flood", people: null, url: "https://go.ifrc.org/countries/9", end: "2026-11-30T00:00:00.000Z", event: null });
    expect(out[0].event).toBe(123);
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

  const platform = async (url: string) => {
    if (url.includes("/country/")) return json({ results: goCountries });
    const cc = /\.org\/([a-z]{2})\//.exec(url)?.[1];
    return new Response("", { status: 303, headers: { location: cc === "sd" ? `https://donate.redcrossredcrescent.org/${cc}/default/~my-donation` : "https://donate.redcrossredcrescent.org/?lang=" } });
  };

  it("fetchSocieties parses the GO list and marks who is on the donation platform; null on failure", async () => {
    const out = await fetchSocieties({}, deps(platform), 0);
    expect(out?.SD.donate).toBe("https://donate.redcrossredcrescent.org/sd/default/");
    expect(out?.TD.donate).toBeNull();
    expect(await fetchSocieties({}, deps(async () => new Response("", { status: 500 })), 0)).toBeNull();
  });

  it("probeDonate keeps a code's previous answer when its request fails", async () => {
    const out = await probeDonate(["SD", "TD"], { SD: "kept" }, deps(async () => Promise.reject(new Error("offline"))), 1);
    expect(out).toEqual({ SD: "kept", TD: null });
  });

  it("fetchAppeals parses the GO list, and returns null on failure", async () => {
    expect((await fetchAppeals(now, deps(async () => json({ results: goAppeals })), 0))?.length).toBe(2);
    expect(await fetchAppeals(now, deps(async () => Promise.reject(new Error("offline"))), 0)).toBeNull();
  });

  it("fetchEmergencies describes each appeal's emergency once, keeping a previous entry on failure", async () => {
    const calls: string[] = [];
    const fetch = async (url: string) => {
      calls.push(url);
      if (url.endsWith("/event/123/")) return json({ id: 123, name: " Sudan - Complex Emergency ", summary: "<p>Sudan was plunged into crisis.</p><p>More.</p>", ifrc_severity_level_display: "Red", key_figures: [{ number: "24,700,000", deck: "People in need", source: "OCHA" }] });
      return new Response("", { status: 500 });
    };
    const appeals = [...toAppeals(goAppeals, now), { ...toAppeals(goAppeals, now)[0], code: "X", event: 999 }, { ...toAppeals(goAppeals, now)[0], code: "Y", event: 123 }];
    const out = await fetchEmergencies(appeals, { 999: { id: 999, name: "Old", summary: null, severity: null, figures: [] } }, deps(fetch), 0);
    expect(Object.keys(out).sort()).toEqual(["123", "999"]);
    expect(out[123]).toEqual({ id: 123, name: "Sudan - Complex Emergency", summary: "Sudan was plunged into crisis. More.", severity: "Red", figures: [{ number: "24,700,000", label: "People in need", source: "OCHA" }] });
    expect(out[999].name).toBe("Old");
    expect(calls).toHaveLength(2);
  });

  it("fetchUncr maps the sitemap's donation pages to countries, null on failure", async () => {
    const xml = `<urlset><url><loc>https://crisisrelief.un.org/donate-sudan-crisis</loc></url><url><loc>https://crisisrelief.un.org/donate-sahel-crisis</loc></url></urlset>`;
    expect(await fetchUncr(resolve, deps(async () => new Response(xml, { status: 200 })), 0)).toEqual({ SD: "https://crisisrelief.un.org/donate-sudan-crisis" });
    expect(await fetchUncr(resolve, deps(async () => new Response("<urlset/>", { status: 200 })), 0)).toBeNull();
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

describe("stripHtml and opening", () => {
  it("turns IFRC's summary HTML into readable text", () => {
    expect(stripHtml('<p class="x">Khartoum &amp; beyond&nbsp;&ndash; <strong>6 million</strong> displaced.</p>\r\n<p>Next&#39;s.</p>')).toBe("Khartoum & beyond \u2013 6 million displaced. Next's.");
  });
  it("cuts a long text at a sentence end", () => {
    const text = "First sentence here. Second sentence is longer than the first. Third one.";
    expect(opening(text, 40)).toBe("First sentence here.");
    expect(opening(text, 200)).toBe(text);
    expect(opening("No sentence end at all in this stretch of words", 20)).toBe("No sentence end at a\u2026");
  });
  it("drops a pasted report heading from the start of a summary", () => {
    expect(dropHeading("1. Situation Overview The escalation of conflict continues.")).toBe("The escalation of conflict continues.");
    expect(dropHeading("Sudan was plunged into crisis.")).toBe("Sudan was plunged into crisis.");
  });
  it("toEmergency handles missing fields", () => {
    expect(toEmergency({ id: 1, name: "X", summary: null, ifrc_severity_level_display: "", key_figures: [] })).toEqual({ id: 1, name: "X", summary: null, severity: null, figures: [] });
  });
});

describe("toUncr", () => {
  it("matches donate pages by country name or alias and skips campaigns and regions", () => {
    const r = buildResolver([
      { code: "SD", name: "Sudan", admin: "Sudan", iso3: "SDN" },
      { code: "SS", name: "S. Sudan", admin: "South Sudan", iso3: "SSD" },
      { code: "LK", name: "Sri Lanka", admin: "Sri Lanka", iso3: "LKA" },
      { code: "PS", name: "Palestine", admin: "Palestine", iso3: "PSE" },
    ]);
    const base = "https://crisisrelief.un.org/";
    const out = toUncr(
      ["donate-sudan-crisis", "donate-south-sudan-crisis", "donate-sri-lanka", "donate-opt-crisis", "ramadan-2026-sudan", "sudan-crisis-ar", "donate-sahel-crisis", "donate-global-emergency-fund", "donate"].map((s) => base + s),
      r,
    );
    expect(out).toEqual({ SD: base + "donate-sudan-crisis", SS: base + "donate-south-sudan-crisis", LK: base + "donate-sri-lanka", PS: base + "donate-opt-crisis" });
  });
});

describe("buildHelp", () => {
  it("takes fresh data where it exists and keeps the previous source otherwise", () => {
    const previous: HelpFile = {
      updated: "2026-10-17T00:00:00.000Z",
      sources: { societies: "2026-10-17T00:00:00.000Z", appeals: "2026-10-16T00:00:00.000Z", plans: null, events: null, uncr: "2026-10-15T00:00:00.000Z" },
      societies: { SD: { name: "Old", url: null, directory: null, donate: null } },
      appeals: [],
      plans: [],
      events: {},
      uncr: { SD: "old" },
    };
    const plans = toPlans(ftsPlans, resolve, now).map((p) => ({ ...p, funded: 1 }));
    const out = buildHelp(previous, { societies: null, appeals: toAppeals(goAppeals, now), plans, events: {}, uncr: null }, now);
    expect(out.sources).toEqual({ societies: "2026-10-17T00:00:00.000Z", appeals: now, plans: now, events: now, uncr: "2026-10-15T00:00:00.000Z" });
    expect(out.societies.SD.name).toBe("Old");
    expect(out.appeals).toHaveLength(2);
    expect(out.plans).toHaveLength(2);
    expect(out.uncr).toEqual({ SD: "old" });
  });
  it("starts from nothing when there is no previous file", () => {
    expect(buildHelp(null, { societies: null, appeals: null, plans: null, events: null, uncr: null }, now)).toEqual({
      updated: now,
      sources: { societies: null, appeals: null, plans: null, events: null, uncr: null },
      societies: {},
      appeals: [],
      plans: [],
      events: {},
      uncr: {},
    });
  });
  it("refreshHelp survives every source failing", async () => {
    const deps = { fetch: (async () => Promise.reject(new Error("offline"))) as unknown as typeof fetch, sleep: async () => {}, log: () => {} };
    const out = await refreshHelp(null, resolve, now, deps);
    expect(out.sources).toEqual({ societies: null, appeals: null, plans: null, events: null, uncr: null });
  });
});
