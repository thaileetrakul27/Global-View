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
  LOCAL_RULES_VERSION,
  MAX_FOUND_HUBS,
  MAX_LOCAL_CHECKS,
  MAX_PAGE_LOG_LINES,
  MAX_SLUGS,
  VERIFIED_NOTE,
  allowlistMisses,
  asciiDigits,
  blankHub,
  buildDirectLinks,
  cappedLog,
  checkLocalPage,
  countryNamesIn,
  directCandidates,
  directKindOf,
  directOutcome,
  disasterStorms,
  earlierEventProblem,
  emptyGoFundMeCache,
  eventYear,
  eventYearsIn,
  failureHolds,
  feedSlugs,
  feedUrl,
  focusOf,
  foreignCountryIn,
  fundraiserSlugOf,
  fundraiserUrl,
  givenSince,
  gregorianYears,
  globalGivingLink,
  globalGivingPage,
  globalGivingProblem,
  gofundmeLinks,
  hazardFit,
  hazardWordsIn,
  hopAllowed,
  hubDatesFit,
  hubEventName,
  hubMatches,
  hubRedirect,
  hubSlugOf,
  hubUrl,
  hubUrlsIn,
  hubWanted,
  isHubPage,
  isNamedStorm,
  leadYearProblem,
  localAddressProblem,
  localLabel,
  localNote,
  localOrg,
  localPageProblem,
  localRules,
  localUrlProblem,
  localVerdictKey,
  logDirectOutcome,
  matchHub,
  mixedScriptWord,
  modifiedOf,
  nameLanguages,
  nameForms,
  nameText,
  normaliseGoFundMeCache,
  otherStorm,
  ownTitle,
  ownCountryNames,
  pageDateProblem,
  parseFeed,
  parseHub,
  parseHubIndex,
  partnerLinks,
  partnerUrl,
  platformProblem,
  pathProblem,
  paymentProblem,
  placeNamedIn,
  placeNames,
  prepareDirectLinks,
  protectedNameIn,
  protectedNameInHost,
  publishedOf,
  readGoFundMeCache,
  readPageSelf,
  readablePath,
  refreshGoFundMe,
  sameSite,
  slugWords,
  societyAcronyms,
  stormAftermath,
  titlePlaces,
  timeOf,
  titleWithoutSite,
  topicProblem,
  verifyLocalPage,
  writeGoFundMeCache,
  type DirectInput,
  type GoFundMeCache,
  type GoFundMeHub,
  type LocalContext,
  type LocalPageRules,
} from "./direct";
import { NOT_ALLOWLISTED, buildDonations, donationContext, donationUrlProblem, emptyRegistry, loadGovernmentDomains, type DonationRegistry } from "./donate";
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
  return { slug, ...parseHub(FX.hubs[slug]), fundraisers: [], fetched: hoursAgo(1), feedFetched: hoursAgo(1), feedFailed: null, seen: hoursAgo(1), failure: null, ...over };
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

