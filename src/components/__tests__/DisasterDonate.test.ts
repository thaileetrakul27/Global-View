import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Disaster, DonationLink } from "@/lib/data";
import DisasterDonate from "@/components/disaster/DisasterDonate";

const link = (over: Partial<DonationLink> & { url: string }): DonationLink => ({ label: "Donate", org: "Org", kind: "un", note: "", via: "registry", ...over });
const flood = (donate: DonationLink[]): Disaster => ({
  id: "flood-th",
  type: "flood",
  title: "Flood in Thailand",
  severity: 2,
  countries: ["TH"],
  lat: 15,
  lng: 100,
  precision: "area",
  started: "2026-10-20T00:00:00Z",
  updated: "2026-10-21T00:00:00Z",
  areas: [],
  places: [],
  figures: [],
  sources: [],
  appeals: [],
  donate,
  reportedBy: [],
  members: [],
});
const render = (donate: DonationLink[]) => renderToStaticMarkup(createElement(DisasterDonate, { disaster: flood(donate) }));
/** The visible text in page order, each element's text between bars. */
const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, "|")
    .replace(/\|+/g, "|")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");

const OFFICIAL = [
  link({ url: "https://www.ifrc.org/appeals?appeal_code=MDRTH001", org: "IFRC", label: "Thailand floods appeal", kind: "appeal", forEvent: true }),
  link({ url: "https://donate.redcrossredcrescent.org/th/", org: "Thai Red Cross Society", kind: "society", note: "The national society" }),
  link({ url: "https://crisisrelief.un.org/", org: "UN Crisis Relief", kind: "un" }),
];
const DIRECT = [
  link({ url: "https://www.example.org/school-fund", org: "Ban Mae Rim School", label: "Rebuild our classrooms", kind: "local", via: "research", forEvent: true, note: "A local group's own page. Global View checked it is live and names Mae Rim, but cannot vouch for the group." }),
  link({ url: "https://www.globalgiving.org/projects/thailand-flood-relief/", org: "GlobalGiving", label: "Thailand Flood Relief Fund", kind: "project", via: "platform", forEvent: true, note: "GlobalGiving vets its local partners" }),
  link({ url: "https://www.gofundme.com/f/mae-rim-families", org: "GoFundMe", label: "Help Mae Rim families", kind: "fundraiser", via: "platform", forEvent: true, note: "Verified by GoFundMe's Trust & Safety team" }),
];

describe("DisasterDonate", () => {
  it("renders a file without direct pages as before: this disaster's pages, then the rest, and the registry footer", () => {
    const t = text(render(OFFICIAL));
    expect(t).not.toContain("Directly to people affected");
    expect(t.indexOf("For this disaster")).toBeLessThan(t.indexOf("Red Cross and Red Crescent"));
    expect(t).toContain("|The national society|");
    expect(t).toContain(
      "Global View takes no donations and chooses no charities. These pages come from the Red Cross and UN registries, or are official pages checked against an allowlist.",
    );
  });

  it("lists direct pages first, fundraisers then projects then local groups, each with who checked it", () => {
    const t = text(render([...OFFICIAL, ...DIRECT]));
    const order = ["Directly to people affected", "Help Mae Rim families", "Thailand Flood Relief Fund", "Rebuild our classrooms", "For this disaster", "Thailand floods appeal"];
    const at = order.map((s) => t.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(t).toContain("|Verified by GoFundMe's Trust & Safety team|");
    expect(t).toContain("|GlobalGiving vets its local partners|");
    expect(t).toContain("but cannot vouch for the group.");
    // A local page found by research is not called an official page.
    expect(t).not.toContain("checked as an official page");
    expect(t).toContain("Direct pages come from GoFundMe's verified lists, GlobalGiving and local groups' own pages, all checked automatically.");
    expect(t).toContain("The others come from the Red Cross and UN registries");
  });

  it("names the direct group even when it is the only one", () => {
    const t = text(render(DIRECT.slice(0, 1)));
    expect(t).toContain("Directly to people affected");
    expect(t).toContain("These pages come from GoFundMe's verified lists");
  });

  it("points to UN Crisis Relief when nothing safe is listed", () => {
    const t = text(render([link({ url: "http://www.gofundme.com/f/x", kind: "fundraiser" })]));
    expect(t).toContain("No official donation page is listed for this disaster yet.");
    expect(t).toContain("|Global View takes no donations and chooses no charities.|");
  });
});
