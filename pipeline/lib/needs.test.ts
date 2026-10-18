import { describe, expect, it } from "vitest";
import { buildResolver } from "./alerts";
import type { FetchDeps } from "./googlenews";
import { INDICATORS, buildNeeds, fetchIndicator, refreshNeeds, toNeeds, type NeedsFile } from "./needs";

const now = "2026-10-18T12:00:00.000Z";
const resolve = buildResolver([
  { code: "TD", name: "Chad", admin: "Chad", iso3: "TCD" },
  { code: "JP", name: "Japan", admin: "Japan", iso3: "JPN" },
  { code: "HT", name: "Haiti", admin: "Haiti", iso3: "HTI" },
]);
const water = INDICATORS.find((i) => i.key === "water")!;
const hunger = INDICATORS.find((i) => i.key === "hunger")!;
const rows = [
  { countryiso3code: "AFE", date: "2024", value: 61.6 },
  { countryiso3code: "TCD", date: "2024", value: 52.2 },
  { countryiso3code: "JPN", date: "2024", value: 99.2 },
  { countryiso3code: "HTI", date: "2005", value: 60 },
  { countryiso3code: "", date: "2024", value: 10 },
  { countryiso3code: "TCD", date: "2020", value: 40 },
];

describe("toNeeds", () => {
  it("turns coverage into a gap, drops aggregates, stale and small figures, and keeps the latest year", () => {
    const out = toNeeds(rows, water, resolve, now);
    expect(out).toEqual({ TD: { key: "water", value: 47.8, year: 2024, severity: 1.91 } });
  });
  it("uses a rate as it is and caps severity at 2", () => {
    const out = toNeeds([{ countryiso3code: "HTI", date: "2024", value: 51.4 }, { countryiso3code: "JPN", date: "2024", value: 2.5 }], hunger, resolve, now);
    expect(out).toEqual({ HT: { key: "hunger", value: 51.4, year: 2024, severity: 2 } });
  });
});

describe("buildNeeds", () => {
  const previous: NeedsFile = {
    updated: "2026-10-17T00:00:00.000Z",
    fetched: { water: "2026-10-17T00:00:00.000Z", hunger: "2026-10-17T00:00:00.000Z" },
    countries: { TD: [{ key: "water", value: 40, year: 2023, severity: 1.6 }, { key: "hunger", value: 30, year: 2023, severity: 1.5 }] },
  };
  it("takes fresh figures where they exist and keeps the previous indicator otherwise, ranking per country", () => {
    const out = buildNeeds(previous, { water: { TD: { key: "water", value: 47.8, year: 2024, severity: 1.91 }, HT: { key: "water", value: 30, year: 2024, severity: 1.2 } }, hunger: null }, now);
    expect(out.fetched.water).toBe(now);
    expect(out.fetched.hunger).toBe("2026-10-17T00:00:00.000Z");
    expect(out.fetched.poverty).toBeNull();
    expect(out.countries.TD.map((n) => [n.key, n.value])).toEqual([
      ["water", 47.8],
      ["hunger", 30],
    ]);
    expect(out.countries.HT).toHaveLength(1);
  });
  it("keeps at most four needs per country", () => {
    const fresh = Object.fromEntries(INDICATORS.map((i) => [i.key, { TD: { key: i.key, value: 50, year: 2024, severity: 1 } }]));
    expect(buildNeeds(null, fresh, now).countries.TD).toHaveLength(4);
  });
});

describe("fetchIndicator and refreshNeeds", () => {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const deps = (f: (url: string) => Promise<Response>): FetchDeps => ({ fetch: f as unknown as typeof fetch, sleep: async () => {}, log: () => {} });
  it("returns the rows, retrying once, and null when the body is not an indicator list", async () => {
    let calls = 0;
    const flaky = async () => (++calls === 1 ? new Response("", { status: 502 }) : json([{ page: 1 }, rows]));
    expect(await fetchIndicator(water, deps(flaky), 0)).toHaveLength(6);
    expect(await fetchIndicator(water, deps(async () => json({ message: "no" })), 0)).toBeNull();
  });
  it("refreshNeeds fetches every indicator and survives failures", async () => {
    const f = async (url: string) => (url.includes(water.id) ? json([{ page: 1 }, rows]) : new Response("", { status: 500 }));
    const out = await refreshNeeds(null, resolve, now, deps(f), 0);
    expect(out.countries.TD).toEqual([{ key: "water", value: 47.8, year: 2024, severity: 1.91 }]);
    expect(Object.values(out.fetched).filter(Boolean)).toHaveLength(1);
  });
});
