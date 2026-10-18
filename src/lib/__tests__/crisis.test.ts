import { describe, expect, it } from "vitest";
import { leadCrisis } from "../crisis";
import type { Alert, Appeal, HelpFile, Plan } from "../data";
import { donationLinks, type Need } from "../help";

const now = "2026-10-18T12:00:00.000Z";
const appeal = (over: Partial<Appeal>): Appeal => ({ code: "A", country: "SD", name: "Appeal", kind: "Emergency Appeal", disaster: "Flood", requested: 5e7, funded: 1.85e7, people: null, start: now, end: now, url: "https://go.ifrc.org/emergencies/1", event: 1, ...over });
const plan = (over: Partial<Plan>): Plan => ({ id: 9, name: "Plan", countries: ["SD"], required: 2.9e9, funded: 1.2e9, end: now, url: "https://fts.unocha.org/plans/9/summary/2026", ...over });
const alert = (over: Partial<Alert>): Alert => ({ id: "g", type: "cyclone", level: "Orange", title: "t", description: "A cyclone was active.", name: "SIMON-26", countries: ["MX"], from: now, to: now, url: "https://www.gdacs.org/1", ...over });
const need = (over: Partial<Need>): Need => ({ alerts: [], appeals: [], plans: [], watching: null, unwatched: null, society: null, uncr: null, any: true, ...over });
const help: HelpFile = {
  updated: now,
  sources: { societies: now, appeals: now, plans: now, events: now, uncr: now },
  societies: {},
  appeals: [],
  plans: [],
  events: { 1: { id: 1, name: "Sudan - Complex Emergency", summary: "Sudan was plunged into crisis.", severity: "Red", figures: [{ number: "24.7M", label: "People in need", source: "OCHA" }] } },
  uncr: {},
};

describe("leadCrisis", () => {
  it("lets a Red IFRC emergency lead, described in IFRC's words with its figures and funding", () => {
    const lead = leadCrisis(need({ appeals: [appeal({})], plans: [plan({})] }), help, "Sudan");
    expect(lead).toMatchObject({ kind: "appeal", title: "Sudan - Complex Emergency", summary: "Sudan was plunged into crisis.", severity: "Red", funding: "CHF 50M asked, 37% funded", source: "IFRC" });
    expect(lead?.figures).toHaveLength(1);
  });
  it("prefers a single-country UN plan to a small appeal with no graded emergency", () => {
    const lead = leadCrisis(need({ appeals: [appeal({ event: null, requested: 9e4 })], plans: [plan({})] }), help, "Sudan");
    expect(lead).toMatchObject({ kind: "plan", funding: "$2.9B needed, 41% funded" });
  });
  it("prefers a cyclone alert to a regional plan or a continent-wide drought", () => {
    const wide = alert({ id: "d", type: "drought", level: "Orange", countries: ["MX", "A", "B", "C", "D", "E", "F", "G"], name: null, description: null });
    const lead = leadCrisis(need({ alerts: [wide, alert({})], plans: [plan({ countries: ["MX", "CO", "PE"], required: 7e8 })] }), help, "Mexico");
    expect(lead).toMatchObject({ kind: "alert", title: "Orange tropical cyclone alert: SIMON-26", summary: "A cyclone was active." });
  });
  it("falls back to the headline signal, and to nothing", () => {
    const watching = { code: "CA", editions: 22, baseline: null, share: 0.68, sample: ["Base fire kills four"] };
    expect(leadCrisis(need({ watching }), help, "Canada")).toMatchObject({ kind: "news", title: "Base fire kills four", url: null });
    expect(leadCrisis(need({ any: false }), help, "Japan")).toBeNull();
  });
});

describe("donationLinks", () => {
  const society = { name: "Sudanese Red Crescent", url: "http://www.srcs.sd/", directory: null, donate: "https://donate.redcrossredcrescent.org/sd/default/", checked: null };
  it("leads with the platform page and the UN page for the crisis", () => {
    const links = donationLinks(society, "https://crisisrelief.un.org/donate-sudan-crisis", "Sudan");
    expect(links.map((l) => l.url)).toEqual(["https://donate.redcrossredcrescent.org/sd/default/", "https://crisisrelief.un.org/donate-sudan-crisis"]);
  });
  it("falls back to the society's site and the UN's general fund, and still gives two links with no society", () => {
    const links = donationLinks({ ...society, donate: null, checked: null }, null, "Sudan");
    expect(links.map((l) => l.url)).toEqual(["http://www.srcs.sd/", "https://crisisrelief.un.org/"]);
    expect(donationLinks(null, null, "Nowhere").map((l) => l.url)).toEqual(["https://crisisrelief.un.org/"]);
  });
});
