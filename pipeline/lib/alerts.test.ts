import { describe, expect, it } from "vitest";
import { buildResolver, fetchAlerts, normaliseName, parseAlerts } from "./alerts";

const features = [
  { code: "MX", name: "Mexico", admin: "Mexico", iso3: "MEX" },
  { code: "CD", name: "Dem. Rep. Congo", admin: "Democratic Republic of the Congo", iso3: "COD" },
  { code: "KE", name: "Kenya", admin: "Kenya", iso3: "KEN" },
  { code: "TR", name: "Turkey", admin: "Turkey", iso3: "TUR" },
  { code: "BA", name: "Bosnia and Herz.", admin: "Bosnia and Herzegovina", iso3: "BIH" },
];
const resolve = buildResolver(features);
const now = "2026-10-18T12:00:00.000Z";

const item = (fields: Record<string, string>) =>
  `<item>${Object.entries(fields)
    .map(([k, v]) => `<${k}>${v}</${k}>`)
    .join("")}</item>`;
const feed = (items: string[]) => `<?xml version="1.0"?><rss version="2.0" xmlns:gdacs="http://www.gdacs.org"><channel>${items.join("")}</channel></rss>`;

const cyclone = item({
  title: "Orange notification for tropical cyclone SIMON-26.",
  description: "From 07/10/2026 to 16/10/2026, a Tropical Depression SIMON-26 was active in EastPacific.",
  link: "https://www.gdacs.org/report.aspx?eventtype=TC&amp;eventid=1001335",
  "gdacs:eventid": "1001335",
  "gdacs:eventtype": "TC",
  "gdacs:alertlevel": "Orange",
  "gdacs:eventname": "SIMON-26",
  "gdacs:iso3": "MEX",
  "gdacs:country": "México",
  "gdacs:fromdate": "Wed, 07 Oct 2026 00:00:00 GMT",
  "gdacs:todate": "Fri, 16 Oct 2026 00:00:00 GMT",
});
const drought = item({
  title: "Drought is on going in Democratic Republic of Congo, Kenya, Atlantis",
  description: "The Drought notification level is Red.",
  link: "https://www.gdacs.org/report.aspx?eventtype=DR&amp;eventid=1027465",
  "gdacs:eventid": "1027465",
  "gdacs:eventtype": "DR",
  "gdacs:alertlevel": "Red",
  "gdacs:eventname": "",
  "gdacs:iso3": "COD",
  "gdacs:country": "Democratic Republic of Congo, Kenya, Atlantis",
  "gdacs:fromdate": "Thu, 21 May 2026 00:00:00 GMT",
  "gdacs:todate": "Fri, 16 Oct 2026 00:00:00 GMT",
});
const green = item({
  title: "Green earthquake in Turkey",
  "gdacs:eventid": "1",
  "gdacs:eventtype": "EQ",
  "gdacs:alertlevel": "Green",
  "gdacs:iso3": "TUR",
  "gdacs:country": "Türkiye",
  "gdacs:fromdate": "Sat, 17 Oct 2026 00:00:00 GMT",
  "gdacs:todate": "Sat, 17 Oct 2026 00:00:00 GMT",
});
const stale = item({
  title: "Orange flood in Turkey",
  "gdacs:eventid": "2",
  "gdacs:eventtype": "FL",
  "gdacs:alertlevel": "Orange",
  "gdacs:iso3": "TUR",
  "gdacs:country": "Türkiye",
  "gdacs:fromdate": "Mon, 01 Sep 2026 00:00:00 GMT",
  "gdacs:todate": "Mon, 07 Sep 2026 00:00:00 GMT",
});
const offMap = item({
  title: "Red notification for tropical cyclone CHAMPI-26.",
  "gdacs:eventid": "3",
  "gdacs:eventtype": "TC",
  "gdacs:alertlevel": "Red",
  "gdacs:iso3": "GUM",
  "gdacs:country": "Guam, Northern Mariana Islands",
  "gdacs:fromdate": "Wed, 14 Oct 2026 00:00:00 GMT",
  "gdacs:todate": "Sun, 18 Oct 2026 00:00:00 GMT",
});