describe("hazardWordsIn", () => {
  it("reads hazards named in other scripts or in several words, by their English word", () => {
    expect(hazardWordsIn("บริจาคช่วยน้ำท่วมเชียงราย")).toEqual(["flood"]);
    expect(hazardWordsIn("能登半島地震 義援金")).toEqual(["earthquake"]);
    expect(hazardWordsIn("تبرع لضحايا زلزال الحوز")).toEqual(["earthquake"]);
    // Nepali spells a flood बाढी, a landslide पहिरो and a forest fire डढेलो.
    expect(hazardWordsIn("बाढी पीडितलाई सहयोग")).toEqual(["flood"]);
    expect(hazardWordsIn("पहिरो र डढेलो")).toEqual(["landslide", "wildfire"]);
    expect(hazardWordsIn("Aide après le tremblement de terre")).toEqual(["earthquake"]);
    expect(hazardWordsIn("Ủng hộ đồng bào lũ lụt miền Trung")).toEqual(["flood"]);
    // A word that only contains a hazard's letters names none.
    expect(hazardWordsIn("タイトル")).toEqual([]);
    expect(hazardWordsIn("Donate now")).toEqual([]);
  });

  it("lets hazardFit read hazard words in other languages", () => {
    expect(hazardFit(slugWords("Banjir Jakarta: donasi"), "flood")).toBe("fits");
    expect(hazardFit(slugWords("Hochwasserhilfe"), "flood")).toBe("none");
    expect(hazardFit(slugWords("Hochwasser Hilfe"), "flood")).toBe("fits");
    expect(hazardFit(slugWords("Enchentes no RS"), "earthquake")).toBe("other");
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

describe("disasterStorms and otherStorm for floods a storm brought", () => {
  it("knows the storms a disaster's title names", () => {
    expect(disasterStorms(ctxFor(MELISSA))).toEqual(["melissa"]);
    const philippines = disaster({ countries: ["PH"], type: "flood", title: "Philippines: Southwest Monsoon enhanced by Tropical Cyclones Maymay and Dolphin" });
    expect(disasterStorms(ctxFor(philippines))).toEqual(["maymay"]);
    expect(disasterStorms(ctxFor(disaster({ countries: ["PL"], type: "flood", title: "Flood in Poland" })))).toEqual([]);
  });

  it("finds no other storm for a disaster whose title names none: the storm that brought its floods", () => {
    const poland = disaster({ countries: ["PL"], type: "flood", title: "Flood in Poland", started: "2026-09-14T00:00:00.000Z" });
    const derna = disaster({ countries: ["LY"], type: "flood", title: "Floods in Derna, Libya", started: "2026-09-10T00:00:00.000Z" });
    expect(otherStorm(slugWords("Storm Boris flood relief for Klodzko"), ctxFor(poland))).toBeNull();
    // The review's inputs (2026-10-25), refused before.
    expect(earlierEventProblem(["Storm Boris flood relief for Klodzko"], { type: "flood", minYear: 2026 }, ctxFor(poland))).toBeNull();
    expect(earlierEventProblem(["Storm Daniel: donate to Derna families"], { type: "flood", minYear: 2026 }, ctxFor(derna))).toBeNull();
    // A disaster whose title names its storm still has others, and so does a storm whose title names none.
    const daniel = disaster({ countries: ["LY"], type: "flood", title: "Floods after Storm Daniel in Derna, Libya" });
    expect(earlierEventProblem(["Storm Boris flood relief"], { type: "flood", minYear: 2026 }, ctxFor(daniel))).toBe("names another storm (boris)");
    const unnamed = disaster({ countries: ["MZ"], type: "cyclone", title: "Tropical Cyclone in Mozambique" });
    expect(otherStorm(slugWords("Cyclone Freddy relief"), ctxFor(unnamed))).toBeNull();
    expect(otherStorm(slugWords("Cyclone Freddy relief"), ctxFor(unnamed), "cyclone")).toBe("freddy");
    expect(earlierEventProblem(["Cyclone Freddy relief"], { type: "cyclone", minYear: 2026 }, ctxFor(unnamed))).toBe("names another storm (freddy)");
  });
});

describe("eventYearsIn and readablePath", () => {
  it("reads the years a text gives for an event: no founding year, and a season by its second year", () => {
    expect(eventYearsIn("Hurricane Relief 2024")).toEqual([2024]);
    expect(eventYearsIn("2025-26 Bushfire Appeal")).toEqual([2026]);
    expect(eventYearsIn("Bushfire Appeal 2025/26")).toEqual([2026]);
    expect(eventYearsIn("Serving Kerala since 1952")).toEqual([]);
    expect(eventYearsIn("Est. 1998 — flood appeal 2026")).toEqual([2026]);
    expect(eventYearsIn("Fundada en 1985")).toEqual([]);
    // Two years apart are two years; a year and a month are a year.
    expect(eventYearsIn("1990-2020 floods")).toEqual([1990, 2020]);
    expect(eventYearsIn("2025-10 update")).toEqual([2025]);
  });

  it("reads a path without its escapes and without segments that are only numbers", () => {
    expect(readablePath("https://kerala-relief.org/node/2019")).toBe("/node");
    expect(readablePath("https://www.school.ac.th/%E0%B8%9A%E0%B8%A3%E0%B8%B4%E0%B8%88%E0%B8%B2%E0%B8%84")).toBe("/บริจาค");
    expect(readablePath("https://kingstonrelief.org/donate-2024-hurricane-beryl/")).toBe("/donate-2024-hurricane-beryl/");
    expect(readablePath("not a url")).toBe("");
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
    const cache: GoFundMeCache = { index: { fetched: NOW, slugs: ["venezuela-earthquake-relief"], failed: null }, hubs: { "hurricane-melissa": hub("hurricane-melissa", { fundraisers: parseFeed(FX.feed.melissa) }) } };
    writeGoFundMeCache(cache, file);
    expect(readGoFundMeCache(file)).toEqual(cache);
    expect(readGoFundMeCache(path.join(dir, "missing.json"))).toEqual(emptyGoFundMeCache());
    const damaged = normaliseGoFundMeCache({
      index: { fetched: "yesterday", slugs: ["ok-slug", "Bad Slug", 3] },
      hubs: { "Bad Slug": { seen: NOW }, "no-seen": {}, kept: { seen: NOW, partners: [{ url: "https://www.facebook.com/x", name: "FB" }], fund: "https://evil.example/f/x", fundraisers: [{ slug: "a", name: "A" }] } },
    });
    expect(damaged.index).toEqual({ fetched: null, slugs: ["ok-slug"], failed: null });
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

describe("hubRedirect and isHubPage", () => {
  it("follows a redirect only within GoFundMe's crisis pages, in any of their languages", () => {
    const from = hubUrl("hurricane-melissa");
    expect(hubRedirect("/c/act/hurricane-melissa/", from)).toEqual({ slug: "hurricane-melissa", url: "https://www.gofundme.com/c/act/hurricane-melissa/" });
    expect(hubRedirect("https://www.gofundme.com/en-gb/c/act/hurricane-melissa", from)).toEqual({ slug: "hurricane-melissa", url: "https://www.gofundme.com/en-gb/c/act/hurricane-melissa" });
    expect(hubRedirect("/c/act/hurricane-beryl-help", hubUrl("hurricane-beryl"))?.slug).toBe("hurricane-beryl-help");
    expect(hubRedirect("https://www.gofundme.com/c/", from)).toBeNull();
    expect(hubRedirect("https://evil.example/c/act/hurricane-melissa", from)).toBeNull();
    expect(hubRedirect("http://www.gofundme.com/c/act/hurricane-melissa", from)).toBeNull();
  });

  it("takes a 200 for the crisis page only when it dates itself and still lists its verified fundraisers", () => {
    const melissa = parseHub(FX.hubs["hurricane-melissa"]);
    expect(isHubPage(melissa, melissa)).toBe(true);
    // A page that never listed any, such as wildfire-relief, may list none.
    const wildfire = parseHub(FX.hubs["wildfire-relief"]);
    expect(isHubPage(wildfire, blankHub("wildfire-relief", NOW))).toBe(true);
    const wall = parseHub("<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>");
    expect(isHubPage(wall, melissa)).toBe(false);
    expect(isHubPage(wall, blankHub("hurricane-melissa", NOW))).toBe(false);
    // Dated, but its fundraisers gone at once: a broken page.
    expect(isHubPage({ ...melissa, listed: 0 }, melissa)).toBe(false);
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
    expect(cache.index).toEqual({ fetched: NOW, slugs: ["public-officials", "venezuela-earthquake-relief"], failed: null });
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
    // The index keeps its list, and notes when it failed.
    expect(cache.index).toEqual({ ...prev.index, failed: NOW });
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

  it("asks again for an index or a feed that failed only after twelve hours (both answering 403 every run, 2026-10-25 review)", async () => {
    const d = deps(async (url) => {
      if (url === GOFUNDME_INDEX || url.startsWith(GOFUNDME_FEED)) return new Response("", { status: 403 });
      const slug = hubSlugOf(url);
      return slug && FX.hubs[slug] ? html(FX.hubs[slug]) : new Response("", { status: 404 });
    });
    const found = ["https://www.gofundme.com/c/act/hurricane-melissa"];
    const wanted = (h: GoFundMeHub) => hubWanted(h, MELISSA, ctxFor(MELISSA));
    const start = Date.parse("2025-10-30T00:00:00.000Z");
    let cache = emptyGoFundMeCache();
    const asked: number[] = [];
    for (const h of [0, 2, 4, 6, 8, 10, 12]) {
      d.fetch.mockClear();
      cache = await refreshGoFundMe(cache, d, new Date(start + h * HOUR).toISOString(), { found, wanted });
      asked.push(d.fetch.mock.calls.length);
    }
    // The index, the page and its feed; then nothing for twelve hours, when all three are due again.
    expect(asked).toEqual([3, 0, 0, 0, 0, 0, 3]);
    expect(cache.index.failed).toBe(new Date(start + 12 * HOUR).toISOString());
    expect(cache.hubs["hurricane-melissa"]).toMatchObject({ feedFetched: null, feedFailed: new Date(start + 12 * HOUR).toISOString() });
    // A feed that answers again clears its failure.
    const ok = gofundme();
    const next = await refreshGoFundMe(cache, ok, new Date(start + 24 * HOUR).toISOString(), { found, wanted });
    expect(next.hubs["hurricane-melissa"]).toMatchObject({ feedFailed: null, feedFetched: new Date(start + 24 * HOUR).toISOString() });
    expect(next.index.failed).toBeNull();
  });

  it("keeps a crisis page's data when it answers 200 with no crisis page (a bot wall), and asks again after twelve hours", async () => {
    const wanted = (h: GoFundMeHub) => hubWanted(h, MELISSA, ctxFor(MELISSA));
    const read = hub("hurricane-melissa", { fundraisers: parseFeed(FX.feed.melissa), fetched: hoursAgo(13), feedFetched: hoursAgo(1) });
    const prev: GoFundMeCache = { index: { fetched: hoursAgo(1), slugs: [], failed: null }, hubs: { "hurricane-melissa": read } };
    const wall = () => html("<html><head><title>Just a moment...</title></head><body>Checking your browser before accessing gofundme.com</body></html>");
    const d = gofundme({ [hubUrl("hurricane-melissa")]: wall });
    const cache = await refreshGoFundMe(prev, d, NOW, { wanted });
    expect(cache.hubs["hurricane-melissa"]).toMatchObject({ verified: true, published: read.published, listed: read.listed, fetched: hoursAgo(13), failure: { at: NOW, kind: "failed" } });
    expect(matchHub(cache, MELISSA, ctxFor(MELISSA))?.slug).toBe("hurricane-melissa");
    expect(failureHolds(cache.hubs["hurricane-melissa"].failure, new Date(Date.parse(NOW) + 11 * HOUR).toISOString())).toBe(true);
    expect(failureHolds(cache.hubs["hurricane-melissa"].failure, new Date(Date.parse(NOW) + 12 * HOUR).toISOString())).toBe(false);
  });

  it("follows a redirect to the same crisis page at another address (a trailing slash, a language), at most three times", async () => {
    const wanted = (h: GoFundMeHub) => hubWanted(h, MELISSA, ctxFor(MELISSA));
    const found = ["https://www.gofundme.com/c/act/hurricane-melissa"];
    const prev: GoFundMeCache = { index: { fetched: NOW, slugs: [], failed: null }, hubs: {} };
    const slash = gofundme({
      [hubUrl("hurricane-melissa")]: () => new Response(null, { status: 301, headers: { location: "/c/act/hurricane-melissa/" } }),
      "https://www.gofundme.com/c/act/hurricane-melissa/": () => new Response(null, { status: 308, headers: { location: "/en-gb/c/act/hurricane-melissa" } }),
      "https://www.gofundme.com/en-gb/c/act/hurricane-melissa": () => html(FX.hubs["hurricane-melissa"]),
    });
    const cache = await refreshGoFundMe(prev, slash, NOW, { found, wanted, maxRequests: 3 });
    expect(urlsOf(slash)).toEqual([hubUrl("hurricane-melissa"), "https://www.gofundme.com/c/act/hurricane-melissa/", "https://www.gofundme.com/en-gb/c/act/hurricane-melissa"]);
    expect(cache.hubs["hurricane-melissa"]).toMatchObject({ fetched: NOW, verified: true, failure: null });
    // A page that only ever redirects to itself has failed; it is not gone.
    const loop = gofundme({
      [hubUrl("hurricane-melissa")]: () => new Response(null, { status: 301, headers: { location: "/c/act/hurricane-melissa/" } }),
      "https://www.gofundme.com/c/act/hurricane-melissa/": () => new Response(null, { status: 301, headers: { location: "/c/act/hurricane-melissa" } }),
    });
    const looped = await refreshGoFundMe(prev, loop, NOW, { found, wanted });
    expect(loop.fetch).toHaveBeenCalledTimes(4);
    expect(looped.hubs["hurricane-melissa"].failure).toEqual({ at: NOW, kind: "failed" });
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

  it("ties no crisis page named only for a hazard to a disaster (tornadoes-relief for tornadoes in Mississippi)", () => {
    const tornadoes = disaster({ countries: ["US"], type: "storm", title: "Tornadoes in Mississippi, United States", started: "2027-04-20T00:00:00.000Z" });
    expect(ctxFor(tornadoes).eventWords).toEqual(["mississippi"]);
    for (const h of [
      { slug: "tornado-relief", title: "How you can help: tornado relief" },
      { slug: "tornadoes-relief", title: "How to help: Tornadoes relief" },
      { slug: "blizzard-relief", title: "Blizzard relief" },
    ])
      expect([h.slug, hubMatches(h, tornadoes, ctxFor(tornadoes))]).toEqual([h.slug, false]);
    expect(hubMatches({ slug: "mississippi-tornado-relief", title: "" }, tornadoes, ctxFor(tornadoes))).toBe(true);
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

  it("accepts a fund named for the storm, or for the country or a place of the title and its hazard with a recent year", () => {
    expect(problem(gg("hurricane-melissa-relief-fund", "Hurricane Melissa Relief Fund - GlobalGiving"))).toBeNull();
    // The title can name the storm when the slug does not.
    expect(problem(gg("rebuild-schools-after-the-storm", "Rebuild Jamaica's schools after Hurricane Melissa"))).toBeNull();
    expect(problem(gg("venezuela-earthquake-relief-2026"), VENEZUELA)).toBeNull();
    // A season that runs into the disaster's year is recent.
    expect(problem(gg("venezuela-earthquake-relief-2025-26"), VENEZUELA)).toBeNull();
    const sucre = disaster({ countries: ["VE"], type: "earthquake", title: "Earthquake in Sucre, Venezuela", started: "2026-10-20T00:00:00.000Z" });
    expect(problem(gg("sucre-earthquake-relief-2026", "", after(sucre, 2)), sucre)).toBeNull();
  });

  it("does not take the search's date as proof: a fund named only for a country or a place and a hazard may be years old (a 2015 fund for a new quake)", () => {
    // GlobalGiving's Nepal fund dates from the 2015 earthquake; the search's date is the day the page last changed.
    const nepal = disaster({ countries: ["NP"], type: "earthquake", title: "Earthquake in Nepal", started: "2026-10-20T00:00:00.000Z" });
    expect(problem(gg("nepal-earthquake-relief-fund", "Nepal Earthquake Relief Fund - GlobalGiving", after(nepal, 3)), nepal)).toBe(
      "nothing dates it to this disaster (no storm name or recent year)",
    );
    expect(problem(gg("venezuela-earthquake-relief-fund", "", after(VENEZUELA, 2)), VENEZUELA)).toMatch(/^nothing dates it/);
    // A place of the title with the search's date is no proof either (the 2026-10-25 review's Kerala fund, a 2018-style fund, and a 2024 Chiang Rai fund).
    const kerala = disaster({ countries: ["IN"], type: "flood", title: "Floods in Kerala, India", started: "2026-10-10T00:00:00.000Z" });
    expect(problem(gg("kerala-flood-relief-fund", "Kerala Flood Relief Fund - GlobalGiving", "2026-10-14T00:00:00Z"), kerala)).toBe("nothing dates it to this disaster (no storm name or recent year)");
    const chiangRai = disaster({ countries: ["TH"], type: "flood", title: "Floods in Chiang Rai, Thailand", started: "2026-10-10T00:00:00.000Z" });
    expect(problem(gg("chiang-rai-flood-relief", "Chiang Rai Flood Relief - GlobalGiving", "2026-10-14T00:00:00Z"), chiangRai)).toMatch(/^nothing dates it/);
    const jajarkot = disaster({ countries: ["NP"], type: "earthquake", title: "Earthquake in Jajarkot, Nepal", started: "2026-10-20T00:00:00.000Z" });
    expect(problem(gg("jajarkot-earthquake-relief", "", after(jajarkot, 3)), jajarkot)).toMatch(/^nothing dates it/);
    // A recent year does date it.
    expect(problem(gg("jajarkot-earthquake-relief-2026", "", after(jajarkot, 3)), jajarkot)).toBeNull();
    expect(problem(gg("nepal-earthquake-relief-2026"), nepal)).toBeNull();
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
    expect(problem(gg("turkey-earthquake-relief-fund", "Turkey Earthquake Relief Fund - GlobalGiving"), turkey)).toBe("nothing dates it to this disaster (no storm name or recent year)");
    // The search dated it to the 2023 earthquake.
    expect(problem(gg("turkey-earthquake-relief-fund", "", "2023-02-07T00:00:00.000Z"), turkey)).toBe("dated 2023-02-07, before the disaster");
    expect(problem(gg("turkey-earthquake-relief-fund", "", after(turkey, 1)), turkey)).toMatch(/^nothing dates it/);
    expect(problem(gg("sindirgi-earthquake-relief-fund", "", after(turkey, 1)), turkey)).toMatch(/^nothing dates it/);
    expect(problem(gg("sindirgi-earthquake-relief-2026", "", after(turkey, 1)), turkey)).toBeNull();
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
      ["https://www.caribbean-news-global.com/donate-melissa", "news site"],
      ["https://news.example-jamaica.org/donate-melissa", "news site"],
      // The movement's names in other languages, and the UN's by a country's name.
      ["https://palangmerah-peduli.org/donasi-gempa", "its host carries an official body's or a platform's name (palangmerah)"],
      ["https://hilalahmar-maroc.org/don", "its host carries an official body's or a platform's name (hilalahmar)"],
      ["https://croissantrouge-maroc.org/don", "its host carries an official body's or a platform's name (croissantrouge)"],
      ["https://medialunaroja.org/donar", "its host carries an official body's or a platform's name (medialunaroja)"],
      ["https://sekijuji-shien.jp/bokin", "its host carries an official body's or a platform's name (sekijuji)"],
      ["https://nisseki-bokin.jp/noto", "its host carries an official body's or a platform's name (nisseki)"],
      ["https://kizilhac-yardim.org/bagis", "its host carries an official body's or a platform's name (kizilhac)"],
      ["https://un-jamaica.org/donate", "its host carries an official body's or a platform's name (un)"],
      ["https://defesacivil-doacoes.org.br/enchentes", "its host carries an official body's or a platform's name (defesacivil)"],
    ];
    for (const [url, why] of cases) expect([url, localUrlProblem(url, local)]).toEqual([url, why]);
    // A name inside a longer word is no claim.
    expect(localUrlProblem("https://mochacafe-kingston.org/melissa/donate", local)).toBeNull();
  });

  it("accepts groups whose hosts only contain news, gov or un inside a word (reviewed live, 2026-10-25)", () => {
    const urls = [
      "https://www.newstorycharity.org/haiti-hurricane-melissa/",
      "https://www.goodnewsschool.edu.jm/hurricane-melissa-relief",
      "https://www.newspringjamaica.org/melissa-appeal",
      "https://govindfoundation.org/kerala-flood-relief/",
      "https://govardhan-trust.org/kerala-floods-donate",
      "https://un-techo-para-mi-pais.org/terremoto-ecuador",
    ];
    for (const url of urls) expect([url, localUrlProblem(url, local)]).toEqual([url, null]);
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
      "https://forms.gle/abc123",
      // Platforms found by regional searches, whatever their paths ("/v4/campaign/", "/th/d/").
      "https://taejai.com/th/d/chiangrai-flood-2026/",
      "https://apoia.se/enchentes-rs",
      "https://ppl.pt/causas/cheias",
      "https://give.asia/campaign/kerala-flood",
      "https://www.simplygiving.com/event/kerala-floods",
      "https://www.launchgood.com/v4/campaign/morocco_earthquake_relief",
      "https://www.betterplace.me/erdbeben-marokko",
      "https://donation.yahoo.co.jp/detail/5612001/",
      "https://for-good.net/project/1001234",
      "https://www.kitabisa.org/campaign/gempasulawesi",
      "https://www.totalgiving.co.uk/appeal/hurricane-melissa",
      "https://www.givingway.com/donate/hurricane-melissa",
      "https://www.fundraiseup.com/x/hurricane-melissa",
    ];
    for (const url of urls) expect([url, localUrlProblem(url, local)]).toEqual([url, expect.stringMatching(/^(?:social network or a site anyone can publish on|crowdfunding or giving platform)$/)]);
  });

  it("refuses payment, checkout, money-transfer and crypto links", () => {
    const urls = [
      "https://donate.stripe.com/14k5lm9Ab2",
      "https://buy.stripe.com/14k5lm9Ab2",
      "https://checkout.sumup.com/pay/c-123",
      "https://link.mercadopago.com.ar/ayuda",
      "https://www.paypal.de/donate/?hosted_button_id=X",
      "https://commerce.coinbase.com/checkout/abc",
      "https://www.westernunion.com/us/en/send-money.html",
      "https://melissa-relief.myshopify.com/products/donation",
    ];
    for (const url of urls) expect([url, localUrlProblem(url, local)]).toEqual([url, "payment, checkout or money-transfer service"]);
  });

  it("refuses a person's page and news articles and blog posts by their paths, after a language or version", () => {
    const cases: [string, string][] = [
      ["https://kingstonrelief.org/@kingston/donate", "a person's page (/@kingston/...), not a group's own"],
      ["https://kingstonrelief.org/en/u/kingston/donate", "a person's page (/u/...), not a group's own"],
      ["https://kingstonrelief.org/v4/users/kingston", "a person's page (/users/...), not a group's own"],
      ["https://kingstonrelief.org/news/how-to-help", "a news article or blog post"],
      ["https://kingstonrelief.org/blog/donate-now", "a news article or blog post"],
      ["https://kingstonrelief.org/2025/10/how-to-help/", "a news article or blog post"],
    ];
    for (const [url, why] of cases) expect([url, localUrlProblem(url, local)]).toEqual([url, why]);
  });

  it("accepts a group's own appeal pages shaped like a platform's (WordPress Charitable's /campaigns/, /projects/, /team/)", () => {
    const urls = [
      "https://www.local-ngo.org.jm/campaigns/hurricane-melissa-relief/",
      "https://www.ebercollege.edu.jm/projects/rebuild-after-melissa",
      "https://www.escola.org.br/team/enchentes",
      "https://kingstonrelief.org/f/help-us",
      "https://www.fundacion-x.org.ve/proyectos/terremoto",
      "https://www.school.ac.th/บริจาค-น้ำท่วม",
    ];
    for (const url of urls) expect([url, localUrlProblem(url, local)]).toEqual([url, null]);
  });
});

describe("protectedNameInHost and protectedNameIn", () => {
  const index = ctxFor(MELISSA).countryNameIndex;
  it("finds an official body's or a platform's name in a host", () => {
    expect(protectedNameInHost("jamaicaredcrossrelief.org")).toBe("redcross");
    expect(protectedNameInHost("www.cruz-roja-venezuela.org")).toBe("cruzroja");
    expect(protectedNameInHost("ocha-relief.net")).toBe("ocha");
    expect(protectedNameInHost("jamaicagov-relief.org")).toBe("gov");
    expect(protectedNameInHost("jamaica-gov-relief.org")).toBe("gov");
    expect(protectedNameInHost("stelizabethrelief.org")).toBeNull();
    expect(protectedNameInHost("mocha.org")).toBeNull();
    expect(protectedNameInHost("fundraiser.org")).toBeNull();
  });

  it("finds the movement's names in other languages, and the UN's by an aid word or a country's name", () => {
    expect(protectedNameInHost("palangmerah-peduli.org")).toBe("palangmerah");
    expect(protectedNameInHost("hilalahmar-maroc.org")).toBe("hilalahmar");
    expect(protectedNameInHost("croissantrouge-maroc.org")).toBe("croissantrouge");
    expect(protectedNameInHost("medialunaroja.org")).toBe("medialunaroja");
    expect(protectedNameInHost("sekijuji-shien.jp")).toBe("sekijuji");
    expect(protectedNameInHost("kizilhac-yardim.org")).toBe("kizilhac");
    expect(protectedNameInHost("un-jamaica.org", index)).toBe("un");
    expect(protectedNameInHost("un-relief.org")).toBe("un");
    expect(protectedNameInHost("un.relief-jamaica.org")).toBe("un");
  });

  it("passes gov and un inside a word or another language: Govind, Govardhan, Un Techo para mi País", () => {
    expect(protectedNameInHost("govindfoundation.org")).toBeNull();
    expect(protectedNameInHost("govardhan-trust.org")).toBeNull();
    expect(protectedNameInHost("un-techo-para-mi-pais.org", index)).toBeNull();
    expect(protectedNameInHost("un-jamaica.org")).toBeNull();
  });

  it("finds a claim to be an official body or a platform in a name, in its own language and script", () => {
    expect(protectedNameIn("Jamaica Red Cross")).toBe("red cross");
    expect(protectedNameIn("Croix-Rouge haïtienne")).toBe("croix rouge");
    expect(protectedNameIn("UNICEF Jamaica")).toBe("unicef");
    expect(protectedNameIn("Ministry of Education")).toBe("ministry");
    expect(protectedNameIn("Ministerio de Salud")).toBe("ministry");
    expect(protectedNameIn("Government of Jamaica")).toBe("government");
    // The look-alikes the review found accepted (2026-10-25).
    expect(protectedNameIn("日本赤十字社 支援窓口")).toBe("赤十字");
    expect(protectedNameIn("Croissant-Rouge Solidarité Maroc")).toBe("croissant rouge");
    expect(protectedNameIn("Palang Merah Indonesia Peduli")).toBe("palang merah");
    expect(protectedNameIn("الهلال الأحمر")).toBe("هلال الأحمر");
    expect(protectedNameIn("สภากาชาดไทย")).toBe("กาชาด");
    expect(protectedNameIn("대한적십자사")).toBe("적십자");
    expect(protectedNameIn("Türk Kızılay")).toBe("kızılay");
    expect(protectedNameIn("Prefeitura de Porto Alegre")).toBe("prefeitura");
    expect(protectedNameIn("Protección Civil")).toBe("protección civil");
    expect(protectedNameIn("Kementerian Sosial")).toBe("kementerian");
    expect(protectedNameIn("政府救援")).toBe("政府");
    // And the registry's society names.
    expect(protectedNameIn("Magen David Adom in Israel appeal", ["Magen David Adom in Israel"])).toBe("magen david adom");
    expect(protectedNameIn("Bahamas Relief Society", ["Bahamas Relief Society"])).toBe("bahamas relief society");
  });

  it("passes schools, churches and groups whose names only look official", () => {
    for (const name of [
      "Hope for Jamaica",
      "St Andrew Youth Ministries",
      "Grace Ministry of Hope",
      "Ministerio de Alabanza Vida Nueva",
      "Government Girls High School",
      "Govt. Boys Degree College",
      "सरकारी विद्यालय",
      "Un Techo para mi País",
      "Media Luna Bakery Relief",
      "Red Crossing Church",
      "Good News School",
    ])
      expect([name, protectedNameIn(name)]).toEqual([name, null]);
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

describe("nameForms and ownCountryNames", () => {
  it("adds the shorter forms a page uses for a local name", () => {
    expect(nameForms("จังหวัดเชียงราย")).toEqual(["จังหวัดเชียงราย", "เชียงราย"]);
    expect(nameForms("เทศบาลนครเชียงราย")).toEqual(["เทศบาลนครเชียงราย", "เชียงราย"]);
    expect(nameForms("ประเทศไทย")).toEqual(["ประเทศไทย", "ไทย"]);
    expect(nameForms("石川県")).toEqual(["石川県", "石川"]);
    expect(nameForms("부산광역시")).toEqual(["부산광역시", "부산"]);
    expect(nameForms("محافظة حلب")).toEqual(["محافظة حلب", "حلب"]);
    // Arabic spellings vary in their last letter: سوريا, سورية.
    expect(nameForms("سوريا")).toEqual(["سوريا", "سوري"]);
    // Never shorter than a name can stand alone.
    expect(nameForms("津市")).toEqual(["津市"]);
    expect(nameForms("北海道")).toEqual(["北海道"]);
    expect(nameForms("")).toEqual([]);
  });

  it("names a country in the language most spoken there", () => {
    expect(ownCountryNames("TH")).toEqual(["ไทย"]);
    expect(ownCountryNames("MA")).toEqual(["المغرب"]);
    expect(ownCountryNames("JP")).toEqual(["日本"]);
    expect(ownCountryNames("BR")).toEqual(["Brasil"]);
    expect(ownCountryNames("CYN")).toEqual([]);
  });
});

describe("titleWithoutSite", () => {
  it("takes the site's name off either end of a title", () => {
    expect(titleWithoutSite("Eber College", "Rebuild Eber Prep | Eber College")).toBe("Rebuild Eber Prep");
    expect(titleWithoutSite("Eber College", "Eber College – Donate")).toBe("Donate");
    expect(titleWithoutSite("Eber College", "Eber College")).toBe("");
    expect(titleWithoutSite(undefined, "Donate")).toBe("Donate");
  });
});

describe("readPageSelf", () => {
  it("reads a page's site name, title and heading, and whether it is a news article", () => {
    const page = `<head><title>Ignored</title><meta content="Eber College" property="og:site_name"><meta property="og:title" content="Rebuild Eber Prep &amp; Jamaica | Eber College"><meta property="og:type" content="article"></head><h1>Rebuild <b>Eber</b> Prep</h1>`;
    // og:type "article" alone marks nothing: WordPress gives it to every page.
    expect(readPageSelf(page)).toEqual({ name: "Eber College", title: "Rebuild Eber Prep & Jamaica | Eber College", heading: "Rebuild Eber Prep", news: false });
    expect(readPageSelf("<title>Donate</title>")).toEqual({ name: "", title: "Donate", heading: "", news: false });
    expect(readPageSelf(`<script type="application/ld+json">{"@type":["NewsArticle"]}</script>`).news).toBe(true);
    expect(readPageSelf(`<script type="application/ld+json">{"@graph":[{"@type":"WebPage"},{"@type":"NewsMediaOrganization"}]}</script>`).news).toBe(true);
    expect(readPageSelf(FX.hubs["hurricane-melissa"]).news).toBe(false);
  });

  it("does not take a WordPress post for news: Yoast's Article and BlogPosting nodes and article:published_time", () => {
    expect(readPageSelf(`<script type="application/ld+json">{"@graph":[{"@type":"WebPage"},{"@type":"Article"}]}</script>`).news).toBe(false);
    expect(readPageSelf(`<script type="application/ld+json">{"@graph":[{"@type":"WebPage"},{"@type":"BlogPosting"}]}</script>`).news).toBe(false);
    expect(readPageSelf(`<meta property="article:published_time" content="2025-10-29T10:00:00Z">`).news).toBe(false);
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

describe("earlierEventProblem: another country, founding years, seasons", () => {
  const venezuela = disaster({ countries: ["VE"], type: "earthquake", title: "Venezuela Earthquake", started: "2026-10-20T00:00:00.000Z" });
  it("refuses a page whose title, heading or path names another country", () => {
    expect(earlierEventProblem(["Dona para el terremoto de Ecuador", "Terremoto en Ecuador: dona ahora"], { type: "earthquake", minYear: 2026 }, ctxFor(venezuela))).toBe("names another country");
    expect(earlierEventProblem(["/donar-terremoto-ecuador"], { type: "earthquake", minYear: 2026 }, ctxFor(venezuela))).toBe("names another country");
    expect(earlierEventProblem(["Terremoto en Venezuela: dona ahora"], { type: "earthquake", minYear: 2026 }, ctxFor(venezuela))).toBeNull();
  });

  it("passes a founding year and a season that runs into the disaster's year", () => {
    const kerala = disaster({ countries: ["IN"], type: "flood", title: "Floods in Kerala, India", started: "2026-10-10T00:00:00.000Z" });
    expect(earlierEventProblem(["Flood relief", "Serving Kerala since 1952"], { type: "flood", minYear: 2026 }, ctxFor(kerala))).toBeNull();
    const nsw = disaster({ countries: ["AU"], type: "wildfire", title: "Bushfires in New South Wales, Australia", started: "2026-02-10T00:00:00.000Z" });
    expect(earlierEventProblem(["2025-26 Bushfire Appeal", "Bushfire Appeal 2025/26"], { type: "wildfire", minYear: eventYear(nsw) }, ctxFor(nsw))).toBeNull();
    expect(earlierEventProblem(["2019-20 Bushfire Appeal"], { type: "wildfire", minYear: eventYear(nsw) }, ctxFor(nsw))).toBe("an earlier disaster's page (2020)");
  });
});

describe("topicProblem", () => {
  const ctx = ctxFor(MELISSA);
  const rules = { type: "cyclone" as const, titleNames: ["Melissa"] };
  it("takes a page whose title, heading or address names the storm or a place of the disaster's title", () => {
    expect(topicProblem(["Hurricane Melissa Appeal | St Joseph's", "", "/give/"], "", rules, ctx)).toBeNull();
    expect(topicProblem(["Donate", "", "/melissa-relief/donate"], "", rules, ctx)).toBeNull();
    const th = disaster({ countries: ["TH"], type: "flood", title: "Floods in Chiang Rai, Thailand" });
    // In the place's own script.
    expect(topicProblem(["อาสาเชียงราย", "", "/"], "", { type: "flood", titleNames: ["Chiang Rai", "เชียงราย"] }, ctxFor(th))).toBeNull();
  });

  it("takes a hazard of the disaster's kind, in any language, and asks a named storm's page to name the storm somewhere", () => {
    const th = disaster({ countries: ["TH"], type: "flood", title: "Flood in Thailand" });
    expect(topicProblem(["บริจาคช่วยน้ำท่วม | โรงเรียน", "", "/donate"], "", { type: "flood" }, ctxFor(th))).toBeNull();
    expect(topicProblem(["Hurricane relief | Hope for Jamaica", "", "/give"], "Help Jamaica rebuild after Hurricane Melissa.", rules, ctx)).toBeNull();
    expect(topicProblem(["Hurricane relief | Hope for Jamaica", "", "/give"], "Help Jamaica rebuild.", rules, ctx)).toBe("names the hazard but not the storm");
  });

  it("refuses a charity's general page that only names the country (the review's JSPCA and Japanese NGO pages)", () => {
    expect(topicProblem(["Give | JSPCA", "Support our animals", "/support-us/give"], "Donate to help stray dogs and cats across Jamaica.", rules, ctx)).toBe(
      "its title, heading and address name neither the disaster's hazard nor a place of its title",
    );
    const noto = disaster({ countries: ["JP"], type: "earthquake", title: "Earthquake in Noto, Japan" });
    expect(topicProblem(["ご支援のお願い | 某NPO", "ご支援のお願い", "/support/"], "寄付で子どもたちを支えてください。日本語", { type: "earthquake" }, ctxFor(noto))).toMatch(/^its title, heading and address name neither/);
  });
});

describe("pageDateProblem", () => {
  const ecuador = disaster({ countries: ["EC"], type: "earthquake", title: "Ecuador Earthquake", started: "2026-10-20T00:00:00.000Z" });
  const rules = { minYear: 2026, started: ecuador.started };
  it("refuses a page its own date puts well before the disaster", () => {
    expect(pageDateProblem("2016-04-20T10:00:00.000Z", ["Donaciones Terremoto | Escuela San José", "Ayuda tras el terremoto", "/donaciones-terremoto"], rules, ctxFor(ecuador))).toBe(
      "published 2016-04-20, before the disaster",
    );
  });

  it("passes a page with no date, a recent one, and an older page rewritten with the storm's name or a recent year", () => {
    expect(pageDateProblem(null, ["Donaciones Terremoto"], rules, ctxFor(ecuador))).toBeNull();
    expect(pageDateProblem("2026-10-12T00:00:00.000Z", ["Donaciones Terremoto"], rules, ctxFor(ecuador))).toBeNull();
    expect(pageDateProblem("2016-04-20T10:00:00.000Z", ["Terremoto 2026: donaciones"], rules, ctxFor(ecuador))).toBeNull();
    expect(pageDateProblem("2024-07-01T00:00:00.000Z", ["Hurricane Melissa relief | Hope for Jamaica"], { minYear: 2025, started: MELISSA.started }, ctxFor(MELISSA))).toBeNull();
    expect(pageDateProblem("2024-07-01T00:00:00.000Z", ["Hurricane relief | Hope for Jamaica"], { minYear: 2025, started: MELISSA.started }, ctxFor(MELISSA))).toBe("published 2024-07-01, before the disaster");
  });
});

describe("paymentProblem", () => {
  it("refuses pages that ask for crypto, gift cards, Zelle, Cash App, money transfers or transfers to a person", () => {
    expect(paymentProblem("URGENT: Send Bitcoin/Zelle to help Hurricane Melissa victims")).toBe("asks for crypto, as scams do");
    expect(paymentProblem("Pay with Zelle to relief@example.com")).toBe("asks for Zelle, as scams do");
    expect(paymentProblem("Buy Google Play cards and send the codes")).toBe("asks for gift cards, as scams do");
    expect(paymentProblem("Send it by Western Union to the family")).toBe("asks for a money-transfer service, as scams do");
    expect(paymentProblem("Wire transfer to my personal account")).toBe("asks for a transfer to a person's own account, as scams do");
    expect(paymentProblem("Deposita en mi cuenta personal")).toBe("asks for a transfer to a person's own account, as scams do");
  });

  it("passes a group's own bank details and a site's account links", () => {
    expect(paymentProblem("Donate by bank transfer to St Joseph's School, account 123")).toBeNull();
    expect(paymentProblem("Log in to My Account")).toBeNull();
    expect(paymentProblem("We accept PayPal and cards")).toBeNull();
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
    // A Drupal node's number is no year.
    expect(localAddressProblem("https://www.hopeforjamaica.org/node/2019", local, rules)).toBeNull();
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
    expect(await checkLocalPage(URL0, deps(async () => html(article)), local, rules)).toMatchObject({ ok: false, reason: "a news article" });
    const lookalike = `<title>Donate to Jamaica Red Cross hurricane Melissa relief</title><p>Give now to families in Kingston, Jamaica.</p>`;
    expect(await checkLocalPage(URL0, deps(async () => html(lookalike)), local, rules)).toMatchObject({ ok: false, reason: "its own name, title or heading claims an official body or a platform (red cross)" });
    const named = `<meta property="og:site_name" content="UNICEF Jamaica Appeal"><p>Donate for Jamaica</p>`;
    expect(await checkLocalPage(URL0, deps(async () => html(named)), local, rules)).toMatchObject({ ok: false, reason: "its own name, title or heading claims an official body or a platform (unicef)" });
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

describe("checkLocalPage: the review's pages (2026-10-25)", () => {
  /** The live check of one page for one disaster, as the integrator builds its rules. */
  async function check(url: string, page: string, d: ReturnType<typeof disaster>, localNames: Record<string, string[]> = {}, press: Record<string, string> = {}) {
    const ctx = ctxFor(d);
    const rules = localRules({ disaster: d, ctx, countryNames: NAMES, pressNames: press, localNames });
    return checkLocalPage(url, deps(async () => html(page)), { donation: ctx }, rules, 0);
  }
  const VE = disaster({ countries: ["VE"], type: "earthquake", title: "Venezuela Earthquake", started: "2026-10-20T00:00:00.000Z" });
  const JP = disaster({ countries: ["JP"], type: "earthquake", title: "Earthquake in Noto, Japan", started: "2026-10-20T00:00:00.000Z" });
  const ID = disaster({ countries: ["ID"], type: "earthquake", title: "Earthquake in Sulawesi, Indonesia", started: "2026-10-20T00:00:00.000Z" });
  const MA = disaster({ countries: ["MA"], type: "earthquake", title: "Morocco Earthquake", started: "2026-10-20T00:00:00.000Z" });
  const EC = disaster({ countries: ["EC"], type: "earthquake", title: "Ecuador Earthquake", started: "2026-10-20T00:00:00.000Z" });

  it("accepts World Central Kitchen's Typhoon Champi page, whose menu offers crypto among the usual ways to give (live run 40206842370)", async () => {
    const champi = disaster({ countries: ["PH", "JP", "CN", "KR"], type: "cyclone", title: "Super Typhoon Champi", started: "2026-10-14T00:00:00.000Z" });
    const wck = [
      `<title>WCK Responds to Typhoon Champi in Guam and the Northern Mariana Islands | WCK</title><meta property="og:site_name" content="WCK">`,
      `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Article","datePublished":"2026-10-20T13:23:43+00:00","dateModified":"2026-10-21T14:19:01+00:00"}]}</script>`,
      `<nav>Give Once Donate Crypto Give via PayPal Give Monthly Donate Stock Zakat Donate Now</nav>`,
      `<h1>WCK Responds to Typhoon Champi in Guam and the Northern Mariana Islands</h1>`,
      `<p>World Central Kitchen is responding to Typhoon Champi, which made landfall on Guam and the Northern Mariana Islands as a Category 4 storm. Donate Now</p>`,
    ].join("");
    expect(await check("https://wck.org/relief/typhoon-champi/", wck, champi)).toMatchObject({ ok: true, name: "WCK" });
  });

  it("refuses an unrelated charity's general page that only names the country (A1)", async () => {
    const jspca = `<title>Give | JSPCA</title><meta property="og:site_name" content="JSPCA"><h1>Support our animals</h1><p>Donate to help stray dogs and cats across Jamaica.</p>`;
    expect(await check("https://www.jspca.org.jm/support-us/give", jspca, MELISSA)).toMatchObject({ ok: false, reason: expect.stringMatching(/^its title, heading and address name neither/) });
    const npo = `<title>ご支援のお願い | 某NPO</title><meta property="og:site_name" content="某NPO"><h1>ご支援のお願い</h1><p>寄付で子どもたちを支えてください。日本語</p>`;
    expect(await check("https://www.some-npo.or.jp/support/", npo, JP)).toMatchObject({ ok: false, reason: expect.stringMatching(/^its title, heading and address name neither/) });
  });

  it("refuses look-alikes of the Red Cross and Red Crescent in other languages (A2)", async () => {
    const maroc = `<title>الهلال الأحمر - Croissant-Rouge : séisme au Maroc</title><meta property="og:site_name" content="Croissant-Rouge Solidarité Maroc"><h1>Séisme au Maroc : faites un don</h1><p>faire un don</p>`;
    expect(await check("https://www.secours-maroc-seisme.org/don", maroc, MA)).toMatchObject({ ok: false, reason: "its own name, title or heading claims an official body or a platform (croissant rouge)" });
    const nisseki = `<title>日本赤十字社 能登地震 義援金 受付</title><meta property="og:site_name" content="日本赤十字社 支援窓口"><h1>能登半島地震 義援金</h1><p>義援金を受け付けています。日本</p>`;
    expect(await check("https://www.noto-shien.jp/bokin", nisseki, JP)).toMatchObject({ ok: false, reason: "its own name, title or heading claims an official body or a platform (赤十字)" });
    const pmi = `<title>Palang Merah Indonesia - Donasi Gempa Sulawesi</title><meta property="og:site_name" content="Palang Merah Indonesia Peduli"><h1>Donasi Gempa Sulawesi</h1><p>donasi sekarang</p>`;
    expect(await check("https://www.pmi-peduli-gempa.org/donasi", pmi, ID)).toMatchObject({ ok: false, reason: "its own name, title or heading claims an official body or a platform (palang merah)" });
  });

  it("refuses another country's disaster page, though its footer names the disaster's country (A3)", async () => {
    const andes = `<title>Dona para el terremoto de Ecuador | Fundación Andes</title><meta property="og:site_name" content="Fundación Andes"><h1>Terremoto en Ecuador: dona ahora</h1><p>Donar</p><footer>Oficinas en Venezuela, Colombia y Ecuador</footer>`;
    expect(await check("https://www.fundacion-andes.org/terremoto", andes, VE)).toMatchObject({ ok: false, reason: "names another country" });
    // Unfetched, by its address.
    expect(await check("https://www.fundacion-andes.org/donar-terremoto-ecuador", andes, VE)).toMatchObject({ ok: false, reason: "names another country" });
  });

  it("refuses an old page dated by its own JSON-LD, with no year in its title (A4)", async () => {
    const old = `<title>Donaciones Terremoto | Escuela San José</title><meta property="og:site_name" content="Escuela San José"><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage","datePublished":"2016-04-20T10:00:00+00:00","dateModified":"2016-05-01T10:00:00+00:00"}]}</script><h1>Ayuda tras el terremoto</h1><p>El 16 de abril de 2016 un terremoto de 7,8 golpeó Ecuador. Donar aquí.</p>`;
    expect(await check("https://www.escuela-sanjose.edu.ec/donaciones-terremoto", old, EC)).toMatchObject({ ok: false, reason: "published 2016-04-20, before the disaster" });
  });

  it("refuses a page that asks for crypto or Zelle, whatever its title says (labels)", async () => {
    const scam = `<title>URGENT: Send Bitcoin/Zelle to help Hurricane Melissa victims</title><h1>Hurricane Melissa relief</h1><p>Donate. Jamaica.</p>`;
    expect(await check("https://www.jamaica-hope-relief.org/donate-hurricane", scam, MELISSA)).toMatchObject({ ok: false, reason: "asks for crypto, as scams do" });
    const body = `<title>Hurricane Melissa relief | Hope</title><p>Donate to Jamaica. Send your gift by Western Union to Mr Brown.</p>`;
    expect(await check("https://www.jamaica-hope-relief.org/melissa", body, MELISSA)).toMatchObject({ ok: false, reason: "asks for a money-transfer service, as scams do" });
  });

  it("accepts local groups' pages in their own scripts, by the places' own names and the country's (b)", async () => {
    const places = (country: string, ...names: string[]) => names.map((name) => ({ name, country, lat: 0, lng: 0, kind: "city" as const, source: "research" as const }));
    const haouz = disaster({ countries: ["MA"], type: "earthquake", title: "Earthquake in Al Haouz, Morocco", started: "2026-10-20T00:00:00.000Z", places: places("MA", "Al Haouz", "Marrakesh") });
    const atlas = `<title>تبرع لضحايا زلزال الحوز</title><meta property="og:site_name" content="جمعية الأطلس"><h1>زلزال الحوز: تبرع الآن</h1><p>تبرع لدعم الأسر في المغرب</p>`;
    expect(await check("https://www.jamiat-atlas.ma/tabarru", atlas, haouz)).toMatchObject({ ok: true, place: "المغرب", name: "جمعية الأطلس" });
    const aleppo = disaster({ countries: ["SY"], type: "earthquake", title: "Earthquake in Aleppo, Syria", started: "2026-10-20T00:00:00.000Z", places: places("SY", "Aleppo") });
    const halab = `<title>تبرع لمتضرري الزلزال في حلب</title><meta property="og:site_name" content="جمعية حلب"><h1>زلزال حلب</h1><p>تبرع الآن - سورية</p>`;
    expect(await check("https://www.example-sy.org/donate-quake", halab, aleppo, {}, { SY: "سوريا" })).toMatchObject({ ok: true, place: "سوري" });
    const chiangRai = disaster({ countries: ["TH"], type: "flood", title: "Floods in Chiang Rai, Thailand", started: "2026-10-10T00:00:00.000Z", places: places("TH", "Chiang Rai", "Mae Sai") });
    const school = `<title>บริจาคช่วยน้ำท่วมเชียงราย | โรงเรียนเชียงราย</title><meta property="og:site_name" content="โรงเรียนเชียงราย"><h1>ช่วยนักเรียนที่ประสบภัยน้ำท่วม</h1><p>บริจาค ไทย</p>`;
    expect(await check("https://www.school.ac.th/flood-donate", school, chiangRai, {}, { TH: "ประเทศไทย" })).toMatchObject({ ok: true });
    // Naming only เชียงราย, as the geocoder names Chiang Rai.
    const volunteers = `<title>บริจาคช่วยน้ำท่วมเชียงราย | อาสาเชียงราย</title><meta property="og:site_name" content="อาสาเชียงราย"><h1>ช่วยผู้ประสบภัยน้ำท่วมเชียงราย</h1><p>บริจาค</p>`;
    expect(await check("https://www.chiangrai-volunteers.or.th/flood", volunteers, chiangRai, { "Chiang Rai": ["จังหวัดเชียงราย"] })).toMatchObject({ ok: true, place: "เชียงราย" });
    expect(await check("https://www.chiangrai-volunteers.or.th/flood", volunteers, chiangRai)).toMatchObject({ ok: false, reason: "names none of the disaster's places" });
  });

  it("accepts a WordPress post, a season's appeal, a founding year, a government school and a storm's floods (b)", async () => {
    const post = `<title>Hurricane Melissa Appeal | St Joseph's</title><meta property="og:site_name" content="St Joseph's"><meta property="article:published_time" content="2025-10-29T10:00:00+00:00"><script type="application/ld+json">{"@graph":[{"@type":"WebPage","datePublished":"2025-10-29T10:00:00+00:00"},{"@type":"Article"}]}</script><h1>Hurricane Melissa Appeal</h1><p>Donate to rebuild our school in Jamaica.</p>`;
    expect(await check("https://www.stjoseph.edu.jm/hurricane-melissa-appeal/", post, MELISSA)).toMatchObject({ ok: true, title: "Hurricane Melissa Appeal | St Joseph's" });
    const nsw = disaster({ countries: ["AU"], type: "wildfire", title: "Bushfires in New South Wales, Australia", started: "2026-02-10T00:00:00.000Z" });
    const season = `<title>2025-26 Bushfire Appeal | Bega Valley Community Fund</title><meta property="og:site_name" content="Bega Valley Community Fund"><h1>Bushfire Appeal 2025/26</h1><p>Donate to families in New South Wales.</p>`;
    expect(await check("https://www.ruralfirebrigade-x.org.au/appeal", season, nsw)).toMatchObject({ ok: true });
    const kerala = disaster({ countries: ["IN"], type: "flood", title: "Floods in Kerala, India", started: "2026-10-10T00:00:00.000Z" });
    const since = `<title>Flood relief | St Mary's School</title><meta property="og:site_name" content="St Mary's School"><h1>Serving Kerala since 1952</h1><p>Donate to families hit by the floods in Kerala.</p>`;
    expect(await check("https://www.stmarys-school.ac.in/flood-relief", since, kerala)).toMatchObject({ ok: true, place: "Kerala" });
    const sindh = disaster({ countries: ["PK"], type: "flood", title: "Floods in Sindh, Pakistan", started: "2026-08-20T00:00:00.000Z" });
    const ggh = `<title>Flood Relief Fund | Government Girls High School Hyderabad</title><meta property="og:site_name" content="Government Girls High School Hyderabad"><h1>Sindh flood relief</h1><p>Donate for our students' families in Sindh.</p>`;
    expect(await check("https://www.gghs-hyderabad.edu.pk/flood-relief", ggh, sindh)).toMatchObject({ ok: true, name: "Government Girls High School Hyderabad" });
    const poland = disaster({ countries: ["PL"], type: "flood", title: "Flood in Poland", started: "2026-09-14T00:00:00.000Z", places: [{ name: "Kłodzko", country: "PL", lat: 0, lng: 0, kind: "town", source: "research" }] });
    const boris = `<title>Storm Boris flood relief | Kłodzko Scouts</title><meta property="og:site_name" content="Kłodzko Scouts"><h1>Storm Boris flood relief for Kłodzko</h1><p>Donate now: wpłać darowiznę.</p>`;
    expect(await check("https://www.harcerze-klodzko.pl/powodz", boris, poland)).toMatchObject({ ok: true, place: "Kłodzko" });
    // A Drupal node's number is no year.
    expect(await check("https://www.kerala-relief.org/node/2019", `<title>Kerala flood relief</title><p>Donate now.</p>`, kerala)).toMatchObject({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// The second review's rules, one function at a time (2026-10-25)
// ---------------------------------------------------------------------------

describe("asciiDigits, gregorianYears and eventYearsIn: other calendars and founding years", () => {
  it("writes other scripts' digits as ASCII", () => {
    expect(asciiDigits("भूकम्प २०७२")).toBe("भूकम्प 2072");
    expect(asciiDigits("น้ำท่วม ๒๕๖๗ / ٢٠١٦ / ۱۴۰۲ / ２０２４")).toBe("น้ำท่วม 2567 / 2016 / 1402 / 2024");
  });

  it("reads Thai Buddhist years, Japanese eras and Nepal's Bikram Sambat as their latest Gregorian year", () => {
    expect(gregorianYears("บริจาคช่วยน้ำท่วมเชียงราย 2567")).toBe("บริจาคช่วยน้ำท่วมเชียงราย 2024");
    expect(gregorianYears("令和6年能登半島地震")).toBe("2024年能登半島地震");
    expect(gregorianYears("令和元年 平成二十三年 昭和50年")).toBe("2019年 2011年 1975年");
    expect(gregorianYears("भूकम्प २०७२")).toBe("भूकम्प 2016");
    // Gregorian years stay: a Thai page's 2026, a Hindi page's २०२६, a 2567 on a page in another script.
    expect(gregorianYears("น้ำท่วม 2026")).toBe("น้ำท่วม 2026");
    expect(gregorianYears("बाढ़ २०२६")).toBe("बाढ़ 2026");
    expect(gregorianYears("Paybill 2567")).toBe("Paybill 2567");
  });

  it("finds the review's old pages' years", () => {
    expect(eventYearsIn("บริจาคช่วยน้ำท่วมเชียงราย 2567 | อาสาเชียงราย")).toEqual([2024]);
    expect(eventYearsIn("令和6年能登半島地震 緊急支援募金")).toEqual([2024]);
    expect(eventYearsIn("भूकम्प २०७२ पीडितलाई दान")).toEqual([2016]);
  });

  it("reads no founding or registration year as an event's, in the review's languages", () => {
    for (const text of [
      "Yayasan Al-Ikhlas, melayani Cianjur sejak 1990",
      "Tunahudumia jamii tangu 1990",
      "جمعية الأطلس في خدمة الحوز منذ 1990",
      "1990年設立の某NPO 能登半島地震 緊急支援",
      "تأسست عام 1990",
      "itinatag noong 1990",
      "mula noong 1990",
      "ตั้งแต่ปี 2533",
      "ก่อตั้งเมื่อปี 2533",
      "स्थापना २०४७",
      "1990 yılından beri",
      "1990'dan beri",
      "kuruluş 1990",
      "основан в 1990 году",
      "Kerala Flood Appeal (Reg. 1995)",
      "Registered charity no. 1990-123",
    ])
      expect([text, eventYearsIn(text)]).toEqual([text, []]);
  });

  it("counts a span of up to five years as its last", () => {
    expect(eventYearsIn("Bushfire Recovery 2025–2027")).toEqual([2027]);
    expect(eventYearsIn("Black Summer 2025 - 2026 Bushfire Appeal")).toEqual([2026]);
    expect(eventYearsIn("2010-2026 programme")).toEqual([2010, 2026]);
  });
});

describe("titlePlaces: phrases with their connectors", () => {
  it("keeps the words that join a place's name, and never joins across punctuation", () => {
    expect(titlePlaces("Floods in Rio Grande do Sul, Brazil", ["rio", "grande", "sul"])).toEqual(["Rio Grande do Sul"]);
    expect(titlePlaces("Earthquake in Port-au-Prince", ["port", "prince"])).toEqual(["Port-au-Prince"]);
    expect(titlePlaces("Floods in Kerala, Tamil Nadu", ["kerala", "tamil", "nadu"])).toEqual(["Kerala", "Tamil Nadu"]);
    expect(titlePlaces("Floods in Kerala and Tamil Nadu", ["kerala", "tamil", "nadu"])).toEqual(["Kerala", "Tamil Nadu"]);
    expect(titlePlaces("Earthquake in Al Haouz, Morocco", ["haouz"])).toEqual(["Haouz"]);
  });
});

describe("topicProblem: title places as whole phrases only", () => {
  it("refuses a page that only shares a word with a place of the title (the review's Chiang Mai and Rio de Janeiro pages)", () => {
    const br = disaster({ countries: ["BR"], type: "flood", title: "Floods in Rio Grande do Sul, Brazil" });
    expect(topicProblem(["Doe | Casa do Menor Rio de Janeiro", "Faça sua doação", "/doe/"], "", { type: "flood" }, ctxFor(br))).toMatch(/^its title, heading and address name neither/);
    expect(topicProblem(["Doe", "Enchentes: doe agora", "/doe/"], "", { type: "flood" }, ctxFor(br))).toBeNull();
    expect(topicProblem(["SOS Rio Grande do Sul", "", "/doe/"], "", { type: "flood" }, ctxFor(br))).toBeNull();
    expect(topicProblem(["Doe", "", "/sos-rio-grande-do-sul/"], "", { type: "flood" }, ctxFor(br))).toBeNull();
    const th = disaster({ countries: ["TH"], type: "flood", title: "Floods in Chiang Rai, Thailand" });
    expect(topicProblem(["Chiang Mai Children's Home", "Support our children", "/donate/"], "", { type: "flood" }, ctxFor(th))).toMatch(/^its title, heading and address name neither/);
  });

  it("takes a storm's other name as its name", () => {
    const ph = disaster({ countries: ["PH"], type: "cyclone", title: "Typhoon Kalmaegi" });
    expect(topicProblem(["Tulong para sa Tino", "", "/relief"], "", { type: "cyclone" }, ctxFor(ph))).toBeNull();
    expect(topicProblem(["Bagyong relief drive", "", "/relief"], "Help Cebu after Bagyong Tino.", { type: "cyclone" }, ctxFor(ph))).toBeNull();
  });
});

describe("ownTitle", () => {
  it("takes the site's name off a title by its og:site_name, its start or end, or its host", () => {
    expect(ownTitle({ name: "Chiang Mai Children's Home", title: "Donate | Chiang Mai Children's Home" }, "https://www.chiangmaichildrenshome.org/donate/")).toBe("Donate");
    expect(ownTitle({ name: "Casa do Menor", title: "Doe | Casa do Menor Rio de Janeiro" }, "https://www.casadomenor-rj.org.br/doe/")).toBe("Doe");
    expect(ownTitle({ name: "", title: "Donate | Kerala Children's Trust" }, "https://www.keralachildrenstrust.org/donate/")).toBe("Donate");
    // A part that names the page stays, and so does a span of years.
    expect(ownTitle({ name: "", title: "Hurricane Melissa Relief | Hope for Jamaica" }, "https://www.melissa-relief.org/give")).toBe("Hurricane Melissa Relief | Hope for Jamaica");
    expect(ownTitle({ name: "Bega Valley Community Fund", title: "Black Summer 2025 - 2026 Bushfire Appeal | Bega Valley Community Fund" }, "https://www.begavalleyfund.org.au/appeal")).toBe(
      "Black Summer 2025 - 2026 Bushfire Appeal",
    );
  });
});

describe("pageDateProblem, modifiedOf, timeOf and leadYearProblem", () => {
  const br = disaster({ countries: ["BR"], type: "flood", title: "Floods in Rio Grande do Sul, Brazil", started: "2026-10-10T00:00:00.000Z" });
  const rules = { minYear: 2026, started: br.started, type: "flood" as const, titleNames: ["Rio Grande do Sul"] };
  it("passes an old page changed since the disaster whose title or heading names its hazard and a place of its title", () => {
    const own = ["Doe", "Enchentes no Rio Grande do Sul: doe agora", "/doe/"];
    expect(pageDateProblem("2021-03-02T13:00:00.000Z", own, rules, ctxFor(br), "2026-10-12T12:00:00.000Z")).toBeNull();
    expect(pageDateProblem("2021-03-02T13:00:00.000Z", own, rules, ctxFor(br), "2024-05-12T12:00:00.000Z")).toBe("published 2021-03-02, before the disaster");
    expect(pageDateProblem("2021-03-02T13:00:00.000Z", ["Doe", "Doe agora", "/doe/"], rules, ctxFor(br), "2026-10-12T12:00:00.000Z")).toBe("published 2021-03-02, before the disaster");
  });

  it("reads a page's dateModified and its first <time>", () => {
    expect(modifiedOf(`<script type="application/ld+json">{"@graph":[{"@type":"WebPage","datePublished":"2021-03-02","dateModified":"2026-10-12T09:00:00-03:00"}]}</script>`)).toBe("2026-10-12T12:00:00.000Z");
    expect(modifiedOf(`<meta property="article:modified_time" content="2026-10-12T12:00:00Z">`)).toBe("2026-10-12T12:00:00.000Z");
    expect(modifiedOf("<p>no date</p>")).toBeNull();
    expect(timeOf(`<p>Posted <time datetime="2016-04-20T10:00:00Z">20 April</time></p>`)).toBe("2016-04-20T10:00:00.000Z");
    expect(timeOf("<p>no date</p>")).toBeNull();
  });

  it("refuses a page whose first paragraphs give an older year next to the disaster's hazard, and passes a recent one or another hazard's", () => {
    const ec = disaster({ countries: ["EC"], type: "earthquake", title: "Ecuador Earthquake", started: "2026-10-20T00:00:00.000Z" });
    const r = { type: "earthquake" as const, minYear: 2026 };
    const page = (p: string) => `<nav>Inicio 2016</nav><h1>Ayuda tras el terremoto</h1><p>${p}</p>`;
    expect(leadYearProblem(page("El 16 de abril de 2016 un terremoto de 7,8 golpeó Ecuador. Donar aquí."), [], r, ctxFor(ec))).toBe("an earlier disaster's page (2016)");
    expect(leadYearProblem(page("In 2016 a 7.8 earthquake struck Ecuador. Donate here."), [], r, ctxFor(ec))).toBe("an earlier disaster's page (2016)");
    expect(leadYearProblem(page("El terremoto de 2016 nos enseñó mucho. El terremoto de 2026 nos necesita."), [], r, ctxFor(ec))).toBeNull();
    expect(leadYearProblem(page("Since the 2016 floods we have rebuilt schools. Donate for the earthquake."), [], r, ctxFor(ec))).toBeNull();
    expect(leadYearProblem(page("El 16 de abril de 2016 un terremoto golpeó Ecuador."), ["Terremoto 2026"], r, ctxFor(ec))).toBeNull();
  });
});

describe("country names in other languages", () => {
  it("folds text as country names are matched in it", () => {
    expect(nameText("Côte d’Ivoire")).toBe("cote d ivoire");
    expect(nameText("سورية / سوريا")).toBe("سوريا سوريا");
    expect(nameText("サン・マルタン")).toBe("サンマルタン");
  });

  it("reads a disaster's pages in its countries' languages and a fixed set, each once", () => {
    expect(nameLanguages(["MA"], { MA: "fr" })).toEqual(["fr", "ar", "es", "pt", "id", "tr", "ru", "zh", "ja", "th", "de", "it"]);
    expect(nameLanguages(["NP"], { NP: "ne" })[0]).toBe("ne");
    expect(nameLanguages(["TW"])[0]).toBe("zh-Hant");
  });

  it("names every country in those languages, leaving out what the English names read, saints and common words", () => {
    const names = countryNamesIn(["fr", "ar", "ja", "es"], ctxFor(MELISSA).countryNameIndex ?? {});
    const codes = (n: string) => names.find((x) => x.name === n)?.codes;
    expect(codes("algerie")).toEqual(["DZ"]);
    expect(codes(nameText("الجزائر"))).toEqual(["DZ"]);
    expect(codes("トルコ")).toEqual(["TR"]);
    // Both Congos, by the name before " - ".
    expect(codes("الكونغو")?.sort()).toEqual(["CD", "CG"]);
    for (const n of ["georgia", "jersey", "panama", "maurice", "dominique", "granada", "saint martin", "مالي", "chili"]) expect([n, codes(n)]).toEqual([n, undefined]);
    expect(countryNamesIn(["de"], ctxFor(MELISSA).countryNameIndex ?? {}).find((x) => x.name === "island")).toBeUndefined();
  });

  it("finds another country's name in the review's pages, and none in the disaster's own", () => {
    const ma = ctxFor(disaster({ countries: ["MA"], type: "earthquake", title: "Morocco Earthquake" }));
    const langs = nameLanguages(["MA"], { MA: "fr" });
    expect(foreignCountryIn(["Faites un don pour le séisme en Algérie"], ma, langs)).toBe("algerie");
    expect(foreignCountryIn(["تبرع لضحايا زلزال تركيا وسوريا"], ma, langs)).toBe("تركيا");
    expect(foreignCountryIn(["/don-seisme-algerie"], ma, langs)).toBe("algerie");
    expect(foreignCountryIn(["Séisme au Maroc : faites un don", "تبرع للمغرب", "بالمغرب"], ma, langs)).toBeNull();
    const ve = ctxFor(disaster({ countries: ["VE"], type: "earthquake", title: "Venezuela Earthquake" }));
    expect(foreignCountryIn(["Terremoto en Turquía y Siria: dona ahora"], ve, nameLanguages(["VE"]))).toBe("turquia");
    expect(foreignCountryIn(["Erdbeben in der Türkei: jetzt spenden"], ma, langs)).toBe("turkei");
    // English pages' words: island families, a church's chili supper.
    const us = ctxFor(disaster({ countries: ["US"], type: "cyclone", title: "Hurricane Helene" }));
    expect(foreignCountryIn(["Chili supper for island families after Hurricane Helene"], us, nameLanguages(["US"]))).toBeNull();
    // Words that only look like a country's name: Japanese タイトル (a title), Chūgoku in western Japan, financial support in Arabic.
    const jp = ctxFor(disaster({ countries: ["JP"], type: "flood", title: "Floods in Japan" }));
    expect(foreignCountryIn(["中国地方 豪雨 緊急支援 タイトル"], jp, nameLanguages(["JP"]))).toBeNull();
    expect(foreignCountryIn(["タイの洪水"], jp, nameLanguages(["JP"]))).toBe("タイ");
    expect(foreignCountryIn(["دعم مالي للأسر"], ma, langs)).toBeNull();
    // The longest name wins: Soudan du Sud is South Sudan.
    const ss = ctxFor(disaster({ countries: ["SS"], type: "flood", title: "Floods in South Sudan" }));
    expect(foreignCountryIn(["Inondations au Soudan du Sud"], ss, nameLanguages(["SS"]))).toBeNull();
    // A name inside one of the disaster's own places names no other country.
    const jo = ctxFor(disaster({ countries: ["JO"], type: "flood", title: "Floods in Jordan" }));
    expect(foreignCountryIn(["فيضانات عمان"], jo, nameLanguages(["JO"]), ["عمان"])).toBeNull();
  });
});

describe("readWords through earlierEventProblem: a disaster's own places and states", () => {
  it("reads no other country in a US disaster's state names or its places' names", () => {
    const helene = disaster({ countries: ["US"], type: "cyclone", title: "Hurricane Helene" });
    expect(earlierEventProblem(["Hurricane Helene Relief for South Georgia Families"], { type: "cyclone", minYear: 2026 }, ctxFor(helene))).toBeNull();
    expect(earlierEventProblem(["Hurricane Milton relief for Panama City families"], { type: "cyclone", minYear: 2026 }, ctxFor(disaster({ countries: ["US"], title: "Hurricane Milton" })))).toBeNull();
    const nj = disaster({ countries: ["US"], type: "flood", title: "Flood in United States" });
    expect(earlierEventProblem(["Jersey Shore Flood Relief"], { type: "flood", minYear: 2026 }, ctxFor(nj))).toBeNull();
    // Elsewhere the Jersey Shore is in another country, unless one of the disaster's own places holds the name.
    expect(earlierEventProblem(["Jersey Shore Flood Relief"], { type: "flood", minYear: 2026 }, ctxFor(disaster({ countries: ["CA"], type: "flood", title: "Flood in Canada" })))).toBe("names another country");
    const co = ctxFor(disaster({ countries: ["CO"], type: "flood", title: "Inundaciones en Colombia" }));
    expect(earlierEventProblem(["Ayuda al barrio Venezuela tras la inundación"], { type: "flood", minYear: 2026 }, co)).toBe("names another country");
    expect(earlierEventProblem(["Ayuda al barrio Venezuela tras la inundación"], { type: "flood", minYear: 2026, ownPlaces: ["Barrio Venezuela"] }, co)).toBeNull();
    expect(globalGivingProblem({ url: "https://www.globalgiving.org/projects/hurricane-helene-south-georgia-relief/", title: "" }, helene, ctxFor(helene))).toBeNull();
  });
});

describe("protected names: the UN, more of the movement's names, regional governments and relief funds", () => {
  it("finds the review's names", () => {
    expect(protectedNameIn("UN Crisis Relief")).toBe("un crisis relief");
    expect(protectedNameIn("Un Crisis Relief Fund")).toBe("un crisis relief");
    expect(protectedNameIn("U.N. Relief for Haiti")).toBe("UN");
    expect(protectedNameIn("UN Hurricane Relief Fund")).toBe("UN");
    expect(protectedNameIn("UN-Habitat Jamaica")).toBe("UN");
    expect(protectedNameIn("UN Women Jamaica")).toBe("un women");
    expect(protectedNameIn("UNRWA")).toBe("unrwa");
    expect(protectedNameIn("IOM UN Migration")).toBe("iom");
    expect(protectedNameIn("UN HURRICANE RELIEF")).toBe("UN");
    expect(protectedNameIn("د افغانستان د سره میاشتې ټولنه")).toBe("سره میاشت");
    expect(protectedNameIn("Ҳилоли Аҳмари Тоҷикистон")).toBe("ҳилоли аҳмар");
    expect(protectedNameIn("Кыргызстандын Кызыл Жарым Ай коому")).toBe("кызыл жарым ай");
    expect(protectedNameIn("Ўзбекистон Қизил Ярим Ой жамияти")).toBe("қизил ярим ой");
    expect(protectedNameIn("日本ユニセフ協会")).toBe("ユニセフ");
    expect(protectedNameIn("유니세프 한국위원회")).toBe("유니세프");
    expect(protectedNameIn("اليونيسف")).toBe("يونيسف");
    expect(protectedNameIn("ЮНИСЕФ")).toBe("юнисеф");
    expect(protectedNameIn("CMDRF Kerala")).toBe("cmdrf");
    expect(protectedNameIn("Chief Minister's Distress Relief Fund - Kerala Floods")).toBe("relief fund");
    expect(protectedNameIn("Prime Minister's National Relief Fund")).toBe("relief fund");
    expect(protectedNameIn("Generalitat Valenciana")).toBe("generalitat");
    expect(protectedNameIn("Royaume du Maroc")).toBe("royaume");
    expect(protectedNameIn("المملكة المغربية")).toBe("المملكة المغربية");
    expect(protectedNameIn("Gobernación de Antioquia")).toBe("gobernación");
    expect(protectedNameIn("Câmara Municipal de Lisboa")).toBe("câmara municipal");
    expect(protectedNameIn("Municipalidad de Lima")).toBe("municipalidad");
    expect(protectedNameIn("PMI Peduli", [], ["PMI"])).toBe("PMI");
  });

  it("passes French and Spanish 'un', all-capitals articles and students' governments", () => {
    for (const name of [
      "Faites un don pour Haïti",
      "Un Techo para mi País",
      "UN DON POUR HAÏTI",
      "Supreme Student Government Relief Drive for Typhoon Kalmaegi",
      "SSLG Relief Drive",
      "Gobierno Escolar Colegio San José",
      "Pmi workers' relief",
      "Un habitat digne pour tous",
      "Junta de Vecinos Villa Alegre",
    ])
      expect([name, protectedNameIn(name, [], ["PMI"])]).toEqual([name, null]);
  });

  it("finds a word that mixes Latin with Cyrillic or Greek letters", () => {
    expect(mixedScriptWord("Jamaica Rеd Cross")).toBe("Rеd");
    expect(mixedScriptWord("Cruz Rοja")).toBe("Rοja");
    expect(mixedScriptWord("Jamaica Red Cross")).toBeNull();
    expect(mixedScriptWord("Ҳилоли Аҳмари Тоҷикистон")).toBeNull();
    expect(mixedScriptWord(undefined)).toBeNull();
  });

  it("reads the societies' short names from their hosts", () => {
    expect(societyAcronyms(["pmi.or.id", "arcs.org.af", "www.nrcs.org", "redcross.org.ph", "en.example.org", "cruzroja.es/folder"])).toEqual(["PMI", "ARCS", "NRCS"]);
  });

  it("finds the UN in look-alike hosts, and passes 'un' in other words", () => {
    expect(protectedNameInHost("uncrisisrelief.org")).toBe("uncrisisrelief");
    expect(protectedNameInHost("un-hurricane-relief.org")).toBe("un");
    expect(protectedNameInHost("www.uncrisisrelief-jamaica.org")).toBe("uncrisisrelief");
    expect(protectedNameInHost("unhumanitarian-fund.org")).toBe("un");
    expect(protectedNameInHost("iom-haiti.org")).toBe("iom");
    expect(protectedNameInHost("unrwa-donate.org")).toBe("unrwa");
    for (const host of ["unidos-por-haiti.org", "union-relief.org", "university-relief.org", "un-techo-para-mi-pais.org", "radiom.org", "unityschool.edu.jm"])
      expect([host, protectedNameInHost(host)]).toEqual([host, null]);
  });
});

describe("localUrlProblem: the review's platform and payment hosts, and good news", () => {
  const local: LocalContext = { donation: ctxFor(MELISSA) };
  it("refuses the platforms and payment links the lists missed", () => {
    for (const url of [
      "https://www.cotizi.com/campaign/seisme-al-haouz-douar-tikht",
      "https://fonzip.com/ahbap/deprem",
      "https://www.juntos.com.vc/pt/enchentes-rs",
      "https://www.isupportjamaica.com/projects/hurricane-melissa-relief",
      "https://www.bitgiving.com/kerala-flood-relief",
      "https://sharinghappiness.org/gempa-cianjur",
      "https://www.amalsholeh.com/gempa-cianjur",
      "https://wecare.id/gempa-cianjur",
      "https://cafdonate.cafonline.org/12345",
      "https://hipgive.org/project/terremoto-venezuela",
      "https://donate.app.neoncrm.com/forms/hurricane-melissa",
      "https://secure.everyaction.com/abc123",
    ])
      expect([url, localUrlProblem(url, local)]).toEqual([url, "crowdfunding or giving platform"]);
    for (const url of [
      "https://www.asaas.com/c/enchentes-rs",
      "https://link.infinitepay.io/enchentes",
      "https://payments.cashfree.com/forms/kerala-flood",
      "https://wipayfinancial.com/pay/melissa-relief",
      "https://pay.khalti.com/donate/earthquake",
      "https://esewa.com.np/donate/earthquake",
      "https://pagar.me/enchentes",
      "https://www.paymaya.com/donate/typhoon",
      "https://www.instamojo.in/kerala-flood",
    ])
      expect([url, localUrlProblem(url, local)]).toEqual([url, "payment, checkout or money-transfer service"]);
  });

  it("passes a church whose host says good news, and still refuses a news host", () => {
    expect(localUrlProblem("https://www.good-news-church.org.jm/hurricane-melissa-relief", local)).toBeNull();
    expect(localUrlProblem("https://www.goodnews-ministries.org/hurricane-melissa-relief", local)).toBeNull();
    expect(localUrlProblem("https://www.jamaica-news.org/hurricane-melissa-relief", local)).toBe("news site");
  });
});

describe("platformProblem", () => {
  it("knows a person's campaign on a platform by what it says", () => {
    expect(platformProblem("Campagne créée par Youssef B. Faire un don. Lancer ma cagnotte. Maroc")).toMatch(/^a person's campaign on a crowdfunding platform/);
    expect(platformProblem("Hurricane Melissa Relief for Black River. Project by Andre W. Donate. Start a project. Jamaica")).toMatch(/^a person's campaign/);
    for (const text of ["Crie sua vaquinha", "Crea tu campaña", "Buat galang dana", "Kampanya oluştur", "Start a fundraiser", "Campaign created by Maria", "Spendenaktion starten", "クラウドファンディングを始める"])
      expect([text, platformProblem(text)]).toEqual([text, expect.stringMatching(/^a person's campaign/)]);
  });

  it("passes a group's own appeal", () => {
    for (const text of ["Relief drive organised by the PTA of Black River High School", "Penggalangan dana untuk korban gempa Cianjur", "A project by the Rotary Club of Kingston", "Donate to our campaign for Hurricane Melissa"])
      expect([text, platformProblem(text)]).toEqual([text, null]);
  });
});

describe("paymentProblem: the review's asks", () => {
  it("refuses crypto by ticker or address, and transfers into a person's account", () => {
    expect(paymentProblem("Donate BTC to bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh. Jamaica.")).toBe("asks for crypto, as scams do");
    expect(paymentProblem("Send to bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh")).toBe("asks for crypto, as scams do");
    expect(paymentProblem("Send to 0x52908400098527886E0F7030069857D2E4169EE7")).toBe("asks for crypto, as scams do");
    expect(paymentProblem("Send to TJCnKsPa7y5okkXvQAidZBzqx3QyQ6sxMW")).toBe("asks for crypto, as scams do");
    expect(paymentProblem("Terremoto: dona en criptomonedas. Donar USDC o BTC. Venezuela.")).toBe("asks for crypto, as scams do");
    expect(paymentProblem("Doe em criptomoedas")).toBe("asks for crypto, as scams do");
    // World Central Kitchen's menu on its Typhoon Champi page (live run 40206842370): crypto as one option among the usual ones.
    expect(paymentProblem("WCK Responds to Typhoon Champi in Guam and the Northern Mariana Islands. Give Once Donate Crypto Give via PayPal Give Monthly Donate Stock Zakat")).toBeNull();
    // A wallet address is refused even beside the usual ways to give.
    expect(paymentProblem("Give once by credit card or PayPal, or send BTC to bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh")).toBe("asks for crypto, as scams do");
    expect(paymentProblem("Pay by credit card, or use Zelle")).toBe("asks for Zelle, as scams do");
    expect(paymentProblem("Donar: deposita en mi cuenta Banesco 0134-xxxx a nombre de Juan Pérez. Venezuela.")).toBe("asks for a transfer to a person's own account, as scams do");
    expect(paymentProblem("Transferencia: cuenta corriente 0102-123 a nombre de Juan Pérez")).toBe("asks for a transfer to a person's own account, as scams do");
    expect(paymentProblem("Donate: transfer to my account at NCB, 123456789, John Brown. Jamaica.")).toBe("asks for a transfer to a person's own account, as scams do");
    expect(paymentProblem("Deposite na minha conta do Nubank")).toBe("asks for a transfer to a person's own account, as scams do");
    expect(paymentProblem("Scratch the card and send us the gift card codes")).toBe("asks for gift cards, as scams do");
    expect(paymentProblem("Send Amazon gift cards to help")).toBe("asks for gift cards, as scams do");
  });

  it("passes supermarket gift cards for families and a group's own account", () => {
    expect(paymentProblem("Donate cash or Woolworths and Coles gift cards for families in New South Wales.")).toBeNull();
    expect(paymentProblem("Cuenta corriente Banco de Venezuela 0102-123 a nombre de Fundación Andes")).toBeNull();
    expect(paymentProblem("Depósito: conta 1234-5 em nome da Associação Amigos do Bairro")).toBeNull();
    expect(paymentProblem("Agradecemos a nombre de todos los niños")).toBeNull();
    expect(paymentProblem("The ripple effect of your gift")).toBeNull();
    expect(paymentProblem("Fundación Sol para Venezuela")).toBeNull();
  });
});

describe("storms' other names", () => {
  it("does not take PAGASA's name for another storm", () => {
    const ph = disaster({ countries: ["PH"], type: "cyclone", title: "Typhoon Kalmaegi" });
    expect(disasterStorms(ctxFor(ph))).toEqual(["kalmaegi", "tino"]);
    expect(otherStorm(["typhoon", "tino", "relief"], ctxFor(ph), "cyclone")).toBeNull();
    expect(otherStorm(["bagyong", "tino"], ctxFor(ph), "cyclone")).toBeNull();
    expect(otherStorm(["bagyong", "odette"], ctxFor(ph), "cyclone")).toBe("odette");
    // From an IFRC appeal's name, for a storm the list lacks.
    const appeal = disaster({ countries: ["PH"], type: "cyclone", title: "Typhoon Halong", appeals: [{ code: "MDRPH060", name: "Philippines: Typhoon Halong (Basyang)", kind: "DREF", requested: 0, funded: 0, url: "", end: "" }] });
    expect(disasterStorms(ctxFor(appeal))).toEqual(["halong", "basyang"]);
  });
});

describe("checkLocalPage: the second review's pages (2026-10-25)", () => {
  type Extra = Partial<Omit<LocalContext, "donation">>;
  /** The live check of one page for one disaster, as the integrator builds its rules. */
  async function check(url: string, page: string, d: ReturnType<typeof disaster>, localNames: Record<string, string[]> = {}, extra: Extra = {}) {
    const ctx = ctxFor(d);
    const rules = localRules({ disaster: d, ctx, countryNames: NAMES, pressNames: {}, localNames });
    return checkLocalPage(url, deps(async () => html(page)), { donation: ctx, ...extra }, rules, 0);
  }
  const places = (country: string, ...names: string[]) => names.map((name) => ({ name, country, lat: 0, lng: 0, kind: "city" as const, source: "research" as const }));
  const at = (started: string) => ({ started: `${started}T00:00:00.000Z` });
  const MA = disaster({ countries: ["MA"], type: "earthquake", title: "Morocco Earthquake", ...at("2026-10-20") });
  const HAOUZ = disaster({ countries: ["MA"], type: "earthquake", title: "Earthquake in Al Haouz, Morocco", ...at("2026-10-20"), places: places("MA", "Al Haouz", "Marrakesh") });
  const VE = disaster({ countries: ["VE"], type: "earthquake", title: "Venezuela Earthquake", ...at("2026-10-20") });
  const DZ = disaster({ countries: ["DZ"], type: "earthquake", title: "Algeria Earthquake", ...at("2026-10-20") });
  const TH = disaster({ countries: ["TH"], type: "flood", title: "Floods in Chiang Rai, Thailand", ...at("2026-10-10"), places: places("TH", "Chiang Rai") });
  const TH_NAMES = { "Chiang Rai": ["จังหวัดเชียงราย", "เทศบาลนครเชียงราย", "เชียงราย"] };
  const BR = disaster({ countries: ["BR"], type: "flood", title: "Floods in Rio Grande do Sul, Brazil", ...at("2026-10-10") });
  const KERALA = disaster({ countries: ["IN"], type: "flood", title: "Floods in Kerala, India", ...at("2026-10-10") });
  const NOTO = disaster({ countries: ["JP"], type: "earthquake", title: "Earthquake in Noto, Japan", ...at("2026-10-20"), places: places("JP", "Noto") });
  const NOTO_NAMES = { Noto: ["能登町", "能登"] };
  const NP = disaster({ countries: ["NP"], type: "earthquake", title: "Earthquake in Nepal", ...at("2026-10-20") });
  const PH = disaster({ countries: ["PH"], type: "cyclone", title: "Typhoon Kalmaegi", ...at("2026-10-20"), places: places("PH", "Cebu") });
  const KE = disaster({ countries: ["KE"], type: "flood", title: "Floods in Kenya", ...at("2026-10-10"), places: places("KE", "Budalangi") });
  const AF = disaster({ countries: ["AF"], type: "earthquake", title: "Earthquake in Kunar, Afghanistan", ...at("2026-10-20"), places: places("AF", "Kunar") });
  const ES = disaster({ countries: ["ES"], type: "flood", title: "Floods in Valencia, Spain", ...at("2026-10-20"), places: places("ES", "Valencia") });
  const TJ = disaster({ countries: ["TJ"], type: "flood", title: "Floods in Tajikistan", ...at("2026-10-20") });
  const ID = disaster({ countries: ["ID"], type: "earthquake", title: "Earthquake in Cianjur, Indonesia", ...at("2026-10-20"), places: places("ID", "Cianjur") });
  const EC = disaster({ countries: ["EC"], type: "earthquake", title: "Ecuador Earthquake", ...at("2026-10-20") });
  const NSW = disaster({ countries: ["AU"], type: "wildfire", title: "Bushfires in New South Wales, Australia", ...at("2026-02-10") });
  const JM = disaster({ countries: ["JM"] });
  const refused = (reason: string | RegExp) => ({ ok: false, reason: typeof reason === "string" ? reason : expect.stringMatching(reason) });

  it("refuses look-alikes of the UN and of official bodies the first fix missed, in their own languages and scripts (A2)", async () => {
    const uncr = `<title>Hurricane Melissa Humanitarian Fund | UN Crisis Relief</title><meta property="og:site_name" content="UN Crisis Relief"><h1>Hurricane Melissa Humanitarian Fund</h1><p>Donate to people affected in Jamaica, Haiti and Cuba.</p>`;
    expect(await check("https://uncrisisrelief.org/hurricane-melissa", uncr, MELISSA)).toMatchObject(refused("its host carries an official body's or a platform's name (uncrisisrelief)"));
    expect(await check("https://www.melissa-crisis-relief.org/donate", uncr, MELISSA)).toMatchObject(refused("its own name, title or heading claims an official body or a platform (un crisis relief)"));
    // "UN" itself, in capitals.
    const habitat = `<title>Hurricane Melissa shelter fund | UN-Habitat Jamaica</title><meta property="og:site_name" content="UN-Habitat Jamaica"><h1>Hurricane Melissa shelter fund</h1><p>Donate. Jamaica</p>`;
    expect(await check("https://www.melissa-shelter.org/donate", habitat, MELISSA)).toMatchObject(refused("its own name, title or heading claims an official body or a platform (UN)"));
    const pashto = `<title>د افغانستان د سره میاشتې ټولنه - زلزله کنړ</title><meta property="og:site_name" content="د افغانستان د سره میاشتې ټولنه"><h1>زلزله کنړ - Donate</h1><p>Donate now. افغانستان</p>`;
    expect(await check("https://www.kunar-zalzala-help.org/donate", pashto, AF)).toMatchObject(refused("its own name, title or heading claims an official body or a platform (سره میاشت)"));
    const tajik = `<title>Ҳилоли Аҳмари Тоҷикистон - Селоб</title><meta property="og:site_name" content="Ҳилоли Аҳмари Тоҷикистон"><h1>Флood relief Donate</h1><p>Donate. Tajikistan flood</p>`;
    expect(await check("https://www.selob-yordam.tj/donate", tajik, TJ)).toMatchObject(refused(/claims an official body or a platform \(ҳилоли аҳмар\)$/));
    const unicef = `<title>日本ユニセフ協会 能登半島地震 緊急募金</title><meta property="og:site_name" content="日本ユニセフ協会"><h1>能登半島地震 緊急募金</h1><p>募金 日本</p>`;
    expect(await check("https://www.noto-kinkyu.jp/bokin", unicef, NOTO, NOTO_NAMES)).toMatchObject(refused(/\(ユニセフ\)$/));
    const cmdrf = `<title>Chief Minister's Distress Relief Fund - Kerala Floods</title><meta property="og:site_name" content="CMDRF Kerala"><h1>Donate to Kerala Flood Relief</h1><p>Donate. Kerala</p>`;
    expect(await check("https://www.cmdrf-kerala.org/donate", cmdrf, KERALA)).toMatchObject(refused(/\(cmdrf\)$/));
    const generalitat = `<title>Generalitat Valenciana - Donaciones inundaciones</title><meta property="og:site_name" content="Generalitat Valenciana"><h1>Inundaciones en Valencia: donar</h1><p>Donar. España</p>`;
    expect(await check("https://www.ajuda-dana.org/donar", generalitat, ES)).toMatchObject(refused(/\(generalitat\)$/));
    const royaume = `<title>Royaume du Maroc - Fonds spécial séisme</title><meta property="og:site_name" content="Royaume du Maroc"><h1>Séisme : faites un don au fonds spécial</h1><p>faire un don. Maroc</p>`;
    expect(await check("https://www.fonds-seisme-maroc.org/don", royaume, MA)).toMatchObject(refused(/\(royaume\)$/));
    // "Jamaica Rеd Cross" with a Cyrillic е.
    const homoglyph = `<title>Jamaica Rеd Cross - Hurricane Melissa</title><meta property="og:site_name" content="Jamaica Rеd Cross"><h1>Hurricane Melissa Appeal</h1><p>Donate. Jamaica</p>`;
    expect(await check("https://www.jamaica-hurricane-help.org/donate", homoglyph, MELISSA)).toMatchObject(refused(/mixes Latin with Cyrillic or Greek letters in one word \(Rеd\)/));
    // A society's short name from its site's host, in capitals.
    const pmi = `<title>PMI Peduli Gempa Cianjur</title><meta property="og:site_name" content="PMI Peduli"><h1>Donasi Gempa Cianjur</h1><p>donasi sekarang. Indonesia</p>`;
    expect(await check("https://www.peduli-gempa-cianjur.org/donasi", pmi, ID, {}, { societyAcronyms: societyAcronyms(["pmi.or.id"]) })).toMatchObject(refused(/\(PMI\)$/));
  });

  it("refuses another country's disaster page named in the page's own language, though its footer names the disaster's country (A3)", async () => {
    const algerie = `<title>Faites un don pour le séisme en Algérie | Fondation Atlas</title><meta property="og:site_name" content="Fondation Atlas"><h1>Séisme en Algérie : donnez maintenant</h1><p>faire un don</p><footer>Bureaux au Maroc et en Algérie</footer>`;
    expect(await check("https://www.fondation-atlas.org/don-seisme-algerie", algerie, MA)).toMatchObject(refused("names another country"));
    const turquia = `<title>Dona para el terremoto en Turquía | Fundación Andes</title><meta property="og:site_name" content="Fundación Andes"><h1>Terremoto en Turquía y Siria: dona ahora</h1><p>Donar</p><footer>Oficinas en Venezuela</footer>`;
    expect(await check("https://www.fundacion-andes.org/donar-terremoto-turquia", turquia, VE)).toMatchObject(refused("names another country"));
    const turkiya = `<title>تبرع لضحايا زلزال تركيا وسوريا</title><meta property="og:site_name" content="جمعية الأمل"><h1>زلزال تركيا وسوريا: تبرع الآن</h1><p>جمعية الأمل - المغرب</p>`;
    expect(await check("https://www.jamiat-amal.ma/tabarru-turkiya", turkiya, MA)).toMatchObject(refused("names another country"));
    const maroc = `<title>Séisme au Maroc : faites un don | Secours Maghreb</title><meta property="og:site_name" content="Secours Maghreb"><h1>Séisme au Maroc</h1><p>faire un don</p><footer>Alger, Algérie</footer>`;
    expect(await check("https://www.secours-maghreb.org/seisme-maroc", maroc, DZ)).toMatchObject(refused("names another country"));
  });

  it("accepts US groups whose places hold a country's name: South Georgia, the Jersey Shore, Panama City (A3's regression)", async () => {
    const helene = disaster({ countries: ["US"], type: "cyclone", title: "Hurricane Helene", ...at("2026-09-26"), places: places("US", "Valdosta", "Augusta") });
    const georgia = `<title>Hurricane Helene Relief for South Georgia Families | Valdosta Community Fund</title><meta property="og:site_name" content="Valdosta Community Fund"><h1>Hurricane Helene Relief for South Georgia</h1><p>Donate to families in Valdosta, United States.</p>`;
    expect(await check("https://www.valdostacommunityfund.org/hurricane-helene-relief", georgia, helene)).toMatchObject({ ok: true });
    const nj = disaster({ countries: ["US"], type: "flood", title: "Flood in United States", ...at("2026-10-10"), places: places("US", "Jersey Shore Region", "Atlantic City") });
    const jersey = `<title>Jersey Shore Flood Relief | Ocean County Food Bank</title><meta property="og:site_name" content="Ocean County Food Bank"><h1>Jersey Shore Flood Relief</h1><p>Donate to families in Atlantic City.</p>`;
    expect(await check("https://www.oceancountyfoodbank.org/flood-relief", jersey, nj)).toMatchObject({ ok: true });
    const milton = disaster({ countries: ["US"], type: "cyclone", title: "Hurricane Milton", ...at("2026-10-08"), places: places("US", "Panama City") });
    const panama = `<title>Hurricane Milton Relief | Bay County Fund</title><meta property="og:site_name" content="Bay County Fund"><h1>Hurricane Milton relief for Panama City families</h1><p>Donate. Panama City, Florida, United States.</p>`;
    expect(await check("https://www.baycountyunitedway.org/hurricane-milton-relief", panama, milton)).toMatchObject({ ok: true });
    // Georgia the country is still another country for a disaster elsewhere.
    expect(await check("https://www.valdostacommunityfund.org/hurricane-helene-relief", georgia, disaster({ countries: ["AM"], type: "cyclone", title: "Hurricane Helene", ...at("2026-09-26") }))).toMatchObject(
      refused("names another country"),
    );
  });

  it("refuses general donate pages whose group's own name holds a word of the disaster's title (A1)", async () => {
    const chiangMai = `<title>Donate | Chiang Mai Children's Home</title><meta property="og:site_name" content="Chiang Mai Children's Home"><h1>Support our children</h1><p>Your donation feeds and educates children in northern Thailand.</p>`;
    expect(await check("https://www.chiangmaichildrenshome.org/donate/", chiangMai, TH, TH_NAMES)).toMatchObject(refused(/^its title, heading and address name neither/));
    const rio = `<title>Doe | Casa do Menor Rio de Janeiro</title><meta property="og:site_name" content="Casa do Menor"><h1>Faça sua doação</h1><p>Ajude crianças em situação de rua no Brasil. Doe agora.</p>`;
    expect(await check("https://www.casadomenor-rj.org.br/doe/", rio, BR)).toMatchObject(refused(/^its title, heading and address name neither/));
    const kerala = `<title>Donate | Kerala Children's Trust</title><meta property="og:site_name" content="Kerala Children's Trust"><h1>Support a child's education</h1><p>Your donation supports children across Kerala, India.</p>`;
    expect(await check("https://www.keralachildrenstrust.org/donate/", kerala, KERALA)).toMatchObject(refused(/^its title, heading and address name neither/));
    // Without its og:site_name, the group's name is known by its host.
    expect(await check("https://www.keralachildrenstrust.org/donate/", kerala.replace(/<meta[^>]*>/, ""), KERALA)).toMatchObject(refused(/^its title, heading and address name neither/));
  });

  it("refuses old pages dated by a Buddhist, Japanese or Nepali year, or by the year next to the hazard in their text (A4)", async () => {
    const thai = `<title>บริจาคช่วยน้ำท่วมเชียงราย 2567 | อาสาเชียงราย</title><meta property="og:site_name" content="อาสาเชียงราย"><h1>น้ำท่วมเชียงราย ปี 2567</h1><p>บริจาค</p>`;
    expect(await check("https://www.chiangrai-volunteers.or.th/flood-2567", thai, TH, TH_NAMES)).toMatchObject(refused("an earlier disaster's page (2024)"));
    const reiwa = `<title>令和6年能登半島地震 緊急支援募金 | 某NPO</title><meta property="og:site_name" content="某NPO"><h1>令和6年能登半島地震 緊急支援募金</h1><p>能登の被災地への寄付をお願いします。</p>`;
    expect(await check("https://www.some-npo.or.jp/noto-bokin/", reiwa, NOTO, NOTO_NAMES)).toMatchObject(refused("an earlier disaster's page (2024)"));
    const gorkha = `<title>भूकम्प २०७२ पीडितलाई दान | सहयोग नेपाल</title><meta property="og:site_name" content="सहयोग नेपाल"><h1>भूकम्प २०७२: दान गर्नुहोस्</h1><p>नेपाल</p>`;
    expect(await check("https://www.sahayog-nepal.org.np/bhukampa", gorkha, NP)).toMatchObject(refused("an earlier disaster's page (2016)"));
    // The first review's 2016 page without its JSON-LD, as a Wix or Squarespace site would serve it.
    const wix = `<title>Donaciones Terremoto | Escuela San José</title><meta property="og:site_name" content="Escuela San José"><h1>Ayuda tras el terremoto</h1><p>El 16 de abril de 2016 un terremoto de 7,8 golpeó Ecuador. Donar aquí.</p>`;
    expect(await check("https://www.escuela-sanjose.edu.ec/donaciones-terremoto", wix, EC)).toMatchObject(refused("an earlier disaster's page (2016)"));
    // A <time> dates a page that has no JSON-LD.
    const time = `<title>Donaciones | Escuela San José</title><meta property="og:site_name" content="Escuela San José"><h1>Ayuda tras el terremoto</h1><time datetime="2016-04-20">20 de abril</time><p>Donar aquí. Ecuador</p>`;
    expect(await check("https://www.escuela-sanjose.edu.ec/donaciones-terremoto", time, EC)).toMatchObject(refused("published 2016-04-20, before the disaster"));
  });

  it("refuses pages that ask for crypto by ticker or address, or for transfers into a person's account, and passes supermarket gift cards", async () => {
    const btc = `<title>Hurricane Melissa Relief</title><h1>Hurricane Melissa relief</h1><p>Donate BTC to bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh. Jamaica.</p>`;
    expect(await check("https://www.jamaica-hope-relief.org/donate-hurricane", btc, MELISSA)).toMatchObject(refused("asks for crypto, as scams do"));
    const cripto = `<title>Terremoto Venezuela: donar</title><h1>Terremoto: dona en criptomonedas</h1><p>Donar USDC o BTC. Venezuela.</p>`;
    expect(await check("https://www.ayuda-venezuela.org/donar-terremoto", cripto, VE)).toMatchObject(refused("asks for crypto, as scams do"));
    const banesco = `<title>Terremoto Venezuela: donar</title><h1>Terremoto: ayuda a mi familia</h1><p>Donar: deposita en mi cuenta Banesco 0134-xxxx a nombre de Juan Pérez. Venezuela.</p>`;
    expect(await check("https://www.ayuda-venezuela.org/donar-terremoto", banesco, VE)).toMatchObject(refused("asks for a transfer to a person's own account, as scams do"));
    const ncb = `<title>Hurricane Melissa Relief</title><h1>Hurricane Melissa relief</h1><p>Donate: transfer to my account at NCB, 123456789, John Brown. Jamaica.</p>`;
    expect(await check("https://www.jamaica-hope-relief.org/donate-hurricane", ncb, MELISSA)).toMatchObject(refused("asks for a transfer to a person's own account, as scams do"));
    const cobargo = `<title>Bushfire Appeal | Cobargo Community Association</title><meta property="og:site_name" content="Cobargo Community Association"><h1>Bushfire Appeal</h1><p>Donate cash or Woolworths and Coles gift cards for families in New South Wales.</p>`;
    expect(await check("https://www.cobargo-community.org.au/bushfire-appeal", cobargo, NSW)).toMatchObject({ ok: true });
  });

  it("refuses a person's campaign on a crowdfunding platform the lists miss, by what the page says (Cotizi, iSupportJamaica)", async () => {
    const cotizi = `<title>Séisme Al Haouz : aidons Douar Tikht | Cotizi</title><meta property="og:site_name" content="Cotizi"><h1>Séisme Al Haouz : aidons Douar Tikht</h1><p>Campagne créée par Youssef B. Faire un don. Lancer ma cagnotte. Maroc</p>`;
    expect(await check("https://www.cotizi.com/campaign/seisme-al-haouz-douar-tikht", cotizi, HAOUZ)).toMatchObject(refused("crowdfunding or giving platform"));
    const isj = `<title>Hurricane Melissa Relief for Black River | iSupportJamaica</title><meta property="og:site_name" content="iSupportJamaica"><h1>Hurricane Melissa Relief for Black River</h1><p>Project by Andre W. Donate. Start a project. Jamaica</p>`;
    expect(await check("https://www.isupportjamaica.com/projects/hurricane-melissa-relief", isj, JM)).toMatchObject(refused("crowdfunding or giving platform"));
    // On a host no list knows, what the page says gives it away.
    expect(await check("https://www.new-platform.ma/campaign/seisme-al-haouz-douar-tikht", cotizi, HAOUZ)).toMatchObject(refused(/^a person's campaign on a crowdfunding platform/));
    expect(await check("https://www.new-platform.jm/projects/hurricane-melissa-relief", isj, JM)).toMatchObject(refused(/^a person's campaign on a crowdfunding platform/));
  });

  it("accepts a group's standing donate page it rewrote for the disaster, by its JSON-LD dateModified", async () => {
    const yoast = (pub: string, mod: string) => `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage","datePublished":"${pub}","dateModified":"${mod}"}]}</script>`;
    const instituto = `<title>Doe | Instituto Solidário</title><meta property="og:site_name" content="Instituto Solidário">${yoast("2021-03-02T10:00:00-03:00", "2026-10-12T09:00:00-03:00")}<h1>Enchentes no Rio Grande do Sul: doe agora</h1><p>Doe agora para as famílias atingidas no Rio Grande do Sul, Brasil.</p>`;
    expect(await check("https://www.institutosolidario.org.br/doe/", instituto, BR)).toMatchObject({ ok: true });
    const tifawin = `<title>Faire un don | Association Tifawin</title><meta property="og:site_name" content="Association Tifawin">${yoast("2019-05-01T10:00:00+01:00", "2026-10-21T09:00:00+01:00")}<h1>Séisme d'Al Haouz : aidez les familles</h1><p>faire un don. Maroc</p>`;
    expect(await check("https://www.association-tifawin.ma/faire-un-don/", tifawin, HAOUZ)).toMatchObject({ ok: true });
    // Changed before the disaster, or naming the hazard without a place of the title: still refused.
    expect(await check("https://www.institutosolidario.org.br/doe/", instituto.replace("2026-10-12T09", "2024-05-12T09"), BR)).toMatchObject(refused("published 2021-03-02, before the disaster"));
    expect(await check("https://www.institutosolidario.org.br/doe/", instituto.replace("no Rio Grande do Sul: doe", ": doe"), BR)).toMatchObject(refused("published 2021-03-02, before the disaster"));
  });

  it("accepts an Arabic page for Al Haouz by the place's Arabic name from the geocoder (live Nominatim names, 2026-10-25)", async () => {
    const local = { "Al Haouz": ["Province d'Al Haouz ⵜⴰⵙⴳⴰ ⵏ ⵍⵃⵓⵣ إقليم الحوز"], Marrakesh: ["Marrakech ⵎⵕⵕⴰⴽⵯⵛ مراكش"] };
    const atlas = `<title>تبرع لأسر الحوز | جمعية الأطلس</title><meta property="og:site_name" content="جمعية الأطلس"><h1>ساعدوا أسر الحوز</h1><p>تبرع الآن لإعادة بناء المنازل في دواوير الحوز</p>`;
    expect(await check("https://www.jamiat-atlas.ma/tabarru-alhaouz", atlas, HAOUZ, local)).toMatchObject({ ok: true, place: "الحوز" });
  });

  it("accepts Philippine groups' pages that name the typhoon by PAGASA's name, and a Supreme Student Government's drive", async () => {
    const bagyong = `<title>Bagyong Tino Relief Drive | St. Paul College Cebu</title><meta property="og:site_name" content="St. Paul College Cebu"><h1>Tulong para sa mga nasalanta ng Bagyong Tino</h1><p>Donate now. Cebu, Philippines</p>`;
    expect(await check("https://www.stpaulcebu.edu.ph/bagyong-tino-relief", bagyong, PH)).toMatchObject({ ok: true });
    const tino = `<title>Typhoon Tino Relief Drive | St. Paul College Cebu</title><meta property="og:site_name" content="St. Paul College Cebu"><h1>Typhoon Tino relief for Cebu families</h1><p>Donate now. Cebu, Philippines</p>`;
    expect(await check("https://www.stpaulcebu.edu.ph/typhoon-tino-relief", tino, PH)).toMatchObject({ ok: true });
    const ssg = `<title>Typhoon Kalmaegi Relief Drive | Mantalongon NHS</title><meta property="og:site_name" content="Mantalongon National High School"><h1>Supreme Student Government Relief Drive for Typhoon Kalmaegi</h1><p>Donate. Cebu, Philippines</p>`;
    expect(await check("https://www.mantalongon-nhs.edu.ph/typhoon-kalmaegi-relief", ssg, PH)).toMatchObject({ ok: true });
    // Another storm's name is still another storm.
    expect(await check("https://www.stpaulcebu.edu.ph/typhoon-relief", tino.replace(/Tino/g, "Odette"), PH)).toMatchObject(refused("names another storm (odette)"));
  });

  it("accepts pages that give a group's founding year in other languages", async () => {
    const sejak = `<title>Donasi Gempa Cianjur | Yayasan Al-Ikhlas</title><meta property="og:site_name" content="Yayasan Al-Ikhlas"><h1>Yayasan Al-Ikhlas, melayani Cianjur sejak 1990</h1><p>donasi sekarang. Indonesia</p>`;
    expect(await check("https://www.yayasan-alikhlas.or.id/donasi-gempa-cianjur", sejak, ID)).toMatchObject({ ok: true });
    const tangu = `<title>Budalangi Floods Appeal | St. Mary's Mumias</title><meta property="og:site_name" content="St. Mary's Mumias"><h1>Tunahudumia jamii tangu 1990</h1><p>Changia waathiriwa wa mafuriko Budalangi. M-Pesa Paybill 123456. Kenya</p>`;
    expect(await check("https://www.stmarysmumias.ac.ke/budalangi-floods", tangu, KE)).toMatchObject({ ok: true });
    const mundhu = `<title>تبرع لضحايا زلزال الحوز</title><meta property="og:site_name" content="جمعية الأطلس"><h1>جمعية الأطلس في خدمة الحوز منذ 1990</h1><p>تبرع لدعم الأسر في المغرب</p>`;
    expect(await check("https://www.jamiat-atlas.ma/tabarru", mundhu, HAOUZ)).toMatchObject({ ok: true });
    const setsuritsu = `<title>能登半島地震 緊急支援 | 某NPO</title><meta property="og:site_name" content="某NPO"><h1>1990年設立の某NPO 能登半島地震 緊急支援</h1><p>寄付をお願いします。日本</p>`;
    expect(await check("https://www.some-npo.or.jp/noto/", setsuritsu, disaster({ countries: ["JP"], type: "earthquake", title: "Earthquake in Noto, Japan", ...at("2026-10-20") }))).toMatchObject({ ok: true });
  });

  it("accepts a church whose host says good news", async () => {
    const page = `<title>Hurricane Melissa Relief | Good News Church</title><meta property="og:site_name" content="Good News Church"><h1>Hurricane Melissa Relief</h1><p>Donate to families in Jamaica.</p>`;
    expect(await check("https://www.good-news-church.org.jm/hurricane-melissa-relief", page, JM)).toMatchObject({ ok: true });
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
    // Verdicts made under earlier rules are not reused: the key carries the rules' version.
    expect(localVerdictKey("d1", URL0)).toBe(`local${LOCAL_RULES_VERSION}:d1:stelizabethrelief.org/hurricane-melissa/donate`);
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

  it("leaves logging the verdict to its caller, which logs each refusal once (prepareDirectLinks)", async () => {
    const log = vi.fn();
    const d = { ...deps(async () => html("<p>Donate</p>")), log };
    expect(await verifyLocalPage(URL0, "d1", d, local, rules, emptyRegistry(), NOW)).toBe(false);
    expect(log).not.toHaveBeenCalled();
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
  it("holds a disaster's local pages to its place names, title's places, type, year and start", () => {
    const d = { ...MELISSA, countries: ["JM"], places: [{ name: "Black River", country: "JM", lat: 18, lng: -77.8, kind: "town" as const, source: "research" as const }] };
    expect(localRules({ disaster: d, ctx: ctxFor(d), countryNames: NAMES, pressNames: {} })).toEqual({
      names: ["Jamaica", "Black River", "Melissa"],
      titleNames: ["Melissa"],
      type: "cyclone",
      minYear: 2025,
      started: "2025-10-21T12:00:00.000Z",
      ownPlaces: ["Black River", "Melissa"],
      languages: ["en", "es", "fr", "pt", "ar", "id", "tr", "ru", "zh", "ja", "th", "de", "it"],
    });
  });

  it("adds the places' own names from the geocoder, and those of the title's places to its title names", () => {
    const d = disaster({
      countries: ["TH"],
      type: "flood",
      title: "Floods in Chiang Rai, Thailand",
      started: "2026-10-10T00:00:00.000Z",
      places: [
        { name: "Chiang Rai", country: "TH", lat: 19.9, lng: 99.8, kind: "region", source: "research" },
        { name: "Mae Sai", country: "TH", lat: 20.4, lng: 99.9, kind: "town", source: "research" },
      ],
    });
    const rules = localRules({ disaster: d, ctx: ctxFor(d), countryNames: NAMES, pressNames: { TH: "ประเทศไทย" }, localNames: { "Chiang Rai": ["จังหวัดเชียงราย"], "Mae Sai": ["แม่สาย"] } });
    expect(rules.names).toEqual(["Thailand", "ประเทศไทย", "ไทย", "Chiang Rai", "จังหวัดเชียงราย", "เชียงราย", "Mae Sai", "แม่สาย", "chiang", "rai"]);
    expect(rules.titleNames).toEqual(["Chiang Rai", "จังหวัดเชียงราย", "เชียงราย"]);
  });
});

describe("localNote", () => {
  it("says who checked the page, and that the group is not vouched for", () => {
    expect(localNote("St. Elizabeth")).toBe(
      "A charity's or local group's own page for this disaster. Global View checked it is live and names St. Elizabeth, but cannot vouch for the group.",
    );
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
    registry.verdicts[key] = { ok: true, reason: "", checked: NOW, chain: [SCHOOL], place: "Jamaica", title: "URGENT: Send Bitcoin/Zelle to help Hurricane Melissa victims" };
    expect(buildDirectLinks(input(), registry, NOW).some((l) => l.kind === "local")).toBe(false);
    // A pass made under earlier rules is not reused.
    registry.verdicts[`local:${MELISSA.id}:${SCHOOL.replace("https://www.", "")}`] = { ok: true, reason: "", checked: NOW, chain: [SCHOOL], place: "Jamaica", name: "Eber College" };
    delete registry.verdicts[key];
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

describe("directKindOf", () => {
  it("tells a page's kind by its host alone", () => {
    expect(directKindOf("https://www.globalgiving.org/projects/typhoon-champi-relief-fund/")).toBe("globalgiving");
    expect(directKindOf("https://globalgiving.org/fundraisers/x/")).toBe("globalgiving");
    expect(directKindOf("https://www.pennyappealusa.org/campaigns/x/")).toBe("local");
    // A look-alike is no GlobalGiving page.
    expect(directKindOf("https://globalgiving.org.example.com/projects/x/")).toBe("local");
    expect(directKindOf("not a url")).toBe("local");
  });
});

// ---------------------------------------------------------------------------
// The other searches' pages off the official allowlist
// ---------------------------------------------------------------------------

describe("pages the research or the donation search found off the official allowlist", () => {
  /** The Nuristan floods in Afghanistan (IFRC GO 8025), as the first live run had them. */
  const NURISTAN = disaster({
    id: "ifrc-flood-8025",
    countries: ["AF"],
    type: "flood",
    title: "Afghanistan: Nuristan Flood",
    started: "2026-07-20T00:00:00.000Z",
    places: [{ name: "Nuristan", country: "AF", lat: 35.42, lng: 70.79, kind: "district", source: "ifrc" }],
  });
  /** Penny Appeal USA's appeal for the floods, which the research found and donate.ts turned away as off its allowlist. */
  const PENNY = "https://www.pennyappealusa.org/campaigns/emergency-alert-flash-floods-hit-nuristan-afghanistan/";
  /** The page's own name, title, heading and dates as it gave them (2026-10-25), with a donation word; not its text. */
  const PENNY_PAGE = [
    "<title>Emergency Alert: Flash Floods Hit Nuristan, Afghanistan</title>",
    '<meta property="og:site_name" content="Penny Appeal USA">',
    '<script type="application/ld+json">{"@graph":[{"@type":"WebPage","datePublished":"2026-07-24T12:19:21+00:00","dateModified":"2026-07-24T14:55:58+00:00"}]}</script>',
    "<h1>Emergency Alert: Flash Floods Hit Nuristan, Afghanistan</h1><a>Donate now</a>",
  ].join("");
  const IFRC_LIST = "https://go.ifrc.org/appeals/all?region=2";
  const research = (donation: ResearchEntry["donation"], over: Partial<ResearchEntry> = {}) => ({ donation, ...over }) as ResearchEntry;
  /** The research entry the first live run cached: an IFRC listing page (refused by the official rules) and Penny Appeal's page. */
  const ENTRY = research([
    { url: IFRC_LIST, org: "IFRC (IFRC GO)", kind: "society", note: "Appeals listing", specific: false },
    { url: PENNY, org: "Penny Appeal USA", kind: "agency", note: "Emergency appeal campaign for victims of the Nuristan flash floods." },
  ]);
  const input = (over: Partial<DirectInput> = {}): DirectInput => ({
    disaster: NURISTAN,
    entry: ENTRY,
    gofundme: emptyGoFundMeCache(),
    ctx: ctxFor(NURISTAN),
    countryNames: NAMES,
    pressNames: {},
    ...over,
  });

  it("offers only the local pages donate.ts turns away for their host alone, each once, with the model's org and note but no title or date", () => {
    const ctx = ctxFor(NURISTAN);
    expect(donationUrlProblem(PENNY, ctx)).toBe(NOT_ALLOWLISTED);
    // The listing is on the allowlist, and refused for another reason: never offered.
    expect(donationUrlProblem(IFRC_LIST, ctx)).toBe("listing or search page");
    const GG = "https://www.globalgiving.org/projects/afghanistan-flood-relief-2026/";
    const misses = allowlistMisses(
      research(
        [
          ...ENTRY.donation,
          { url: GG, org: "GlobalGiving", kind: "", note: "" },
          // Plain http and a shortener are refused before the allowlist is asked.
          { url: "http://www.pennyappealusa.org/campaigns/x/", org: "", kind: "", note: "" },
          { url: "https://bit.ly/nuristan", org: "", kind: "", note: "" },
          { url: "https://www.ifrc.org/emergency/afghanistan-floods", org: "IFRC", kind: "agency", note: "" },
        ],
        { earlierSearch: [{ url: PENNY.replace("https://www.", "https://"), org: "Penny Appeal", kind: "agency", note: "From an earlier search", specific: true }] },
      ),
      ctx,
    );
    // GlobalGiving's host is off the allowlist too, but its page is no local one: never offered.
    expect(donationUrlProblem(GG, ctx)).toBe(NOT_ALLOWLISTED);
    expect(misses).toEqual<DirectPage[]>([
      // The earlier search's copy comes first; the research's copy of the same page is left out.
      { url: PENNY.replace("https://www.", "https://"), org: "Penny Appeal", kind: "local", note: "From an earlier search", title: "" },
    ]);
    expect(allowlistMisses(undefined, ctx)).toEqual([]);
    expect(allowlistMisses({} as ResearchEntry, ctx)).toEqual([]);
  });

  it("puts the direct search's pages first, then the other searches' that it did not find", () => {
    const own: DirectPage = { url: PENNY, org: "Penny Appeal USA", kind: "local", note: "", title: "Emergency Alert", published: "2026-07-24T00:00:00.000Z" };
    const other = "https://www.islamicrelief.org/afghanistan-floods-appeal/";
    const entry = research([...ENTRY.donation, { url: other, org: "Islamic Relief", kind: "agency", note: "" }], { direct: [own] });
    expect(directCandidates(input({ entry })).map((p) => [p.url, p.title])).toEqual([
      [PENNY, "Emergency Alert"],
      [other, ""],
    ]);
    expect(directCandidates(input({ entry: undefined }))).toEqual([]);
  });

  it("never shows a GlobalGiving page the research or the donation search named, since only the direct search's are checked against its results", async () => {
    // The model alone wrote these URLs (validDonations keeps them unchecked against the search results), and
    // GlobalGiving pages get no live check: the slug alone would pass globalGivingProblem.
    const GG = "https://www.globalgiving.org/projects/afghanistan-flood-relief-2026/";
    const GG_FUND = "https://globalgiving.org/fundraisers/nuristan-flood-relief-2026/";
    expect(globalGivingProblem({ url: GG, title: "" }, NURISTAN, ctxFor(NURISTAN))).toBeNull();
    const entry = research([{ url: GG, org: "GlobalGiving", kind: "agency", note: "Vetted relief fund" }], {
      earlierSearch: [{ url: GG_FUND, org: "GlobalGiving", kind: "agency", note: "", specific: true }],
    });
    const registry = emptyRegistry();
    const outcome = directOutcome(input({ entry }), registry, NOW);
    expect(outcome).toEqual({ links: [], fromSearch: 0, fromOther: 0, passed: 0, refused: [], waiting: [] });
    const d = { ...deps(async () => html("<title>Afghanistan flood relief</title><a>Donate</a>")), log: vi.fn() };
    const links = await prepareDirectLinks(input({ entry }), registry, d, NOW, { pageLog: vi.fn(), pauseMs: 0 });
    expect(links).toEqual([]);
    expect(d.fetch).not.toHaveBeenCalled();
    // Nor do the official rules take them: nothing on globalgiving.org reaches the site.
    const shown = buildDonations(
      { countries: NURISTAN.countries, appeals: NURISTAN.appeals, researched: [...entry.earlierSearch!, ...entry.donation], title: NURISTAN.title, countryNames: NAMES, direct: links },
      registry,
      NOW,
      GOV,
    );
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.filter((l) => l.url.includes("globalgiving"))).toEqual([]);
    // The direct search's own page, with the title its search returned, is still judged as GlobalGiving's.
    const own: DirectPage = { url: GG, org: "GlobalGiving", kind: "globalgiving", note: "", title: "Afghanistan Flood Relief 2026" };
    expect(directOutcome(input({ entry: research([], { direct: [own] }) }), registry, NOW).links).toEqual([globalGivingLink(own)]);
  });

  it("live-checks Penny Appeal's Nuristan page and lists it as a charity's own page, by its own name and title", async () => {
    const registry = emptyRegistry();
    const log = vi.fn();
    const pageLog = vi.fn();
    const d = { ...deps(async (u) => (u === PENNY ? html(PENNY_PAGE) : new Response("", { status: 404 }))), log };
    const links = await prepareDirectLinks(input(), registry, d, NOW, { pageLog, pauseMs: 0 });
    expect(d.fetch.mock.calls.map(([u]) => String(u))).toEqual([PENNY]);
    expect(links).toEqual([
      {
        label: "Emergency Alert: Flash Floods Hit Nuristan, Afghanistan",
        url: PENNY,
        org: "Penny Appeal USA",
        kind: "local",
        note: "A charity's or local group's own page for this disaster. Global View checked it is live and names Afghanistan, but cannot vouch for the group.",
        via: "research",
        forEvent: true,
      },
    ]);
    expect(log.mock.calls.map(([m]) => m)).toEqual([
      `Direct page ${PENNY}: accepted (donation word "donat*", names "Afghanistan")`,
      "  direct pages for ifrc-flood-8025: 1 candidate (0 from the direct search, 1 from the other searches): 1 passed, 0 refused, 0 wait for a live check",
    ]);
    expect(pageLog).not.toHaveBeenCalled();
    // From the caches alone, the same link.
    expect(buildDirectLinks(input(), registry, NOW)).toEqual(links);
  });

  it("holds the other searches' pages to every direct rule: platforms, news, look-alikes, official names, earlier events and the live check", async () => {
    const pages: ResearchEntry["donation"] = [
      { url: "https://www.gofundme.com/f/help-nuristan-flood-victims", org: "GoFundMe", kind: "", note: "" },
      { url: "https://www.dawn.com/news/2017247", org: "Dawn", kind: "", note: "" },
      { url: "https://afghanredcrescent-relief.org/nuristan", org: "Relief", kind: "", note: "" },
      { url: "https://www.kabulrelief.org/nuristan-flood", org: "Afghan Red Crescent Society", kind: "society", note: "" },
      { url: "https://www.hopeforafghans.org/2024-afghanistan-flood-appeal/", org: "Hope for Afghans", kind: "", note: "" },
      { url: "https://www.mountainschools.org/nuristan-flood/donate", org: "Mountain Schools", kind: "", note: "" },
    ];
    const registry = emptyRegistry();
    const log = vi.fn();
    const pageLog = vi.fn();
    // The one page that passes the address rules asks for crypto.
    const d = { ...deps(async () => html("<title>Nuristan flood relief</title><h1>Nuristan flood relief</h1><p>Donate BTC to help families in Afghanistan.</p>")), log };
    expect(await prepareDirectLinks(input({ entry: research(pages) }), registry, d, NOW, { pageLog, pauseMs: 0 })).toEqual([]);
    expect(d.fetch.mock.calls.map(([u]) => String(u))).toEqual(["https://www.mountainschools.org/nuristan-flood/donate"]);
    const from = "(from the research or the donation search)";
    expect(pageLog.mock.calls.map(([m]) => m)).toEqual([
      `Direct page ${pages[0].url} ${from}: rejected (crowdfunding or giving platform)`,
      `Direct page ${pages[1].url} ${from}: rejected (a news article or blog post)`,
      `Direct page ${pages[2].url} ${from}: rejected (its host carries an official body's or a platform's name (redcrescent))`,
      `Direct page ${pages[3].url} ${from}: rejected (the search names it for an official body or a platform (red crescent))`,
      `Direct page ${pages[4].url} ${from}: rejected (an earlier disaster's page (2024))`,
      `Direct page ${pages[5].url} ${from}: rejected (live check: asks for crypto, as scams do)`,
    ]);
    expect(log.mock.calls.map(([m]) => m)).toEqual([
      "  direct pages for ifrc-flood-8025: 6 candidates (0 from the direct search, 6 from the other searches): 0 passed, 6 refused, 0 wait for a live check",
    ]);
  });

  it("refuses the look-alikes of official sites that donate.ts turns away for their host, as it refuses the direct search's", async () => {
    // donate.ts's attack cases, each "host not on the allowlist" there.
    const lookalikes = ["redcross.org.ph.evil.com", "evilredcross.org.ph", "gov.ph.evil.com", "evilgov.ph", "un.org.evil.com", "unicef.org.donate-now.com", "fakeun.org"].map(
      (host) => `https://${host}/nuristan-flood`,
    );
    expect(lookalikes.every((u) => donationUrlProblem(u, ctxFor(NURISTAN)) === NOT_ALLOWLISTED)).toBe(true);
    const pageLog = vi.fn();
    const d = deps(async () => html("<title>UN Nuristan Flood Relief</title><h1>UN Nuristan Flood Relief</h1><p>Donate to families in Afghanistan.</p>"));
    const entry = research(lookalikes.map((url) => ({ url, org: "", kind: "", note: "" })));
    expect(await prepareDirectLinks(input({ entry }), emptyRegistry(), d, NOW, { pageLog, pauseMs: 0, maxChecks: 10 })).toEqual([]);
    // Only the one whose host claims no official name is fetched, and its own title's "UN" refuses it.
    expect(d.fetch.mock.calls.map(([u]) => String(u))).toEqual(["https://fakeun.org/nuristan-flood"]);
    expect(pageLog).toHaveBeenCalledTimes(lookalikes.length);
    expect(pageLog.mock.calls.at(-1)?.[0]).toBe(
      "Direct page https://fakeun.org/nuristan-flood (from the research or the donation search): rejected (live check: its own name, title or heading claims an official body or a platform (UN))",
    );
  });
});

describe("directOutcome and logDirectOutcome", () => {
  const JM = { ...MELISSA, countries: ["JM"] };
  const SCHOOL = "https://www.ebercollege.edu.jm/rebuild-after-melissa/donate";
  const pages: DirectPage[] = [
    { url: "https://www.globalgiving.org/projects/hurricane-beryl-jamaica-2024/", org: "GlobalGiving", kind: "globalgiving", note: "", title: "" },
    { url: SCHOOL, org: "Eber Preparatory School", kind: "local", note: "", title: "" },
    { url: "https://www.stelizabeth-relief.org/melissa/donate", org: "St Elizabeth Relief", kind: "local", note: "", title: "" },
    { url: "https://www.kingston-schools.org/melissa/donate", org: "Kingston Schools", kind: "local", note: "", title: "" },
  ];
  const input = (): DirectInput => ({ disaster: JM, entry: { direct: pages } as ResearchEntry, gofundme: emptyGoFundMeCache(), ctx: ctxFor(JM), countryNames: NAMES, pressNames: {} });

  it("says what became of each candidate: passed, refused with its reason, or waiting for a live check", () => {
    const registry = emptyRegistry();
    const school = localVerdictKey(MELISSA.id, SCHOOL);
    registry.verdicts[school] = { ok: true, reason: "", checked: NOW, chain: [SCHOOL], place: "Jamaica", name: "Eber College" };
    registry.verdicts[localVerdictKey(MELISSA.id, pages[2].url)] = { ok: false, reason: "HTTP 403", checked: NOW, chain: [pages[2].url] };
    const o = directOutcome(input(), registry, NOW);
    expect(o.links.map((l) => l.url)).toEqual([SCHOOL]);
    expect([o.fromSearch, o.fromOther, o.passed]).toEqual([4, 0, 1]);
    expect(o.refused).toEqual([
      { url: pages[0].url, reason: "names another storm (beryl)", other: false },
      { url: pages[2].url, reason: "live check: HTTP 403", other: false },
    ]);
    expect(o.waiting).toEqual([pages[3].url]);
    // A cached pass that today's rules refuse says why.
    registry.verdicts[school] = { ok: true, reason: "", checked: NOW, chain: [SCHOOL, "https://www.paypal.com/donate"], place: "Jamaica" };
    expect(directOutcome(input(), registry, NOW).refused[1]).toEqual({ url: SCHOOL, reason: "a redirect it followed may no longer be shown", other: false });
    registry.verdicts[school] = { ok: true, reason: "", checked: NOW, chain: [SCHOOL], place: "Jamaica", name: "Jamaica Red Cross Relief" };
    expect(directOutcome(input(), registry, NOW).refused[1].reason).toBe("its own name or title claims an official body or a platform (red cross)");
    // "Rеlief" with a Cyrillic е.
    registry.verdicts[school] = { ok: true, reason: "", checked: NOW, chain: [SCHOOL], place: "Jamaica", name: "Kingston Rеlief Fund" };
    expect(directOutcome(input(), registry, NOW).refused[1].reason).toBe("its own name or title mixes Latin with Cyrillic or Greek letters in one word (Rеlief)");
    registry.verdicts[school] = { ok: true, reason: "", checked: NOW, chain: [SCHOOL], place: "Jamaica", title: "URGENT: Send Bitcoin to help Hurricane Melissa victims" };
    expect(directOutcome(input(), registry, NOW).refused[1].reason).toBe("asks for crypto, as scams do");
    registry.verdicts[school] = { ok: true, reason: "", checked: NOW, chain: [SCHOOL], place: "Jamaica", title: "Rebuild after Hurricane Beryl" };
    expect(directOutcome(input(), registry, NOW).refused[1].reason).toBe("names another storm (beryl)");
  });

  it("logs one line for a disaster with candidates and one per refused page, and nothing for a disaster without", () => {
    const registry = emptyRegistry();
    const log = vi.fn();
    const page = vi.fn();
    expect(buildDirectLinks(input(), registry, NOW, { log, page })).toEqual([]);
    expect(log.mock.calls.map(([m]) => m)).toEqual([`  direct pages for ${MELISSA.id}: 4 candidates (4 from the direct search, 0 from the other searches): 0 passed, 1 refused, 3 wait for a live check`]);
    expect(page.mock.calls.map(([m]) => m)).toEqual([`Direct page ${pages[0].url}: rejected (names another storm (beryl))`]);
    const quiet = vi.fn();
    logDirectOutcome("d1", { links: [], fromSearch: 0, fromOther: 0, passed: 0, refused: [], waiting: [] }, { log: quiet, page: quiet });
    expect(quiet).not.toHaveBeenCalled();
  });
});

describe("cappedLog", () => {
  it("passes on at most its cap of lines a run and counts the rest", () => {
    const log = vi.fn();
    const capped = cappedLog(log, 2);
    ["a", "b", "c", "d"].forEach((m) => capped.line(m));
    expect(log.mock.calls.map(([m]) => m)).toEqual(["a", "b"]);
    expect(capped.omitted()).toBe(2);
    expect(MAX_PAGE_LOG_LINES).toBe(40);
    const run = cappedLog(log);
    Array.from({ length: 45 }, (_, i) => String(i)).forEach((m) => run.line(m));
    expect(run.omitted()).toBe(5);
  });
});
