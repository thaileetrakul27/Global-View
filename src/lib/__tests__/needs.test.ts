import { describe, expect, it } from "vitest";
import { NEED_TEXT, needPages, needSentence, needSource, needsFor } from "../needs";

const water = { key: "water", value: 47.8, year: 2024, severity: 1.91 };
const hunger = { key: "hunger", value: 33.6, year: 2024, severity: 1.68 };
const school = { key: "school", value: 24.8, year: 2024, severity: 1.24 };

describe("need wording", () => {
  it("has a sentence and a source for every indicator the pipeline fetches", () => {
    for (const key of ["water", "sanitation", "electricity", "hunger", "poverty", "school", "literacy", "mortality"]) expect(NEED_TEXT[key]).toBeDefined();
    expect(needSentence(water)).toBe("48% of people lack basic drinking water");
    expect(needSentence({ key: "mortality", value: 97.3, year: 2024, severity: 1.62 })).toBe("97 in every 1,000 children die before age five");
    expect(needSentence({ key: "new", value: 1, year: 2024, severity: 1 })).toBe("new: 1");
    expect(needSource(water)).toBe("2024 · WHO/UNICEF via World Bank");
    expect(needSource({ key: "poverty", value: 40, year: 2012, severity: 1.6 })).toBe("2012 · World Bank");
  });
});

describe("needPages", () => {
  it("lists each agency once, in the order of the needs", () => {
    expect(needPages([water, hunger, school]).map((p) => p.label)).toEqual(["UNICEF", "World Food Programme", "Education Cannot Wait"]);
    expect(needPages([{ key: "electricity", value: 50, year: 2024, severity: 1 }])).toEqual([]);
  });
});

describe("needsFor", () => {
  it("returns a country's needs or nothing", () => {
    const file = { updated: "", fetched: {}, countries: { TD: [water] } };
    expect(needsFor(file, "TD")).toEqual([water]);
    expect(needsFor(file, "JP")).toEqual([]);
    expect(needsFor(null, "TD")).toEqual([]);
  });
});
