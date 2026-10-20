import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi, type Mock } from "vitest";
import { loadGlobeFeatures } from "../countries";
import type { FetchDeps } from "../googlenews";
import { USER_AGENT } from "../googlenews";
import { buildResolver } from "../resolve";
import type { AppealRef } from "./types";
import {
  DONATION_TERMS,
  GO_COUNTRIES_URL,
  IFRC_APPEAL_PAGE,
  IFRC_DONATE,
  MAX_LINKS,
  UNCR_HOME,
  UNCR_SITEMAP,
  buildDonations,
  checkDonationPage,
  cleanText,
  compileTerm,
  decodeEntities,
  donationContext,
  donationUrlProblem,
  donationWordsIn,
  emptyRegistry,
  fetchGoCountries,
  fetchUncrLocs,
  foldText,
  hasDonationWord,
  hostClass,
  hostMatches,
  inSiteScope,
  isAllowedDonationUrl,
  isBloodDonationPath,
  isPlainHostname,
  isSocietyCampaign,
  knownOrg,
  landingAnswer,
  loadGovernmentDomains,
  nextToCheck,
  normaliseRegistry,
  normaliseSiteUrl,
  pageText,
  parseSitemapLocs,
  passingVerdict,
  pickAppeal,
  platformAnswer,
  platformCampaign,
  platformUrl,
  prepareDonations,
  probePlatform,
  pruneVerdicts,
  readRegistry,
  refreshRegistry,
  researchKind,
  researchedLinks,
  siteHost,
  siteScope,
  societyLabel,
  societyOf,
  societySiteUrl,
  toSocieties,
  toUncr,
  urlKey,
  verdictFresh,
  verifyDonationPage,
  writeRegistry,
  type DonationContext,
  type DonationInput,
  type DonationRegistry,
  type DonationVerdict,
  type GoCountryRow,
  type RegistrySociety,
} from "./donate";

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

/** Reads a trimmed real response saved under fixtures/. */
function fixture<T>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", name), "utf8")) as T;
}

interface PageFixture {
  name: string;
  url: string;
  contentType: string;
  html: string;
}

const GO_ROWS = fixture<{ results: GoCountryRow[] }>("donate-go-countries.json").results;
const SITEMAP = fixture<{ xml: string }>("donate-uncr-sitemap.json").xml;
interface LiveRedirect {
  url: string;
  status: number;
  location: string | null;
}
const LIVE = fixture<{
  platform: { cc: string; status: number; location: string }[];
  redirects: LiveRedirect[];
  hijacked: { redirects: LiveRedirect[]; pages: PageFixture[] };
}>("donate-live-answers.json");
/** Real platform landing pages, trimmed to the block that names the campaign. */
const LANDINGS = Object.fromEntries(fixture<{ pages: { cc: string; html: string }[] }>("donate-platform-landings.json").pages.map((p) => [p.cc, p.html]));
const landingUrl = (cc: string) => `https://donate.redcrossredcrescent.org/${cc}/default/~my-donation?_cv=1`;
const PAGES = Object.fromEntries(fixture<{ pages: PageFixture[] }>("donate-pages.json").pages.map((p) => [p.name, p]));
const GOV = loadGovernmentDomains();
const RESOLVE = buildResolver(loadGlobeFeatures());

const NOW = "2026-10-19T12:00:00.000Z";
const daysBefore = (days: number) => new Date(Date.parse(NOW) - days * 86_400_000).toISOString();

function html(body: string, status = 200, type = "text/html; charset=utf-8"): Response {
  return new Response(body, { status, headers: { "content-type": type } });
}

function redirect(location: string | null, status = 302): Response {
  return new Response(null, { status, headers: location === null ? {} : { location } });
}

function page(name: string): Response {
  const p = PAGES[name];
  return html(p.html, 200, p.contentType);
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

interface FakeDeps extends FetchDeps {
  fetch: Mock<typeof globalThis.fetch>;
  sleep: Mock<(ms: number) => Promise<void>>;
  log: Mock<(msg: string) => void>;
}

/** Fake deps whose fetch answers by exact URL; unknown URLs throw like a network error. */
function deps(routes: Record<string, Handler | Response | (() => Response)> | Handler): FakeDeps {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);
    if (typeof routes === "function") return routes(url, init);
    const r = routes[url];
    if (!r) throw new Error(`no route for ${url}`);
    return typeof r === "function" ? (r as Handler)(url, init) : r.clone();
  });
  return { fetch, sleep: vi.fn<(ms: number) => Promise<void>>(async () => {}), log: vi.fn<(msg: string) => void>() };
}

function society(over: Partial<RegistrySociety> & { name: string }): RegistrySociety {
  return { country: "", url: null, directory: null, hosts: [], donate: null, checked: null, ...over };
}

/** A registry like a real run's, by hand. */
function registry(over: Partial<DonationRegistry> = {}): DonationRegistry {
  return {
    ...emptyRegistry(),
    societies: {
      PH: society({ name: "Philippine Red Cross", country: "Philippines", url: "http://www.redcross.org.ph/", hosts: ["redcross.org.ph"], checked: daysBefore(1) }),
      SD: society({ name: "Sudanese Red Crescent", country: "Sudan", url: "http://www.srcs.sd/", hosts: ["srcs.sd"], donate: platformUrl("SD"), checked: daysBefore(1) }),
      JP: society({ name: "Japanese Red Cross Society", country: "Japan", url: "http://www.jrc.or.jp/", hosts: ["jrc.or.jp"], donate: platformUrl("JP"), checked: daysBefore(1) }),
      US: society({ name: "American Red Cross", country: "United States", url: "http://www.redcross.org/", hosts: ["redcross.org"], checked: daysBefore(1) }),
      PR: society({ name: "American Red Cross", country: "Puerto Rico", parent: "US" }),
      TH: society({ name: "Thai Red Cross Society", country: "Thailand", url: "http://www.redcross.or.th/", hosts: ["redcross.or.th"], checked: daysBefore(1) }),
      TR: society({ name: "Turkish Red Crescent Society", country: "Türkiye", url: "http://www.kizilay.org.tr/", hosts: ["kizilay.org.tr"], checked: daysBefore(1) }),
      GB: society({ name: "British Red Cross", country: "United Kingdom", url: "http://www.redcross.org.uk/", hosts: ["redcross.org.uk"], checked: daysBefore(1) }),
    },
    uncr: {
      SD: { url: "https://crisisrelief.un.org/donate-sudan-crisis", name: "Sudan" },
      CF: { url: "https://crisisrelief.un.org/donate-car-crisis", name: "the Central African Republic" },
    },
    uncrGeneral: "https://crisisrelief.un.org/donate-global-emergency-fund",
    ...over,
  };
}

function ctxFor(countries: string[], reg = registry()): DonationContext {
  return donationContext(countries, reg, GOV);
}

function verdict(chain: string[], ok = true, checked = NOW): DonationVerdict {
  return { ok, reason: ok ? "test" : "test failure", checked, chain };
}

function appeal(over: Partial<AppealRef> = {}): AppealRef {
  return { code: "MDRPH060", name: "Philippines - Floods", kind: "DREF", requested: 500_000, funded: 100_000, url: "https://go.ifrc.org/emergencies/8057", end: "2027-02-28T00:00:00.000Z", ...over };
}

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------

describe("siteScope and inSiteScope", () => {
  it("keeps a society's own host, even when IFRC lists a language or home page", () => {
    expect(siteScope("http://www.redcross.org.ph/")).toBe("redcross.org.ph");
    expect(siteScope("https://www.mdais.org/en/")).toBe("mdais.org");
    expect(siteScope("https://ckrm.org.mk/en/home/")).toBe("ckrm.org.mk");
    expect(siteScope("https://sarc.sy/home/")).toBe("sarc.sy");
    expect(siteScope("http://www.redcross.lv/lv/")).toBe("redcross.lv");
    expect(siteScope("http://jnrcs.org/en")).toBe("jnrcs.org");
    expect(siteScope("https://www.croix-rouge.fr/index.php")).toBe("croix-rouge.fr");
  });

  it("adds the folder for a society site that is one folder of a bigger host", () => {
    // Cuba's Red Cross is a folder on Infomed, the health ministry's network.
    expect(siteScope("http://www.sld.cu/sitios/cruzroja/")).toBe("sld.cu/sitios/cruzroja");
    expect(siteScope("http://www.sld.cu/sitios/CruzRoja/index.html")).toBe("sld.cu/sitios/cruzroja");
    expect(siteScope("http://www.friend.com.kp/dprkrcs")).toBe("friend.com.kp/dprkrcs");
    expect(siteScope("https://www.facebook.com/redcross")).toBeNull();
  });

  it("matches a host entry on the host and its subdomains", () => {
    expect(inSiteScope(new URL("https://www.redcross.org.ph/donate"), "redcross.org.ph")).toBe(true);
    expect(inSiteScope(new URL("https://give.redcross.org.ph/"), "redcross.org.ph")).toBe(true);
    expect(inSiteScope(new URL("https://redcross.org.ph.evil.com/"), "redcross.org.ph")).toBe(false);
  });

  it("matches a folder entry only inside that folder on that very host", () => {
    const cu = "sld.cu/sitios/cruzroja";
    expect(inSiteScope(new URL("https://www.sld.cu/sitios/cruzroja/donaciones/"), cu)).toBe(true);
    expect(inSiteScope(new URL("https://sld.cu/sitios/cruzroja"), cu)).toBe(true);
    expect(inSiteScope(new URL("https://www.sld.cu/sitios/CruzRoja/x"), cu)).toBe(true);
    expect(inSiteScope(new URL("https://www.sld.cu/sitios/cruzrojanueva/"), cu)).toBe(false);
    expect(inSiteScope(new URL("https://www.sld.cu/noticia/llegan-donaciones-santiago"), cu)).toBe(false);
    expect(inSiteScope(new URL("https://instituciones.sld.cu/sitios/cruzroja/"), cu)).toBe(false);
  });

  it("keeps the rest of a shared host off the society allowlist", () => {
    const reg = registry({
      societies: { CU: society({ name: "Cuban Red Cross", country: "Cuba", url: "http://www.sld.cu/sitios/cruzroja/", hosts: ["sld.cu/sitios/cruzroja"], checked: daysBefore(1) }) },
    });
    const ctx = donationContext(["CU"], reg, GOV);
    const own = new URL("https://www.sld.cu/sitios/cruzroja/donaciones/");
    expect(hostClass(own, ctx)).toBe("society");
    expect(knownOrg(own, "society", ["CU"], reg)).toBe("Cuban Red Cross");
    expect(hostClass(new URL("https://instituciones.sld.cu/hospitalcalixtogarcia/donaciones/"), ctx)).toBeNull();
    expect(hostClass(new URL("https://www.sld.cu/noticia/2026/10/20/llegan-donaciones-santiago"), ctx)).toBeNull();
  });
});

