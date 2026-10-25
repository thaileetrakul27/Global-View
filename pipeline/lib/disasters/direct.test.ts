import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ResearchResult } from "../ai";
import { loadGlobeFeatures } from "../countries";
import type { FetchDeps } from "../googlenews";
import { USER_AGENT } from "../googlenews";
import {
  FEED_BATCH,
  GLOBALGIVING_NOTE,
  GOFUNDME_FEED,
  GOFUNDME_INDEX,
  GOFUNDME_MAX_REQUESTS,
  HUB_KEEP_DAYS,
  MAX_FOUND_HUBS,
  MAX_LOCAL_CHECKS,
  MAX_SLUGS,
  VERIFIED_NOTE,
  buildDirectLinks,
  checkLocalPage,
  emptyGoFundMeCache,
  feedSlugs,
  feedUrl,
  focusOf,
  fundraiserSlugOf,
  fundraiserUrl,
  globalGivingLink,
  globalGivingPage,
  globalGivingProblem,
  gofundmeLinks,
  hazardFit,
  hopAllowed,
  hubEventName,
  hubMatches,
  hubSlugOf,
  hubUrl,
  hubUrlsIn,
  localNote,
  localUrlProblem,
  localVerdictKey,
  matchHub,
  normaliseGoFundMeCache,
  parseFeed,
  parseHub,
  parseHubIndex,
  partnerLinks,
  partnerUrl,
  placeNamedIn,
  placeNames,
  prepareDirectLinks,
  readGoFundMeCache,
  refreshGoFundMe,
  sameSite,
  slugWords,
  titlePlaces,
  verifyLocalPage,
  writeGoFundMeCache,
  type DirectInput,
  type GoFundMeCache,
  type GoFundMeHub,
  type LocalContext,
} from "./direct";
import { donationContext, emptyRegistry, loadGovernmentDomains, type DonationRegistry } from "./donate";
import type { DirectPage, ResearchEntry } from "./research";
import type { Disaster } from "./types";

const NOW = "2026-10-25T12:00:00.000Z";
const HOUR = 3_600_000;
const hoursAgo = (h: number) => new Date(Date.parse(NOW) - h * HOUR).toISOString();
const GOV = loadGovernmentDomains();
/** Every globe country's English name, as a run passes them. */
const NAMES: Record<string, string> = Object.fromEntries(loadGlobeFeatures().map((f) => [f.code, f.admin]));

/**
 * Live GoFundMe pages (2026-10-25), trimmed to their <main>: the crisis
 * index, four crisis pages and two answers of the feed the pages' own
 * script reads. See the fixture's _note.
 */
const FX = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "gofundme-pages.json"), "utf8")) as {
  index: string;
  hubs: Record<string, string>;
  feed: { melissa: unknown; funds: unknown };
};

/** A disaster as the integrator has it, with only what direct.ts reads. */
function disaster(p: Partial<Disaster> = {}): Pick<Disaster, "id" | "countries" | "type" | "title" | "places" | "appeals"> {
  return { id: "gdacs-cyclone-tc-1001200", countries: ["JM", "HT", "CU"], type: "cyclone", title: "Hurricane Melissa", places: [], appeals: [], ...p };
}

/** The allowlist context the integrator builds for a disaster. */
const ctxFor = (d: Pick<Disaster, "countries" | "title" | "appeals">, registry: DonationRegistry = emptyRegistry()) =>
  donationContext(d.countries, registry, GOV, { title: d.title, countryNames: NAMES, appeals: d.appeals });

const MELISSA = disaster();
const VENEZUELA = disaster({ id: "ifrc-earthquake-7990", countries: ["VE"], type: "earthquake", title: "Venezuela Earthquake" });

/** A crisis page as the cache holds it after a run read it. */
function hub(slug: string, over: Partial<GoFundMeHub> = {}): GoFundMeHub {
  return { slug, ...parseHub(FX.hubs[slug]), fundraisers: [], fetched: hoursAgo(1), feedFetched: hoursAgo(1), seen: hoursAgo(1), ...over };
}

function deps(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>): FetchDeps & { fetch: ReturnType<typeof vi.fn>; sleep: ReturnType<typeof vi.fn> } {
  return {
    fetch: vi.fn(async (u: string | URL | Request, init?: RequestInit) => fetchImpl(String(u), init)),
    sleep: vi.fn(async () => {}),
    log: () => {},
  } as unknown as FetchDeps & { fetch: ReturnType<typeof vi.fn>; sleep: ReturnType<typeof vi.fn> };
}

const html = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

describe("focusOf", () => {
  it("tells schools from homes and families, schools first, in English, Spanish and French", () => {
    expect(focusOf("Rebuild Eber Prep School After Hurricane Melissa")).toBe("schools");
    expect(focusOf("rebuild-rural-classrooms-in-jamaica-after-hurricane-melissa")).toBe("schools");
    expect(focusOf("Help St. Elizabeth Families Rebuild After Hurricane Melissa")).toBe("homes");
    expect(focusOf("ayudemos-a-reconstuir-el-hogar-de-mi-hija-tras-el-terremoto")).toBe("homes");
    expect(focusOf("Aidons les familles sinistrées et l'école")).toBe("schools");
    expect(focusOf("support-starlink-for-venezuela-earthquake-response")).toBe("other");
  });
});

describe("hazardFit", () => {
  it("says whether words name no hazard, one of the disaster's kind or another kind", () => {
    expect(hazardFit(["venezuela", "earthquake", "relief"], "earthquake")).toBe("fits");
    expect(hazardFit(["venezuela", "earthquake", "relief"], "flood")).toBe("other");
    expect(hazardFit(["hurricane", "melissa"], "flood")).toBe("fits");
    expect(hazardFit(["wildfire", "relief"], "cyclone")).toBe("other");
    expect(hazardFit(["public", "officials"], "earthquake")).toBe("none");
  });
});

describe("slugWords", () => {
  it("folds a slug or title into words and numbers", () => {
    expect(slugWords("Hurricane-Melissa-2025")).toEqual(["hurricane", "melissa", "2025"]);
    expect(slugWords("Ayuda a Venezuela: ¡terremoto!")).toEqual(["ayuda", "a", "venezuela", "terremoto"]);
  });
});

