import { describe, expect, it } from "vitest";
import { loadCountryConfig, loadGlobeCodes, selectCountries, type CountryConfig } from "./countries";

const ed = { hl: "en", gl: "XX", ceid: "XX:en" };
const TH: CountryConfig = { code: "TH", name: "Thailand", enabled: true, edition: ed };
const GB: CountryConfig = { code: "GB", name: "United Kingdom", enabled: true, edition: ed };
const CN: CountryConfig = { code: "CN", name: "China", enabled: false, edition: ed };

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

describe("real config file", () => {
  const all = loadCountryConfig();
  it("has unique codes that all exist on the globe", () => {
    const globe = loadGlobeCodes();
    const codes = all.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.filter((c) => !globe.has(c))).toEqual([]);
  });
  it("has a complete edition for every country", () => {
    for (const c of all) {
      expect(c.edition.hl, c.code).toBeTruthy();
      expect(c.edition.gl, c.code).toBe(c.code);
      expect(c.edition.ceid, c.code).toMatch(/^[A-Z]{2}:[a-zA-Z0-9-]+$/);
    }
  });
});