describe("hostMatches", () => {
  it("matches the domain itself and its subdomains, at a dot boundary", () => {
    expect(hostMatches("gov.uk", "gov.uk")).toBe(true);
    expect(hostMatches("www.gov.uk", "gov.uk")).toBe(true);
    expect(hostMatches("a.b.gov.uk", "gov.uk")).toBe(true);
    expect(hostMatches("evilgov.uk", "gov.uk")).toBe(false);
    expect(hostMatches("gov.uk.evil.com", "gov.uk")).toBe(false);
    expect(hostMatches("www.fema.gov", "gov")).toBe(true);
    expect(hostMatches("fema.gov.evil.com", "gov")).toBe(false);
  });
});

describe("isPlainHostname", () => {
  it("accepts ordinary names", () => {
    expect(isPlainHostname("redcross.org.ph")).toBe(true);
    expect(isPlainHostname("bagis.kizilay.org.tr")).toBe(true);
    expect(isPlainHostname("rks-gov.net")).toBe(true);
  });

  it("rejects IPs, single labels, punycode, odd characters and trailing dots", () => {
    for (const h of ["127.0.0.1", "localhost", "xn--redcrss-2fg.org", "exa_mple.com", "a..b.com", "redcross.org.", "-bad.org", "", "x.123"]) {
      expect(isPlainHostname(h), h).toBe(false);
    }
  });
});

