import { describe, expect, it } from "vitest";
import { loadCountryConfig, loadGlobeCodes, loadGlobeFeatures, loadLanguages, loadWorldQueries, selectCountries, type CountryConfig, worldCountries } from "./countries";

const ed = { hl: "en", gl: "XX", ceid: "XX:en" };
const TH: CountryConfig = { code: "TH", name: "Thailand", enabled: true, kind: "local", edition: ed };
const GB: CountryConfig = { code: "GB", name: "United Kingdom", enabled: true, kind: "local", edition: ed };
const CN: CountryConfig = { code: "CN", name: "China", enabled: false, kind: "local", edition: ed };

describe("selectCountries", () => {
  it("returns enabled countries by default", () => {
    expect(selectCountries([TH, GB, CN])).toEqual([TH, GB]);
  });
  it("returns exactly the requested codes, even when disabled", () => {
    expect(selectCountries([TH, GB, CN], ["CN", "TH"])).toEqual([CN, TH]);
  });
  it("throws on unknown codes", () => {
    expect(() => selectCountries([TH], ["XX"])).toThrow(/XX is not in/);
  });
});

describe("worldCountries", () => {
  const globe = [
    { code: "TH", name: "Thailand", admin: "Thailand" },
    { code: "MN", name: "Mongolia", admin: "Mongolia" },
    { code: "TZ", name: "Tanzania", admin: "United Republic of Tanzania" },
    { code: "GE", name: "Georgia", admin: "Georgia" },
    { code: "AQ", name: "Antarctica", admin: "Antarctica" },
  ];
  const wq = { skip: ["AQ"], queries: { GE: '"Georgia" (Tbilisi OR Georgian)' } };
  it("covers globe countries without an edition, skipping the skip list", () => {
    const out = worldCountries([TH], globe, wq);
    expect(out.every((c) => c.local?.lang === "en" && c.local.name === c.name)).toBe(true);
    const withLangs = worldCountries([TH], globe, wq, { languages: { MN: { lang: "mn", name: "Монгол" } } });
    expect(withLangs.find((c) => c.code === "MN")?.local).toEqual({ lang: "mn", name: "Монгол" });
    expect(out.map((c) => c.code)).toEqual(["GE", "MN", "TZ"]);
    expect(out.every((c) => c.kind === "world" && c.enabled)).toBe(true);
  });
  it("quotes plain names, strips awkward prefixes, and uses overrides", () => {
    const by = Object.fromEntries(worldCountries([TH], globe, wq).map((c) => [c.code, c]));
    expect(by.MN.query).toBe('"Mongolia"');
    expect(by.TZ).toMatchObject({ name: "Tanzania", query: '"Tanzania"' });
    expect(by.GE.query).toBe('"Georgia" (Tbilisi OR Georgian)');
  });
});

describe("real config files", () => {
  const local = loadCountryConfig();
  const globe = loadGlobeFeatures();
  it("has unique local codes that all exist on the globe", () => {
    const codes = local.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    const onGlobe = loadGlobeCodes();
    expect(codes.filter((c) => !onGlobe.has(c))).toEqual([]);
  });
  it("has a complete edition for every local country", () => {
    for (const c of local) {
      expect(c.edition?.hl, c.code).toBeTruthy();
      expect(c.edition?.gl, c.code).toBe(c.code);
      expect(c.edition?.ceid, c.code).toMatch(/^[A-Z]{2}:[a-zA-Z0-9-]+$/);
    }
  });
  it("gives every other globe country a world query, with overrides for known codes only", () => {
    const wq = loadWorldQueries();
    const world = worldCountries(local, globe, wq);
    const globeCodes = new Set(globe.map((f) => f.code));
    for (const code of Object.keys(wq.queries)) expect(globeCodes.has(code), `override ${code}`).toBe(true);
    expect(local.length + world.length + wq.skip.length).toBe(globe.length);
    for (const c of world) expect(c.query, c.code).toBeTruthy();
  });
});

describe("loadLanguages", () => {
  it("loads the real table with a language code and a name for every entry", () => {
    const { languages } = loadLanguages();
    expect(Object.keys(languages).length).toBeGreaterThan(80);
    for (const [code, v] of Object.entries(languages)) {
      expect(code).toMatch(/^[A-Z]{2,3}$/);
      expect(v.lang).toMatch(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/);
      expect(v.name.trim().length).toBeGreaterThan(1);
    }
    expect(languages.TD).toEqual({ lang: "fr", name: "Tchad" });
  });
});
