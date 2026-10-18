import { describe, expect, it } from "vitest";
import type { CrisesFile, HelpFile } from "../data";
import { helpLinks, leastFunded, needFor, societyLink } from "../help";

const now = "2026-10-18T12:00:00.000Z";
const help: HelpFile = {
  updated: now,
  sources: { societies: now, appeals: now, plans: now },
  societies: {
    SD: { name: "Sudanese Red Crescent", url: "http://www.srcs.sd/", directory: "https://www.ifrc.org/national-societies-directory/sudanese-red-crescent" },
    TD: { name: "Red Cross of Chad", url: null, directory: null },
  },
  appeals: [{ code: "MDRSD030", country: "SD", name: "Sudan", kind: "Emergency Appeal", disaster: "Complex Emergency", requested: 5e7, funded: 1.8e7, people: null, start: now, end: now, url: "u" }],
  plans: [
    { id: 1, name: "Sudan plan", countries: ["SD"], required: 2.8e9, funded: 1.2e9, end: now, url: "u1" },
    { id: 2, name: "Regional plan", countries: ["TD", "SD"], required: 1e9, funded: 1e8, end: now, url: "u2" },
    { id: 3, name: "Chad plan", countries: ["TD"], required: 1e9, funded: 2e8, end: now, url: "u3" },
    { id: 4, name: "Unknown funding", countries: ["NE"], required: 1e9, funded: null, end: now, url: "u4" },
  ],
};
const crises: CrisesFile = {
  updated: now,
  watching: [],
  unwatched: [],
  alerts: [{ id: "a", type: "flood", level: "Orange", title: "t", description: null, name: null, countries: ["TD", "SD"], from: now, to: now, url: "g" }],
  quiet: [],
};

describe("societyLink", () => {
  it("prefers the society's own site and falls back to IFRC's directory", () => {
    expect(societyLink(help.societies.SD, "Sudan").url).toBe("http://www.srcs.sd/");
    expect(societyLink(help.societies.TD, "Chad").url).toBe("https://www.ifrc.org/national-societies-directory");
  });
});

describe("helpLinks", () => {
  it("puts the national society first, then the fixed UN and Red Cross pages", () => {
    const links = helpLinks("SDN", "Sudan", help.societies.SD);
    expect(links.map((l) => l.label)).toEqual(["Sudanese Red Crescent", "ReliefWeb: Sudan", "UN Crisis Relief", "Red Cross and Red Crescent emergencies"]);
    expect(helpLinks(undefined, "Nowhere")).toHaveLength(2);
  });
});

describe("needFor", () => {
  it("collects everything that names a country", () => {
    const n = needFor("SD", crises, help);
    expect(n.any).toBe(true);
    expect(n.alerts.map((a) => a.id)).toEqual(["a"]);
    expect(n.appeals.map((a) => a.code)).toEqual(["MDRSD030"]);
    expect(n.plans.map((p) => p.id)).toEqual([1, 2]);
    expect(n.society?.name).toBe("Sudanese Red Crescent");
  });
  it("reports nothing for a country nothing names, keeping its society", () => {
    const n = needFor("TH", crises, { ...help, societies: { TH: { name: "Thai Red Cross Society", url: "x", directory: null } } });
    expect(n.any).toBe(false);
    expect(n.society?.name).toBe("Thai Red Cross Society");
    expect(needFor("TH", null, null).any).toBe(false);
  });
});

describe("leastFunded", () => {
  it("ranks single-country plans with known funding, least funded first", () => {
    expect(leastFunded(help, 5).map((p) => p.id)).toEqual([3, 1]);
    expect(leastFunded(null, 5)).toEqual([]);
  });
});