describe("siteHost and normaliseSiteUrl", () => {
  it("takes the host without www", () => {
    expect(siteHost("http://www.redcross.org/")).toBe("redcross.org");
    expect(siteHost("https://bagis.kizilay.org.tr/tr")).toBe("bagis.kizilay.org.tr");
  });

  it("never trusts a shared platform as a society host", () => {
    expect(siteHost("https://www.facebook.com/cruzvermelhaportuguesa.oficial")).toBeNull();
    expect(siteHost("http://croixrouge.ci.over-blog.org")).toBeNull();
    expect(siteHost("https://redcross-xx.wixsite.com/home")).toBeNull();
  });

  it("cleans IFRC's website fields", () => {
    expect(normaliseSiteUrl("www.cra.dz")).toBe("http://www.cra.dz/");
    expect(normaliseSiteUrl("http://www.crucearosie.ro/.")).toBe("http://www.crucearosie.ro/");
    expect(normaliseSiteUrl("redcross.org.nz")).toBe("http://redcross.org.nz/");
    expect(normaliseSiteUrl("projet")).toBeNull();
    expect(normaliseSiteUrl("ftp://redcross.org")).toBeNull();
    expect(normaliseSiteUrl("http://user:pw@redcross.org")).toBeNull();
    expect(normaliseSiteUrl("http://redcross.org:8080/")).toBeNull();
    expect(normaliseSiteUrl("https://www.facebook.com/x")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Societies
// ---------------------------------------------------------------------------

describe("toSocieties (real IFRC GO rows)", () => {
  const societies = toSocieties(GO_ROWS);

  it("keys societies by country code with their own site and directory page", () => {
    expect(societies.PH).toEqual({
      name: "Philippine Red Cross",
      country: "Philippines",
      url: "http://www.redcross.org.ph/",
      directory: "https://www.ifrc.org/national-societies-directory/philippine-red-cross",
      hosts: ["redcross.org.ph"],
      donate: null,
      checked: null,
    });
  });

  it("collects every listed site's host, leaving out social media", () => {
    expect(societies.BE.hosts).toEqual(["redcross.be", "croix-rouge.be", "rodekruis.be"]);
    expect(societies.DK.hosts).toEqual(["drk.dk", "rodekors.dk"]);
    expect(societies.DZ.hosts).toEqual(["cra-algerie.org", "cra.dz"]);
    expect(societies.PT.hosts).toEqual(["cruzvermelha.org.pt"]);
  });

  it("keeps a society site on a shared host to its folder", () => {
    expect(societies.CU.url).toBe("http://www.sld.cu/sitios/cruzroja/");
    expect(societies.CU.hosts).toEqual(["sld.cu/sitios/cruzroja"]);
  });

  it("prefers a site IFRC lists over https", () => {
    // society_url "http://www.arcs.org.af/", website "https://arcs.af/"
    expect(societies.AF.url).toBe("https://arcs.af/");
    expect(societies.AF.hosts).toEqual(["arcs.org.af", "arcs.af"]);
    expect(societies.PH.url).toBe("http://www.redcross.org.ph/");
  });

  it("falls back to the website field and drops junk", () => {
    expect(societies.KM.url).toBe("http://www.cr-comorien.org/");
    expect(societies.GN.url).toBeNull();
    expect(societies.GN.hosts).toEqual([]);
  });

  it("links a territory to the society IFRC names for it, by exact name", () => {
    expect(societies.PR.parent).toBe("US");
    expect(societies.GL.parent).toBe("DK");
    // "The Red Cross of Serbia" is not the exact name of the Serbian society's record.
    expect(societies.XK.parent).toBeUndefined();
    // Macau has a society of its own.
    expect(societies.MO.parent).toBeUndefined();
    expect(societies.MO.url).toBe("http://www.redcross.org.mo/");
  });

  it("skips rows without a code or a society name", () => {
    expect(societies.AQ).toBeUndefined();
    expect(societies.AW).toBeUndefined();
    expect(Object.keys(societies).every((c) => /^[A-Z]{2}$/.test(c))).toBe(true);
  });

  it("carries over earlier platform answers", () => {
    const again = toSocieties(GO_ROWS, { JP: { ...societies.JP, donate: platformUrl("JP"), checked: daysBefore(2) } });
    expect(again.JP.donate).toBe("https://donate.redcrossredcrescent.org/jp/default/");
    expect(again.JP.checked).toBe(daysBefore(2));
  });

  it("survives malformed rows", () => {
    expect(toSocieties([null as unknown as GoCountryRow, { iso: 5 } as unknown as GoCountryRow, { iso: "ZZ", record_type: 1, society_name: "  " }])).toEqual({});
  });
});

describe("societyOf", () => {
  it("returns a territory's parent society", () => {
    const reg = registry();
    expect(societyOf("PR", reg)?.url).toBe("http://www.redcross.org/");
    expect(societyOf("ph", reg)?.name).toBe("Philippine Red Cross");
    expect(societyOf("TW", reg)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The donation platform
// ---------------------------------------------------------------------------

describe("platformAnswer (real platform answers)", () => {
  it("reads every answer seen live", () => {
    for (const p of LIVE.platform) {
      const expected = p.cc === "jp" || p.cc === "sd" ? platformUrl(p.cc) : null;
      expect(platformAnswer(p.cc.toUpperCase(), p.status, p.location), p.cc).toBe(expected);
    }
  });

  it("treats anything else as unclear", () => {
    expect(platformAnswer("JP", 200, null)).toBeUndefined();
    expect(platformAnswer("JP", 303, null)).toBeUndefined();
    expect(platformAnswer("JP", 303, "/sd/default/~my-donation")).toBeUndefined();
    expect(platformAnswer("JP", 404, "/")).toBeUndefined();
  });

  it("accepts an absolute location too", () => {
    expect(platformAnswer("JP", 302, "https://donate.redcrossredcrescent.org/jp/default/~my-donation")).toBe(platformUrl("JP"));
  });

  it("treats a redirect off the platform as unclear", () => {
    expect(platformAnswer("JP", 302, "https://evil.example/jp/default/")).toBeUndefined();
    expect(platformAnswer("JP", 302, "http://donate.redcrossredcrescent.org/jp/default/")).toBeUndefined();
    expect(platformAnswer("JP", 302, "//evil.example/")).toBeUndefined();
  });
});

describe("platformCampaign, isSocietyCampaign and landingAnswer (real landing pages)", () => {
  it("reads the campaign each real page collects for", () => {
    expect(platformCampaign(LANDINGS.jp)).toBe("Japanese RC - default campaign");
    expect(platformCampaign(LANDINGS.ke)).toBe("Kenya Red Cross");
    expect(platformCampaign(LANDINGS.sd)).toBe("Sudanese Red Crescent");
    expect(platformCampaign(LANDINGS.np)).toBe("Nepal Red Cross Society - Flood Emergency");
    expect(platformCampaign(LANDINGS.es)).toBe("Cruz Roja Española");
    for (const cc of ["ch", "am", "lb"]) expect(platformCampaign(LANDINGS[cc]), cc).toBe("Red Cross and Red Crescent Movement");
    // Bosnia and Herzegovina: an unfinished template ("Add your content here.") with no campaign.
    expect(platformCampaign(LANDINGS.ba)).toBeNull();
    expect(platformCampaign("<p>Donate</p>")).toBeNull();
  });

  it("accepts a society's own campaign and nothing movement-wide or unnamed", () => {
    for (const cc of ["jp", "ke", "sd", "np", "es"]) expect(isSocietyCampaign(platformCampaign(LANDINGS[cc])), cc).toBe(true);
    for (const cc of ["ch", "am", "lb", "ba"]) expect(isSocietyCampaign(platformCampaign(LANDINGS[cc])), cc).toBe(false);
    expect(isSocietyCampaign("Red Cross Red Crescent")).toBe(false);
    expect(isSocietyCampaign("IFRC - Kenya floods")).toBe(false);
    expect(isSocietyCampaign("Default campaign")).toBe(false);
    expect(isSocietyCampaign("")).toBe(false);
    expect(isSocietyCampaign("Red Crescent of Kazakhstan")).toBe(true);
  });

  it("answers per landing page", () => {
    expect(landingAnswer("KE", 200, LANDINGS.ke)).toBe(platformUrl("KE"));
    expect(landingAnswer("CH", 200, LANDINGS.ch)).toBeNull();
    expect(landingAnswer("BA", 200, LANDINGS.ba)).toBeNull();
    expect(landingAnswer("KE", 404, "")).toBeNull();
    expect(landingAnswer("KE", 503, "")).toBeUndefined();
    expect(landingAnswer("KE", 429, "")).toBeUndefined();
    expect(landingAnswer("KE", 302, "")).toBeUndefined();
  });
});

describe("nextToCheck", () => {
  const s = (checked: string | null, parent?: string) => society({ name: "x", checked, ...(parent ? { parent } : {}) });

  it("asks never-checked societies first, then the oldest, skipping fresh answers and territories", () => {
    const societies = { AA: s(daysBefore(30)), BB: s(null), CC: s(daysBefore(1)), DD: s(daysBefore(10)), EE: s(null), PR: s(null, "US") };
    expect(nextToCheck(societies, NOW)).toEqual(["BB", "EE", "AA", "DD"]);
    expect(nextToCheck(societies, NOW, 3)).toEqual(["BB", "EE", "AA"]);
  });

  it("can be limited to some codes", () => {
    expect(nextToCheck({ AA: s(null), BB: s(null) }, NOW, 40, 7, ["bb"])).toEqual(["BB"]);
  });

  it("asks again about an answer with a broken date", () => {
    expect(nextToCheck({ AA: s("not a date") }, NOW)).toEqual(["AA"]);
  });
});

/** Real platform answers: the probe redirects, and the landing pages they lead to. */
const PLATFORM_ROUTES: Record<string, () => Response> = {
  ...Object.fromEntries(LIVE.platform.map((p) => [platformUrl(p.cc), () => redirect(p.location, p.status)])),
  ...Object.fromEntries(Object.entries(LANDINGS).map(([cc, body]) => [landingUrl(cc), () => html(body)])),
};

describe("probePlatform", () => {
  const answers = PLATFORM_ROUTES;
  /** A society whose path redirects into the platform, landing on the given page. */
  const maybeOn = (cc: string, landing: () => Response) => ({ [platformUrl(cc)]: () => redirect(`/${cc}/default/~my-donation?_cv=1`, 303), [landingUrl(cc)]: landing });

  it("asks one society at a time with redirects left manual, reading the page a society's path lands on", async () => {
    const d = deps(answers);
    const out = await probePlatform(["JP", "PH", "SD"], d, 0);
    expect(out).toEqual({ JP: platformUrl("JP"), PH: null, SD: platformUrl("SD") });
    expect(d.fetch.mock.calls.map((c) => String(c[0]))).toEqual([platformUrl("JP"), landingUrl("jp"), platformUrl("PH"), platformUrl("SD"), landingUrl("sd")]);
    for (const [, init] of d.fetch.mock.calls) {
      expect((init as RequestInit).redirect).toBe("manual");
      expect(((init as RequestInit).headers as Record<string, string>)["User-Agent"]).toBe(USER_AGENT);
    }
    expect(d.sleep).toHaveBeenCalledTimes(5);
  });

  it("does not link a path that lands on the movement-wide campaign or an unfinished page", async () => {
    // Seen live: Switzerland's and Lebanon's paths land on IFRC's "Red Cross and Red Crescent Movement"
    // campaign, Bosnia and Herzegovina's on a template with no campaign.
    const d = deps({ ...maybeOn("ch", () => html(LANDINGS.ch)), ...maybeOn("lb", () => html(LANDINGS.lb)), ...maybeOn("ba", () => html(LANDINGS.ba)), ...maybeOn("ke", () => html(LANDINGS.ke)) });
    expect(await probePlatform(["CH", "LB", "BA", "KE"], d, 0)).toEqual({ CH: null, LB: null, BA: null, KE: platformUrl("KE") });
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining('CH: campaign "Red Cross and Red Crescent Movement" is not the society\'s own'));
  });

  it("leaves a society unanswered when its landing page fails, and stops at a 429 there", async () => {
    const d = deps({ ...answers, ...maybeOn("ke", () => html("busy", 503)), ...maybeOn("np", () => new Response("", { status: 429 })) });
    expect(await probePlatform(["KE", "NP", "SD"], d, 0)).toEqual({});
    expect(d.fetch).toHaveBeenCalledTimes(4);
  });

  it("spends at most maxRequests requests, landing pages included", async () => {
    const d = deps(answers);
    expect(await probePlatform(["JP", "PH", "SD", "US"], d, 0, 3)).toEqual({ JP: platformUrl("JP"), PH: null });
    expect(d.fetch).toHaveBeenCalledTimes(3);
    const short = deps(answers);
    // The redirect of SD is read, but no request is left for its page: asked again next run.
    expect(await probePlatform(["PH", "SD"], short, 0, 2)).toEqual({ PH: null });
    expect(short.fetch).toHaveBeenCalledTimes(2);
  });

  it("stops at the first 429 and keeps the earlier answers", async () => {
    const d = deps({ ...answers, [platformUrl("PH")]: () => new Response("", { status: 429 }) });
    const out = await probePlatform(["JP", "PH", "SD"], d, 0);
    expect(out).toEqual({ JP: platformUrl("JP") });
    expect(d.fetch).toHaveBeenCalledTimes(3);
  });

  it("leaves unclear answers out and stops after three network failures in a row", async () => {
    const d = deps({ [platformUrl("JP")]: () => html("odd", 200) });
    const out = await probePlatform(["JP", "AA", "BB", "CC", "DD"], d, 0);
    expect(out).toEqual({});
    expect(d.fetch).toHaveBeenCalledTimes(4);
  });
});

// ---------------------------------------------------------------------------
// UN Crisis Relief
// ---------------------------------------------------------------------------

describe("UN Crisis Relief sitemap (real)", () => {
  const locs = parseSitemapLocs(SITEMAP);

  it("lists every page", () => {
    expect(locs).toHaveLength(72);
    expect(locs[0]).toBe("https://crisisrelief.un.org/");
  });

  it("maps per-country pages, aliases included, and finds the general fund", () => {
    const { pages, general } = toUncr(locs, RESOLVE);
    expect(pages.SD).toEqual({ url: "https://crisisrelief.un.org/donate-sudan-crisis", name: "Sudan" });
    expect(pages.LK).toEqual({ url: "https://crisisrelief.un.org/donate-sri-lanka", name: "Sri Lanka" });
    expect(pages.SS.name).toBe("South Sudan");
    expect(pages.CF).toEqual({ url: "https://crisisrelief.un.org/donate-car-crisis", name: "the Central African Republic" });
    expect(pages.CD.url).toBe("https://crisisrelief.un.org/donate-drc-crisis");
    expect(pages.PS.url).toBe("https://crisisrelief.un.org/donate-opt-crisis");
    expect(general).toBe("https://crisisrelief.un.org/donate-global-emergency-fund");
    // Regional and campaign pages belong to no country.
    expect(Object.values(pages).some((p) => /asia-pacific|sahel|climate|latin-america|hurricane/.test(p.url))).toBe(false);
    expect(Object.keys(pages).length).toBeGreaterThanOrEqual(20);
  });

  it("accepts language copies and keeps the first page per country", () => {
    const { pages, general } = toUncr(["https://crisisrelief.un.org/en/donate-haiti-crisis/", "https://crisisrelief.un.org/donate-haiti", "https://evil.example/donate-haiti"], RESOLVE);
    expect(pages).toEqual({ HT: { url: "https://crisisrelief.un.org/en/donate-haiti-crisis/", name: "Haiti" } });
    expect(general).toBeNull();
  });

  it("decodes &amp; in locs", () => {
    expect(parseSitemapLocs("<url><loc>https://a.org/?x=1&amp;y=2</loc></url>")).toEqual(["https://a.org/?x=1&y=2"]);
  });
});

// ---------------------------------------------------------------------------
// Fetching and refreshing the registry
// ---------------------------------------------------------------------------

const goJson = () => html(JSON.stringify({ count: GO_ROWS.length, results: GO_ROWS }), 200, "application/json");
const sitemapXml = () => html(SITEMAP, 200, "text/xml; charset=utf-8");

describe("fetchGoCountries and fetchUncrLocs", () => {
  it("read the real responses", async () => {
    const d = deps({ [GO_COUNTRIES_URL]: goJson, [UNCR_SITEMAP]: sitemapXml });
    expect(await fetchGoCountries(d, 0)).toHaveLength(GO_ROWS.length);
    expect(await fetchUncrLocs(d, 0)).toHaveLength(72);
  });

  it("retry once after a delay", async () => {
    let calls = 0;
    const d = deps({ [GO_COUNTRIES_URL]: () => (++calls === 1 ? html("busy", 503) : goJson()) });
    expect(await fetchGoCountries(d, 1234)).toHaveLength(GO_ROWS.length);
    expect(d.sleep).toHaveBeenCalledWith(1234);
  });

  it("follow IFRC GO's next pages, so a smaller page size cannot cut the registry short", async () => {
    const page2 = "https://goadmin.ifrc.org/api/v2/country/?limit=500&offset=10";
    const d = deps({
      [GO_COUNTRIES_URL]: () => html(JSON.stringify({ count: GO_ROWS.length, next: page2, results: GO_ROWS.slice(0, 10) }), 200, "application/json"),
      [page2]: () => html(JSON.stringify({ count: GO_ROWS.length, next: null, results: GO_ROWS.slice(10) }), 200, "application/json"),
    });
    expect(await fetchGoCountries(d, 0)).toEqual(GO_ROWS);
  });

  it("give up rather than return part of the list", async () => {
    const endless = deps((url) => html(JSON.stringify({ next: `${url}x`, results: GO_ROWS.slice(0, 1) }), 200, "application/json"));
    expect(await fetchGoCountries(endless, 0)).toBeNull();
    const elsewhere = deps({ [GO_COUNTRIES_URL]: () => html(JSON.stringify({ next: "https://evil.example/page2", results: GO_ROWS }), 200, "application/json") });
    expect(await fetchGoCountries(elsewhere, 0)).toBeNull();
    const broken = deps({ [GO_COUNTRIES_URL]: () => html(JSON.stringify({ next: "https://goadmin.ifrc.org/api/v2/country/?offset=1", results: GO_ROWS }), 200, "application/json") });
    expect(await fetchGoCountries(broken, 0)).toBeNull();
    expect(elsewhere.log).toHaveBeenCalledWith(expect.stringContaining("unexpected next page"));
  });

  it("return null when both attempts fail, without throwing", async () => {
    const d = deps({ [GO_COUNTRIES_URL]: () => html("{}", 200, "application/json"), [UNCR_SITEMAP]: () => html("<urlset></urlset>") });
    expect(await fetchGoCountries(d, 0)).toBeNull();
    expect(await fetchUncrLocs(d, 0)).toBeNull();
    expect(await fetchGoCountries(deps({}), 0)).toBeNull();
    expect(d.fetch).toHaveBeenCalledTimes(4);
  });
});

describe("pruneVerdicts and verdictFresh", () => {
  it("keeps passes for seven days and failures for one", () => {
    const v = {
      pass: verdict(["https://a.org/"], true, daysBefore(6)),
      oldPass: verdict(["https://b.org/"], true, daysBefore(8)),
      fail: verdict(["https://c.org/"], false, daysBefore(0.5)),
      oldFail: verdict(["https://d.org/"], false, daysBefore(1.5)),
      bad: verdict(["https://e.org/"], true, "bad"),
    };
    expect(Object.keys(pruneVerdicts(v, NOW))).toEqual(["pass", "fail"]);
    expect(verdictFresh(v.pass, NOW)).toBe(true);
    expect(verdictFresh(v.oldFail, NOW)).toBe(false);
  });
});

describe("refreshRegistry", () => {
  const platform = PLATFORM_ROUTES;

  it("builds the registry from IFRC GO, the platform and UN Crisis Relief", async () => {
    const d = deps({ [GO_COUNTRIES_URL]: goJson, [UNCR_SITEMAP]: sitemapXml, ...platform });
    const reg = await refreshRegistry(null, d, NOW, RESOLVE, { pauseMs: 0, retryMs: 0, probeCodes: ["JP", "SD", "PH", "US", "TR", "AF", "GB"] });
    expect(reg.updated).toBe(NOW);
    expect(reg.fetched).toEqual({ societies: NOW, uncr: NOW });
    expect(reg.societies.JP.donate).toBe(platformUrl("JP"));
    expect(reg.societies.SD.donate).toBe(platformUrl("SD"));
    expect(reg.societies.PH).toMatchObject({ donate: null, checked: NOW });
    expect(reg.societies.TH.checked).toBeNull();
    expect(reg.uncr.SD.url).toBe("https://crisisrelief.un.org/donate-sudan-crisis");
    expect(reg.uncrGeneral).toBe("https://crisisrelief.un.org/donate-global-emergency-fund");
    // Territories are never probed.
    expect(d.fetch.mock.calls.map((c) => String(c[0]))).not.toContain(platformUrl("PR"));
  });

  it("keeps every source's previous data when everything fails, and never throws", async () => {
    const prev = registry({ fetched: { societies: daysBefore(1), uncr: daysBefore(1) }, verdicts: { old: verdict(["https://x.org/"], true, daysBefore(9)), recent: verdict(["https://y.org/"]) } });
    const d = deps(() => {
      throw new Error("offline");
    });
    const reg = await refreshRegistry(prev, d, NOW, RESOLVE, { pauseMs: 0, retryMs: 0 });
    expect(reg.societies).toEqual(prev.societies);
    expect(reg.uncr).toEqual(prev.uncr);
    expect(reg.uncrGeneral).toBe(prev.uncrGeneral);
    expect(reg.fetched).toEqual(prev.fetched);
    expect(reg.updated).toBe(NOW);
    expect(Object.keys(reg.verdicts)).toEqual(["recent"]);
  });

  it("never replaces data with an empty list", async () => {
    const prev = registry();
    const d = deps({ [GO_COUNTRIES_URL]: () => html(JSON.stringify({ results: [{ iso: null, record_type: 3 }] }), 200, "application/json"), [UNCR_SITEMAP]: () => html("<urlset><url><loc>https://crisisrelief.un.org/blog</loc></url></urlset>") });
    const reg = await refreshRegistry(prev, d, NOW, RESOLVE, { pauseMs: 0, retryMs: 0, batch: 0 });
    expect(reg.societies).toEqual(prev.societies);
    expect(reg.uncr).toEqual(prev.uncr);
  });

  it("probes at most the batch size", async () => {
    const d = deps({ [GO_COUNTRIES_URL]: goJson, [UNCR_SITEMAP]: sitemapXml, ...platform });
    await refreshRegistry(null, d, NOW, RESOLVE, { pauseMs: 0, retryMs: 0, batch: 2 });
    expect(d.fetch.mock.calls.filter((c) => String(c[0]).includes("redcrossredcrescent"))).toHaveLength(2);
  });
});

describe("readRegistry, writeRegistry and normaliseRegistry", () => {
  it("round-trips through a file", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "donate-")), "cache", "donation-registry.json");
    const reg = registry({ verdicts: { "a.org/x": verdict(["https://a.org/x"]) } });
    writeRegistry(reg, file);
    expect(readRegistry(file)).toEqual(reg);
  });

  it("returns an empty registry for a missing or broken file", () => {
    expect(readRegistry("/nonexistent/donation-registry.json")).toEqual(emptyRegistry());
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "donate-")), "bad.json");
    fs.writeFileSync(file, "{not json");
    expect(readRegistry(file)).toEqual(emptyRegistry());
  });

  it("drops damaged entries", () => {
    const reg = normaliseRegistry({
      societies: { PH: { name: "Philippine Red Cross", hosts: ["redcross.org.ph", 5] }, XX: { url: "https://x.org" } },
      uncr: { SD: { url: "https://crisisrelief.un.org/donate-sudan-crisis", name: "Sudan" }, ZZ: { url: 3 } },
      verdicts: { good: { ok: true, checked: NOW, chain: ["https://a.org/"] }, bad: { ok: "yes", checked: NOW, chain: [] } },
    });
    expect(Object.keys(reg.societies)).toEqual(["PH"]);
    expect(reg.societies.PH).toMatchObject({ country: "PH", hosts: ["redcross.org.ph"], donate: null });
    expect(Object.keys(reg.uncr)).toEqual(["SD"]);
    expect(Object.keys(reg.verdicts)).toEqual(["good"]);
    expect(normaliseRegistry("nonsense")).toEqual(emptyRegistry());
  });
});

// ---------------------------------------------------------------------------
// The allowlist
// ---------------------------------------------------------------------------

describe("loadGovernmentDomains (pipeline/config/donation-domains.json)", () => {
  const globeCodes = new Set(loadGlobeFeatures().map((f) => f.code));
  const raw = JSON.parse(fs.readFileSync("pipeline/config/donation-domains.json", "utf8")) as { leftOut: string[]; domains: Record<string, string[]> };

  it("covers the conventions the task names", () => {
    expect(GOV).toMatchObject({
      US: ["gov"],
      GB: expect.arrayContaining(["gov.uk"]),
      JP: expect.arrayContaining(["go.jp"]),
      IN: ["gov.in", "nic.in"],
      DE: ["bund.de"],
      CH: ["admin.ch"],
      FR: ["gouv.fr"],
      BR: ["gov.br"],
      MX: ["gob.mx"],
      PH: ["gov.ph"],
      TR: ["gov.tr"],
      CN: ["gov.cn"],
      ID: ["go.id"],
      TH: ["go.th"],
      UY: ["gub.uy"],
      NZ: ["govt.nz"],
      AT: ["gv.at"],
    });
  });

  it("uses only globe codes, and every globe code is either listed or deliberately left out", () => {
    for (const code of [...Object.keys(raw.domains), ...raw.leftOut]) expect(globeCodes.has(code), code).toBe(true);
    for (const code of globeCodes) expect(code in raw.domains || raw.leftOut.includes(code), code).toBe(true);
    for (const code of raw.leftOut) expect(raw.domains[code], code).toBeUndefined();
  });

  it("lists plain lower-case suffixes, and no bare top-level domain except the US 'gov'", () => {
    for (const [code, list] of Object.entries(GOV)) {
      expect(list.length, code).toBeGreaterThan(0);
      for (const d of list) {
        expect(d, code).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)*$/);
        if (!d.includes(".")) expect(d, code).toBe("gov");
      }
    }
  });
});