// ---------------------------------------------------------------------------
// GoFundMe URLs and pages
// ---------------------------------------------------------------------------

describe("crisis page and fundraiser URLs", () => {
  it("reads a crisis page's slug only from GoFundMe's own /c/act/<slug> over https", () => {
    expect(hubSlugOf("https://www.gofundme.com/c/act/hurricane-melissa")).toBe("hurricane-melissa");
    expect(hubSlugOf("https://gofundme.com/c/act/venezuela-earthquake-relief/")).toBe("venezuela-earthquake-relief");
    expect(hubSlugOf("/c/act/public-officials")).toBe("public-officials");
    // A page in another language, a sub-page, the index, another host, plain http.
    expect(hubSlugOf("https://www.gofundme.com/de-de/c/act/hurrikan-melissa")).toBeNull();
    expect(hubSlugOf("https://www.gofundme.com/c/act/wildfire-relief/california")).toBeNull();
    expect(hubSlugOf("https://www.gofundme.com/c/act")).toBeNull();
    expect(hubSlugOf("https://www.gofundme.com.evil.example/c/act/hurricane-melissa")).toBeNull();
    expect(hubSlugOf("http://www.gofundme.com/c/act/hurricane-melissa")).toBeNull();
    expect(hubUrl("hurricane-melissa")).toBe("https://www.gofundme.com/c/act/hurricane-melissa");
  });

  it("reads a fundraiser's slug, keeping GoFundMe's own spelling, and drops its tracking", () => {
    expect(fundraiserSlugOf("https://www.gofundme.com/f/help-airlift-earthquake-relief-to-venezuela?attribution_id=sl:c222")).toBe("help-airlift-earthquake-relief-to-venezuela");
    expect(fundraiserSlugOf("https://www.gofundme.com/f/CORE-Venezuela-Earthquakes")).toBe("CORE-Venezuela-Earthquakes");
    expect(fundraiserSlugOf("https://www.gofundme.com/f/x/donate")).toBeNull();
    expect(fundraiserSlugOf("https://www.gofundme.com/charity/direct-relief")).toBeNull();
    expect(fundraiserUrl("rebuild-eber-prep-school-after-hurricane-melissa")).toBe("https://www.gofundme.com/f/rebuild-eber-prep-school-after-hurricane-melissa");
  });

  it("finds the crisis pages a search returned or cited, each once, at most five", () => {
    const research: Pick<ResearchResult, "citations" | "results"> = {
      citations: [{ url: "https://www.gofundme.com/c/act/hurricane-melissa", title: "How to help", citedText: "" }],
      results: [
        { url: "https://www.gofundme.com/c/act/hurricane-melissa/", title: "How to help" },
        { url: "https://www.gofundme.com/f/some-fundraiser", title: "A fundraiser" },
        ...Array.from({ length: 8 }, (_, i) => ({ url: `https://www.gofundme.com/c/act/crisis-${i}`, title: "" })),
      ],
    };
    const hubs = hubUrlsIn(research);
    expect(hubs[0]).toBe("https://www.gofundme.com/c/act/hurricane-melissa");
    expect(hubs).toHaveLength(MAX_FOUND_HUBS);
  });
});

describe("parseHubIndex", () => {
  it("lists the crisis pages GoFundMe's index links (live page, 2026-10-25)", () => {
    // The wildfire page is linked only by its California sub-page, which is no crisis page here.
    expect(parseHubIndex(FX.index)).toEqual(["public-officials", "venezuela-earthquake-relief"]);
  });
});

describe("parseHub", () => {
  it("reads Hurricane Melissa's page: verified fundraisers with schools first, no Donate fund, its partners", () => {
    const page = parseHub(FX.hubs["hurricane-melissa"]);
    expect(page.title).toBe("How to help: Hurricane Melissa relief");
    expect(page.verified).toBe(true);
    expect(page.listed).toBe(122);
    expect(page.slugs).toHaveLength(MAX_SLUGS);
    expect(page.slugs.slice(0, 4)).toEqual([
      "rebuilding-hope-for-hamwalk-primary-school",
      "rebuild-rural-classrooms-in-jamaica-after-hurricane-melissa",
      "rebuild-eber-prep-school-after-hurricane-melissa",
      "rebuild-a-school-rebuild-a-nation",
    ]);
    expect(page.fund).toBeNull();
    // GEM's page for the hurricane, whose text speaks of schools; Project C.U.R.E.'s without its _gl tracking.
    expect(page.partners).toContainEqual({ url: "https://www.globalempowermentmission.org/mission/hurricane-melissa/?campaign=738134&c_src=hurricane-melissa", name: "GEM", focus: "schools" });
    expect(page.partners.find((p) => p.name === "Project C.U.R.E.")?.url).toBe("https://give.projectcure.org/give/440765#!/donation/checkout");
    expect(page.partners.find((p) => p.name === "AH&H")?.focus).toBe("homes");
  });

  it("reads the Venezuela page's Donate fund and leaves out GoFundMe's general charity profiles", () => {
    const page = parseHub(FX.hubs["venezuela-earthquake-relief"]);
    expect(page.title).toBe("How you can help: Venezuela earthquakes");
    expect(page.fund).toBe("https://www.gofundme.com/f/emergency-relief-for-venezuela-earthquake-victims");
    expect(page.partners.map((p) => p.url).some((u) => u.includes("/charity/"))).toBe(false);
    // A nonprofit's fundraiser on GoFundMe, without its attribution query; a campaign on GoFundMe's giving host.
    expect(page.partners).toContainEqual({ url: "https://www.gofundme.com/f/help-airlift-earthquake-relief-to-venezuela", name: "Airlink", focus: "other" });
    expect(page.partners.find((p) => p.name === "Observatorio De La Diaspora Venezolana")?.url).toBe("https://giving.gofundme.com/campaign/823612/donate?c_src=Venezuela_earthquake");
    // "AH&H’s disaster relief team": the name without its possessive.
    expect(page.partners.some((p) => p.name === "AH&H")).toBe(true);
  });

  it("finds nothing verified on the wildfire and public officials pages", () => {
    for (const slug of ["wildfire-relief", "public-officials"]) {
      const page = parseHub(FX.hubs[slug]);
      expect(page.verified).toBe(false);
      expect(page.slugs).toEqual([]);
      expect(page.partners).toEqual([]);
    }
  });
});