describe("normaliseName", () => {
  it("lines up accents, ampersands and articles", () => {
    expect(normaliseName("México")).toBe("mexico");
    expect(normaliseName("Bosnia & Herzegovina")).toBe("bosnia and herzegovina");
    expect(normaliseName("The Bahamas")).toBe("bahamas");
    expect(normaliseName("Democratic Republic of the Congo")).toBe("democratic republic of congo");
  });
});

describe("buildResolver", () => {
  it("resolves by ISO3, by map name, by full name and by alias", () => {
    expect(resolve.byIso3("mex")).toBe("MX");
    expect(resolve.byName("Dem. Rep. Congo")).toBe("CD");
    expect(resolve.byName("Democratic Republic of Congo")).toBe("CD");
    expect(resolve.byName("Türkiye")).toBe("TR");
    expect(resolve.byName("Bosnia & Herzegovina")).toBe("BA");
    expect(resolve.byName("Atlantis")).toBeUndefined();
  });
});

describe("parseAlerts", () => {
  it("keeps recent Orange and Red alerts the globe can show, Red first", () => {
    const out = parseAlerts(feed([cyclone, drought, green, stale, offMap]), resolve, now);
    expect(out.map((a) => a.id)).toEqual(["1027465", "1001335"]);
    expect(out[1]).toMatchObject({
      type: "cyclone",
      level: "Orange",
      description: "From 07/10/2026 to 16/10/2026, a Tropical Depression SIMON-26 was active in EastPacific.",
      name: "SIMON-26",
      countries: ["MX"],
      from: "2026-10-07T00:00:00.000Z",
      to: "2026-10-16T00:00:00.000Z",
      url: "https://www.gdacs.org/report.aspx?eventtype=TC&eventid=1001335",
    });
    expect(out[0]).toMatchObject({ type: "drought", level: "Red", name: null, description: null, countries: ["CD", "KE"] });
  });
  it("keeps a Red alert longer than an Orange one", () => {
    const later = "2026-10-30T12:00:00.000Z";
    expect(parseAlerts(feed([cyclone, drought]), resolve, later).map((a) => a.id)).toEqual(["1027465"]);
  });
  it("handles a single item and an empty channel", () => {
    expect(parseAlerts(feed([cyclone]), resolve, now)).toHaveLength(1);
    expect(parseAlerts(feed([]), resolve, now)).toEqual([]);
  });
  it("rejects a non-XML body", () => {
    expect(() => parseAlerts("<html><body>Blocked", resolve, now)).toThrow(/Not a GDACS feed/);
  });
});

describe("fetchAlerts", () => {
  const deps = (res: () => Promise<Response>) => ({ fetch: res as unknown as typeof fetch, sleep: async () => {}, log: () => {} });
  it("returns parsed alerts on success", async () => {
    const out = await fetchAlerts(resolve, now, deps(async () => new Response(feed([cyclone]), { status: 200 })));
    expect(out?.map((a) => a.id)).toEqual(["1001335"]);
  });
  it("retries once, then returns null on an HTTP error or a network failure", async () => {
    let calls = 0;
    const flaky = async () => (++calls === 1 ? new Response("", { status: 503 }) : new Response(feed([cyclone]), { status: 200 }));
    expect((await fetchAlerts(resolve, now, deps(flaky), undefined, 0))?.length).toBe(1);
    expect(calls).toBe(2);
    expect(await fetchAlerts(resolve, now, deps(async () => new Response("", { status: 503 })), undefined, 0)).toBeNull();
    expect(await fetchAlerts(resolve, now, deps(async () => Promise.reject(new Error("offline"))), undefined, 0)).toBeNull();
  });
});