describe("isAllowedDonationUrl", () => {
  const ph = ctxFor(["PH"]);

  it("accepts the disaster's society, the UN and Red Cross family, and its government", () => {
    for (const url of [
      "https://redcross.org.ph/donate",
      "https://www.redcross.org.ph/donate?campaign=typhoon",
      "https://crisisrelief.un.org/donate-x",
      "https://www.un.org/en/",
      "https://www.unicef.org/emergencies",
      "https://donate.wfp.org/1/",
      "https://www.ifrc.org/donate",
      "https://www.icrc.org/en/donate",
      "https://ndrrmc.gov.ph/donate",
      "HTTPS://WWW.UN.ORG/donate",
    ]) {
      expect(donationUrlProblem(url, ph), url).toBeNull();
    }
  });

  it("allows a society's platform path only when the probe found the society there", () => {
    expect(isAllowedDonationUrl("https://donate.redcrossredcrescent.org/sd/default/", ctxFor(["SD"]))).toBe(true);
    expect(isAllowedDonationUrl("https://donate.redcrossredcrescent.org/sd/default/~my-donation?_cv=1", ctxFor(["SD"]))).toBe(true);
    // The Philippine Red Cross is not on the platform; Ukraine's path lands on IFRC's movement-wide
    // campaign (seen live), which research must not pass off as the society's page.
    expect(donationUrlProblem("https://donate.redcrossredcrescent.org/ph/default/", ph)).toBe("host not on the allowlist");
    const ua = registry();
    ua.societies.UA = society({ name: "Ukrainian Red Cross Society", country: "Ukraine", hosts: ["redcross.org.ua"], checked: NOW });
    expect(donationUrlProblem("https://donate.redcrossredcrescent.org/ua/default/~my-donation?_cv=1", ctxFor(["UA"], ua))).toBe("host not on the allowlist");
    expect(ctxFor(["UA"], ua).platformCodes).toEqual([]);
    // A context built by hand allows no platform path.
    expect(hostClass(new URL("https://donate.redcrossredcrescent.org/sd/default/"), { countries: ["SD"], societyHosts: [] })).toBeNull();
  });

  it("rejects attacks and lookalikes", () => {
    const cases: [string, string][] = [
      ["http://redcross.org.ph/donate", "not https"],
      ["https://redcross.org.ph.evil.com/donate", "host not on the allowlist"],
      ["https://evilredcross.org.ph/donate", "host not on the allowlist"],
      ["https://gov.ph.evil.com/donate", "host not on the allowlist"],
      ["https://evilgov.ph/donate", "host not on the allowlist"],
      ["https://un.org.evil.com/donate", "host not on the allowlist"],
      ["https://fakeun.org/donate", "host not on the allowlist"],
      ["https://unicef.org.donate-now.com/", "host not on the allowlist"],
      ["https://user:pass@redcross.org.ph/donate", "has credentials"],
      ["https://redcross.org.ph@evil.com/donate", "has credentials"],
      ["https://203.0.113.5/donate", "IP address host"],
      ["https://2130706433/donate", "IP address host"],
      ["https://[2001:db8::1]/donate", "IP address host"],
      ["https://redcrоss.org.ph/donate", "punycode host"], // Cyrillic "о"
      ["https://xn--un-xyz.org/donate", "punycode host"],
      ["https://bit.ly/3abcd", "URL shortener"],
      ["https://go.usa.gov/abc", "URL shortener"],
      ["https://redcross.org.ph:8443/donate", "has a port"],
      ["https://redcross.org.ph./donate", "unusual host"],
      ["javascript:alert(1)", "not https"],
      ["data:text/html,donate", "not https"],
      ["https://redcross.org.ph/ donate", "has spaces or control characters"],
      ["https://redcross.org.ph/\u0000", "has spaces or control characters"],
      ["not a url", "has spaces or control characters"],
      ["https://www.gov.uk/donate", "host not on the allowlist"],
      ["https://donate.redcrossredcrescent.org/jp/default/", "host not on the allowlist"],
      ["https://donate.redcrossredcrescent.org/", "host not on the allowlist"],
      ["https://redcross.org.ph/give-blood", "blood donation page"],
      ["", "not a URL"],
      [`https://redcross.org.ph/${"a".repeat(2100)}`, "not a URL"],
    ];
    for (const [url, problem] of cases) expect(donationUrlProblem(url, ph), url).toBe(problem);
    expect(isAllowedDonationUrl("https://redcross.org.ph.evil.com/", ph)).toBe(false);
  });

  it("holds government domains to the disaster's own countries", () => {
    const gb = ctxFor(["GB"]);
    expect(isAllowedDonationUrl("https://www.gov.uk/guidance/donate", gb)).toBe(true);
    expect(isAllowedDonationUrl("https://www.gov.scot/donate", gb)).toBe(true);
    expect(isAllowedDonationUrl("https://gov.uk.evil.com/", gb)).toBe(false);
    expect(isAllowedDonationUrl("https://evilgov.uk/", gb)).toBe(false);
    expect(isAllowedDonationUrl("https://ndrrmc.gov.ph/", gb)).toBe(false);
    const us = ctxFor(["US"]);
    expect(isAllowedDonationUrl("https://www.fema.gov/disaster", us)).toBe(true);
    expect(isAllowedDonationUrl("https://fema.gov.evil.com/", us)).toBe(false);
    expect(isAllowedDonationUrl("https://www.fema.gov/disaster", ph)).toBe(false);
  });

  it("gives a territory its parent society's sites and platform path, and its own government", () => {
    const pr = ctxFor(["PR"]);
    expect(pr.societyHosts).toEqual(["redcross.org"]);
    expect(isAllowedDonationUrl("https://www.redcross.org/donate/donation.html", pr)).toBe(true);
    expect(isAllowedDonationUrl("https://www.pr.gov/", pr)).toBe(true);
    // The American Red Cross is not on the platform in this registry, so neither path is allowed.
    expect(isAllowedDonationUrl("https://donate.redcrossredcrescent.org/us/default/", pr)).toBe(false);
    const onPlatform = registry();
    onPlatform.societies.US = { ...onPlatform.societies.US, donate: platformUrl("US") };
    const prOn = ctxFor(["PR"], onPlatform);
    expect(prOn.platformCodes).toEqual(["US"]);
    expect(isAllowedDonationUrl("https://donate.redcrossredcrescent.org/us/default/", prOn)).toBe(true);
    expect(isAllowedDonationUrl("https://donate.redcrossredcrescent.org/pr/default/", prOn)).toBe(false);
  });

  it("allows nothing society-specific when the country has no society", () => {
    const ctx = ctxFor([]);
    expect(isAllowedDonationUrl("https://redcross.org.ph/donate", ctx)).toBe(false);
    expect(isAllowedDonationUrl("https://crisisrelief.un.org/", ctx)).toBe(true);
  });
});