describe("partnerUrl", () => {
  it("keeps https partner pages without tracking, and refuses social, shared, shortened, home and charity-profile links", () => {
    expect(partnerUrl("https://my.americares.org/campaign/757046/donate?utm_source=web&utm_medium=web&c_src=DI26J5Z2")).toBe("https://my.americares.org/campaign/757046/donate?c_src=DI26J5Z2");
    expect(partnerUrl("https://www.gofundme.com/f/earthquake-emergency-in-venezuela")).toBe("https://www.gofundme.com/f/earthquake-emergency-in-venezuela");
    expect(partnerUrl("https://www.gofundme.com/charity/mercy-corps")).toBeNull();
    expect(partnerUrl("https://www.facebook.com/gofundme")).toBeNull();
    expect(partnerUrl("https://bit.ly/abc")).toBeNull();
    expect(partnerUrl("https://www.directrelief.org/")).toBeNull();
    expect(partnerUrl("http://give.wtw.org/campaign/815988/donate")).toBeNull();
    expect(partnerUrl("not a url")).toBeNull();
  });
});

describe("the feed", () => {
  it("asks for the Donate fund first, then fundraisers for schools, then homes and families, twelve at most", () => {
    const venezuela = parseHub(FX.hubs["venezuela-earthquake-relief"]);
    const slugs = feedSlugs(venezuela);
    expect(slugs[0]).toBe("emergency-relief-for-venezuela-earthquake-victims");
    expect(slugs).toHaveLength(FEED_BATCH);
    expect(feedSlugs(parseHub(FX.hubs["hurricane-melissa"]))[0]).toBe("rebuilding-hope-for-hamwalk-primary-school");
    expect(feedUrl(["a-b", "C-d"])).toBe(`${GOFUNDME_FEED}?slugs=a-b&slugs=C-d`);
  });

  it("reads the names, categories and donation counts of the feed's answer (live, 2026-10-25)", () => {
    const melissa = parseFeed(FX.feed.melissa);
    expect(melissa).toHaveLength(5);
    expect(melissa.find((f) => f.slug === "rebuild-eber-prep-school-after-hurricane-melissa")).toEqual({
      slug: "rebuild-eber-prep-school-after-hurricane-melissa",
      name: "Rebuild Eber Prep School After Hurricane Melissa",
      category: "Emergencies",
      donations: 60,
      lastDonation: "2025-12-21 10:47:07",
    });
    expect(parseFeed(FX.feed.funds).find((f) => f.slug === "donate-to-support-communities-affected-by-hurricane-melissa")?.lastDonation).toBeNull();
    expect(parseFeed({ data: [{ url: "../x", fund_name: "Bad" }, { url: "ok", fund_name: "" }, null] })).toEqual([]);
    expect(parseFeed("nope")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GoFundMe: the cache and its refresh
// ---------------------------------------------------------------------------

describe("GoFundMe cache", () => {
  it("round-trips through disk and drops what does not check out", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gv-gofundme-"));
    const file = path.join(dir, "gofundme.json");
    const cache: GoFundMeCache = { index: { fetched: NOW, slugs: ["venezuela-earthquake-relief"] }, hubs: { "hurricane-melissa": hub("hurricane-melissa", { fundraisers: parseFeed(FX.feed.melissa) }) } };
    writeGoFundMeCache(cache, file);
    expect(readGoFundMeCache(file)).toEqual(cache);
    expect(readGoFundMeCache(path.join(dir, "missing.json"))).toEqual(emptyGoFundMeCache());
    const damaged = normaliseGoFundMeCache({
      index: { fetched: "yesterday", slugs: ["ok-slug", "Bad Slug", 3] },
      hubs: { "Bad Slug": { seen: NOW }, "no-seen": {}, kept: { seen: NOW, partners: [{ url: "https://www.facebook.com/x", name: "FB" }], fund: "https://evil.example/f/x", fundraisers: [{ slug: "a", name: "A" }] } },
    });
    expect(damaged.index).toEqual({ fetched: null, slugs: ["ok-slug"] });
    expect(Object.keys(damaged.hubs)).toEqual(["kept"]);
    expect(damaged.hubs.kept).toMatchObject({ title: "", verified: false, fund: null, partners: [], fetched: null, listed: 0 });
    expect(damaged.hubs.kept.fundraisers).toEqual([{ slug: "a", name: "A", category: "", donations: 0, lastDonation: null }]);
    expect(normaliseGoFundMeCache(null)).toEqual(emptyGoFundMeCache());
  });
});

describe("refreshGoFundMe", () => {
  /** GoFundMe as it answered on 2026-10-25. */
  function gofundme(over: Record<string, () => Response> = {}) {
    return deps(async (url) => {
      if (over[url]) return over[url]();
      if (url === GOFUNDME_INDEX) return html(FX.index);
      const slug = hubSlugOf(url);
      if (slug && FX.hubs[slug]) return html(FX.hubs[slug]);
      if (url.startsWith(GOFUNDME_FEED)) return json(url.includes("hurricane-melissa") ? FX.feed.melissa : FX.feed.funds);
      return new Response("", { status: 404 });
    });
  }
  const wantsVenezuela = (h: GoFundMeHub) => hubMatches(h, VENEZUELA, ctxFor(VENEZUELA));

  it("reads the index, its crisis pages and the feed for the one a disaster matches, a second and a half apart, with the pipeline's user agent", async () => {
    const d = gofundme();
    const cache = await refreshGoFundMe(emptyGoFundMeCache(), d, NOW, { wanted: wantsVenezuela });
    const urls = d.fetch.mock.calls.map(([u]) => String(u));
    expect(urls[0]).toBe(GOFUNDME_INDEX);
    // The matching page first, then the other index page; then its feed.
    expect(urls.slice(1, 3)).toEqual([hubUrl("venezuela-earthquake-relief"), hubUrl("public-officials")]);
    expect(urls[3].startsWith(`${GOFUNDME_FEED}?slugs=emergency-relief-for-venezuela-earthquake-victims&`)).toBe(true);
    expect(urls).toHaveLength(4);
    expect(d.fetch.mock.calls.every(([, init]) => (init as RequestInit).headers && (init?.headers as Record<string, string>)["User-Agent"] === USER_AGENT)).toBe(true);
    expect(d.sleep.mock.calls.every(([ms]) => ms >= 1_000)).toBe(true);
    expect(d.sleep).toHaveBeenCalledTimes(3);
    expect(cache.index).toEqual({ fetched: NOW, slugs: ["public-officials", "venezuela-earthquake-relief"] });
    const venezuela = cache.hubs["venezuela-earthquake-relief"];
    expect(venezuela).toMatchObject({ fetched: NOW, feedFetched: NOW, seen: NOW, verified: true });
    expect(venezuela.fundraisers.map((f) => f.slug)).toContain("emergency-relief-for-venezuela-earthquake-victims");
    // A page no disaster matches is read, but its feed is not.
    expect(cache.hubs["public-officials"]).toMatchObject({ fetched: NOW, feedFetched: null });
  });

  it("makes no request while everything is younger than twelve hours", async () => {
    const d = gofundme();
    const first = await refreshGoFundMe(emptyGoFundMeCache(), d, hoursAgo(11), { wanted: wantsVenezuela });
    d.fetch.mockClear();
    await refreshGoFundMe(first, d, NOW, { wanted: wantsVenezuela });
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("reads a crisis page research found though the index no longer lists it", async () => {
    const d = gofundme();
    const prev: GoFundMeCache = { index: { fetched: hoursAgo(1), slugs: ["venezuela-earthquake-relief"] }, hubs: {} };
    const cache = await refreshGoFundMe(prev, d, NOW, {
      found: ["https://www.gofundme.com/c/act/hurricane-melissa"],
      wanted: (h) => hubMatches(h, MELISSA, ctxFor(MELISSA)),
    });
    expect(cache.hubs["hurricane-melissa"]).toMatchObject({ fetched: NOW, feedFetched: NOW, title: "How to help: Hurricane Melissa relief" });
    expect(cache.hubs["hurricane-melissa"].fundraisers).toHaveLength(5);
  });

  it("keeps the previous data when a request fails, and drops a page that is gone", async () => {
    const prev: GoFundMeCache = {
      index: { fetched: hoursAgo(13), slugs: ["venezuela-earthquake-relief", "old-crisis"] },
      hubs: { "venezuela-earthquake-relief": hub("venezuela-earthquake-relief", { fetched: hoursAgo(13), feedFetched: hoursAgo(13) }), "old-crisis": hub("hurricane-melissa", { slug: "old-crisis", fetched: hoursAgo(200) }) },
    };
    const d = gofundme({
      [GOFUNDME_INDEX]: () => new Response("", { status: 503 }),
      [hubUrl("venezuela-earthquake-relief")]: () => {
        throw new Error("network down");
      },
      [hubUrl("old-crisis")]: () => new Response("", { status: 404 }),
    });
    const cache = await refreshGoFundMe(prev, d, NOW, { wanted: wantsVenezuela });
    expect(cache.index).toEqual(prev.index);
    expect(cache.hubs["venezuela-earthquake-relief"].fetched).toBe(hoursAgo(13));
    expect(cache.hubs["old-crisis"]).toBeUndefined();
  });

  it("never makes more than its cap of requests", async () => {
    const found = Array.from({ length: 12 }, (_, i) => `https://www.gofundme.com/c/act/crisis-${i}`);
    const d = gofundme();
    await refreshGoFundMe(emptyGoFundMeCache(), d, NOW, { found });
    expect(d.fetch).toHaveBeenCalledTimes(GOFUNDME_MAX_REQUESTS);
    const two = gofundme();
    await refreshGoFundMe(emptyGoFundMeCache(), two, NOW, { found, maxRequests: 2 });
    expect(two.fetch).toHaveBeenCalledTimes(2);
  });

  it("forgets a page neither listed nor found for thirty days, unless a disaster matches it", async () => {
    const old = new Date(Date.parse(NOW) - (HUB_KEEP_DAYS + 1) * 24 * HOUR).toISOString();
    const prev: GoFundMeCache = {
      index: { fetched: hoursAgo(1), slugs: [] },
      hubs: { "venezuela-earthquake-relief": hub("venezuela-earthquake-relief", { seen: old }), "hurricane-melissa": hub("hurricane-melissa", { seen: old }) },
    };
    const cache = await refreshGoFundMe(prev, gofundme(), NOW, { wanted: wantsVenezuela, maxRequests: 0 });
    expect(Object.keys(cache.hubs)).toEqual(["venezuela-earthquake-relief"]);
  });
});

// ---------------------------------------------------------------------------
// GoFundMe: matching and links
// ---------------------------------------------------------------------------

describe("hubMatches", () => {
  const pages = ["hurricane-melissa", "venezuela-earthquake-relief", "wildfire-relief", "public-officials"].map((slug) => ({ slug, title: parseHub(FX.hubs[slug]).title }));
  const matches = (d: ReturnType<typeof disaster>) => pages.filter((p) => hubMatches(p, d, ctxFor(d))).map((p) => p.slug);

  it("ties each real crisis page to its own disaster only", () => {
    expect(matches(MELISSA)).toEqual(["hurricane-melissa"]);
    expect(matches(VENEZUELA)).toEqual(["venezuela-earthquake-relief"]);
    // IFRC's title for the hurricane's floods in Jamaica names its storm.
    expect(matches(disaster({ type: "flood", countries: ["JM"], title: "Jamaica: Floods after Hurricane Melissa" }))).toEqual(["hurricane-melissa"]);
  });

  it("matches nothing for another disaster in the same country, a quake elsewhere, or a wildfire", () => {
    expect(matches(disaster({ type: "flood", countries: ["VE"], title: "Venezuela: Floods" }))).toEqual([]);
    expect(matches(disaster({ type: "earthquake", countries: ["CO"], title: "Colombia - Earthquake" }))).toEqual([]);
    expect(matches(disaster({ type: "cyclone", countries: ["JM"], title: "Hurricane Vance" }))).toEqual([]);
    expect(matches(disaster({ type: "wildfire", countries: ["US"], title: "Wildfire in California" }))).toEqual([]);
    expect(matches(disaster({ type: "cyclone", countries: ["MX"], title: "Hurricane Vance" }))).toEqual([]);
  });

  it("needs a hazard of the disaster's kind with a country, so a page for a country's crisis is no flood's", () => {
    expect(hubMatches({ slug: "support-ukraine", title: "How to help Ukraine" }, disaster({ type: "flood", countries: ["UA"], title: "Ukraine: Floods" }), ctxFor(disaster({ countries: ["UA"], title: "Ukraine: Floods" })))).toBe(false);
    // A page naming two countries is no single country's disaster's.
    const tr = disaster({ type: "earthquake", countries: ["TR"], title: "Earthquake in Turkey" });
    expect(hubMatches({ slug: "turkiye-syria-earthquake", title: "" }, tr, ctxFor(tr))).toBe(false);
    expect(hubMatches({ slug: "turkiye-earthquake", title: "" }, tr, ctxFor(tr))).toBe(true);
  });

  it("matches nothing without every country's names", () => {
    expect(hubMatches({ slug: "hurricane-melissa", title: "" }, MELISSA, { eventWords: ["melissa"] })).toBe(false);
  });
});

describe("matchHub", () => {
  it("takes the first read, verified page that matches, the index's first", () => {
    const cache: GoFundMeCache = {
      index: { fetched: NOW, slugs: ["venezuela-earthquake-relief"] },
      hubs: {
        "venezuela-earthquake-relief-es": { ...hub("venezuela-earthquake-relief"), slug: "venezuela-earthquake-relief-es" },
        "venezuela-earthquake-relief": hub("venezuela-earthquake-relief"),
        "hurricane-melissa": hub("hurricane-melissa", { fetched: null }),
      },
    };
    expect(matchHub(cache, VENEZUELA, ctxFor(VENEZUELA))?.slug).toBe("venezuela-earthquake-relief");
    // Known only by its URL until it is read.
    expect(matchHub(cache, MELISSA, ctxFor(MELISSA))).toBeNull();
    cache.hubs["venezuela-earthquake-relief"].verified = false;
    expect(matchHub(cache, VENEZUELA, ctxFor(VENEZUELA))?.slug).toBe("venezuela-earthquake-relief-es");
  });
});

describe("hubEventName", () => {
  it("reads the event from a crisis page's heading", () => {
    expect(hubEventName("How to help: Hurricane Melissa relief")).toBe("Hurricane Melissa");
    expect(hubEventName("How you can help: Venezuela earthquakes")).toBe("Venezuela earthquakes");
    expect(hubEventName("How to help those impacted by Venezuela earthquakes | GoFundMe")).toBe("Venezuela earthquakes");
    expect(hubEventName("")).toBeNull();
    expect(hubEventName("Relief: a very long heading that goes on and on about many different things at once")).toBeNull();
  });
});

describe("gofundmeLinks and partnerLinks", () => {
  it("lists Hurricane Melissa's verified page, then its school fundraisers, three in all", () => {
    const links = gofundmeLinks(hub("hurricane-melissa", { fundraisers: parseFeed(FX.feed.melissa) }));
    expect(links).toEqual([
      { label: "Verified fundraisers for Hurricane Melissa", url: "https://www.gofundme.com/c/act/hurricane-melissa", org: "GoFundMe", kind: "fundraiser", note: VERIFIED_NOTE, via: "platform", forEvent: true },
      { label: "Rebuild Hamwalk Primary School in Jamaica post Hurricane Mel", url: fundraiserUrl("rebuilding-hope-for-hamwalk-primary-school"), org: "GoFundMe", kind: "fundraiser", note: VERIFIED_NOTE, via: "platform", forEvent: true },
      // Three name a school; the two with the most donations (76 and 63, not Eber Prep's 60).
      { label: "School Recovery Relief after Hurricane Melissa", url: fundraiserUrl("rebuild-rural-classrooms-in-jamaica-after-hurricane-melissa"), org: "GoFundMe", kind: "fundraiser", note: VERIFIED_NOTE, via: "platform", forEvent: true },
    ]);
  });

  it("puts the Donate fund second when the feed named it, and lists only the page without names", () => {
    const venezuela = hub("venezuela-earthquake-relief", { fundraisers: parseFeed(FX.feed.funds) });
    const links = gofundmeLinks(venezuela);
    expect(links.map((l) => l.url)).toEqual([hubUrl("venezuela-earthquake-relief"), fundraiserUrl("emergency-relief-for-venezuela-earthquake-victims")]);
    expect(links[1]).toMatchObject({ label: "Emergency Relief for Venezuela Earthquake Victims", note: "Featured by GoFundMe on its verified page for this disaster" });
    expect(gofundmeLinks(hub("venezuela-earthquake-relief"))).toHaveLength(1);
    expect(gofundmeLinks(hub("venezuela-earthquake-relief", { verified: false }))).toEqual([]);
  });

  it("lists two partners, schools first", () => {
    const links = partnerLinks(hub("hurricane-melissa"));
    expect(links).toEqual([
      {
        label: "Donate to GEM",
        url: "https://www.globalempowermentmission.org/mission/hurricane-melissa/?campaign=738134&c_src=hurricane-melissa",
        org: "GEM",
        kind: "project",
        note: "A nonprofit GoFundMe lists as a vetted partner for this disaster",
        via: "platform",
        forEvent: true,
      },
      expect.objectContaining({ org: "AH&H", kind: "project" }),
    ]);
    expect(partnerLinks(hub("hurricane-melissa", { verified: false }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GlobalGiving
// ---------------------------------------------------------------------------

describe("globalGivingPage", () => {
  it("takes project and fundraiser pages at their usual address, nothing else", () => {
    expect(globalGivingPage("https://globalgiving.org/projects/Hurricane-Melissa-Relief-Fund")).toEqual({ url: "https://www.globalgiving.org/projects/hurricane-melissa-relief-fund/", slug: "hurricane-melissa-relief-fund" });
    expect(globalGivingPage("https://www.globalgiving.org/fundraisers/rebuild-st-elizabeth/?rf=x")?.url).toBe("https://www.globalgiving.org/fundraisers/rebuild-st-elizabeth/");
    expect(globalGivingPage("https://www.globalgiving.org/projects/x/reports/")).toBeNull();
    expect(globalGivingPage("https://www.globalgiving.org/search/?keywords=melissa")).toBeNull();
    expect(globalGivingPage("http://www.globalgiving.org/projects/x/")).toBeNull();
    expect(globalGivingPage("https://www.globalgiving.org.evil.example/projects/x/")).toBeNull();
  });
});

describe("globalGivingProblem", () => {
  const gg = (slug: string, title = ""): Pick<DirectPage, "url" | "title"> => ({ url: `https://www.globalgiving.org/projects/${slug}/`, title });
  const problem = (page: Pick<DirectPage, "url" | "title">, d = MELISSA) => globalGivingProblem(page, d, ctxFor(d), NOW);

  it("accepts a fund named for the storm, or for the country and its hazard", () => {
    expect(problem(gg("hurricane-melissa-relief-fund", "Hurricane Melissa Relief Fund - GlobalGiving"))).toBeNull();
    expect(problem(gg("jamaica-hurricane-recovery"))).toBeNull();
    expect(problem(gg("venezuela-earthquake-relief-fund"), VENEZUELA)).toBeNull();
    // The title can name the place when the slug does not.
    expect(problem(gg("rebuild-schools-after-the-storm", "Rebuild Jamaica's schools after Hurricane Melissa"))).toBeNull();
    // A recent year stands in for the hazard.
    expect(problem(gg("jamaica-recovery-2026"))).toBeNull();
  });

  it("refuses another country's, an earlier disaster's, another hazard's and a general fund", () => {
    expect(problem(gg("colombia-earthquake-relief"), VENEZUELA)).toBe("names another country");
    expect(problem(gg("venezuela-earthquake-relief-fund", "Venezuela and Colombia Earthquake Fund"), VENEZUELA)).toBe("names another country");
    expect(problem(gg("hurricane-beryl-jamaica-2024"))).toBe("an earlier disaster's project (2024)");
    expect(problem(gg("jamaica-relief", "Jamaica Relief 2023"))).toMatch(/^an earlier disaster's project/);
    expect(problem(gg("jamaica-earthquake-fund"))).toBe("names another kind of disaster");
    expect(problem(gg("disaster-recovery-fund"))).toBe("names none of the disaster's places");
    expect(problem(gg("jamaica-education-fund"))).toBe("names neither the hazard, a place in the title nor a recent year");
    expect(problem({ url: "https://www.globalgiving.org/search/", title: "" })).toBe("not a GlobalGiving project page");
  });
});

describe("globalGivingLink", () => {
  it("labels a project by its search title when that is the project's, else by its slug", () => {
    expect(globalGivingLink({ url: "https://www.globalgiving.org/projects/hurricane-melissa-relief-fund/", title: "Hurricane Melissa Relief Fund - GlobalGiving" })).toEqual({
      label: "Hurricane Melissa Relief Fund",
      url: "https://www.globalgiving.org/projects/hurricane-melissa-relief-fund/",
      org: "GlobalGiving",
      kind: "project",
      note: GLOBALGIVING_NOTE,
      via: "research",
      forEvent: true,
    });
    expect(globalGivingLink({ url: "https://www.globalgiving.org/projects/jamaica-hurricane-recovery/", title: "October 03, 2026" })?.label).toBe("Jamaica Hurricane Recovery");
    expect(globalGivingLink({ url: "https://example.org/x", title: "" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Local groups' pages
// ---------------------------------------------------------------------------

describe("localUrlProblem", () => {
  // The American Red Cross is another country's society: still no local group.
  const local: LocalContext = { donation: ctxFor(MELISSA), societyHosts: ["redcross.org"], newsHosts: new Set(["jamaica-gleaner.com", "radiojamaicanewsonline.com"]) };

  it("accepts a local group's own page", () => {
    expect(localUrlProblem("https://www.ebercollege.edu.jm/rebuild-after-melissa/donate", local)).toBeNull();
    expect(localUrlProblem("https://stelizabethrelief.org/give?campaign=melissa", local)).toBeNull();
  });

  it("refuses unsafe URLs, shared and social sites, platforms, marketplaces, news and official sites, and home pages", () => {
    const cases: [string, string][] = [
      ["http://stelizabethrelief.org/give", "not https"],
      ["https://user:pw@stelizabethrelief.org/give", "has credentials"],
      ["https://stelizabethrelief.org:8443/give", "has a port"],
      ["https://203.0.113.9/give", "IP address host"],
      ["https://xn--80ak6aa92e.com/give", "punycode host"],
      ["https://bit.ly/melissa", "URL shortener"],
      ["https://www.facebook.com/groups/melissa-relief", "social network or a site anyone can publish on"],
      ["https://melissa-relief.wixsite.com/home/donate", "social network or a site anyone can publish on"],
      ["https://www.reddit.com/r/jamaica/comments/x", "social network or a site anyone can publish on"],
      ["https://www.gofundme.com/f/rebuild-eber-prep-school-after-hurricane-melissa", "crowdfunding or giving platform"],
      ["https://www.globalgiving.org/projects/hurricane-melissa-relief-fund/", "crowdfunding or giving platform"],
      ["https://www.justgiving.com/crowdfunding/melissa", "crowdfunding or giving platform"],
      ["https://www.amazon.co.uk/hz/wishlist/ls/melissa", "marketplace"],
      ["https://jamaica-gleaner.com/article/news/20251030/how-help", "news site"],
      ["https://radiojamaicanewsonline.com/local/donate-melissa", "news site"],
      ["https://www.redcross.org/donate/hurricane-melissa.html", "official site, listed with the official links"],
      ["https://www.unicef.org/jamaica/donate", "official site, listed with the official links"],
      ["https://www.odpem.gov.jm/donate", "official site, listed with the official links"],
      ["https://www.state.gov/hurricane-melissa", "official site, listed with the official links"],
      ["https://stelizabethrelief.org/blood-drive", "blood donation page"],
      ["https://stelizabethrelief.org/search?q=melissa", "listing or search page"],
      ["https://stelizabethrelief.org/", "home page, not a page for this disaster"],
    ];
    for (const [url, why] of cases) expect([url, localUrlProblem(url, local)]).toEqual([url, why]);
  });
});

describe("sameSite and hopAllowed", () => {
  const local: LocalContext = { donation: ctxFor(MELISSA) };
  it("treats www, the bare host and subdomains as one site, never a registry suffix", () => {
    expect(sameSite("www.ebercollege.edu.jm", "ebercollege.edu.jm")).toBe(true);
    expect(sameSite("donate.ebercollege.edu.jm", "www.ebercollege.edu.jm")).toBe(true);
    expect(sameSite("ebercollege.edu.jm", "othercollege.edu.jm")).toBe(false);
    expect(sameSite("ebercollege.co.uk", "co.uk")).toBe(false);
  });

  it("allows a hop on the same site to a page that may be shown, nothing else", () => {
    expect(hopAllowed("stelizabethrelief.org", "https://www.stelizabethrelief.org/give/", local)).toBe(true);
    expect(hopAllowed("stelizabethrelief.org", "https://www.stelizabethrelief.org/", local)).toBe(false);
    expect(hopAllowed("stelizabethrelief.org", "https://www.paypal.com/donate?hosted_button_id=1", local)).toBe(false);
    expect(hopAllowed("stelizabethrelief.org", "not a url", local)).toBe(false);
  });
});

describe("placeNames and placeNamedIn", () => {
  it("names the countries in English and their press language, the disaster's places and its title's place words", () => {
    const d = disaster({ countries: ["JM", "HT"], places: [{ name: "Black River", country: "JM", lat: 18, lng: -77.8, kind: "town", source: "research" }] });
    expect(placeNames(d, NAMES, { HT: "Ayiti" }, ["melissa"])).toEqual(["Jamaica", "Haiti", "Ayiti", "Black River", "melissa"]);
    // Each name once, accents aside; nothing too short.
    expect(placeNames(disaster({ countries: ["HT"] }), { HT: "Haiti" }, { HT: "Haïti" }, ["bo"])).toEqual(["Haiti"]);
  });

  it("reads the title's places as the title writes them, runs joined", () => {
    expect(titlePlaces("Bangladesh: Monsoon Depression in Cox's Bazar", ["cox", "bazar"])).toEqual(["Cox's Bazar"]);
    expect(titlePlaces("Congo: Floods in the department of likouala, districts of Epéna and Impfondo", ["likouala", "epena", "impfondo"])).toEqual(["likouala", "Epéna", "Impfondo"]);
    expect(titlePlaces("Hurricane Melissa", ["melissa"])).toEqual(["Melissa"]);
    expect(titlePlaces("Venezuela Earthquake", [])).toEqual([]);
  });

  it("finds a whole name on the page, in any script", () => {
    expect(placeNamedIn("<h1>Rebuild Black River Primary</h1>", ["Jamaica", "Black River"])).toBe("Black River");
    expect(placeNamedIn("<p>Jamaican pride</p>", ["Jamaica"])).toBeNull();
    expect(placeNamedIn("<p>支援四川灾区</p>", ["四川"])).toBe("四川");
    expect(placeNamedIn("<p>Aide aux sinistrés en Haïti</p>", ["Haiti"])).toBe("Haiti");
  });
});

describe("checkLocalPage", () => {
  const local: LocalContext = { donation: ctxFor(MELISSA) };
  const names = ["Jamaica", "St. Elizabeth", "melissa"];
  const URL0 = "https://stelizabethrelief.org/hurricane-melissa/donate";

  it("passes a live page with a donation word that names the disaster's place", async () => {
    const d = deps(async () => html("<h1>Rebuild St. Elizabeth</h1><a>Donate now</a>"));
    expect(await checkLocalPage(URL0, d, local, names)).toEqual({ ok: true, reason: 'donation word "donat*", names "St. Elizabeth"', chain: [URL0], place: "St. Elizabeth" });
    expect(d.fetch.mock.calls[0][1]).toMatchObject({ redirect: "manual", headers: { "User-Agent": USER_AGENT } });
  });

  it("fails a page without a donation word, or naming no place of the disaster's", async () => {
    expect(await checkLocalPage(URL0, deps(async () => html("<h1>Rebuild St. Elizabeth</h1>")), local, names)).toMatchObject({ ok: false, reason: "no donation word on the page" });
    expect(await checkLocalPage(URL0, deps(async () => html("<h1>Donate to our school in Ohio</h1>")), local, names)).toMatchObject({ ok: false, reason: "names none of the disaster's places" });
  });

  it("follows redirects on the same site only", async () => {
    const moved = deps(async (u) => (u === URL0 ? new Response(null, { status: 301, headers: { location: "/melissa/give/" } }) : html("<p>Donate to Jamaica relief</p>")));
    expect(await checkLocalPage(URL0, moved, local, names)).toMatchObject({ ok: true, chain: [URL0, "https://stelizabethrelief.org/melissa/give/"] });
    const away = deps(async () => new Response(null, { status: 302, headers: { location: "https://www.paypal.com/donate?id=1" } }));
    expect(await checkLocalPage(URL0, away, local, names)).toMatchObject({ ok: false, reason: "redirect leaves the site or reaches a page that may not be shown" });
    const home = deps(async () => new Response(null, { status: 302, headers: { location: "https://stelizabethrelief.org/" } }));
    expect((await checkLocalPage(URL0, home, local, names))?.ok).toBe(false);
  });

  it("fails a bot wall, a missing page and a non-HTML answer; tries once more after a server error; refuses a bad URL unfetched", async () => {
    expect(await checkLocalPage(URL0, deps(async () => new Response("", { status: 403 })), local, names)).toMatchObject({ ok: false, reason: "HTTP 403" });
    expect(await checkLocalPage(URL0, deps(async () => new Response("", { status: 404 })), local, names)).toMatchObject({ ok: false, reason: "HTTP 404" });
    expect(await checkLocalPage(URL0, deps(async () => json({ donate: "Jamaica" })), local, names)).toMatchObject({ ok: false });
    const flaky = deps(async () => new Response("", { status: 503 }));
    expect(await checkLocalPage(URL0, flaky, local, names)).toBeNull();
    expect(flaky.fetch).toHaveBeenCalledTimes(2);
    const none = deps(async () => html(""));
    expect(await checkLocalPage("https://www.facebook.com/x", none, local, names)).toMatchObject({ ok: false, reason: "social network or a site anyone can publish on" });
    expect(none.fetch).not.toHaveBeenCalled();
  });
});

describe("verifyLocalPage", () => {
  const local: LocalContext = { donation: ctxFor(MELISSA) };
  const URL0 = "https://stelizabethrelief.org/hurricane-melissa/donate";

  it("caches its verdict per disaster in the registry, and reuses it", async () => {
    const registry = emptyRegistry();
    const d = deps(async () => html("<p>Donate for Jamaica</p>"));
    expect(await verifyLocalPage(URL0, "d1", d, local, ["Jamaica"], registry, NOW)).toBe(true);
    expect(registry.verdicts[localVerdictKey("d1", URL0)]).toMatchObject({ ok: true, checked: NOW, place: "Jamaica" });
    expect(localVerdictKey("d1", URL0)).toBe("local:d1:stelizabethrelief.org/hurricane-melissa/donate");
    expect(await verifyLocalPage(URL0, "d1", d, local, ["Jamaica"], registry, NOW)).toBe(true);
    expect(d.fetch).toHaveBeenCalledTimes(1);
    // A URL the rules refuse is neither fetched nor cached.
    expect(await verifyLocalPage("https://bit.ly/x", "d1", d, local, ["Jamaica"], registry, NOW)).toBe(false);
    expect(Object.keys(registry.verdicts)).toHaveLength(1);
  });

  it("caches nothing when no verdict could be had", async () => {
    const registry = emptyRegistry();
    expect(await verifyLocalPage(URL0, "d1", deps(async () => Promise.reject(new Error("down"))), local, ["Jamaica"], registry, NOW)).toBe(false);
    expect(registry.verdicts).toEqual({});
  });
});

describe("localNote", () => {
  it("says who checked the page, and that the group is not vouched for", () => {
    expect(localNote("St. Elizabeth")).toBe("A local group's own page. Global View checked it is live and names St. Elizabeth, but cannot vouch for the group.");
    expect(localNote(undefined)).toContain("names the disaster's place");
  });
});

// ---------------------------------------------------------------------------
// The direct links for one disaster
// ---------------------------------------------------------------------------

describe("buildDirectLinks and prepareDirectLinks", () => {
  const SCHOOL = "https://www.ebercollege.edu.jm/rebuild-after-melissa/donate";
  const NEWS = "https://jamaica-gleaner.com/article/news/how-to-help";
  const pages: DirectPage[] = [
    { url: "https://www.globalgiving.org/projects/hurricane-melissa-relief-fund/", org: "GlobalGiving", kind: "globalgiving", note: "", title: "Hurricane Melissa Relief Fund - GlobalGiving" },
    { url: "https://www.globalgiving.org/projects/hurricane-beryl-jamaica-2024/", org: "GlobalGiving", kind: "globalgiving", note: "", title: "" },
    { url: SCHOOL, org: "Eber Preparatory School", kind: "local", note: "Rebuilding classrooms", title: "" },
    { url: NEWS, org: "The Gleaner", kind: "local", note: "", title: "" },
  ];
  const entry = { direct: pages } as ResearchEntry;
  const gofundme: GoFundMeCache = { index: { fetched: NOW, slugs: [] }, hubs: { "hurricane-melissa": hub("hurricane-melissa", { fundraisers: parseFeed(FX.feed.melissa) }) } };
  const input = (over: Partial<DirectInput> = {}): DirectInput => ({
    disaster: { ...MELISSA, places: [{ name: "Black River", country: "JM", lat: 18, lng: -77.8, kind: "town", source: "research" }] },
    entry,
    gofundme,
    ctx: ctxFor(MELISSA),
    countryNames: NAMES,
    pressNames: {},
    newsHosts: new Set(["jamaica-gleaner.com"]),
    ...over,
  });

  it("checks the local page live, then lists GoFundMe's, the projects in turn and the local page", async () => {
    const registry = emptyRegistry();
    const d = deps(async (u) => (u === SCHOOL ? html("<h1>Rebuild Eber Prep in Black River</h1><a>Donate</a>") : new Response("", { status: 404 })));
    const links = await prepareDirectLinks(input(), registry, d, NOW);
    // The news page is refused unfetched; GlobalGiving is never fetched.
    expect(d.fetch.mock.calls.map(([u]) => String(u))).toEqual([SCHOOL]);
    expect(links.map((l) => [l.kind, l.org])).toEqual([
      ["fundraiser", "GoFundMe"],
      ["fundraiser", "GoFundMe"],
      ["fundraiser", "GoFundMe"],
      ["project", "GlobalGiving"],
      ["project", "GEM"],
      ["project", "AH&H"],
      ["local", "Eber Preparatory School"],
    ]);
    expect(links[6]).toEqual({ label: "Donate to Eber Preparatory School", url: SCHOOL, org: "Eber Preparatory School", kind: "local", note: localNote("Black River"), via: "research", forEvent: true });
    // From the caches alone the same list comes back.
    expect(buildDirectLinks(input(), registry, NOW)).toEqual(links);
  });

  it("checks at most three local pages a run, and none it has a fresh verdict for", async () => {
    const many = Array.from({ length: 5 }, (_, i): DirectPage => ({ url: `https://school${i}.edu.jm/melissa/donate`, org: `School ${i}`, kind: "local", note: "", title: "" }));
    const registry = emptyRegistry();
    const d = deps(async () => html("<p>Donate to Jamaica</p>"));
    await prepareDirectLinks(input({ entry: { direct: many } as ResearchEntry }), registry, d, NOW);
    expect(d.fetch).toHaveBeenCalledTimes(MAX_LOCAL_CHECKS);
    d.fetch.mockClear();
    await prepareDirectLinks(input({ entry: { direct: many } as ResearchEntry }), registry, d, NOW);
    expect(d.fetch).toHaveBeenCalledTimes(2);
  });

  it("drops a cached pass once its page or a hop is refused, and lists nothing without a matching crisis page or pages", () => {
    const registry = emptyRegistry();
    registry.verdicts[localVerdictKey(MELISSA.id, SCHOOL)] = { ok: true, reason: "", checked: NOW, chain: [SCHOOL, "https://www.paypal.com/donate"], place: "Jamaica" };
    expect(buildDirectLinks(input(), registry, NOW).some((l) => l.kind === "local")).toBe(false);
    expect(buildDirectLinks(input({ gofundme: emptyGoFundMeCache(), entry: undefined }), registry, NOW)).toEqual([]);
  });
});
