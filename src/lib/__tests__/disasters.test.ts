import { describe, expect, it } from "vitest";
import type { Disaster, DonationLink } from "../data";
import {
  cleanDisasters,
  appealFunding,
  centreLabel,
  coordText,
  countByType,
  disastersIn,
  findDisaster,
  groupDonations,
  hiddenOnMap,
  isMinor,
  isSafeUrl,
  locationLine,
  placeDetail,
  rankDisasters,
  safeDonations,
  safeHref,
  shortDate,
  shortTitle,
  significantOnly,
  sinceLine,
  typeCountLabel,
} from "../disasters";

const NOW = Date.parse("2026-10-19T21:00:00Z");

/** A minimal disaster; tests override what they need. */
function make(over: Partial<Disaster> & { id: string }): Disaster {
  return {
    type: "flood",
    title: "Flood",
    severity: 1,
    countries: [],
    lat: 0,
    lng: 0,
    precision: "exact",
    started: "2026-10-10T00:00:00Z",
    updated: "2026-10-19T00:00:00Z",
    areas: [],
    places: [],
    figures: [],
    sources: [],
    appeals: [],
    donate: [],
    reportedBy: ["gdacs"],
    members: [],
    ...over,
  };
}

const NAMES: Record<string, string> = { US: "United States", KE: "Kenya", UG: "Uganda", TZ: "Tanzania", CD: "DR Congo", LY: "Libya" };
const nameOf = (c: string) => NAMES[c] ?? c;

function link(over: Partial<DonationLink> & { url: string }): DonationLink {
  return { label: "Donate", org: "Org", kind: "un", note: "", via: "registry", ...over };
}

describe("cleanDisasters", () => {
  it("drops malformed entries and fills in missing optional lists", () => {
    const good = make({ id: "ok" });
    const bare: Record<string, unknown> = { ...make({ id: "bare" }) };
    for (const key of ["figures", "sources", "appeals", "reportedBy", "members"]) delete bare[key];
    const raw = [
      good,
      bare,
      { ...good, id: "unknown-type", type: "meteor" },
      { ...good, id: "bad-severity", severity: 4 },
      { ...good, id: "no-position", lat: null },
      { ...good, id: "no-areas", areas: undefined },
      { ...good, id: "no-donate", donate: "none" },
      { ...good, title: undefined, id: "no-title" },
      { ...good }, // repeats "ok"
      null,
      "junk",
    ];
    const out = cleanDisasters(raw);
    expect(out.map((d) => d.id)).toEqual(["ok", "bare"]);
    expect(out[1].figures).toEqual([]);
    expect(out[1].reportedBy).toEqual([]);
    expect(out[1].members).toEqual([]);
  });

  it("keeps a good entry but drops its broken areas, places and links", () => {
    const d = make({ id: "d" }) as unknown as Record<string, unknown>;
    const [out] = cleanDisasters([
      {
        ...d,
        precision: "somewhere",
        countries: ["LY", 5],
        areas: [{ kind: "affected", geometry: { type: "Point", coordinates: [0, 0] } }, { kind: "affected", geometry: { type: "Polygon", coordinates: [] } }],
        places: [{ name: "Misrata", lat: 32.4, lng: 15.1 }, { name: "Nowhere" }],
        donate: [link({ url: "https://ifrc.org" }), { url: 42 }],
      },
    ]);
    expect(out.precision).toBe("area");
    expect(out.countries).toEqual(["LY"]);
    expect(out.areas).toHaveLength(1);
    expect(out.places.map((p) => p.name)).toEqual(["Misrata"]);
    expect(out.donate).toHaveLength(1);
  });

  it("reads anything that is not a list as no disasters", () => {
    expect(cleanDisasters(undefined)).toEqual([]);
    expect(cleanDisasters({ disasters: [] })).toEqual([]);
  });
});

