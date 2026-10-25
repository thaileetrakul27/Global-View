import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ResearchResult } from "../ai";
import { loadGlobeFeatures } from "../countries";
import type { FetchDeps } from "../googlenews";
import { USER_AGENT } from "../googlenews";
import {
  FAILED_RETRY_HOURS,
  FEED_BATCH,
  GLOBALGIVING_NOTE,
  GOFUNDME_FEED,
  GOFUNDME_INDEX,
  GOFUNDME_MAX_REQUESTS,
  GONE_RETRY_DAYS,
  HUB_KEEP_DAYS,
  MAX_FOUND_HUBS,
  MAX_LOCAL_CHECKS,
  MAX_SLUGS,
  VERIFIED_NOTE,
  blankHub,
  buildDirectLinks,
  checkLocalPage,
  earlierEventProblem,
  emptyGoFundMeCache,
  eventYear,
  failureHolds,
  feedSlugs,
  feedUrl,
  focusOf,
  fundraiserSlugOf,
  fundraiserUrl,
  givenSince,
  globalGivingLink,
  globalGivingPage,
  globalGivingProblem,
  gofundmeLinks,
  hazardFit,
  hopAllowed,
  hubDatesFit,
  hubEventName,
  hubMatches,
  hubSlugOf,
  hubUrl,
  hubUrlsIn,
  hubWanted,
  isNamedStorm,
  localAddressProblem,
  localLabel,
  localNote,
  localOrg,
  localPageProblem,
  localRules,
  localUrlProblem,
  localVerdictKey,
  matchHub,
  normaliseGoFundMeCache,
  otherStorm,
  parseFeed,
  parseHub,
  parseHubIndex,
  partnerLinks,
  partnerUrl,
  pathProblem,
  placeNamedIn,
  placeNames,
  prepareDirectLinks,
  protectedNameIn,
  protectedNameInHost,
  publishedOf,
  readGoFundMeCache,
  readPageSelf,
  refreshGoFundMe,
  sameSite,
  slugWords,
  stormAftermath,
  titlePlaces,
  verifyLocalPage,
  writeGoFundMeCache,
  type DirectInput,
  type GoFundMeCache,
  type GoFundMeHub,
  type LocalContext,
  type LocalPageRules,
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

/** A disaster as the integrator has it, with only what direct.ts reads; Hurricane Melissa (it formed on 21 October 2025) by default. */
function disaster(p: Partial<Disaster> = {}): Pick<Disaster, "id" | "countries" | "type" | "title" | "places" | "appeals" | "started"> {
  return { id: "gdacs-cyclone-tc-1001200", countries: ["JM", "HT", "CU"], type: "cyclone", title: "Hurricane Melissa", places: [], appeals: [], started: "2025-10-21T12:00:00.000Z", ...p };
}

/** The allowlist context the integrator builds for a disaster. */
const ctxFor = (d: Pick<Disaster, "countries" | "title" | "appeals">, registry: DonationRegistry = emptyRegistry()) =>
  donationContext(d.countries, registry, GOV, { title: d.title, countryNames: NAMES, appeals: d.appeals });

const MELISSA = disaster();
/** The Venezuela earthquakes, whose crisis page GoFundMe published on 26 June 2026. */
const VENEZUELA = disaster({ id: "ifrc-earthquake-7990", countries: ["VE"], type: "earthquake", title: "Venezuela Earthquake", started: "2026-06-24T00:00:00.000Z" });

/** A crisis page as the cache holds it after a run read it. */
function hub(slug: string, over: Partial<GoFundMeHub> = {}): GoFundMeHub {
  return { slug, ...parseHub(FX.hubs[slug]), fundraisers: [], fetched: hoursAgo(1), feedFetched: hoursAgo(1), seen: hoursAgo(1), failure: null, ...over };
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
    expect(hazardFit(["wildfire", "relief"], "cyclone")).toBe("other");
    expect(hazardFit(["public", "officials"], "earthquake")).toBe("none");
  });

  it("reads hazards strictly: an earthquake's words fit its tsunami but no landslide, a flood's only a flood, a storm's no flood", () => {
    expect(hazardFit(["earthquake"], "tsunami")).toBe("fits");
    expect(hazardFit(["earthquake"], "landslide")).toBe("other");
    expect(hazardFit(["pakistan", "flood", "relief"], "cyclone")).toBe("other");
    expect(hazardFit(["pakistan", "flood", "relief"], "landslide")).toBe("other");
    expect(hazardFit(["hurricane", "melissa"], "flood")).toBe("other");
    expect(hazardFit(["typhoon"], "storm")).toBe("fits");
  });
});

describe("stormAftermath", () => {
  it("lets a storm's words stand for the floods and landslides it brings, and nothing else", () => {
    expect(stormAftermath(["hurricane", "melissa"], "flood")).toBe(true);
    expect(stormAftermath(["hurricane", "melissa", "floods"], "landslide")).toBe(false);
    expect(stormAftermath(["typhoon", "landslides"], "landslide")).toBe(true);
    expect(stormAftermath(["hurricane", "melissa"], "earthquake")).toBe(false);
    expect(stormAftermath(["earthquake", "relief"], "flood")).toBe(false);
  });
});