describe("hostClass", () => {
  const ph = ctxFor(["PH"]);
  it("names the kind of official site", () => {
    expect(hostClass(new URL("https://redcross.org.ph/"), ph)).toBe("society");
    expect(hostClass(new URL("https://donate.redcrossredcrescent.org/sd/default/"), ctxFor(["SD"]))).toBe("platform");
    expect(hostClass(new URL("https://donate.redcrossredcrescent.org/ph/default/"), ph)).toBeNull();
    expect(hostClass(new URL("https://crisisrelief.un.org/"), ph)).toBe("un");
    expect(hostClass(new URL("https://www.unocha.org/"), ph)).toBe("un");
    expect(hostClass(new URL("https://www.unicef.org/"), ph)).toBe("agency");
    expect(hostClass(new URL("https://www.ifrc.org/"), ph)).toBe("agency");
    expect(hostClass(new URL("https://www.dswd.gov.ph/"), ph)).toBe("government");
    expect(hostClass(new URL("https://example.org/"), ph)).toBeNull();
  });
});

describe("isBloodDonationPath", () => {
  it("spots blood-donation pages in several languages", () => {
    for (const p of ["/give-blood", "/donar-sangre", "/don-du-sang/", "/blutspende", "/%E7%8C%AE%E8%A1%80/", "/kan-bagisi", "/giving-blood"]) {
      expect(isBloodDonationPath(new URL(`https://a.org${p}`)), p).toBe(true);
    }
    expect(isBloodDonationPath(new URL("https://a.org/donate/typhoon"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The donation-word check
// ---------------------------------------------------------------------------

describe("donation words on real pages", () => {
  it("finds the word on real donation pages in several languages", () => {
    expect(donationWordsIn(PAGES["platform-sd"].html)).toContain("donat*");
    expect(donationWordsIn(PAGES["jrc-jp"].html)).toContain("寄付");
    expect(donationWordsIn(PAGES["drk-de"].html)).toContain("spenden*");
    expect(donationWordsIn(PAGES["trcs-th"].html)).toContain("บริจาค");
    expect(donationWordsIn(PAGES["kizilay-tr"].html)).toContain("bağış*");
    expect(donationWordsIn(PAGES["croix-rouge-fr"].html)).toContain("faire un don");
    // A JavaScript app: the words are only in its inline script data.
    expect(donationWordsIn(PAGES["uncr-sudan-spa"].html)).toContain("donat*");
  });

  it("finds none on real pages that are not about giving", () => {
    // Has "appeal" (tribunals) and "contribute", which alone do not count.
    expect(PAGES["govuk-organisations"].html).toMatch(/appeal/i);
    expect(hasDonationWord(PAGES["govuk-organisations"].html)).toBe(false);
    // A meta refresh to another page.
    expect(hasDonationWord(PAGES["cruzroja-es-refresh"].html)).toBe(false);
  });
});

describe("donation words by language", () => {
  const yes: [string, string][] = [
    ["en", "<button>Donate now</button>"],
    ["en", "<a>Ways to give</a>"],
    ["fr", "<a>Faites un don</a>"],
    ["fr", "Faire un don en ligne"],
    ["ht", "Fè yon don jodi a"],
    ["de", "Jetzt spenden"],
    ["de", "Ihre Spende hilft"],
    ["nl", "Doneer nu"],
    ["da", "Giv en gave"],
    ["no", "Gi en gave"],
    ["sv", "Ge en gåva"],
    ["fi", "Lahjoita nyt"],
    ["es", "Dona ahora"],
    ["es", "Haz tu donación"],
    ["pt", "Faça uma doação"],
    ["it", "Fai una donazione"],
    ["ro", "Donează acum"],
    ["pl", "Przekaż darowiznę"],
    ["cs", "Darujte"],
    ["hu", "Adományozz most"],
    ["hr", "Doniraj"],
    ["sq", "Dhuro tani"],
    ["et", "Anneta"],
    ["lv", "Ziedot"],
    ["lt", "Aukoti"],
    ["el", "Κάντε δωρεά"],
    ["tr", "BAĞIŞ YAP"],
    ["az", "İanə et"],
    ["ru", "Пожертвовать"],
    ["uk", "Зробити благодійний внесок"],
    ["be", "Ахвяраванні"],
    ["bg", "Дари"],
    ["sr", "Донирајте"],
    ["mn", "Хандив өгөх"],
    ["ka", "შემოწირულობა"],
    ["hy", "Նվիրատվություն"],
    ["uz", "Xayriya qilish"],
    ["ar", "تبر\u0651ع الآن"],
    ["fa", "کمک مالی کنید"],
    ["ur", "عطیہ دیں"],
    ["he", "לתרומה"],
    ["hi", "दान करें"],
    ["bn", "দান করুন"],
    ["si", "පරිත්\u200dයාග කරන්න"],
    ["ta", "நன்கொடை அளிக்க"],
    ["te", "విరాళం ఇవ్వండి"],
    ["kn", "ದೇಣಿಗೆ ನೀಡಿ"],
    ["ml", "സംഭാവന നൽകുക"],
    ["gu", "દાન કરો"],
    ["pa", "ਦਾਨ ਕਰੋ"],
    ["id", "Donasi sekarang"],
    ["id", "Salurkan sumbangan"],
    ["ms", "Derma sekarang"],
    ["tl", "Magbigay ng donasyon"],
    ["vi", "Quyên góp ngay"],
    ["th", "บริจาคเลย"],
    ["lo", "ບໍລິຈາກ"],
    ["km", "បរិច្ចាគឥឡូវនេះ"],
    ["my", "လှူဒါန်းရန်"],
    ["zh", "我要捐款"],
    ["ja", "寄付する"],
    ["ko", "기부하기"],
    ["sw", "Changia sasa"],
    ["am", "ይለግሱ"],
    ["so", "Tabaruc hadda"],
  ];

  it.each(yes)("%s: %s", (_lang, text) => {
    expect(hasDonationWord(`<p>${text}</p>`)).toBe(true);
  });

  const no = [
    "Give feedback on this page",
    "Court of Appeal decisions",
    "Contribute to the consultation",
    "Donald Duck",
    "Big spender",
    "Dermatology clinic",
    "δωρεάν αποστολή",
    "Dona Maria visitou",
    "Este serviço está disponível doar", // Romanian-like "doar" alone is not a term
    "मतदान केंद्र",
    "",
  ];
  it.each(no)("not a donation word: %s", (text) => {
    expect(hasDonationWord(`<p>${text}</p>`)).toBe(false);
  });

  it("compiles every term, and every term finds itself", () => {
    for (const [lang, terms] of Object.entries(DONATION_TERMS)) {
      for (const term of terms) {
        expect(() => compileTerm(term)).not.toThrow();
        expect(donationWordsIn(`<p>${term.replace("*", "")}</p>`), `${lang}: ${term}`).toContain(term);
      }
    }
  });

  it("reads labels in attributes but not URLs in links", () => {
    expect(hasDonationWord('<input type="submit" value="Donate">')).toBe(true);
    expect(hasDonationWord('<meta name="description" content="Make a donation">')).toBe(true);
    expect(hasDonationWord('<a href="https://donate.example.org/donate">Home</a>')).toBe(false);
    expect(hasDonationWord("<style>.donate-button{}</style><p>Home</p>")).toBe(false);
    expect(hasDonationWord("<!-- donate --><p>Home</p>")).toBe(false);
  });

  it("decodes entities before looking", () => {
    expect(decodeEntities("&#3610;&#x0e23; &amp; &nbsp;x &bogus;")).toBe("บร &  x &bogus;");
    expect(hasDonationWord("<p>&#3610;&#3619;&#3636;&#3592;&#3634;&#3588;</p>")).toBe(true);
    expect(pageText("<p>a</p>\n<p>b</p>")).toBe(" a b ");
  });

  it("folds case, accents and Turkish dotless i", () => {
    expect(foldText("BAĞIŞ Δωρεά İstanbul ủng hộ")).toBe("bagis δωρεα istanbul ung ho");
  });
});

// ---------------------------------------------------------------------------
// The live check
// ---------------------------------------------------------------------------

describe("checkDonationPage", () => {
  const th = ctxFor(["TH"]);
  const tr = ctxFor(["TR"]);
  const sd = ctxFor(["SD"]);
  const liveRedirect = (url: string) => {
    const r = LIVE.redirects.find((x) => x.url === url)!;
    return () => redirect(r.location, r.status);
  };

  it("passes a real donation page", async () => {
    const d = deps({ "https://redcross.or.th/donate/": () => page("trcs-th") });
    expect(await checkDonationPage("https://redcross.or.th/donate/", d, th, 0)).toEqual({ ok: true, reason: 'donation word "donat*"', chain: ["https://redcross.or.th/donate/"] });
    const init = d.fetch.mock.calls[0][1] as RequestInit;
    expect(init.redirect).toBe("manual");
    expect((init.headers as Record<string, string>)["User-Agent"]).toBe(USER_AGENT);
  });

  it("follows real redirects that stay on the allowlist", async () => {
    const d = deps({
      "https://www.redcross.or.th/donate/": liveRedirect("https://www.redcross.or.th/donate/"),
      "https://redcross.or.th/donate/": () => page("trcs-th"),
      "https://www.kizilay.org.tr/bagis": liveRedirect("https://www.kizilay.org.tr/bagis"),
      "https://bagis.kizilay.org.tr/tr": () => page("kizilay-tr"),
      "https://crisisrelief.un.org/donate-sudan-crisis": liveRedirect("https://crisisrelief.un.org/donate-sudan-crisis"),
      "https://crisisrelief.un.org/en/donate-sudan-crisis": () => page("uncr-sudan-spa"),
    });
    expect((await checkDonationPage("https://www.redcross.or.th/donate/", d, th, 0))?.chain).toEqual(["https://www.redcross.or.th/donate/", "https://redcross.or.th/donate/"]);
    expect((await checkDonationPage("https://www.kizilay.org.tr/bagis", d, tr, 0))?.ok).toBe(true);
    expect((await checkDonationPage("https://crisisrelief.un.org/donate-sudan-crisis", d, sd, 0))?.ok).toBe(true);
  });

  it("resolves relative redirects", async () => {
    const d = deps({ "https://redcross.or.th/a": () => redirect("/donate/", 301), "https://redcross.or.th/donate/": () => page("trcs-th") });
    expect((await checkDonationPage("https://redcross.or.th/a", d, th, 0))?.chain).toEqual(["https://redcross.or.th/a", "https://redcross.or.th/donate/"]);
  });

  it("stops at a redirect that leaves the allowlist, without fetching it", async () => {
    const d = deps({ "https://redcross.or.th/donate/": () => redirect("https://redcross-or-th.example.com/donate") });
    const out = await checkDonationPage("https://redcross.or.th/donate/", d, th, 0);
    expect(out).toEqual({ ok: false, reason: "redirect leaves the allowlist (host not on the allowlist)", chain: ["https://redcross.or.th/donate/", "https://redcross-or-th.example.com/donate"] });
    expect(d.fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a redirect down to http or to a shortener", async () => {
    const d = deps({ "https://redcross.or.th/a": () => redirect("http://redcross.or.th/donate/"), "https://redcross.or.th/b": () => redirect("https://bit.ly/x") });
    expect((await checkDonationPage("https://redcross.or.th/a", d, th, 0))?.reason).toBe("redirect leaves the allowlist (not https)");
    expect((await checkDonationPage("https://redcross.or.th/b", d, th, 0))?.reason).toBe("redirect leaves the allowlist (URL shortener)");
  });

  it("follows at most three redirects", async () => {
    const hop = (n: number) => `https://redcross.or.th/${n}`;
    const routes: Record<string, () => Response> = {};
    for (let i = 0; i < 4; i++) routes[hop(i)] = () => redirect(hop(i + 1));
    routes[hop(4)] = () => page("trcs-th");
    const d = deps(routes);
    expect((await checkDonationPage(hop(1), d, th, 0))?.ok).toBe(true); // 3 redirects
    expect(await checkDonationPage(hop(0), d, th, 0)).toMatchObject({ ok: false, reason: "more than 3 redirects" }); // 4
  });

  it("fails clearly on bad answers", async () => {
    const d = deps({
      "https://redcross.or.th/none": () => redirect(null),
      "https://redcross.or.th/403": () => html(PAGES["cruzroja-es-refresh"].html, 403),
      "https://redcross.or.th/404": () => html("gone", 404),
      "https://redcross.or.th/pdf": () => html("%PDF donate", 200, "application/pdf"),
      "https://redcross.or.th/words": () => page("govuk-organisations"),
      "https://redcross.or.th/refresh": () => page("cruzroja-es-refresh"),
    });
    expect((await checkDonationPage("https://redcross.or.th/none", d, th, 0))?.reason).toBe("redirect 302 without a location");
    expect((await checkDonationPage("https://redcross.or.th/403", d, th, 0))?.reason).toBe("blocked to scripts (HTTP 403)");
    expect((await checkDonationPage("https://redcross.or.th/404", d, th, 0))?.reason).toBe("HTTP 404");
    expect((await checkDonationPage("https://redcross.or.th/pdf", d, th, 0))?.reason).toBe("not an HTML page (application/pdf)");
    expect((await checkDonationPage("https://redcross.or.th/words", d, th, 0))?.reason).toBe("no donation word on the page");
    expect((await checkDonationPage("https://redcross.or.th/refresh", d, th, 0))?.reason).toBe("no donation word on the page");
    // Definitive answers are not retried.
    expect(d.sleep).not.toHaveBeenCalled();
  });

  it("retries once after a server error or network failure, then gives no verdict", async () => {
    let calls = 0;
    const flaky = deps({ "https://redcross.or.th/donate/": () => (++calls === 1 ? html("busy", 503) : page("trcs-th")) });
    expect((await checkDonationPage("https://redcross.or.th/donate/", flaky, th, 777))?.ok).toBe(true);
    expect(flaky.sleep).toHaveBeenCalledWith(777);
    const down = deps({});
    expect(await checkDonationPage("https://redcross.or.th/donate/", down, th, 0)).toBeNull();
    expect(down.fetch).toHaveBeenCalledTimes(2);
  });

  it("never fetches a URL that is off the allowlist", async () => {
    const d = deps({});
    expect(await checkDonationPage("https://evil.example/donate", d, th, 0)).toEqual({ ok: false, reason: "host not on the allowlist", chain: ["https://evil.example/donate"] });
    expect(d.fetch).not.toHaveBeenCalled();
  });
});

describe("urlKey", () => {
  it("lines up spellings of one page", () => {
    expect(urlKey("https://www.redcross.org.ph/donate/")).toBe("redcross.org.ph/donate");
    expect(urlKey("https://redcross.org.ph/donate?utm_source=x&_cv=1#top")).toBe("redcross.org.ph/donate");
    expect(urlKey("https://redcross.org.ph/donate?id=5&utm_medium=y")).toBe("redcross.org.ph/donate?id=5");
    expect(urlKey("https://crisisrelief.un.org/en/donate-sudan-crisis")).toBe(urlKey("https://crisisrelief.un.org/donate-sudan-crisis"));
    expect(urlKey("https://crisisrelief.un.org/en")).toBe("crisisrelief.un.org");
    expect(urlKey(" not a url ")).toBe("not a url");
  });
});

describe("verifyDonationPage", () => {
  const url = "https://redcross.or.th/donate/";

  it("caches a verdict for seven days", async () => {
    const reg = registry();
    const d = deps({ [url]: () => page("trcs-th") });
    expect(await verifyDonationPage(url, d, ctxFor(["TH"], reg), reg, NOW)).toBe(true);
    expect(reg.verdicts[urlKey(url)]).toMatchObject({ ok: true, checked: NOW, chain: [url] });
    const later = new Date(Date.parse(NOW) + 6 * 86_400_000).toISOString();
    expect(await verifyDonationPage(url, d, ctxFor(["TH"], reg), reg, later)).toBe(true);
    expect(d.fetch).toHaveBeenCalledTimes(1);
    const muchLater = new Date(Date.parse(NOW) + 8 * 86_400_000).toISOString();
    await verifyDonationPage(url, d, ctxFor(["TH"], reg), reg, muchLater);
    expect(d.fetch).toHaveBeenCalledTimes(2);
  });

  it("caches failures for one day, so a bot wall or outage does not hide a page for long", async () => {
    const reg = registry();
    let wall = true;
    // Seen live: the Thai Red Cross answered Node's fetch with a script-only check page.
    const d = deps({ [url]: () => (wall ? html("<html><head><script>setTimeout(function(){location.reload()},1000)</script></head></html>") : page("trcs-th")) });
    expect(await verifyDonationPage(url, d, ctxFor(["TH"], reg), reg, NOW)).toBe(false);
    expect(await verifyDonationPage(url, d, ctxFor(["TH"], reg), reg, NOW)).toBe(false);
    expect(d.fetch).toHaveBeenCalledTimes(1);
    expect(reg.verdicts[urlKey(url)].ok).toBe(false);
    wall = false;
    const nextDay = new Date(Date.parse(NOW) + 1.5 * 86_400_000).toISOString();
    expect(await verifyDonationPage(url, d, ctxFor(["TH"], reg), reg, nextDay)).toBe(true);
    expect(d.fetch).toHaveBeenCalledTimes(2);
  });

  it("does not cache failures caused by the allowlist, or network failures", async () => {
    const reg = registry();
    const d = deps({ [url]: () => redirect("https://donate.redcrossredcrescent.org/th/default/") });
    // For a Japanese disaster the Thai platform path is off the list; for a Thai one it would not be.
    const jpWithThaiSite: DonationContext = { ...ctxFor(["JP"], reg), societyHosts: ["redcross.or.th"] };
    expect(await verifyDonationPage(url, d, jpWithThaiSite, reg, NOW)).toBe(false);
    expect(reg.verdicts).toEqual({});
    expect(await verifyDonationPage("https://redcross.or.th/other", deps({}), ctxFor(["TH"], reg), reg, NOW)).toBe(false);
    expect(reg.verdicts).toEqual({});
  });

  it("re-checks a cached chain against this disaster's allowlist", async () => {
    const reg = registry({ verdicts: { [urlKey(url)]: verdict([url, "https://donate.redcrossredcrescent.org/th/default/"]) } });
    reg.societies.TH = { ...reg.societies.TH, donate: platformUrl("TH") };
    const d = deps({});
    expect(await verifyDonationPage(url, d, ctxFor(["TH"], reg), reg, NOW)).toBe(true);
    expect(await verifyDonationPage(url, d, { ...ctxFor(["JP"], reg), societyHosts: ["redcross.or.th"] }, reg, NOW)).toBe(false);
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("rejects a URL off the allowlist without fetching", async () => {
    const reg = registry();
    const d = deps({});
    expect(await verifyDonationPage("https://redcross.or.th.evil.com/", d, ctxFor(["TH"], reg), reg, NOW)).toBe(false);
    expect(d.fetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Building the links
// ---------------------------------------------------------------------------

describe("small helpers", () => {
  it("cleanText strips control and direction characters and cuts long text", () => {
    expect(cleanText("  Philippine\u202e Red\nCross\u0000 ", 80)).toBe("Philippine Red Cross");
    expect(cleanText("x".repeat(300), 10)).toBe(`${"x".repeat(9)}…`);
    expect(cleanText(42, 10)).toBe("");
  });

  it("societyLabel adds a single 'the'", () => {
    expect(societyLabel("Philippine Red Cross")).toBe("the Philippine Red Cross");
    expect(societyLabel("The Netherlands Red Cross")).toBe("the Netherlands Red Cross");
  });

  it("researchKind trusts a kind only when the host backs it up", () => {
    expect(researchKind("government", "government")).toBe("government");
    expect(researchKind("government", "society")).toBe("society");
    expect(researchKind("government", "un")).toBe("un");
    expect(researchKind("society", "platform")).toBe("society");
    expect(researchKind("society", "government")).toBe("government");
    expect(researchKind("un", "agency")).toBe("agency");
    expect(researchKind("UN", "un")).toBe("un");
    expect(researchKind("agency", "government")).toBe("agency");
    expect(researchKind("appeal", "society")).toBe("appeal");
    expect(researchKind("charity", "society")).toBe("society");
  });

  it("pickAppeal prefers an Emergency Appeal, then the largest, and skips bad codes", () => {
    const dref = appeal({ code: "MDRPH060", kind: "DREF", requested: 900_000 });
    const ea = appeal({ code: "MDRPH061", kind: "Emergency Appeal", requested: 100_000 });
    expect(pickAppeal([dref, ea])?.code).toBe("MDRPH061");
    expect(pickAppeal([dref, appeal({ code: "MDRPH059", requested: 1_000_000 })])?.code).toBe("MDRPH059");
    expect(pickAppeal([appeal({ code: "bad code!" })])).toBeNull();
    expect(pickAppeal([])).toBeNull();
  });
});

describe("buildDonations", () => {
  const input = (over: Partial<DonationInput>): DonationInput => ({ countries: [], appeals: [], researched: [], ...over });

  it("orders a Sudan flood: platform, UN Crisis Relief, research, appeal, IFRC", () => {
    const research = "https://srcs.sd/donate";
    const reg = registry({ verdicts: { [urlKey(research)]: verdict([research]) } });
    const links = buildDonations(
      input({
        countries: ["SD"],
        appeals: [appeal({ code: "MDRSD040", name: "Sudan - Floods", kind: "Emergency Appeal" })],
        researched: [{ url: research, org: "Sudanese Red Crescent", kind: "society", note: "Flood appeal page" }],
      }),
      reg,
      NOW,
      GOV,
    );
    expect(links).toEqual([
      { label: "Donate to the Sudanese Red Crescent", url: "https://donate.redcrossredcrescent.org/sd/default/", org: "Sudanese Red Crescent", kind: "society", note: "On the Red Cross Red Crescent donation platform run by IFRC", via: "registry" },
      { label: "Donate to UN Crisis Relief for Sudan", url: "https://crisisrelief.un.org/donate-sudan-crisis", org: "UN Crisis Relief", kind: "un", note: "The UN's own donation page for Sudan", via: "registry" },
      { label: "Donate to the Sudanese Red Crescent", url: research, org: "Sudanese Red Crescent", kind: "society", note: "Flood appeal page", via: "research" },
      { label: "IFRC appeal: Sudan - Floods", url: `${IFRC_APPEAL_PAGE}MDRSD040`, org: "IFRC", kind: "appeal", note: "The plan and updates for appeal MDRSD040 on ifrc.org; IFRC's donation page lets you give to it", via: "registry" },
      { label: "Donate to the IFRC", url: IFRC_DONATE, org: "IFRC", kind: "agency", note: "Give to IFRC's global work or choose a specific emergency", via: "registry" },
    ]);
  });

  it("orders a Philippine typhoon: research, the society's own site, appeal, then both fallbacks", () => {
    const gov = "https://www.dswd.gov.ph/donate";
    const site = "https://www.redcross.org.ph/";
    const reg = registry({ verdicts: { [urlKey(gov)]: verdict([gov]), [urlKey(site)]: verdict([site, "https://redcross.org.ph/"]) } });
    const links = buildDonations(input({ countries: ["PH"], appeals: [appeal()], researched: [{ url: gov, org: "DSWD", kind: "government", note: "" }] }), reg, NOW, GOV);
    expect(links.map((l) => [l.kind, l.via, l.url])).toEqual([
      ["government", "research", gov],
      // IFRC lists http://www.redcross.org.ph/; the link and its check use https.
      ["society", "registry", site],
      ["appeal", "registry", `${IFRC_APPEAL_PAGE}MDRPH060`],
      ["un", "registry", "https://crisisrelief.un.org/donate-global-emergency-fund"],
      ["agency", "registry", IFRC_DONATE],
    ]);
    expect(links[0].note).toBe("Found by web research and checked against official sites");
    expect(links[1].label).toBe("Give to the Philippine Red Cross");
  });

  it("shows the society's own site only after a fresh passing live check", () => {
    const site = "https://www.redcross.org.ph/";
    const urls = (reg: DonationRegistry) => buildDonations(input({ countries: ["PH"] }), reg, NOW, GOV).map((l) => l.url);
    expect(urls(registry())).toEqual(["https://crisisrelief.un.org/donate-global-emergency-fund", IFRC_DONATE]);
    expect(urls(registry({ verdicts: { [urlKey(site)]: verdict([site], false) } }))).not.toContain(site);
    expect(urls(registry({ verdicts: { [urlKey(site)]: verdict([site], true, daysBefore(8)) } }))).not.toContain(site);
    expect(urls(registry({ verdicts: { [urlKey(site)]: verdict([site]) } }))[0]).toBe(site);
    expect(urls(registry({ verdicts: { [urlKey(site)]: verdict([site]) } }))).not.toContain("http://www.redcross.org.ph/");
  });

  it("never shows a society site over plain http, or one IFRC lists without a scheme it can upgrade", () => {
    expect(societySiteUrl(society({ name: "x", url: "http://www.redcross.org.ph/" }))).toBe("https://www.redcross.org.ph/");
    expect(societySiteUrl(society({ name: "x", url: "https://redcross.org.ph/en" }))).toBe("https://redcross.org.ph/en");
    expect(societySiteUrl(society({ name: "x", url: null }))).toBeNull();
    expect(societySiteUrl(society({ name: "x", url: "ftp://redcross.org.ph/" }))).toBeNull();
    expect(societySiteUrl(society({ name: "x", url: "nonsense" }))).toBeNull();
  });

  it("keeps researched pages only with a fresh passing verdict and an allowed URL", () => {
    const ok = "https://redcross.org.ph/ok";
    const failed = "https://redcross.org.ph/failed";
    const stale = "https://redcross.org.ph/stale";
    const unchecked = "https://redcross.org.ph/unchecked";
    const evil = "https://redcross.org.ph.evil.com/donate";
    const reg = registry({
      verdicts: {
        [urlKey(ok)]: verdict([ok]),
        [urlKey(failed)]: verdict([failed], false),
        [urlKey(stale)]: verdict([stale], true, daysBefore(8)),
        [urlKey(evil)]: verdict([evil]),
      },
    });
    const researched = [ok, failed, stale, unchecked, evil].map((url) => ({ url, org: "PRC", kind: "society", note: "" }));
    const links = buildDonations(input({ countries: ["PH"], researched }), reg, NOW, GOV);
    expect(links.filter((l) => l.via === "research").map((l) => l.url)).toEqual([ok]);
  });

  it("groups a researched page with no kind of its own by its host", () => {
    const society = "https://www.redcross.org.ph/donate";
    const gov = "https://www.dswd.gov.ph/donate";
    const reg = registry({ verdicts: { [urlKey(society)]: verdict([society]), [urlKey(gov)]: verdict([gov]) } });
    const researched = [society, gov].map((url) => ({ url, org: "x", kind: "" as const, note: "" }));
    const links = researchedLinks(input({ countries: ["PH"], researched }), ctxFor(["PH"], reg), reg, NOW);
    expect(links.map(({ link }) => [link.url, link.kind])).toEqual([
      [society, "society"],
      [gov, "government"],
    ]);
  });

  it("drops a researched page whose cached redirect chain leaves this disaster's allowlist", () => {
    const url = "https://redcross.org.ph/go";
    const reg = registry({ verdicts: { [urlKey(url)]: verdict([url, "https://donate.redcrossredcrescent.org/jp/default/"]) } });
    expect(passingVerdict(url, ctxFor(["PH"], reg), reg, NOW)).toBeNull();
    expect(researchedLinks(input({ countries: ["PH"], researched: [{ url, org: "x", kind: "society", note: "" }] }), ctxFor(["PH"], reg), reg, NOW)).toEqual([]);
  });

  it("deduplicates by URL, across spellings and redirect chains", () => {
    const viaChain = "https://srcs.sd/give";
    const reg = registry({
      verdicts: {
        [urlKey("https://crisisrelief.un.org/en/donate-sudan-crisis")]: verdict(["https://crisisrelief.un.org/en/donate-sudan-crisis"]),
        [urlKey(viaChain)]: verdict([viaChain, "https://donate.redcrossredcrescent.org/sd/default/"]),
      },
    });
    const links = buildDonations(
      input({
        countries: ["SD"],
        researched: [
          { url: "https://crisisrelief.un.org/en/donate-sudan-crisis", org: "UN", kind: "un", note: "" },
          { url: viaChain, org: "SRCS", kind: "society", note: "" },
          { url: viaChain, org: "SRCS", kind: "society", note: "" },
        ],
      }),
      reg,
      NOW,
      GOV,
    );
    expect(links.map((l) => l.url)).toEqual(["https://donate.redcrossredcrescent.org/sd/default/", "https://crisisrelief.un.org/donate-sudan-crisis", IFRC_DONATE]);
    expect(new Set(links.map((l) => urlKey(l.url))).size).toBe(links.length);
  });

  it("caps the list at six links and three researched pages", () => {
    const urls = [1, 2, 3, 4, 5].map((n) => `https://srcs.sd/p${n}`);
    const reg = registry({ verdicts: Object.fromEntries(urls.map((u) => [urlKey(u), verdict([u])])) });
    const links = buildDonations(input({ countries: ["SD"], appeals: [appeal()], researched: urls.map((url) => ({ url, org: "SRCS", kind: "society", note: "" })) }), reg, NOW, GOV);
    expect(links).toHaveLength(MAX_LINKS);
    expect(links.filter((l) => l.via === "research")).toHaveLength(3);
  });

  it("always gives at least two links, even at sea or for a country with no society", () => {
    for (const countries of [[], ["TW"], ["AQ"]]) {
      const links = buildDonations(input({ countries }), registry(), NOW, GOV);
      expect(links.map((l) => l.url)).toEqual(["https://crisisrelief.un.org/donate-global-emergency-fund", IFRC_DONATE]);
    }
    const bare = buildDonations(input({ countries: [] }), emptyRegistry(), NOW, GOV);
    expect(bare.map((l) => l.url)).toEqual([UNCR_HOME, IFRC_DONATE]);
  });

  it("uses a territory's parent society", () => {
    const site = "https://www.redcross.org/";
    const links = buildDonations(input({ countries: ["PR"] }), registry({ verdicts: { [urlKey(site)]: verdict([site]) } }), NOW, GOV);
    expect(links[0]).toMatchObject({ label: "Give to the American Red Cross", url: site, kind: "society" });
    const onPlatform = registry();
    onPlatform.societies.US = { ...onPlatform.societies.US, donate: platformUrl("US") };
    expect(buildDonations(input({ countries: ["PR"] }), onPlatform, NOW, GOV)[0]).toMatchObject({ label: "Donate to the American Red Cross", url: platformUrl("US") });
  });

  it("uses the first country with a UN Crisis Relief page, and only the first country's society", () => {
    const links = buildDonations(input({ countries: ["TD", "CF"] }), registry(), NOW, GOV);
    expect(links[0]).toMatchObject({ label: "Donate to UN Crisis Relief for the Central African Republic", kind: "un" });
    const jpFirst = buildDonations(input({ countries: ["JP", "SD"] }), registry(), NOW, GOV);
    expect(jpFirst.map((l) => l.url)).toEqual([platformUrl("JP"), "https://crisisrelief.un.org/donate-sudan-crisis", IFRC_DONATE]);
  });

  it("names known organisations from the registry, not from the model", () => {
    const society = "https://redcross.org.ph/typhoon";
    const unicef = "https://www.unicef.org/emergencies/philippines";
    const uncr = "https://crisisrelief.un.org/hurricane-melissa";
    const reg = registry({ verdicts: Object.fromEntries([society, unicef, uncr].map((u) => [urlKey(u), verdict([u])])) });
    const links = buildDonations(
      input({
        countries: ["PH"],
        researched: [
          { url: society, org: "Totally Real Relief Fund", kind: "government", note: "n".repeat(500) },
          { url: unicef, org: "Someone else", kind: "agency", note: "" },
          { url: uncr, org: "UN", kind: "un", note: "" },
        ],
      }),
      reg,
      NOW,
      GOV,
    );
    expect(links[0]).toMatchObject({ label: "Donate to the Philippine Red Cross", org: "Philippine Red Cross", kind: "society", via: "research" });
    expect(links[0].note.length).toBeLessThanOrEqual(200);
    expect(links[1]).toMatchObject({ label: "Donate to UNICEF", org: "UNICEF", kind: "agency" });
    expect(links[2]).toMatchObject({ label: "Donate to UN Crisis Relief", org: "UN Crisis Relief", kind: "un" });
  });

  it("cleans the model's name for a government page, falling back to the host", () => {
    const url = "https://www.dswd.gov.ph/donate";
    const reg = registry({ verdicts: { [urlKey(url)]: verdict([url]) } });
    const [link] = buildDonations(input({ countries: ["PH"], researched: [{ url, org: "DSWD‮\n", kind: "government", note: "" }] }), reg, NOW, GOV);
    expect(link).toMatchObject({ label: "Donate to DSWD", org: "DSWD", kind: "government" });
    const [unnamed] = buildDonations(input({ countries: ["PH"], researched: [{ url, org: "", kind: "government", note: "" }] }), reg, NOW, GOV);
    expect(unnamed.label).toBe("Donate to dswd.gov.ph");
  });

  it("knownOrg names platform pages by country, a territory's by its parent", () => {
    const reg = registry();
    expect(knownOrg(new URL("https://donate.redcrossredcrescent.org/sd/default/"), "platform", ["SD"], reg)).toBe("Sudanese Red Crescent");
    expect(knownOrg(new URL("https://donate.redcrossredcrescent.org/us/default/"), "platform", ["PR"], reg)).toBe("American Red Cross");
    expect(knownOrg(new URL("https://www.dswd.gov.ph/"), "government", ["PH"], reg)).toBeNull();
    expect(knownOrg(new URL("https://news.un.org/"), "un", ["PH"], reg)).toBe("United Nations");
  });

  it("gives every link a label, a note and an https or registry URL", () => {
    const links = buildDonations(input({ countries: ["SD"], appeals: [appeal({ code: "MDRSD040" })] }), registry(), NOW, GOV);
    for (const l of links) {
      expect(l.label.length).toBeGreaterThan(0);
      expect(l.note.length).toBeGreaterThan(0);
      expect(l.url).toMatch(/^https:\/\//);
      expect(l.via).toBe("registry");
    }
  });
});

describe("prepareDonations", () => {
  it("live-checks researched pages, skipping rejected and cached ones, then builds the list", async () => {
    const good = "https://redcross.or.th/donate/";
    const cached = "https://redcross.or.th/cached";
    const site = "https://www.redcross.or.th/";
    const reg = registry({ verdicts: { [urlKey(cached)]: verdict([cached]), [urlKey(site)]: verdict([site]) } });
    const d = deps({ [good]: () => page("trcs-th") });
    const links = await prepareDonations(
      {
        countries: ["TH"],
        appeals: [],
        researched: [
          { url: "https://redcross.or.th.evil.com/donate", org: "Fake", kind: "society", note: "" },
          { url: cached, org: "Thai Red Cross", kind: "society", note: "" },
          { url: good, org: "Thai Red Cross", kind: "society", note: "" },
        ],
      },
      reg,
      d,
      NOW,
      { pauseMs: 0, governmentDomains: GOV },
    );
    expect(d.fetch.mock.calls.map((c) => String(c[0]))).toEqual([good]);
    expect(links.filter((l) => l.via === "research").map((l) => l.url)).toEqual([cached, good]);
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining("rejected (host not on the allowlist)"));
  });

  it("stops after maxChecks live checks of researched pages; the society site's check is extra", async () => {
    const urls = [1, 2, 3].map((n) => `https://redcross.or.th/p${n}`);
    const d = deps(() => page("trcs-th"));
    const reg = registry();
    await prepareDonations({ countries: ["TH"], appeals: [], researched: urls.map((url) => ({ url, org: "TRCS", kind: "society", note: "" })) }, reg, d, NOW, { maxChecks: 2, pauseMs: 0, governmentDomains: GOV });
    expect(d.fetch.mock.calls.map((c) => String(c[0]))).toEqual(["https://www.redcross.or.th/", urls[0], urls[1]]);
  });

  it("tries an unreachable society site once per run when the caller shares the unreachable set", async () => {
    const reg = registry();
    const d = deps(() => Promise.reject(new Error("fetch failed")) as never);
    const unreachable = new Set<string>();
    const input = { countries: ["TH"], appeals: [], researched: [] };
    await prepareDonations(input, reg, d, NOW, { pauseMs: 0, governmentDomains: GOV, unreachable });
    const first = d.fetch.mock.calls.length;
    await prepareDonations(input, reg, d, NOW, { pauseMs: 0, governmentDomains: GOV, unreachable });
    expect(first).toBeGreaterThan(0);
    expect(d.fetch.mock.calls.length).toBe(first);
    expect(unreachable.has(urlKey("https://www.redcross.or.th/"))).toBe(true);
  });

  it("checks the society's own site over https once, then shows it", async () => {
    const site = "https://www.redcross.or.th/";
    const reg = registry();
    const d = deps({ [site]: () => redirect("https://redcross.or.th/", 301), "https://redcross.or.th/": () => page("trcs-th") });
    const links = await prepareDonations({ countries: ["TH"], appeals: [], researched: [] }, reg, d, NOW, { pauseMs: 0, governmentDomains: GOV });
    expect(links[0]).toMatchObject({ label: "Give to the Thai Red Cross Society", url: site, kind: "society", via: "registry" });
    expect(reg.verdicts[urlKey(site)]).toMatchObject({ ok: true, chain: [site, "https://redcross.or.th/"] });
    // A second disaster in Thailand reuses the verdict.
    await prepareDonations({ countries: ["TH"], appeals: [], researched: [] }, reg, d, NOW, { pauseMs: 0, governmentDomains: GOV });
    expect(d.fetch).toHaveBeenCalledTimes(2);
    // Never for a society on the platform: its platform page is the link.
    const sd = deps({});
    await prepareDonations({ countries: ["SD"], appeals: [], researched: [] }, registry(), sd, NOW, { pauseMs: 0, governmentDomains: GOV });
    expect(sd.fetch).not.toHaveBeenCalled();
  });

  it("never links a society domain that now redirects to a betting site (Bolivia, seen live)", async () => {
    const reg = registry();
    reg.societies.BO = society({ name: "Bolivian Red Cross", country: "Bolivia", url: "http://www.cruzrojaboliviana.org/", hosts: ["cruzrojaboliviana.org"], checked: NOW });
    const routes = Object.fromEntries(LIVE.hijacked.redirects.map((r) => [r.url, () => redirect(r.location, r.status)]));
    const d = deps({ ...routes, "https://ufalove.art/": () => html("<p>Donate</p>") });
    const links = await prepareDonations({ countries: ["BO"], appeals: [], researched: [] }, reg, d, NOW, { pauseMs: 0, governmentDomains: GOV });
    expect(links.map((l) => l.url)).toEqual(["https://crisisrelief.un.org/donate-global-emergency-fund", IFRC_DONATE]);
    expect(d.fetch.mock.calls.map((c) => String(c[0]))).toEqual(["https://www.cruzrojaboliviana.org/", "https://cruzrojaboliviana.org/"]);
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining("redirect leaves the allowlist"));
    expect(buildDonations({ countries: ["BO"], appeals: [], researched: [] }, reg, NOW, GOV).some((l) => /cruzrojaboliviana|ufalove/.test(l.url))).toBe(false);
  });

  it("links a registry society homepage that blocks scripts with 403, but not a blocked researched page or a 403 after leaving the host", async () => {
    const reg = registry();
    reg.societies.US = society({ name: "American Red Cross", country: "United States", url: "https://www.redcross.org/", hosts: ["redcross.org"], checked: NOW });
    const d = deps({ "https://www.redcross.org/": () => html("Forbidden", 403), "https://www.redcross.org/donate/fire": () => html("Forbidden", 403) });
    const researched = [{ url: "https://www.redcross.org/donate/fire", org: "American Red Cross", kind: "society", note: "Fire appeal" }];
    const links = await prepareDonations({ countries: ["US"], appeals: [], researched }, reg, d, NOW, { pauseMs: 0, governmentDomains: GOV });
    expect(reg.verdicts[urlKey("https://www.redcross.org/")]).toMatchObject({ ok: false, blocked: true });
    expect(links.map((l) => l.url)).toContain("https://www.redcross.org/");
    expect(links.map((l) => l.url)).not.toContain("https://www.redcross.org/donate/fire");
    // The blocked flag survives a round trip through the cache file.
    expect(normaliseRegistry(JSON.parse(JSON.stringify(reg))).verdicts[urlKey("https://www.redcross.org/")].blocked).toBe(true);
  });

  it("never links a society domain that now serves a lottery page (Saint Lucia, seen live)", async () => {
    const lc = LIVE.hijacked.pages[0];
    const reg = registry();
    reg.societies.LC = society({ name: "Saint Lucia Red Cross", country: "Saint Lucia", url: lc.url, hosts: ["saintluciaredcross.org"], checked: NOW });
    const d = deps({ [lc.url]: () => html(lc.html, 200, lc.contentType) });
    const links = await prepareDonations({ countries: ["LC"], appeals: [], researched: [] }, reg, d, NOW, { pauseMs: 0, governmentDomains: GOV });
    expect(links.some((l) => l.url.includes("saintluciaredcross"))).toBe(false);
    expect(reg.verdicts[urlKey(lc.url)]).toMatchObject({ ok: false, reason: "no donation word on the page" });
  });
});