describe("rankDisasters", () => {
  it("puts the most severe first, then the newest", () => {
    const list = [
      make({ id: "a", severity: 1, started: "2026-10-18T00:00:00Z" }),
      make({ id: "b", severity: 3, started: "2026-10-01T00:00:00Z" }),
      make({ id: "c", severity: 2, started: "2026-10-05T00:00:00Z" }),
      make({ id: "d", severity: 2, started: "2026-10-15T00:00:00Z" }),
    ];
    expect(rankDisasters(list).map((d) => d.id)).toEqual(["b", "d", "c", "a"]);
  });

  it("breaks ties by last update, then id, and does not change the input", () => {
    const list = [
      make({ id: "z", updated: "2026-10-18T00:00:00Z" }),
      make({ id: "y", updated: "2026-10-19T00:00:00Z" }),
      make({ id: "x", updated: "2026-10-19T00:00:00Z" }),
    ];
    expect(rankDisasters(list).map((d) => d.id)).toEqual(["x", "y", "z"]);
    expect(list.map((d) => d.id)).toEqual(["z", "y", "x"]);
  });

  it("sorts a broken date last instead of throwing", () => {
    const list = [make({ id: "bad", started: "not a date" }), make({ id: "ok" })];
    expect(rankDisasters(list).map((d) => d.id)).toEqual(["ok", "bad"]);
  });
});

describe("disastersIn", () => {
  it("keeps only disasters naming the country, ranked", () => {
    const list = [
      make({ id: "a", countries: ["KE", "UG"] }),
      make({ id: "b", countries: ["US"] }),
      make({ id: "c", countries: ["KE"], severity: 2 }),
    ];
    expect(disastersIn(list, "KE").map((d) => d.id)).toEqual(["c", "a"]);
    expect(disastersIn(list, "FR")).toEqual([]);
  });
});

describe("findDisaster", () => {
  it("finds by id and returns null otherwise", () => {
    const list = [make({ id: "a" })];
    expect(findDisaster(list, "a")?.id).toBe("a");
    expect(findDisaster(list, "b")).toBeNull();
    expect(findDisaster(null, "a")).toBeNull();
    expect(findDisaster(list, null)).toBeNull();
  });
});

describe("countByType", () => {
  it("counts each type, most common first, ties in the metadata order", () => {
    const list = [
      make({ id: "1", type: "wildfire" }),
      make({ id: "2", type: "flood" }),
      make({ id: "3", type: "wildfire" }),
      make({ id: "4", type: "earthquake" }),
    ];
    expect(countByType(list)).toEqual([
      { type: "wildfire", count: 2 },
      { type: "earthquake", count: 1 },
      { type: "flood", count: 1 },
    ]);
    expect(countByType([])).toEqual([]);
  });
});

describe("typeCountLabel", () => {
  it("uses the singular for one and the plural otherwise", () => {
    expect(typeCountLabel({ type: "wildfire", count: 3 })).toBe("3 wildfires");
    expect(typeCountLabel({ type: "cyclone", count: 1 })).toBe("1 tropical cyclone");
  });
});

describe("shortDate", () => {
  it("gives day and month, adding the year only when it differs", () => {
    expect(shortDate("2026-10-07T00:00:00Z", NOW)).toBe("7 Oct");
    expect(shortDate("2025-12-30T00:00:00Z", NOW)).toBe("30 Dec 2025");
  });

  it("reads dates in UTC so midnight does not slip to the day before", () => {
    expect(shortDate("2026-10-14T00:00:00Z", NOW)).toBe("14 Oct");
    expect(shortDate("2026-10-14T23:30:00Z", NOW)).toBe("14 Oct");
  });

  it("returns an empty string for a broken date", () => {
    expect(shortDate("soon", NOW)).toBe("");
  });
});

describe("sinceLine", () => {
  it("joins the start date and the last update", () => {
    expect(sinceLine({ started: "2026-10-14T00:00:00Z", updated: "2026-10-19T18:00:00Z" }, NOW)).toBe("Since 14 Oct · updated 3 hours ago");
  });

  it("drops a missing half and keeps a capital letter", () => {
    expect(sinceLine({ started: "", updated: "2026-10-19T20:00:00Z" }, NOW)).toBe("Updated 1 hour ago");
    expect(sinceLine({ started: "2026-10-07T00:00:00Z", updated: "" }, NOW)).toBe("Since 7 Oct");
  });
});

