import { describe, expect, it } from "vitest";
import { loadCountryConfig, loadGdeltCodes, selectCountries, unknownGdeltCodes, type CountryConfig } from "./countries";

const axis = { summary: "", left: "", right: "" };
const TH: CountryConfig = { code: "TH", gdelt: "TH", name: "Thailand", enabled: true, axis };
const GB: CountryConfig = { code: "GB", gdelt: "UK", name: "United Kingdom", enabled: true, axis };
const CN: CountryConfig = { code: "CN", gdelt: "CH", name: "China", enabled: false, axis };

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

describe("real config files", () => {
  it("every country has a code GDELT knows", () => {
    const known = loadGdeltCodes();
    expect(known.get("UK")).toBe("United Kingdom");
    expect(known.get("CH")).toBe("China");
    expect(unknownGdeltCodes(loadCountryConfig(), known)).toEqual([]);
  });
  it("flags codes GDELT does not know", () => {
    const bad: CountryConfig = { ...GB, gdelt: "GB" }; // GB is Gabon in GDELT, so this is "known" but wrong
    const fake: CountryConfig = { ...TH, gdelt: "ZZ" };
    expect(unknownGdeltCodes([bad, fake], loadGdeltCodes())).toEqual([fake]);
  });
});