describe("otherStorm", () => {
  const ctx = ctxFor(MELISSA);
  it("finds a storm's name that is not the disaster's", () => {
    expect(otherStorm(["help", "jamaica", "recover", "from", "hurricane", "beryl"], ctx)).toBe("beryl");
    expect(otherStorm(slugWords("Donate: 2024 Huracán Beryl"), ctx)).toBe("beryl");
    expect(otherStorm(["storm", "boelo"], ctx)).toBe("boelo");
  });

  it("passes the disaster's own storm, a country, and words that follow storms", () => {
    expect(otherStorm(["hurricane", "melissa", "relief"], ctx)).toBeNull();
    expect(otherStorm(["hurricane", "relief", "fund"], ctx)).toBeNull();
    expect(otherStorm(["storm", "season", "appeal"], ctx)).toBeNull();
    expect(otherStorm(["hurricane", "jamaica"], ctx)).toBeNull();
    expect(otherStorm(["earthquake", "beryl"], ctx)).toBeNull();
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
    expect(page.published).toBe("2025-10-28T21:31:37.000Z");
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
    expect(page.published).toBe("2026-06-26T20:23:08.000Z");
    expect(page.fund).toBe("https://www.gofundme.com/f/emergency-relief-for-venezuela-earthquake-victims");
    expect(page.partners.map((p) => p.url).some((u) => u.includes("/charity/"))).toBe(false);
    // A nonprofit's fundraiser on GoFundMe, without its attribution query; a campaign on GoFundMe's giving host.
    expect(page.partners).toContainEqual({ url: "https://www.gofundme.com/f/help-airlift-earthquake-relief-to-venezuela", name: "Airlink", focus: "other" });
    expect(page.partners.find((p) => p.name === "Observatorio De La Diaspora Venezolana")?.url).toBe("https://giving.gofundme.com/campaign/823612/donate?c_src=Venezuela_earthquake");
    // "AH&H’s disaster relief team": the name without its possessive.
    expect(page.partners.some((p) => p.name === "AH&H")).toBe(true);
  });

  it("reads Morocco's 2023 earthquake page, still verified and dated by its JSON-LD", () => {
    const page = parseHub(FX.hubs["morocco-earthquake-relief"]);
    expect(page.verified).toBe(true);
    expect(page.published).toBe("2023-09-09T18:02:37.000Z");
    expect(page.listed).toBe(80);
    expect(page.slugs).toContain("morocco-earthquake-2023-help-us-rebuild-lives");
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

describe("publishedOf", () => {
  it("reads a page's WebPage datePublished, else any node's, else its article:published_time", () => {
    const ld = (data: unknown) => `<script type="application/ld+json">${JSON.stringify(data)}</script>`;
    expect(publishedOf(ld({ "@graph": [{ "@type": "Organization", datePublished: "2001-01-01" }, { "@type": "WebPage", datePublished: "2026-06-26T20:23:08+00:00" }] }))).toBe("2026-06-26T20:23:08.000Z");
    expect(publishedOf(ld([{ "@type": "NewsArticle", datePublished: "2025-10-29" }]))).toBe("2025-10-29T00:00:00.000Z");
    expect(publishedOf(`<script type="application/ld+json">{broken</script><meta property="article:published_time" content="2024-07-02T10:00:00Z">`)).toBe("2024-07-02T10:00:00.000Z");
    expect(publishedOf("<p>no date</p>")).toBeNull();
    expect(publishedOf(ld({ "@type": "WebPage", datePublished: "soon" }))).toBeNull();
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
    expect(damaged.hubs.kept).toMatchObject({ title: "", verified: false, fund: null, partners: [], fetched: null, listed: 0, published: null, failure: null });
    expect(damaged.hubs.kept.fundraisers).toEqual([{ slug: "a", name: "A", category: "", donations: 0, lastDonation: null }]);
    expect(normaliseGoFundMeCache(null)).toEqual(emptyGoFundMeCache());
  });

  it("keeps a failure record that checks out, and a file written before there were any still loads", () => {
    const failures = normaliseGoFundMeCache({
      hubs: {
        gone: { seen: NOW, failure: { at: NOW, kind: "gone" } },
        moved: { seen: NOW, failure: { at: NOW, kind: "moved", to: "hurricane-beryl-help" } },
        "bad-move": { seen: NOW, failure: { at: NOW, kind: "moved", to: "../x" } },
        odd: { seen: NOW, failure: { at: "never", kind: "failed" } },
        old: { seen: NOW, title: "How to help", published: "2025-10-28T21:31:37+00:00" },
      },
    });
    expect(failures.hubs.gone.failure).toEqual({ at: NOW, kind: "gone" });
    expect(failures.hubs.moved.failure).toEqual({ at: NOW, kind: "moved", to: "hurricane-beryl-help" });
    expect(failures.hubs["bad-move"].failure).toBeNull();
    expect(failures.hubs.odd.failure).toBeNull();
    expect(failures.hubs.old).toMatchObject({ failure: null, published: "2025-10-28T21:31:37.000Z" });
    expect(blankHub("x", NOW)).toEqual(normaliseGoFundMeCache({ hubs: { x: { seen: NOW } } }).hubs.x);
  });
});

describe("failureHolds", () => {
  it("bars a page for 12 hours after a failure and 7 days after it went or moved", () => {
    expect(failureHolds(null, NOW)).toBe(false);
    expect(failureHolds({ at: hoursAgo(FAILED_RETRY_HOURS - 1), kind: "failed" }, NOW)).toBe(true);
    expect(failureHolds({ at: hoursAgo(FAILED_RETRY_HOURS), kind: "failed" }, NOW)).toBe(false);
    expect(failureHolds({ at: hoursAgo(GONE_RETRY_DAYS * 24 - 1), kind: "gone" }, NOW)).toBe(true);
    expect(failureHolds({ at: hoursAgo(GONE_RETRY_DAYS * 24 - 1), kind: "moved", to: "x" }, NOW)).toBe(true);
    expect(failureHolds({ at: hoursAgo(GONE_RETRY_DAYS * 24), kind: "gone" }, NOW)).toBe(false);
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
  const wantsVenezuela = (h: GoFundMeHub) => hubWanted(h, VENEZUELA, ctxFor(VENEZUELA));
  const urlsOf = (d: ReturnType<typeof gofundme>) => d.fetch.mock.calls.map(([u]) => String(u));

  it("reads the index, then the page a disaster wants and its feed, then the other pages, a second and a half apart, with the pipeline's user agent", async () => {
    const d = gofundme();
    const cache = await refreshGoFundMe(emptyGoFundMeCache(), d, NOW, { wanted: wantsVenezuela });
    const urls = urlsOf(d);
    expect(urls[0]).toBe(GOFUNDME_INDEX);
    // The matching page and right away its feed; then the other index page.
    expect(urls[1]).toBe(hubUrl("venezuela-earthquake-relief"));
    expect(urls[2].startsWith(`${GOFUNDME_FEED}?slugs=emergency-relief-for-venezuela-earthquake-victims&`)).toBe(true);
    expect(urls[3]).toBe(hubUrl("public-officials"));
    expect(urls).toHaveLength(4);
    expect(d.fetch.mock.calls.every(([, init]) => (init as RequestInit).headers && (init?.headers as Record<string, string>)["User-Agent"] === USER_AGENT)).toBe(true);
    expect(d.sleep.mock.calls.every(([ms]) => ms >= 1_000)).toBe(true);
    expect(d.sleep).toHaveBeenCalledTimes(3);
    expect(cache.index).toEqual({ fetched: NOW, slugs: ["public-officials", "venezuela-earthquake-relief"] });
    const venezuela = cache.hubs["venezuela-earthquake-relief"];
    expect(venezuela).toMatchObject({ fetched: NOW, feedFetched: NOW, seen: NOW, verified: true, published: "2026-06-26T20:23:08.000Z", failure: null });
    expect(venezuela.fundraisers.map((f) => f.slug)).toContain("emergency-relief-for-venezuela-earthquake-victims");
    // A page no disaster matches is read, but its feed is not.
    expect(cache.hubs["public-officials"]).toMatchObject({ fetched: NOW, feedFetched: null });
  });

  it("asks for the feed of the page a disaster wants before reading pages no disaster wants, within the cap", async () => {
    const d = gofundme();
    const found = ["https://www.gofundme.com/c/act/aaa-crisis", "https://www.gofundme.com/c/act/bbb-crisis"];
    await refreshGoFundMe(emptyGoFundMeCache(), d, NOW, { wanted: wantsVenezuela, found, maxRequests: 3 });
    expect(urlsOf(d)[2].startsWith(GOFUNDME_FEED)).toBe(true);
  });

  it("asks for no feed for a page whose date does not fit the disaster", async () => {
    const later = disaster({ countries: ["VE"], type: "earthquake", title: "Venezuela Earthquake", started: "2026-10-20T00:00:00.000Z" });
    const d = gofundme();
    const cache = await refreshGoFundMe(emptyGoFundMeCache(), d, NOW, { wanted: (h) => hubWanted(h, later, ctxFor(later)) });
    expect(urlsOf(d).some((u) => u.startsWith(GOFUNDME_FEED))).toBe(false);
    expect(cache.hubs["venezuela-earthquake-relief"]).toMatchObject({ fetched: NOW, feedFetched: null });
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
      wanted: (h) => hubWanted(h, MELISSA, ctxFor(MELISSA)),
    });
    expect(cache.hubs["hurricane-melissa"]).toMatchObject({ fetched: NOW, feedFetched: NOW, title: "How to help: Hurricane Melissa relief" });
    expect(cache.hubs["hurricane-melissa"].fundraisers).toHaveLength(5);
  });

  it("keeps the previous data when a request fails; a page that is gone loses its data and is kept as gone", async () => {
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
    expect(cache.hubs["venezuela-earthquake-relief"]).toMatchObject({ fetched: hoursAgo(13), verified: true, failure: { at: NOW, kind: "failed" } });
    expect(cache.hubs["old-crisis"]).toMatchObject({ fetched: null, verified: false, title: "", failure: { at: NOW, kind: "gone" } });
    // The feed is still asked for: the page's previous data stands.
    expect(urlsOf(d).some((u) => u.startsWith(GOFUNDME_FEED))).toBe(true);
  });

  it("does not ask again for a page that failed for 12 hours, or one that is gone for 7 days, though research keeps finding them", async () => {
    const found = ["https://www.gofundme.com/c/act/myanmar-earthquake", "https://www.gofundme.com/c/act/blocked-one", "https://www.gofundme.com/c/act/flaky-one"];
    const d = gofundme({
      // An index that fails leaves only the pages research found.
      [GOFUNDME_INDEX]: () => new Response("", { status: 503 }),
      [hubUrl("blocked-one")]: () => new Response("", { status: 403 }),
      [hubUrl("flaky-one")]: () => {
        throw new Error("reset");
      },
    });
    const at = (h: number) => new Date(Date.parse(NOW) + h * HOUR).toISOString();
    let cache = emptyGoFundMeCache();
    const asked: string[][] = [];
    for (const h of [0, 2, 4, 12, 14, 7 * 24]) {
      d.fetch.mockClear();
      cache = await refreshGoFundMe(cache, d, at(h), { found });
      asked.push(urlsOf(d).filter((u) => u !== GOFUNDME_INDEX).map((u) => u.replace("https://www.gofundme.com/c/act/", "")));
    }
    expect(asked).toEqual([
      ["blocked-one", "flaky-one", "myanmar-earthquake"],
      [],
      [],
      ["blocked-one", "flaky-one"],
      [],
      ["blocked-one", "flaky-one", "myanmar-earthquake"],
    ]);
    expect(cache.hubs["myanmar-earthquake"].failure?.kind).toBe("gone");
  });

  it("follows a crisis page that moved to another one, reads that one at once, and asks for neither again soon", async () => {
    const d = gofundme({
      [hubUrl("hurricane-beryl")]: () => new Response("", { status: 301, headers: { location: "/c/act/hurricane-beryl-help" } }),
      [hubUrl("hurricane-beryl-help")]: () => html(FX.hubs["hurricane-melissa"]),
      [hubUrl("moved-away")]: () => new Response("", { status: 301, headers: { location: "https://www.gofundme.com/c/" } }),
    });
    const found = ["https://www.gofundme.com/c/act/hurricane-beryl", "https://www.gofundme.com/c/act/moved-away"];
    const prev: GoFundMeCache = { index: { fetched: NOW, slugs: [] }, hubs: {} };
    const cache = await refreshGoFundMe(prev, d, NOW, { found });
    expect(urlsOf(d)).toEqual([hubUrl("hurricane-beryl"), hubUrl("hurricane-beryl-help"), hubUrl("moved-away")]);
    expect(cache.hubs["hurricane-beryl"]).toMatchObject({ fetched: null, failure: { at: NOW, kind: "moved", to: "hurricane-beryl-help" } });
    expect(cache.hubs["hurricane-beryl-help"]).toMatchObject({ fetched: NOW, verified: true, seen: NOW });
    // A redirect off GoFundMe's crisis pages is a page gone.
    expect(cache.hubs["moved-away"].failure?.kind).toBe("gone");
    d.fetch.mockClear();
    const later = new Date(Date.parse(NOW) + 2 * HOUR).toISOString();
    const next = await refreshGoFundMe(cache, d, later, { found });
    expect(d.fetch).not.toHaveBeenCalled();
    // Found again by its old address, the page it moved to stays seen.
    expect(next.hubs["hurricane-beryl-help"].seen).toBe(later);
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

  it("reads hazards strictly: an earthquake page is a tsunami's but no landslide's, a flood page no cyclone's", () => {
    const venezuela = pages[1];
    const landslide = disaster({ type: "landslide", countries: ["VE"], title: "Landslide in Mérida, Venezuela" });
    expect(hubMatches(venezuela, landslide, ctxFor(landslide))).toBe(false);
    const tsunami = disaster({ type: "tsunami", countries: ["VE"], title: "Tsunami in Venezuela" });
    expect(hubMatches(venezuela, tsunami, ctxFor(tsunami))).toBe(true);
    const flood = { slug: "pakistan-flood-relief", title: "How to help: Pakistan flood relief" };
    for (const [type, title] of [["cyclone", "Tropical Cyclone BIPARJOY-26"], ["landslide", "Pakistan: Landslides"]] as const) {
      const d = disaster({ type, countries: ["PK"], title });
      expect(hubMatches(flood, d, ctxFor(d))).toBe(false);
    }
  });

  it("refuses a page that names another storm, though it names the country and the hazard", () => {
    const jm = disaster({ countries: ["JM"] });
    expect(hubMatches({ slug: "jamaica-hurricane-beryl-relief", title: "" }, jm, ctxFor(jm))).toBe(false);
    expect(hubMatches({ slug: "jamaica-hurricane-relief", title: "" }, jm, ctxFor(jm))).toBe(true);
  });
});

describe("hubDatesFit and hubWanted", () => {
  const morocco = { slug: "morocco-earthquake-relief", ...parseHub(FX.hubs["morocco-earthquake-relief"]), fetched: NOW };
  const quake = (started: string) => disaster({ type: "earthquake", countries: ["MA"], title: "M 6.2 - 50 km SW of Marrakesh, Morocco", started });

  it("ties Morocco's 2023 page to the 2023 earthquake only, not to a new one near Marrakesh", () => {
    const now = quake("2026-10-24T03:00:00.000Z");
    // By its name alone it would match.
    expect(hubMatches(morocco, now, ctxFor(now))).toBe(true);
    expect(hubDatesFit(morocco, now)).toBe(false);
    expect(hubWanted(morocco, now, ctxFor(now))).toBe(false);
    const then = quake("2023-09-08T22:11:00.000Z");
    expect(hubDatesFit(morocco, then)).toBe(true);
    expect(hubWanted(morocco, then, ctxFor(then))).toBe(true);
  });

  it("allows a page published up to 14 days before the start and 45 after, longer for slow disasters", () => {
    const at = (published: string) => ({ published });
    const d = (type: Disaster["type"]) => ({ type, started: "2026-06-24T00:00:00.000Z" });
    expect(hubDatesFit(at("2026-06-10T01:00:00.000Z"), d("earthquake"))).toBe(true);
    expect(hubDatesFit(at("2026-06-09T00:00:00.000Z"), d("earthquake"))).toBe(false);
    expect(hubDatesFit(at("2026-08-08T00:00:00.000Z"), d("earthquake"))).toBe(true);
    expect(hubDatesFit(at("2026-08-09T01:00:00.000Z"), d("earthquake"))).toBe(false);
    expect(hubDatesFit(at("2026-10-01T00:00:00.000Z"), d("flood"))).toBe(true);
    expect(hubDatesFit(at("2027-05-01T00:00:00.000Z"), d("drought"))).toBe(true);
    expect(hubDatesFit({ published: null }, d("earthquake"))).toBe(false);
  });

  it("wants a page not yet read by its name alone", () => {
    const later = disaster({ countries: ["VE"], type: "earthquake", title: "Venezuela Earthquake", started: "2026-10-20T00:00:00.000Z" });
    expect(hubWanted({ ...blankHub("venezuela-earthquake-relief", NOW) }, later, ctxFor(later))).toBe(true);
    expect(hubWanted(hub("venezuela-earthquake-relief"), later, ctxFor(later))).toBe(false);
    expect(hubWanted(hub("venezuela-earthquake-relief"), VENEZUELA, ctxFor(VENEZUELA))).toBe(true);
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

  it("matches no page of an earlier event: Morocco's 2023 page for a new quake, Venezuela's June page for an October quake or a landslide", () => {
    const cache: GoFundMeCache = {
      index: { fetched: NOW, slugs: ["venezuela-earthquake-relief"] },
      hubs: { "venezuela-earthquake-relief": hub("venezuela-earthquake-relief"), "morocco-earthquake-relief": hub("morocco-earthquake-relief") },
    };
    for (const d of [
      disaster({ type: "earthquake", countries: ["MA"], title: "M 6.2 - 50 km SW of Marrakesh, Morocco", started: "2026-10-24T03:00:00.000Z" }),
      disaster({ type: "earthquake", countries: ["VE"], title: "M 5.9 - 30 km N of Caracas, Venezuela", started: "2026-10-20T00:00:00.000Z" }),
      disaster({ type: "landslide", countries: ["VE"], title: "Landslide in Mérida, Venezuela", started: "2026-06-30T00:00:00.000Z" }),
    ]) {
      expect([d.title, matchHub(cache, d, ctxFor(d))]).toEqual([d.title, null]);
    }
  });
});

describe("givenSince", () => {
  it("passes a fundraiser given to since a day before the start, or with no date known", () => {
    const start = "2026-06-24T00:00:00.000Z";
    expect(givenSince({ lastDonation: "2026-06-30 09:59:31" }, start)).toBe(true);
    expect(givenSince({ lastDonation: "2026-06-23 01:00:00" }, start)).toBe(true);
    expect(givenSince({ lastDonation: "2023-09-20 10:00:00" }, start)).toBe(false);
    expect(givenSince({ lastDonation: null }, start)).toBe(true);
    expect(givenSince({ lastDonation: "2023-09-20 10:00:00" }, undefined)).toBe(true);
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

  it("leaves out fundraisers nobody has given to since the disaster started", () => {
    const melissa = hub("hurricane-melissa", { fundraisers: parseFeed(FX.feed.melissa) });
    // Hamwalk's last gift was on 5 December 2025: of the schools, the classrooms and Eber Prep remain.
    expect(gofundmeLinks(melissa, "2025-12-10T00:00:00.000Z").map((l) => l.url)).toEqual([
      hubUrl("hurricane-melissa"),
      fundraiserUrl("rebuild-rural-classrooms-in-jamaica-after-hurricane-melissa"),
      fundraiserUrl("rebuild-eber-prep-school-after-hurricane-melissa"),
    ]);
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
  const gg = (slug: string, title = "", published?: string): Pick<DirectPage, "url" | "title" | "published"> => ({ url: `https://www.globalgiving.org/projects/${slug}/`, title, ...(published ? { published } : {}) });
  const problem = (page: Pick<DirectPage, "url" | "title" | "published">, d: Pick<Disaster, "countries" | "type" | "started" | "title" | "appeals"> = MELISSA) => globalGivingProblem(page, d, ctxFor(d));
  /** Days after the disaster's start, as the search would date a page. */
  const after = (d: Pick<Disaster, "started">, days: number) => new Date(Date.parse(d.started) + days * 24 * HOUR).toISOString();

  it("accepts a fund named for the storm, or for the country and its hazard when a recent year or the search dates it", () => {
    expect(problem(gg("hurricane-melissa-relief-fund", "Hurricane Melissa Relief Fund - GlobalGiving"))).toBeNull();
    // The title can name the storm when the slug does not.
    expect(problem(gg("rebuild-schools-after-the-storm", "Rebuild Jamaica's schools after Hurricane Melissa"))).toBeNull();
    expect(problem(gg("venezuela-earthquake-relief-fund", "", after(VENEZUELA, 2)), VENEZUELA)).toBeNull();
    expect(problem(gg("venezuela-earthquake-relief-2026"), VENEZUELA)).toBeNull();
  });

  it("refuses another country's, another storm's, an earlier year's and another hazard's page", () => {
    expect(problem(gg("colombia-earthquake-relief"), VENEZUELA)).toBe("names another country");
    expect(problem(gg("venezuela-earthquake-relief-fund", "Venezuela and Colombia Earthquake Fund"), VENEZUELA)).toBe("names another country");
    // Beryl hit Jamaica in 2024; with no year, its name gives it away.
    expect(problem(gg("help-jamaica-recover-from-hurricane-beryl"))).toBe("names another storm (beryl)");
    expect(problem(gg("hurricane-beryl-jamaica-2024"))).toBe("names another storm (beryl)");
    expect(problem(gg("jamaica-relief", "Jamaica Relief 2023"))).toBe("an earlier disaster's project (2023)");
    expect(problem(gg("rebuild-schools-in-nepal", "Rebuild schools in Nepal after the 2015 earthquake"), disaster({ countries: ["NP"], type: "earthquake", title: "Earthquake in Nepal", started: NOW }))).toBe(
      "an earlier disaster's project (2015)",
    );
    expect(problem(gg("jamaica-earthquake-fund"))).toBe("names another kind of disaster");
    expect(problem(gg("disaster-recovery-fund"))).toBe("names none of the disaster's places");
    expect(problem({ url: "https://www.globalgiving.org/search/", title: "" })).toBe("not a GlobalGiving project page");
  });

  it("asks a named storm's pages to name it: the country and the hazard, or a recent year, are not enough", () => {
    expect(problem(gg("jamaica-hurricane-recovery", "", after(MELISSA, 3)))).toBe("does not name the storm");
    expect(problem(gg("feed-children-in-haiti", "Feed children in Haiti 2026"))).toBe("does not name the storm");
    expect(problem(gg("jamaica-recovery-2026"))).toBe("does not name the storm");
  });

  it("refuses a general programme with only a country and a year, and a fund nothing dates to this disaster", () => {
    const haiti = disaster({ countries: ["HT"], type: "earthquake", title: "Earthquake in Haiti", started: "2026-10-20T00:00:00.000Z" });
    expect(problem(gg("feed-children-in-haiti", "Feed children in Haiti 2026"), haiti)).toBe("names neither the hazard nor a place in the title");
    const turkey = disaster({ countries: ["TR"], type: "earthquake", title: "M 6.1 - 20 km of Sindirgi, Turkey", started: "2026-10-20T00:00:00.000Z" });
    expect(problem(gg("turkey-earthquake-relief-fund", "Turkey Earthquake Relief Fund - GlobalGiving"), turkey)).toBe("nothing dates it to this disaster (no storm name, recent year or search date)");
    // The search dated it to the 2023 earthquake.
    expect(problem(gg("turkey-earthquake-relief-fund", "", "2023-02-07T00:00:00.000Z"), turkey)).toBe("dated 2023-02-07, before the disaster");
    expect(problem(gg("turkey-earthquake-relief-fund", "", after(turkey, 1)), turkey)).toBeNull();
    const pakistan = disaster({ countries: ["PK"], type: "flood", title: "Pakistan: Floods", started: "2026-08-01T00:00:00.000Z" });
    expect(problem(gg("pakistan-flood-relief", "Pakistan Flood Relief Fund - GlobalGiving"), pakistan)).toMatch(/^nothing dates it/);
    expect(problem(gg("pakistan-flood-relief", "Pakistan Flood Relief Fund 2022 - GlobalGiving"), pakistan)).toBe("an earlier disaster's project (2022)");
  });

  it("takes a storm's page for its floods only by the storm's name", () => {
    const floods = disaster({ type: "flood", countries: ["JM"], title: "Jamaica: Floods after Hurricane Melissa" });
    expect(problem(gg("hurricane-melissa-relief-fund"), floods)).toBeNull();
    expect(problem(gg("jamaica-hurricane-relief-2025"), floods)).toBe("names another kind of disaster");
  });
});

describe("eventYear and isNamedStorm", () => {
  it("dates a disaster by its start, a month's grace into the year before", () => {
    expect(eventYear({ started: "2025-10-21T12:00:00.000Z" })).toBe(2025);
    expect(eventYear({ started: "2026-01-10T00:00:00.000Z" })).toBe(2025);
    expect(eventYear({ started: "soon" })).toBeNull();
  });

  it("knows a named storm by its title's place words", () => {
    expect(isNamedStorm(MELISSA, ctxFor(MELISSA))).toBe(true);
    const unnamed = disaster({ type: "cyclone", countries: ["MZ"], title: "Tropical Cyclone in Mozambique" });
    expect(isNamedStorm(unnamed, ctxFor(unnamed))).toBe(false);
    expect(isNamedStorm(VENEZUELA, { eventWords: ["caracas"] })).toBe(false);
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

  it("refuses a look-alike of an official body or a platform, and news hosts the lists miss", () => {
    const cases: [string, string][] = [
      ["https://jamaicaredcrossrelief.org/donate-hurricane-melissa", "its host carries an official body's or a platform's name (redcross)"],
      ["https://red-cross-jamaica.org/donate", "its host carries an official body's or a platform's name (redcross)"],
      ["https://unicef-jamaica-appeal.org/donate", "its host carries an official body's or a platform's name (unicef)"],
      ["https://www.wfpusa.org/donate/melissa", "its host carries an official body's or a platform's name (wfp)"],
      ["https://ifrc-relief.org/donate", "its host carries an official body's or a platform's name (ifrc)"],
      ["https://jamaicagov-relief.org/donate", "its host carries an official body's or a platform's name (gov)"],
      ["https://gofundme-jamaica.org/donate", "its host carries an official body's or a platform's name (gofundme)"],
      ["https://loopnews.com/content/where-to-donate-hurricane-melissa-relief", "news site"],
      ["https://www.caribbeannewsglobal.com/donate-melissa", "news site"],
    ];
    for (const [url, why] of cases) expect([url, localUrlProblem(url, local)]).toEqual([url, why]);
    // A name inside a longer word is no claim.
    expect(localUrlProblem("https://mochacafe-kingston.org/melissa/donate", local)).toBeNull();
  });

  it("refuses the crowdfunding, blog, site-builder, form and archive hosts where people post their own fundraisers", () => {
    const urls = [
      "https://readyfor.jp/projects/noto-relief",
      "https://camp-fire.jp/projects/view/123",
      "https://www.shuidichou.com/project/123",
      "https://www.qschou.com/project/123",
      "https://tumblbug.com/relief",
      "https://happybean.naver.com/donations/H000000123",
      "https://www.backabuddy.co.za/campaign/flood-relief",
      "https://mchanga.africa/fundraiser/123",
      "https://uk.virginmoneygiving.com/fundraiser-display/x",
      "https://www.everydayhero.com/au/x",
      "https://www.lepotcommun.fr/pot/x",
      "https://ameblo.jp/someone/entry-12345.html",
      "https://note.com/someone/n/abc123",
      "https://blog.naver.com/someone/22222",
      "https://someone.tistory.com/12",
      "https://someone.substack.com/p/donate-to-jamaica",
      "https://mailchi.mp/abc/donate-melissa",
      "https://relief.webflow.io/donate",
      "https://myrelief.square.site/donate",
      "https://kingston.mystrikingly.com/donate",
      "https://relief.notion.site/Donate-123",
      "https://form.jotform.com/123",
      "https://web.archive.org/web/2025/https://example.org/donate",
      "https://www.eventbrite.com/e/jamaica-relief-concert-123",
    ];
    for (const url of urls) expect([url, localUrlProblem(url, local)]).toEqual([url, expect.stringMatching(/^(?:social network or a site anyone can publish on|crowdfunding or giving platform)$/)]);
  });

  it("refuses paths shaped like a platform's pages or news articles and blog posts", () => {
    const cases: [string, string][] = [
      ["https://kingstonrelief.org/projects/123", "a platform's page (/projects/...), not a group's own"],
      ["https://kingstonrelief.org/campaign/melissa", "a platform's page (/campaign/...), not a group's own"],
      ["https://kingstonrelief.org/fundraiser/abc", "a platform's page (/fundraiser/...), not a group's own"],
      ["https://kingstonrelief.org/f/help-us", "a platform's page (/f/...), not a group's own"],
      ["https://kingstonrelief.org/@kingston/donate", "a platform's page (/@kingston/...), not a group's own"],
      ["https://kingstonrelief.org/news/how-to-help", "a news article or blog post"],
      ["https://kingstonrelief.org/blog/donate-now", "a news article or blog post"],
      ["https://kingstonrelief.org/2025/10/how-to-help/", "a news article or blog post"],
    ];
    for (const [url, why] of cases) expect([url, localUrlProblem(url, local)]).toEqual([url, why]);
  });
});

describe("protectedNameInHost and protectedNameIn", () => {
  it("finds an official body's or a platform's name in a host", () => {
    expect(protectedNameInHost("jamaicaredcrossrelief.org")).toBe("redcross");
    expect(protectedNameInHost("www.cruz-roja-venezuela.org")).toBe("cruzroja");
    expect(protectedNameInHost("un-jamaica.org")).toBe("un");
    expect(protectedNameInHost("ocha-relief.net")).toBe("ocha");
    expect(protectedNameInHost("stelizabethrelief.org")).toBeNull();
    expect(protectedNameInHost("mocha.org")).toBeNull();
    expect(protectedNameInHost("fundraiser.org")).toBeNull();
  });

  it("finds a claim to be an official body or a platform in a name", () => {
    expect(protectedNameIn("Jamaica Red Cross")).toBe("red cross");
    expect(protectedNameIn("Croix-Rouge haïtienne")).toBe("croix-rouge");
    expect(protectedNameIn("UNICEF Jamaica")).toBe("unicef");
    expect(protectedNameIn("Ministry of Education")).toBe("ministry of");
    expect(protectedNameIn("Hope for Jamaica")).toBeNull();
    expect(protectedNameIn("St Andrew Youth Ministries")).toBeNull();
    expect(protectedNameIn(undefined)).toBeNull();
  });
});

describe("pathProblem", () => {
  it("passes a group's own donation path", () => {
    expect(pathProblem(new URL("https://ebercollege.edu.jm/rebuild-after-melissa/donate"))).toBeNull();
    expect(pathProblem(new URL("https://kingstonrelief.org/projects"))).toBeNull();
    expect(pathProblem(new URL("https://kingstonrelief.org/donate-2024-hurricane-beryl/"))).toBeNull();
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

describe("readPageSelf", () => {
  it("reads a page's site name, title and heading, and whether it is an article or post", () => {
    const page = `<head><title>Ignored</title><meta content="Eber College" property="og:site_name"><meta property="og:title" content="Rebuild Eber Prep &amp; Jamaica | Eber College"><meta property="og:type" content="article"></head><h1>Rebuild <b>Eber</b> Prep</h1>`;
    // og:type "article" alone marks nothing: WordPress gives it to every page.
    expect(readPageSelf(page)).toEqual({ name: "Eber College", title: "Rebuild Eber Prep & Jamaica | Eber College", heading: "Rebuild Eber Prep", article: false });
    expect(readPageSelf("<title>Donate</title>")).toEqual({ name: "", title: "Donate", heading: "", article: false });
    expect(readPageSelf(`<script type="application/ld+json">{"@type":["NewsArticle"]}</script>`).article).toBe(true);
    expect(readPageSelf(`<script type="application/ld+json">{"@graph":[{"@type":"WebPage"},{"@type":"BlogPosting"}]}</script>`).article).toBe(true);
    expect(readPageSelf(`<meta property="article:published_time" content="2025-10-29T10:00:00Z">`).article).toBe(true);
    expect(readPageSelf(FX.hubs["hurricane-melissa"]).article).toBe(false);
  });
});

describe("earlierEventProblem", () => {
  const rules = { type: "cyclone" as const, minYear: 2025 };
  const ctx = ctxFor(MELISSA);
  it("finds an older year, another storm, or only hazards of another kind", () => {
    expect(earlierEventProblem(["/donate-2024-hurricane-beryl/"], rules, ctx)).toBe("an earlier disaster's page (2024)");
    expect(earlierEventProblem(["Help Jamaica rebuild after Hurricane Beryl"], rules, ctx)).toBe("names another storm (beryl)");
    expect(earlierEventProblem(["Earthquake relief for Haiti"], rules, ctx)).toBe("names another kind of disaster");
  });

  it("passes the disaster's own storm, recent years and pages that name no hazard", () => {
    expect(earlierEventProblem(["/hurricane-melissa/donate", "Hurricane Melissa Relief 2025", "Rebuild our school"], rules, ctx)).toBeNull();
    expect(earlierEventProblem(["Donate to Hope for Jamaica"], rules, ctx)).toBeNull();
    expect(earlierEventProblem(["Relief for 2023 earthquake"], { minYear: null }, ctx)).toBeNull();
    // A storm's floods, by the storm's name.
    expect(earlierEventProblem(["Hurricane Melissa flood relief"], { type: "flood", minYear: 2025 }, ctx)).toBeNull();
  });
});

describe("localAddressProblem and localPageProblem", () => {
  const local: LocalContext = { donation: ctxFor(MELISSA) };
  const rules = { type: "cyclone" as const, minYear: 2025 };
  const page = (url: string, over: Partial<DirectPage> = {}): DirectPage => ({ url, org: "", kind: "local", note: "", title: "", ...over });

  it("refuses by the address: the URL rules, then an earlier event in its path", () => {
    expect(localAddressProblem("https://www.hopeforjamaica.org/donate-2024-hurricane-beryl/", local, rules)).toBe("an earlier disaster's page (2024)");
    expect(localAddressProblem("https://www.hopeforjamaica.org/hurricane%20beryl/donate", local, rules)).toBe("names another storm (beryl)");
    expect(localAddressProblem("https://bit.ly/x", local, rules)).toBe("URL shortener");
    expect(localAddressProblem("https://www.hopeforjamaica.org/melissa/donate", local, rules)).toBeNull();
  });

  it("refuses a page the search names for an official body, or dates before the disaster", () => {
    expect(localPageProblem(page("https://stelizabethrelief.org/give", { org: "Jamaica Red Cross" }), MELISSA, local, rules)).toBe("the search names it for an official body or a platform (red cross)");
    expect(localPageProblem(page("https://stelizabethrelief.org/give", { published: "2024-07-05T00:00:00.000Z" }), MELISSA, local, rules)).toBe("dated 2024-07-05, before the disaster");
    expect(localPageProblem(page("https://stelizabethrelief.org/give", { org: "St Elizabeth Relief", published: "2025-10-30T00:00:00.000Z" }), MELISSA, local, rules)).toBeNull();
  });
});

describe("checkLocalPage", () => {
  const local: LocalContext = { donation: ctxFor(MELISSA) };
  const rules: LocalPageRules = { names: ["Jamaica", "St. Elizabeth", "melissa"], type: "cyclone", minYear: 2025 };
  const URL0 = "https://stelizabethrelief.org/hurricane-melissa/donate";

  it("passes a live page with a donation word that names the disaster's place, keeping its own name and title", async () => {
    const d = deps(async () => html(`<title>Rebuild St. Elizabeth | St Elizabeth Relief</title><meta property="og:site_name" content="St Elizabeth Relief"><h1>Rebuild St. Elizabeth</h1><a>Donate now</a>`));
    expect(await checkLocalPage(URL0, d, local, rules)).toEqual({
      ok: true,
      reason: 'donation word "donat*", names "St. Elizabeth"',
      chain: [URL0],
      place: "St. Elizabeth",
      name: "St Elizabeth Relief",
      title: "Rebuild St. Elizabeth | St Elizabeth Relief",
    });
    expect(d.fetch.mock.calls[0][1]).toMatchObject({ redirect: "manual", headers: { "User-Agent": USER_AGENT } });
    // Without a name or title of its own, the verdict has none.
    const bare = await checkLocalPage(URL0, deps(async () => html("<p>Donate for Jamaica</p>")), local, rules);
    expect(bare).not.toHaveProperty("name");
    expect(bare).not.toHaveProperty("title");
  });

  it("fails a page without a donation word, or naming no place of the disaster's", async () => {
    expect(await checkLocalPage(URL0, deps(async () => html("<h1>Rebuild St. Elizabeth</h1>")), local, rules)).toMatchObject({ ok: false, reason: "no donation word on the page" });
    expect(await checkLocalPage(URL0, deps(async () => html("<h1>Donate to our school in Ohio</h1>")), local, rules)).toMatchObject({ ok: false, reason: "names none of the disaster's places" });
  });

  it("fails a news article or post, a page whose name or title claims an official body, and a page for an earlier storm", async () => {
    const article = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","headline":"Where to donate"}</script><p>Donate to Jamaica relief</p>`;
    expect(await checkLocalPage(URL0, deps(async () => html(article)), local, rules)).toMatchObject({ ok: false, reason: "a news article or blog post" });
    const lookalike = `<title>Donate to Jamaica Red Cross hurricane Melissa relief</title><p>Give now to families in Kingston, Jamaica.</p>`;
    expect(await checkLocalPage(URL0, deps(async () => html(lookalike)), local, rules)).toMatchObject({ ok: false, reason: "its own name or title claims an official body or a platform (red cross)" });
    const named = `<meta property="og:site_name" content="UNICEF Jamaica Appeal"><p>Donate for Jamaica</p>`;
    expect(await checkLocalPage(URL0, deps(async () => html(named)), local, rules)).toMatchObject({ ok: false, reason: "its own name or title claims an official body or a platform (unicef)" });
    const beryl = `<title>Hope for Jamaica</title><h1>Donate: Hurricane Beryl recovery</h1><p>Donate now to help Jamaica rebuild.</p>`;
    expect(await checkLocalPage(URL0, deps(async () => html(beryl)), local, rules)).toMatchObject({ ok: false, reason: "names another storm (beryl)" });
    const old = `<title>Jamaica relief 2024 | Hope for Jamaica</title><p>Donate now to help Jamaica rebuild.</p>`;
    expect(await checkLocalPage(URL0, deps(async () => html(old)), local, rules)).toMatchObject({ ok: false, reason: "an earlier disaster's page (2024)" });
  });

  it("refuses an earlier storm's page by its address, unfetched", async () => {
    const d = deps(async () => html("<p>Donate now to help Jamaica rebuild</p>"));
    expect(await checkLocalPage("https://www.hopeforjamaica.org/donate-2024-hurricane-beryl/", d, local, rules)).toMatchObject({ ok: false, reason: "an earlier disaster's page (2024)" });
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("follows redirects on the same site only, to pages that may be shown", async () => {
    const moved = deps(async (u) => (u === URL0 ? new Response(null, { status: 301, headers: { location: "/melissa/give/" } }) : html("<p>Donate to Jamaica relief</p>")));
    expect(await checkLocalPage(URL0, moved, local, rules)).toMatchObject({ ok: true, chain: [URL0, "https://stelizabethrelief.org/melissa/give/"] });
    const away = deps(async () => new Response(null, { status: 302, headers: { location: "https://www.paypal.com/donate?id=1" } }));
    expect(await checkLocalPage(URL0, away, local, rules)).toMatchObject({ ok: false, reason: "redirect leaves the site or reaches a page that may not be shown" });
    const home = deps(async () => new Response(null, { status: 302, headers: { location: "https://stelizabethrelief.org/" } }));
    expect((await checkLocalPage(URL0, home, local, rules))?.ok).toBe(false);
    const toNews = deps(async () => new Response(null, { status: 302, headers: { location: "https://stelizabethrelief.org/news/melissa" } }));
    expect((await checkLocalPage(URL0, toNews, local, rules))?.ok).toBe(false);
  });

  it("fails a bot wall, a missing page and a non-HTML answer; tries once more after a server error; refuses a bad URL unfetched", async () => {
    expect(await checkLocalPage(URL0, deps(async () => new Response("", { status: 403 })), local, rules)).toMatchObject({ ok: false, reason: "HTTP 403" });
    expect(await checkLocalPage(URL0, deps(async () => new Response("", { status: 404 })), local, rules)).toMatchObject({ ok: false, reason: "HTTP 404" });
    expect(await checkLocalPage(URL0, deps(async () => json({ donate: "Jamaica" })), local, rules)).toMatchObject({ ok: false });
    const flaky = deps(async () => new Response("", { status: 503 }));
    expect(await checkLocalPage(URL0, flaky, local, rules)).toBeNull();
    expect(flaky.fetch).toHaveBeenCalledTimes(2);
    const none = deps(async () => html(""));
    expect(await checkLocalPage("https://www.facebook.com/x", none, local, rules)).toMatchObject({ ok: false, reason: "social network or a site anyone can publish on" });
    expect(none.fetch).not.toHaveBeenCalled();
  });
});

describe("verifyLocalPage", () => {
  const local: LocalContext = { donation: ctxFor(MELISSA) };
  const URL0 = "https://stelizabethrelief.org/hurricane-melissa/donate";
  const rules: LocalPageRules = { names: ["Jamaica"] };

  it("caches its verdict per disaster in the registry, and reuses it", async () => {
    const registry = emptyRegistry();
    const d = deps(async () => html("<p>Donate for Jamaica</p>"));
    expect(await verifyLocalPage(URL0, "d1", d, local, rules, registry, NOW)).toBe(true);
    expect(registry.verdicts[localVerdictKey("d1", URL0)]).toMatchObject({ ok: true, checked: NOW, place: "Jamaica" });
    expect(localVerdictKey("d1", URL0)).toBe("local:d1:stelizabethrelief.org/hurricane-melissa/donate");
    expect(await verifyLocalPage(URL0, "d1", d, local, rules, registry, NOW)).toBe(true);
    expect(d.fetch).toHaveBeenCalledTimes(1);
    // A URL the rules refuse is neither fetched nor cached.
    expect(await verifyLocalPage("https://bit.ly/x", "d1", d, local, rules, registry, NOW)).toBe(false);
    expect(Object.keys(registry.verdicts)).toHaveLength(1);
  });

  it("caches nothing when no verdict could be had", async () => {
    const registry = emptyRegistry();
    expect(await verifyLocalPage(URL0, "d1", deps(async () => Promise.reject(new Error("down"))), local, rules, registry, NOW)).toBe(false);
    expect(registry.verdicts).toEqual({});
  });
});

describe("localOrg and localLabel", () => {
  const URL0 = "https://www.ebercollege.edu.jm/rebuild-after-melissa/donate";
  it("shows a local page by its own site name and title, else by its host", () => {
    expect(localOrg({ name: "Eber College" }, URL0)).toBe("Eber College");
    expect(localOrg({}, URL0)).toBe("ebercollege.edu.jm");
    expect(localOrg({ name: "ebercollege.edu.jm" }, URL0)).toBe("ebercollege.edu.jm");
    expect(localLabel({ name: "Eber College", title: "Rebuild Eber Prep | Eber College" }, URL0)).toBe("Rebuild Eber Prep");
    expect(localLabel({ name: "Eber College", title: "Eber College – Donate" }, URL0)).toBe("Donate");
    expect(localLabel({ name: "Eber College", title: "Eber College" }, URL0)).toBe("Donation page on ebercollege.edu.jm");
    expect(localLabel({}, URL0)).toBe("Donation page on ebercollege.edu.jm");
  });
});

describe("localRules", () => {
  it("holds a disaster's local pages to its place names, type and year", () => {
    const d = { ...MELISSA, countries: ["JM"], places: [{ name: "Black River", country: "JM", lat: 18, lng: -77.8, kind: "town" as const, source: "research" as const }] };
    expect(localRules({ disaster: d, ctx: ctxFor(d), countryNames: NAMES, pressNames: {} })).toEqual({ names: ["Jamaica", "Black River", "Melissa"], type: "cyclone", minYear: 2025 });
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
  const SCHOOL_PAGE = `<title>Rebuild Eber Prep after Melissa | Eber College</title><meta property="og:site_name" content="Eber College"><h1>Rebuild Eber Prep in Black River</h1><a>Donate</a>`;
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

  it("checks the local page live, then lists GoFundMe's, the projects in turn and the local page by its own name and title", async () => {
    const registry = emptyRegistry();
    const d = deps(async (u) => (u === SCHOOL ? html(SCHOOL_PAGE) : new Response("", { status: 404 })));
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
      ["local", "Eber College"],
    ]);
    // The search's name for the school ("Eber Preparatory School") is never shown.
    expect(links[6]).toEqual({ label: "Rebuild Eber Prep after Melissa", url: SCHOOL, org: "Eber College", kind: "local", note: localNote("Black River"), via: "research", forEvent: true });
    // From the caches alone the same list comes back.
    expect(buildDirectLinks(input(), registry, NOW)).toEqual(links);
  });

  it("shows a local page without a name of its own by its host", async () => {
    const registry = emptyRegistry();
    const d = deps(async () => html("<h1>Rebuild Eber Prep in Black River</h1><a>Donate</a>"));
    const links = await prepareDirectLinks(input({ gofundme: emptyGoFundMeCache() }), registry, d, NOW);
    expect(links.find((l) => l.kind === "local")).toMatchObject({ org: "ebercollege.edu.jm", label: "Donation page on ebercollege.edu.jm" });
  });

  it("refuses a look-alike, a news page and a page the search names for an official body, whatever the model calls them", async () => {
    const lookalikes: DirectPage[] = [
      { url: "https://jamaicaredcrossrelief.org/donate-hurricane-melissa", org: "Jamaica Red Cross", kind: "local", note: "", title: "" },
      { url: "https://loopnews.com/content/where-to-donate-hurricane-melissa-relief", org: "St Andrew Parish Church", kind: "local", note: "", title: "" },
      { url: "https://kingstonrelief.org/melissa/donate", org: "Jamaica Red Cross", kind: "local", note: "", title: "" },
      { url: "https://www.hopeforjamaica.org/donate-2024-hurricane-beryl/", org: "Hope for Jamaica", kind: "local", note: "", title: "" },
      { url: "https://readyfor.jp/projects/jamaica-melissa", org: "Kingston Families", kind: "local", note: "", title: "" },
    ];
    const registry = emptyRegistry();
    const d = deps(async () => html("<p>Donate to Jamaica Red Cross hurricane Melissa relief fund. Give now to families in Kingston.</p>"));
    const links = await prepareDirectLinks(input({ entry: { direct: lookalikes } as ResearchEntry, gofundme: emptyGoFundMeCache() }), registry, d, NOW, { maxChecks: 10, pauseMs: 0 });
    expect(d.fetch).not.toHaveBeenCalled();
    expect(links).toEqual([]);
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

  it("drops a cached pass once its page, a hop, its name or its title is refused, and lists nothing without a matching crisis page or pages", () => {
    const registry = emptyRegistry();
    const key = localVerdictKey(MELISSA.id, SCHOOL);
    registry.verdicts[key] = { ok: true, reason: "", checked: NOW, chain: [SCHOOL, "https://www.paypal.com/donate"], place: "Jamaica" };
    expect(buildDirectLinks(input(), registry, NOW).some((l) => l.kind === "local")).toBe(false);
    registry.verdicts[key] = { ok: true, reason: "", checked: NOW, chain: [SCHOOL], place: "Jamaica", name: "Jamaica Red Cross Relief" };
    expect(buildDirectLinks(input(), registry, NOW).some((l) => l.kind === "local")).toBe(false);
    registry.verdicts[key] = { ok: true, reason: "", checked: NOW, chain: [SCHOOL], place: "Jamaica", title: "Rebuild after Hurricane Beryl" };
    expect(buildDirectLinks(input(), registry, NOW).some((l) => l.kind === "local")).toBe(false);
    registry.verdicts[key] = { ok: true, reason: "", checked: NOW, chain: [SCHOOL], place: "Jamaica", name: "Eber College" };
    expect(buildDirectLinks(input(), registry, NOW).some((l) => l.kind === "local")).toBe(true);
    expect(buildDirectLinks(input({ gofundme: emptyGoFundMeCache(), entry: undefined }), registry, NOW)).toEqual([]);
  });

  it("lists no crisis page of an earlier event, and only fundraisers given to since the disaster began", () => {
    // Had Hamwalk's last gift come before the hurricane, it would be an earlier fundraiser's.
    const fundraisers = parseFeed(FX.feed.melissa).map((f) => (f.slug === "rebuilding-hope-for-hamwalk-primary-school" ? { ...f, lastDonation: "2025-06-01 10:00:00" } : f));
    const withOld: GoFundMeCache = { index: { fetched: NOW, slugs: [] }, hubs: { "hurricane-melissa": hub("hurricane-melissa", { fundraisers }) } };
    const links = buildDirectLinks(input({ gofundme: withOld, entry: undefined }), emptyRegistry(), NOW);
    expect(links.filter((l) => l.kind === "fundraiser").map((l) => l.url)).toEqual([
      hubUrl("hurricane-melissa"),
      fundraiserUrl("rebuild-rural-classrooms-in-jamaica-after-hurricane-melissa"),
      fundraiserUrl("rebuild-eber-prep-school-after-hurricane-melissa"),
    ]);
    const nextYear = { ...MELISSA, started: "2026-10-20T00:00:00.000Z" };
    expect(buildDirectLinks(input({ disaster: nextYear, entry: undefined }), emptyRegistry(), NOW)).toEqual([]);
  });
});