describe("locationLine", () => {
  it("lists places then countries", () => {
    const d = make({
      id: "a",
      countries: ["US"],
      places: [
        { name: "Guam", country: "US", lat: 13, lng: 144, kind: "region", source: "research" },
        { name: "Saipan", country: "US", lat: 15, lng: 145, kind: "town", source: "research" },
      ],
    });
    expect(locationLine(d, nameOf)).toBe("Guam, Saipan · United States");
  });

  it("shortens long lists with a count", () => {
    const d = make({
      id: "a",
      countries: ["KE", "UG", "TZ", "CD"],
      places: ["A", "B", "C"].map((name) => ({ name, country: "KE", lat: 0, lng: 0, kind: "town" as const, source: "news" })),
    });
    expect(locationLine(d, nameOf)).toBe("A, B +1 · Kenya, Uganda +2");
    expect(locationLine(d, nameOf, { places: 1, countries: 1 })).toBe("A +2 · Kenya +3");
  });

  it("does not repeat a place that is the country itself", () => {
    const d = make({ id: "a", countries: ["LY"], places: [{ name: "Libya", country: "LY", lat: 0, lng: 0, kind: "region", source: "gdacs" }] });
    expect(locationLine(d, nameOf)).toBe("Libya");
  });

  it("leaves out bare point labels such as Epicentre", () => {
    const d = make({
      id: "a",
      type: "earthquake",
      countries: ["PK"],
      places: [
        { name: "Epicentre", country: "PK", lat: 28, lng: 66, kind: "site", impact: "48 km WNW of Khuzdar", source: "usgs" },
        { name: "Khuzdar", admin: "Balochistan", country: "PK", lat: 27.8, lng: 66.6, kind: "city", source: "research" },
      ],
    });
    expect(locationLine(d, nameOf)).toBe("Khuzdar · PK");
  });

  it("says At sea for a storm with no country, and nothing for a fire", () => {
    expect(locationLine(make({ id: "a", type: "cyclone" }), nameOf)).toBe("At sea");
    expect(locationLine(make({ id: "b", type: "wildfire" }), nameOf)).toBe("");
  });
});

describe("placeDetail", () => {
  it("joins the region and country, skipping blanks and repeats", () => {
    expect(placeDetail({ admin: "Northern Mariana Islands", country: "US" }, nameOf)).toBe("Northern Mariana Islands, United States");
    expect(placeDetail({ country: "KE" }, nameOf)).toBe("Kenya");
    expect(placeDetail({ admin: "Kenya", country: "KE" }, nameOf)).toBe("Kenya");
  });
});

describe("coordText", () => {
  it("writes hemispheres instead of signs", () => {
    expect(coordText(17.8, 141.6)).toBe("17.8°N 141.6°E");
    expect(coordText(-20.72, -156.8)).toBe("20.7°S 156.8°W");
  });
});

describe("centreLabel", () => {
  it("names the point by hazard", () => {
    expect(centreLabel("earthquake")).toBe("Epicentre");
    expect(centreLabel("cyclone")).toBe("Storm centre");
    expect(centreLabel("volcano")).toBe("Volcano");
    expect(centreLabel("flood")).toBe("Centre");
  });
});

describe("shortTitle", () => {
  it("keeps the part before the first comma", () => {
    expect(shortTitle("Wildfire Hatch Grade, Walla Walla, Washington")).toBe("Wildfire Hatch Grade");
    expect(shortTitle("India: Assam Flood, 2026")).toBe("India: Assam Flood");
  });

  it("keeps short heads whole and cuts long titles with an ellipsis", () => {
    expect(shortTitle("Mt X, Y")).toBe("Mt X, Y");
    expect(shortTitle("Drought in Uganda Kenya Tanzania and DR Congo", 20)).toBe("Drought in Uganda K…");
  });
});

