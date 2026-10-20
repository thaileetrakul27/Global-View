import { describe, expect, it } from "vitest";
import { buildResolver, normaliseName } from "./resolve";

const features = [
  { code: "MX", name: "Mexico", admin: "Mexico", iso3: "MEX" },
  { code: "CD", name: "Dem. Rep. Congo", admin: "Democratic Republic of the Congo", iso3: "COD" },
  { code: "TR", name: "Turkey", admin: "Turkey", iso3: "TUR" },
  { code: "BA", name: "Bosnia and Herz.", admin: "Bosnia and Herzegovina", iso3: "BIH" },
];

describe("normaliseName", () => {
  it("lines up accents, ampersands and articles", () => {
    expect(normaliseName("México")).toBe("mexico");
    expect(normaliseName("Bosnia & Herzegovina")).toBe("bosnia and herzegovina");
    expect(normaliseName("The Bahamas")).toBe("bahamas");
  });
});

describe("buildResolver", () => {
  it("resolves by ISO3, map name, full name and alias", () => {
    const r = buildResolver(features, [{ code: "MX", name: "Mexico", enabled: true, kind: "local" }]);
    expect(r.byIso3("mex")).toBe("MX");
    expect(r.byName("Dem. Rep. Congo")).toBe("CD");
    expect(r.byName("Democratic Republic of Congo")).toBe("CD");
    expect(r.byName("Türkiye")).toBe("TR");
    expect(r.byName("Bosnia & Herzegovina")).toBe("BA");
    expect(r.byName("Atlantis")).toBeUndefined();
    expect(r.byIso3("ATL")).toBeUndefined();
  });
});