describe("isSafeUrl and safeHref", () => {
  it("accepts absolute https links only", () => {
    expect(isSafeUrl("https://crisisrelief.un.org/")).toBe(true);
    expect(isSafeUrl("http://www.indianredcross.org/")).toBe(false);
    expect(isSafeUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeUrl("data:text/html,hi")).toBe(false);
    expect(isSafeUrl("/donate")).toBe(false);
    expect(isSafeUrl("https://user:pass@example.org/")).toBe(false);
    expect(isSafeUrl("https://localhost/")).toBe(false);
    expect(isSafeUrl(undefined)).toBe(false);
    expect(isSafeUrl(`https://example.org/${"a".repeat(2100)}`)).toBe(false);
  });

  it("returns the link or undefined", () => {
    expect(safeHref("https://go.ifrc.org/emergencies/1")).toBe("https://go.ifrc.org/emergencies/1");
    expect(safeHref("ftp://x.org")).toBeUndefined();
  });
});

describe("safeDonations", () => {
  it("drops unsafe links and repeats of the same page", () => {
    const links = [
      link({ url: "https://crisisrelief.un.org/" }),
      link({ url: "http://www.indianredcross.org/" }),
      link({ url: "https://CrisisRelief.un.org#top" }),
      link({ url: "https://www.ifrc.org/emergencies" }),
    ];
    expect(safeDonations(links).map((l) => l.url)).toEqual(["https://crisisrelief.un.org/", "https://www.ifrc.org/emergencies"]);
  });
});

describe("groupDonations", () => {
  it("groups by who runs the page, in a fixed order, keeping order within a group", () => {
    const links = [
      link({ url: "https://crisisrelief.un.org/", kind: "un" }),
      link({ url: "https://gov.example.org/fund", kind: "government" }),
      link({ url: "https://donate.redcrossredcrescent.org/ke/", kind: "society" }),
      link({ url: "https://www.ifrc.org/emergencies", kind: "appeal" }),
      link({ url: "https://www.unicef.org/emergencies", kind: "agency" }),
      link({ url: "http://unsafe.example.org/", kind: "society" }),
    ];
    const groups = groupDonations(links);
    expect(groups.map((g) => g.key)).toEqual(["redcross", "un", "agency", "government"]);
    expect(groups[0].label).toBe("Red Cross and Red Crescent");
    expect(groups[0].links.map((l) => l.kind)).toEqual(["society", "appeal"]);
  });

  it("returns no groups when nothing is safe", () => {
    expect(groupDonations([link({ url: "http://x.org/" })])).toEqual([]);
    expect(groupDonations([])).toEqual([]);
  });
});

describe("appealFunding", () => {
  it("gives the funded share and amounts in francs", () => {
    expect(appealFunding({ requested: 500000, funded: 220000 })).toEqual({ percent: 44, text: "CHF 220k of CHF 500k funded" });
  });

  it("says fully funded at or above the request", () => {
    expect(appealFunding({ requested: 500000, funded: 600000 })).toEqual({ percent: 100, text: "Fully funded: CHF 500k" });
  });

  it("has no percentage when nothing was requested", () => {
    expect(appealFunding({ requested: 0, funded: 0 })).toEqual({ percent: null, text: "Funding not reported" });
    expect(appealFunding({ requested: 0, funded: 1500000 })).toEqual({ percent: null, text: "CHF 1.5M funded" });
  });
});

describe("minor disasters", () => {
  const list = [make({ id: "minor", severity: 1 }), make({ id: "big", severity: 2 }), make({ id: "worst", severity: 3 })];

  it("keeps the significant and severe ones", () => {
    expect(isMinor({ severity: 1 })).toBe(true);
    expect(isMinor({ severity: 2 })).toBe(false);
    expect(significantOnly(list).map((x) => x.id)).toEqual(["big", "worst"]);
  });

  it("hides minor ones on the map unless shown, never the open one", () => {
    expect([...hiddenOnMap(list, { showMinor: false, openId: null })]).toEqual(["minor"]);
    expect(hiddenOnMap(list, { showMinor: true, openId: null }).size).toBe(0);
    expect(hiddenOnMap(list, { showMinor: false, openId: "minor" }).size).toBe(0);
  });
});
