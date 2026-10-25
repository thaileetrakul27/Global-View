// Direct giving for each disaster: pages that take money straight to the
// people, schools and groups it hit, listed before the official links of
// donate.ts. Three sources, each held to its own fixed rules; a model only
// ever suggests pages, never picks one:
//
//   GoFundMe      GoFundMe's crisis pages (https://www.gofundme.com/c/act/
//                 <slug>), read by fixed rule without a model. From the page
//                 that belongs to a disaster (hubMatches): the page itself,
//                 the fund its Donate button leads to and the fundraisers
//                 its Trust & Safety team verified, schools and families
//                 first (kind "fundraiser"); and up to two of the nonprofits
//                 it lists as partners, with their pages for the event (kind
//                 "project"). Pages come from GoFundMe's index of current
//                 crises and from any crisis page a disaster's research
//                 found. Cached in cache/gofundme.json, read again at most
//                 every 12 hours, a handful of requests a run.
//   GlobalGiving  a project or fund on www.globalgiving.org that the direct
//                 search (research.ts) returned, kept only when its slug or
//                 title names the disaster's place and its hazard, storm name
//                 or a recent year, and no other country or an older year
//                 (globalGivingProblem). GlobalGiving vets its local partners.
//                 It refuses many scripted clients, so there is no live check.
//   local         a local organisation's, school's or community group's own
//                 donation page the direct search returned, kept only when
//                 its URL is on no shared, social, marketplace, news,
//                 crowdfunding or official site (localUrlProblem) and a live
//                 check passes: 200 HTML on the same site, a donation word and
//                 a name of the disaster's place (verifyLocalPage). Verdicts
//                 are cached with donate.ts's, per disaster.
//
// The integrator refreshes the GoFundMe cache once per run
// (refreshGoFundMe), checks local pages (prepareDirectLinks) and passes the
// links to donate.ts buildDonations, which orders and caps them.
//
// Live findings (2026-10-25) behind these rules:
//   - www.gofundme.com/c/act links the current crisis pages
//     (venezuela-earthquake-relief, wildfire-relief, public-officials);
//     older ones stay online off the index (hurricane-melissa). robots.txt
//     allows /c/act and /f/ pages, and gateway.gofundme.com allows all;
//   - a crisis page's static HTML holds its verified fundraisers as slugs in
//     the grid's data-slugs attribute (97 on Hurricane Melissa's), and its
//     own script reads their names with a plain public GET of
//     gateway.gofundme.com/web-gateway/v1/feed/campaigns?slugs=..., twelve
//     at a time. That is the one request made here for them;
//   - its partners are the block-carousels-v2__slide links: a partner's own
//     campaign page for the event (globalempowermentmission.org/mission/
//     hurricane-melissa/), a charity fundraiser on GoFundMe, or GoFundMe's
//     general profile of the charity (/charity/<slug>), which is no page for
//     the event and is left out;
//   - the Venezuela page's Donate button leads to a charity fundraiser for
//     the event (/f/emergency-relief-for-venezuela-earthquake-victims);
//     Hurricane Melissa's has none;
//   - www.globalgiving.org answered curl with a GlobalView user agent 403
//     and Node's fetch 200, so a live check there would be unreliable.
import fs from "node:fs";
import type { ResearchResult } from "../ai";
import type { FetchDeps } from "../googlenews";
import { USER_AGENT } from "../googlenews";
import { writeJson } from "../io";
import {
  MAX_REDIRECTS,
  NOT_EVENT_WORDS,
  SHARED_HOSTS,
  SHORTENERS,
  asciiWords,
  cleanText,
  compileTerm,
  countriesNamedIn,
  decodeEntities,
  donationWordsIn,
  foldText,
  hostClass,
  hostMatches,
  isBloodDonationPath,
  isGeneralPage,
  isListingPage,
  isPlainHostname,
  isRegistrySuffix,
  pageText,
  urlKey,
  verdictFresh,
  type DonationContext,
  type DonationRegistry,
  type PageCheck,
} from "./donate";
import type { DirectPage, ResearchEntry } from "./research";
import type { Disaster, DisasterType, DonationLink } from "./types";

export const GOFUNDME_HOST = "www.gofundme.com";
export const GOFUNDME_INDEX = "https://www.gofundme.com/c/act";
export const GOFUNDME_FEED = "https://gateway.gofundme.com/web-gateway/v1/feed/campaigns";
export const GOFUNDME_CACHE_PATH = "cache/gofundme.json";
/** The index and a crisis page that matches a disaster are read again after this many hours. */
export const GOFUNDME_REFRESH_HOURS = 12;
/** A crisis page that matches no current disaster is read again only after this many days. */
export const UNMATCHED_RECHECK_DAYS = 7;
/** A crisis page neither on the index nor found by research for this many days is forgotten. */
export const HUB_KEEP_DAYS = 30;
/** Most requests to GoFundMe in one run. */
export const GOFUNDME_MAX_REQUESTS = 8;
/** Pause between two requests to GoFundMe (at least a second). */
export const GOFUNDME_PAUSE_MS = 1_500;
/** Fundraisers asked about in one feed request, as the crisis page's own script asks. */
export const FEED_BATCH = 12;
/** Crisis page URLs kept from one research. */
export const MAX_FOUND_HUBS = 5;
/** Live checks of local groups' pages per disaster per run; the rest use cached verdicts. */
export const MAX_LOCAL_CHECKS = 3;
/** The note on GoFundMe's crisis page and its verified fundraisers. */
export const VERIFIED_NOTE = "Verified by GoFundMe's Trust & Safety team";
/** The note on a GlobalGiving project. */
export const GLOBALGIVING_NOTE = "GlobalGiving vets its local partners";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const TIMEOUT_MS = 20_000;
/** Pages longer than this are cut before they are read. */
const MAX_PAGE_CHARS = 2_000_000;
/** Most verified fundraiser slugs kept per crisis page (schools and families first; Hurricane Melissa's lists 878), and most partners. */
export const MAX_SLUGS = 48;
const MAX_PARTNERS = 30;
/** A crisis page's slug: lower-case words joined by hyphens. */
const HUB_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A fundraiser's slug as GoFundMe writes them: some in upper case, some UUIDs. */
const FUNDRAISER_SLUG = /^[A-Za-z0-9][A-Za-z0-9-]{0,199}$/;

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** Words that say a fundraiser or partner works for schools, then for homes and families; folded. */
const SCHOOL_WORDS = /\b(?:schools?|classrooms?|students?|teachers?|pupils|escuelas?|colegios?|liceos?|ecoles?|scuolas?|schulen?)\b/;
const HOME_WORDS =
  /\b(?:famil(?:y|ies)|homes?|houses?|housing|roofs?|shelters?|households?|rebuild(?:ing)?|communit(?:y|ies)|familias?|hogar(?:es)?|casas?|viviendas?|familles?|maisons?)\b/;

/** What a fundraiser or partner works on, from its own words: schools, homes and families, or other. */
export type Focus = "schools" | "homes" | "other";

/** The focus of a text, schools before homes: "Rebuild Eber Prep School" -> "schools". */
export function focusOf(text: string): Focus {
  const t = foldText(text).replace(/[-_]+/g, " ");
  return SCHOOL_WORDS.test(t) ? "schools" : HOME_WORDS.test(t) ? "homes" : "other";
}

const FOCUS_RANK: Record<Focus, number> = { schools: 0, homes: 1, other: 2 };

/** Hazard words in crisis page and project slugs and titles, with the disaster types each can name. */
const HAZARD_WORDS: readonly (readonly [string, readonly DisasterType[]])[] = [
  ["earthquake earthquakes quake quakes seismic terremoto terremotos sismo sismos seisme deprem gempa", ["earthquake", "tsunami", "landslide"]],
  ["tsunami tsunamis", ["tsunami", "earthquake"]],
  ["hurricane hurricanes typhoon typhoons cyclone cyclones huracan huracanes tifon ouragan", ["cyclone", "storm", "flood", "landslide"]],
  ["storm storms tornado tornadoes tornados windstorm hailstorm", ["storm", "cyclone", "flood"]],
  ["flood floods flooding floodwaters inundacion inundaciones inondation inondations monsoon", ["flood", "landslide", "cyclone", "storm"]],
  ["landslide landslides mudslide mudslides", ["landslide", "flood", "earthquake"]],
  ["wildfire wildfires fire fires bushfire bushfires incendio incendios", ["wildfire"]],
  ["volcano volcanoes volcanic eruption eruptions", ["volcano"]],
  ["drought droughts famine", ["drought"]],
  ["heatwave heatwaves heat", ["heatwave", "drought"]],
  ["coldwave cold winter blizzard", ["coldwave", "storm"]],
  ["sandstorm duststorm dust", ["dust"]],
];
const HAZARD_TYPES: ReadonlyMap<string, ReadonlySet<DisasterType>> = (() => {
  const map = new Map<string, Set<DisasterType>>();
  for (const [words, types] of HAZARD_WORDS) for (const w of words.split(" ")) map.set(w, new Set([...(map.get(w) ?? []), ...types]));
  return map;
})();

/** Whether words name a hazard, and whether it can be this type: "none", "fits" or "other". */
export function hazardFit(words: readonly string[], type: DisasterType): "none" | "fits" | "other" {
  const named = words.map((w) => HAZARD_TYPES.get(w)).filter((t): t is ReadonlySet<DisasterType> => t !== undefined);
  if (named.length === 0) return "none";
  return named.some((t) => t.has(type)) ? "fits" : "other";
}

/** Words of crisis page titles that name nothing: "How you can help: Venezuela earthquakes". */
const HUB_FILLER = new Set("how you can help those impacted affected donate verified fundraiser fundraisers gofundme official ways way give giving page".split(" "));

/** Folded words and numbers of a slug or title: "Hurricane-Melissa-2025" -> ["hurricane", "melissa", "2025"]. */
export function slugWords(text: string): string[] {
  return foldText(text).split(/[^a-z0-9]+/).filter(Boolean);
}

/** What a run of words says about a disaster (see hubMatches and globalGivingProblem). */
interface Reading {
  /** It names a country that is not one of the disaster's. */
  foreign: boolean;
  /** It names one of the disaster's countries (and no other). */
  country: boolean;
  /** It names no country and its place words are all place words of the disaster's title. */
  onlyTitlePlaces: boolean;
  /** It has a place word of the disaster's title. */
  titlePlace: boolean;
}

function readWords(words: readonly string[], countries: readonly string[], ctx: Pick<DonationContext, "countryNameIndex" | "eventWords">): Reading {
  const own = new Set(countries.map((c) => c.toUpperCase()));
  const named = ctx.countryNameIndex ? countriesNamedIn([...words], ctx.countryNameIndex) : [];
  const foreign = named.some((codes) => !codes.some((c) => own.has(c)));
  const title = new Set(ctx.eventWords ?? []);
  const places = words.filter((w) => /^[a-z]{3,}$/.test(w) && !NOT_EVENT_WORDS.has(w) && !HUB_FILLER.has(w));
  return {
    foreign,
    country: named.length > 0 && !foreign,
    onlyTitlePlaces: named.length === 0 && places.length > 0 && places.every((w) => title.has(w)),
    titlePlace: words.some((w) => title.has(w)),
  };
}

// ---------------------------------------------------------------------------
// GoFundMe: URLs
// ---------------------------------------------------------------------------

/** True for www.gofundme.com or gofundme.com over https, without credentials or port. */
function onGoFundMe(url: URL): boolean {
  return url.protocol === "https:" && (url.hostname === GOFUNDME_HOST || url.hostname === "gofundme.com") && !url.username && !url.password && !url.port;
}

/** The slug of a crisis page URL ("https://www.gofundme.com/c/act/hurricane-melissa" -> "hurricane-melissa"); null for anything else, a page in another language among them. */
export function hubSlugOf(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim(), `https://${GOFUNDME_HOST}`);
  } catch {
    return null;
  }
  if (!onGoFundMe(url)) return null;
  const m = /^\/c\/act\/([a-z0-9-]{1,120})\/?$/.exec(url.pathname);
  return m && HUB_SLUG.test(m[1]) ? m[1] : null;
}

/** A crisis page's URL. */
export function hubUrl(slug: string): string {
  return `https://${GOFUNDME_HOST}/c/act/${slug}`;
}

/** The slug of a fundraiser URL ("https://www.gofundme.com/f/<slug>?attribution_id=..."); null for anything else. */
export function fundraiserSlugOf(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim(), `https://${GOFUNDME_HOST}`);
  } catch {
    return null;
  }
  if (!onGoFundMe(url)) return null;
  const m = /^\/f\/([^/]+)\/?$/.exec(url.pathname);
  return m && FUNDRAISER_SLUG.test(m[1]) ? m[1] : null;
}

/** A fundraiser's URL. */
export function fundraiserUrl(slug: string): string {
  return `https://${GOFUNDME_HOST}/f/${slug}`;
}

/** The crisis pages among the URLs a search returned or cited, each once, at most MAX_FOUND_HUBS. */
export function hubUrlsIn(research: Pick<ResearchResult, "citations" | "results">): string[] {
  const out: string[] = [];
  for (const s of [...(research.citations ?? []), ...(research.results ?? [])]) {
    const slug = typeof s?.url === "string" ? hubSlugOf(s.url) : null;
    if (slug && !out.includes(hubUrl(slug)) && out.length < MAX_FOUND_HUBS) out.push(hubUrl(slug));
  }
  return out;
}

// ---------------------------------------------------------------------------
// GoFundMe: reading its pages
// ---------------------------------------------------------------------------

/** Text of an HTML fragment, tags out and entities decoded, on one line. */
function textOf(html: string, max: number): string {
  return cleanText(decodeEntities(html.replace(/<[^>]*>/g, " ")), max);
}

/** The crisis pages GoFundMe's index links, each once, in its order. */
export function parseHubIndex(html: string): string[] {
  const out: string[] = [];
  for (const m of html.slice(0, MAX_PAGE_CHARS).matchAll(/\bhref\s*=\s*"([^"]*)"/gi)) {
    const slug = hubSlugOf(decodeEntities(m[1]));
    if (slug && !out.includes(slug) && out.length < 50) out.push(slug);
  }
  return out;
}

/** A nonprofit a crisis page lists as a partner, with its page for the event. */
export interface GoFundMePartner {
  url: string;
  /** As the page names it: "GEM", "Hope for Haiti". */
  name: string;
  /** What the page says it works on; its words themselves are not kept. */
  focus: Focus;
}

/** What a crisis page says, as parseHub reads it. */
export interface HubPage {
  /** Its heading, e.g. "How to help: Hurricane Melissa relief". */
  title: string;
  /** It says its fundraisers were verified by GoFundMe's Trust & Safety team. */
  verified: boolean;
  /** Slugs of the verified fundraisers it lists, those that name schools first, then homes and families, then the rest, each in its order; at most MAX_SLUGS. */
  slugs: string[];
  /** How many verified fundraisers it lists. */
  listed: number;
  /** The fundraiser its Donate button leads to, when it has one. */
  fund: string | null;
  partners: GoFundMePartner[];
}

/**
 * A partner's page as the crisis page links it, over https only, with its
 * tracking parameters (_gl, utm_*) removed. Null for a social or shared
 * site, a shortener, a home page, GoFundMe's general charity profiles, or
 * any GoFundMe page that is not a fundraiser (www.gofundme.com/f/...) or a
 * nonprofit's campaign on another GoFundMe host (giving.gofundme.com).
 */
export function partnerUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const host = url.hostname;
  if (url.protocol !== "https:" || url.username || url.password || url.port || !isPlainHostname(host)) return null;
  if (SHORTENERS.some((s) => hostMatches(host, s)) || SHARED_HOSTS.some((s) => hostMatches(host, s)) || SOCIAL_HOSTS.some((s) => hostMatches(host, s))) return null;
  if (host === GOFUNDME_HOST || host === "gofundme.com") {
    const slug = fundraiserSlugOf(url.toString());
    return slug ? fundraiserUrl(slug) : null;
  }
  for (const key of [...url.searchParams.keys()]) if (/^(?:_gl|utm_.*)$/i.test(key)) url.searchParams.delete(key);
  if (isGeneralPage(url.toString(), new Set()) && !url.search && !url.hash) return null;
  return url.toString();
}

/** The partners in a crisis page's carousels: each link's page, the name in bold, and what its text says it works on. */
function parsePartners(html: string): GoFundMePartner[] {
  const out: GoFundMePartner[] = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const [, attrs, inner] = m;
    if (!/\bclass\s*=\s*"(?:[^"]*\s)?block-carousels-v2__slide(?=[\s"])/i.test(attrs)) continue;
    const href = /\bhref\s*=\s*"([^"]*)"/i.exec(attrs)?.[1];
    const url = href ? partnerUrl(decodeEntities(href)) : null;
    if (!url || out.some((p) => p.url === url)) continue;
    const strong = /<strong\b[^>]*>([\s\S]*?)<\/strong>/i.exec(inner)?.[1];
    const alt = /\balt\s*=\s*"([^"]*)"/i.exec(inner)?.[1];
    // "AH&H’s disaster relief team": the name without its possessive; else the logo's alt text without "logo".
    const name = (strong ? textOf(strong, 80) : "").replace(/\s*['’‘]s$/i, "") || textOf(alt ?? "", 80).replace(/\s*\blogo\b.*$/i, "");
    if (!name) continue;
    out.push({ url, name, focus: focusOf(pageText(inner)) });
    if (out.length >= MAX_PARTNERS) break;
  }
  return out;
}

/** Slugs ranked by what they name: schools first, then homes and families, then the rest, each in the given order. */
function bySlugFocus(slugs: readonly string[]): string[] {
  return slugs
    .map((slug, i) => ({ slug, i, rank: FOCUS_RANK[focusOf(slug)] }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.slug);
}

/**
 * Reads a crisis page: its heading (else its title), whether it says its
 * fundraisers are verified by Trust & Safety, the verified fundraisers'
 * slugs from the grid's data-slugs (ranked, see HubPage.slugs), the
 * fundraiser the hero section's Donate button leads to, and its partners.
 */
export function parseHub(raw: string): HubPage {
  const html = raw.slice(0, MAX_PAGE_CHARS);
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1];
  const title = (h1 ? textOf(h1, 160) : "") || textOf(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "", 160).replace(/\s*\|\s*GoFundMe\s*$/i, "");
  const text = pageText(html);
  const verified = /trust\s*(?:&|and)\s*safety/i.test(text) && /\bverified\b/i.test(text);
  const all = new Set<string>();
  for (const m of html.matchAll(/\bdata-slugs\s*=\s*"([^"]*)"/gi)) {
    for (const s of decodeEntities(m[1]).split(",").map((x) => x.trim())) if (FUNDRAISER_SLUG.test(s)) all.add(s);
  }
  const hero = /<section\b[^>]*\bid\s*=\s*"hero"[^>]*>([\s\S]*?)<\/section>/i.exec(html)?.[1] ?? "";
  const fundSlug = [...hero.matchAll(/\bhref\s*=\s*"([^"]*)"/gi)].map((m) => fundraiserSlugOf(decodeEntities(m[1]))).find((s): s is string => s !== null);
  return { title, verified, slugs: bySlugFocus([...all]).slice(0, MAX_SLUGS), listed: all.size, fund: fundSlug ? fundraiserUrl(fundSlug) : null, partners: parsePartners(html) };
}

/** One fundraiser as GoFundMe's feed describes it; only what the links need. */
export interface GoFundMeFundraiser {
  slug: string;
  /** Its title, e.g. "Rebuild Eber Prep School After Hurricane Melissa". */
  name: string;
  /** GoFundMe's category, e.g. "Emergencies" or "Charity". */
  category: string;
  donations: number;
  /** As GoFundMe gives it ("2026-01-27 03:13:54"), or null. */
  lastDonation: string | null;
}

/** The feed's request for these fundraisers, as the crisis page's own script makes it. */
export function feedUrl(slugs: readonly string[]): string {
  return `${GOFUNDME_FEED}?${slugs.map((s) => `slugs=${encodeURIComponent(s)}`).join("&")}`;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The fundraisers in a feed answer ({ data: [...] }); malformed ones are left out. */
export function parseFeed(raw: unknown): GoFundMeFundraiser[] {
  const data = isObject(raw) && Array.isArray(raw.data) ? raw.data : [];
  const out: GoFundMeFundraiser[] = [];
  for (const f of data) {
    if (!isObject(f) || typeof f.url !== "string" || !FUNDRAISER_SLUG.test(f.url)) continue;
    const name = cleanText(f.fund_name, 120);
    if (!name || out.some((x) => x.slug === f.url)) continue;
    const donations = typeof f.donation_count === "number" && Number.isFinite(f.donation_count) && f.donation_count > 0 ? Math.floor(f.donation_count) : 0;
    out.push({ slug: f.url, name, category: cleanText(f.category, 40), donations, lastDonation: typeof f.last_donation_at === "string" ? cleanText(f.last_donation_at, 40) : null });
  }
  return out;
}

/**
 * The fundraisers to ask the feed about for a crisis page: its fund first,
 * then its verified fundraisers whose slug names schools, then homes and
 * families, then the rest in the page's order; at most FEED_BATCH.
 */
export function feedSlugs(hub: Pick<HubPage, "slugs" | "fund">): string[] {
  const fund = hub.fund ? fundraiserSlugOf(hub.fund) : null;
  return [...new Set([...(fund ? [fund] : []), ...bySlugFocus(hub.slugs)])].slice(0, FEED_BATCH);
}

// ---------------------------------------------------------------------------
// GoFundMe: the cache
// ---------------------------------------------------------------------------

/** One crisis page as cached. */
export interface GoFundMeHub extends HubPage {
  slug: string;
  /** Names of the fundraisers last asked about (feedSlugs). */
  fundraisers: GoFundMeFundraiser[];
  /** When the page was last read; null when it is only known by its URL. */
  fetched: string | null;
  /** When the feed was last read for it; null until it has been. */
  feedFetched: string | null;
  /** When it was last on the index or found by research. */
  seen: string;
}

export interface GoFundMeCache {
  /** GoFundMe's index of current crises: when last read, and the pages it listed. */
  index: { fetched: string | null; slugs: string[] };
  hubs: Record<string, GoFundMeHub>;
}

export function emptyGoFundMeCache(): GoFundMeCache {
  return { index: { fetched: null, slugs: [] }, hubs: {} };
}

function time(v: unknown): string | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null;
}

function stringList(v: unknown, ok: (s: string) => boolean): string[] {
  return Array.isArray(v) ? [...new Set(v.filter((s): s is string => typeof s === "string" && ok(s)))] : [];
}

/** Cached fundraisers, checked by the feed's own rules (parseFeed) after renaming their fields back. */
function cachedFundraisers(v: unknown): GoFundMeFundraiser[] {
  const list = Array.isArray(v) ? v.filter(isObject) : [];
  return parseFeed({ data: list.map((f) => ({ url: f.slug, fund_name: f.name, category: f.category, donation_count: f.donations, last_donation_at: f.lastDonation })) });
}

/** A cache read from disk with every field checked, so older or damaged files still load. */
export function normaliseGoFundMeCache(raw: unknown): GoFundMeCache {
  const cache = emptyGoFundMeCache();
  if (!isObject(raw)) return cache;
  if (isObject(raw.index)) cache.index = { fetched: time(raw.index.fetched), slugs: stringList(raw.index.slugs, (s) => HUB_SLUG.test(s)) };
  if (!isObject(raw.hubs)) return cache;
  for (const [slug, h] of Object.entries(raw.hubs)) {
    if (!HUB_SLUG.test(slug) || !isObject(h) || !time(h.seen)) continue;
    const partners = (Array.isArray(h.partners) ? h.partners : [])
      .filter((p): p is GoFundMePartner => isObject(p) && typeof p.url === "string" && partnerUrl(p.url) === p.url && typeof p.name === "string" && p.name !== "")
      .map((p) => ({ url: p.url, name: cleanText(p.name, 80), focus: p.focus === "schools" || p.focus === "homes" ? p.focus : ("other" as const) }));
    cache.hubs[slug] = {
      slug,
      title: typeof h.title === "string" ? cleanText(h.title, 160) : "",
      verified: h.verified === true,
      slugs: stringList(h.slugs, (s) => FUNDRAISER_SLUG.test(s)).slice(0, MAX_SLUGS),
      listed: typeof h.listed === "number" && Number.isFinite(h.listed) && h.listed >= 0 ? Math.floor(h.listed) : 0,
      fund: typeof h.fund === "string" && fundraiserSlugOf(h.fund) ? h.fund : null,
      partners,
      fundraisers: cachedFundraisers(h.fundraisers),
      fetched: time(h.fetched),
      feedFetched: time(h.feedFetched),
      seen: String(h.seen),
    };
  }
  return cache;
}

/** Reads cache/gofundme.json; an empty cache when the file is missing or unreadable. */
export function readGoFundMeCache(path = GOFUNDME_CACHE_PATH): GoFundMeCache {
  try {
    return normaliseGoFundMeCache(JSON.parse(fs.readFileSync(path, "utf8")));
  } catch {
    return emptyGoFundMeCache();
  }
}

export function writeGoFundMeCache(cache: GoFundMeCache, path = GOFUNDME_CACHE_PATH): void {
  writeJson(path, cache);
}

/** True when `at` is missing or at least `ms` before now. */
function stale(at: string | null, now: string, ms: number): boolean {
  if (!at) return true;
  const age = Date.parse(now) - Date.parse(at);
  return !(Number.isFinite(age) && age < ms);
}

export interface RefreshGoFundMeOptions {
  /** Crisis page URLs the run's research found (ResearchEntry.hubs). */
  found?: readonly string[];
  /** True when a crisis page matches one of the run's disasters (see hubMatches). */
  wanted?: (hub: GoFundMeHub) => boolean;
  maxRequests?: number;
  pauseMs?: number;
}

function blankHub(slug: string, now: string): GoFundMeHub {
  return { slug, title: "", verified: false, slugs: [], listed: 0, fund: null, partners: [], fundraisers: [], fetched: null, feedFetched: null, seen: now };
}

/**
 * Refreshes the GoFundMe cache with at most maxRequests requests, a pause
 * of at least a second between them, with the pipeline's user agent:
 *   1. the index, when it was read 12 hours ago or more;
 *   2. crisis pages never read, then those read 12 hours ago or more that
 *      match a disaster (wanted), then those read 7 days ago or more that
 *      match none; pages a disaster matches go first;
 *   3. the feed for each page that matches a disaster and says its
 *      fundraisers are verified, when it was read 12 hours ago or more.
 * A failed request keeps the previous data; a page that answers 404 or
 * 410 is gone and is dropped. Pages neither on the index nor found by
 * research for 30 days, and matching no disaster, are forgotten. Never
 * throws.
 */
export async function refreshGoFundMe(prev: GoFundMeCache, deps: FetchDeps, now: string, opts: RefreshGoFundMeOptions = {}): Promise<GoFundMeCache> {
  const cache: GoFundMeCache = { index: { ...prev.index }, hubs: { ...prev.hubs } };
  const wanted = opts.wanted ?? (() => false);
  const max = opts.maxRequests ?? GOFUNDME_MAX_REQUESTS;
  const pause = Math.max(1_000, opts.pauseMs ?? GOFUNDME_PAUSE_MS);
  let requests = 0;
  // One request: the status and, for a 200, the body; null when it failed or none are left.
  const get = async (url: string, accept: string): Promise<{ status: number; text: string } | null> => {
    if (requests >= max) return null;
    if (requests > 0) await deps.sleep(pause);
    requests++;
    try {
      const res = await deps.fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: accept }, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.status !== 200) {
        res.body?.cancel().catch(() => {});
        deps.log(`GoFundMe ${url}: HTTP ${res.status}`);
        return { status: res.status, text: "" };
      }
      return { status: 200, text: (await res.text()).slice(0, MAX_PAGE_CHARS) };
    } catch (err) {
      deps.log(`GoFundMe ${url}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };

  try {
    if (stale(cache.index.fetched, now, GOFUNDME_REFRESH_HOURS * HOUR_MS)) {
      const res = await get(GOFUNDME_INDEX, "text/html");
      const slugs = res?.status === 200 ? parseHubIndex(res.text) : [];
      if (slugs.length > 0) {
        cache.index = { fetched: now, slugs };
        deps.log(`GoFundMe: the index lists ${slugs.length} crisis pages (${slugs.join(", ")})`);
      } else deps.log("GoFundMe: the index could not be read; its previous list kept");
    }
    const found = (opts.found ?? []).map(hubSlugOf).filter((s): s is string => s !== null);
    for (const slug of [...cache.index.slugs, ...found]) cache.hubs[slug] = { ...(cache.hubs[slug] ?? blankHub(slug, now)), seen: now };

    // Pages a disaster matches first, then the index's, each by its order.
    const order = (h: GoFundMeHub) => (wanted(h) ? 0 : 2) + (cache.index.slugs.includes(h.slug) ? 0 : 1);
    const toRead = Object.values(cache.hubs)
      .filter((h) => h.fetched === null || stale(h.fetched, now, wanted(h) ? GOFUNDME_REFRESH_HOURS * HOUR_MS : UNMATCHED_RECHECK_DAYS * DAY_MS))
      .sort((a, b) => order(a) - order(b) || a.slug.localeCompare(b.slug));
    for (const h of toRead) {
      if (requests >= max) break;
      const res = await get(hubUrl(h.slug), "text/html");
      if (res?.status === 200) {
        const page = parseHub(res.text);
        // Names already read stay while the page still lists them.
        const kept = new Set([...page.slugs, ...(page.fund ? [fundraiserSlugOf(page.fund)] : [])]);
        cache.hubs[h.slug] = { ...h, ...page, fundraisers: h.fundraisers.filter((f) => kept.has(f.slug)), fetched: now };
        deps.log(`GoFundMe: read ${h.slug} ("${page.title}", ${page.listed} verified fundraisers, ${page.partners.length} partners)`);
      } else if (res?.status === 404 || res?.status === 410) {
        delete cache.hubs[h.slug];
        deps.log(`GoFundMe: ${h.slug} is gone`);
      }
    }

    for (const h of Object.values(cache.hubs)) {
      if (requests >= max) break;
      if (!h.fetched || !h.verified || !wanted(h) || !stale(h.feedFetched, now, GOFUNDME_REFRESH_HOURS * HOUR_MS)) continue;
      const slugs = feedSlugs(h);
      if (slugs.length === 0) continue;
      const res = await get(feedUrl(slugs), "application/json");
      if (res?.status !== 200) continue;
      let fundraisers: GoFundMeFundraiser[];
      try {
        fundraisers = parseFeed(JSON.parse(res.text));
      } catch {
        deps.log(`GoFundMe: the feed for ${h.slug} was not JSON; previous names kept`);
        continue;
      }
      cache.hubs[h.slug] = { ...h, fundraisers, feedFetched: now };
      deps.log(`GoFundMe: named ${fundraisers.length} of ${slugs.length} fundraisers for ${h.slug}`);
    }
  } catch (err) {
    deps.log(`GoFundMe: ${err instanceof Error ? err.message : String(err)}`);
  }

  for (const h of Object.values(cache.hubs)) {
    if (stale(h.seen, now, HUB_KEEP_DAYS * DAY_MS) && !wanted(h)) delete cache.hubs[h.slug];
  }
  return cache;
}

// ---------------------------------------------------------------------------
// GoFundMe: which page is a disaster's, and its links
// ---------------------------------------------------------------------------

/**
 * True when a crisis page is about this disaster, by fixed rule on its
 * slug and title (the way isIfrcEventCampaign reads IFRC's campaigns):
 * neither names a country that is not the disaster's (by whole names, see
 * countriesNamedIn), no hazard either names is of another kind, and one of
 * them is made only of place words of the disaster's title, or names one
 * of its countries together with a hazard of its kind. So
 * "hurricane-melissa" is Hurricane Melissa's and
 * "venezuela-earthquake-relief" the Venezuela earthquake's (not a flood in
 * Venezuela nor an earthquake in Colombia), while "wildfire-relief" and
 * "public-officials" are no disaster's. False without the context's
 * countryNameIndex.
 */
export function hubMatches(hub: Pick<GoFundMeHub, "slug" | "title">, d: Pick<Disaster, "countries" | "type">, ctx: Pick<DonationContext, "countryNameIndex" | "eventWords">): boolean {
  if (!ctx.countryNameIndex || d.countries.length === 0) return false;
  const slug = hub.slug.split("-").filter(Boolean);
  const title = asciiWords(hub.title).filter((w) => !HUB_FILLER.has(w));
  const readings = [readWords(slug, d.countries, ctx), readWords(title, d.countries, ctx)];
  if (readings.some((r) => r.foreign)) return false;
  const hazard = hazardFit([...slug, ...title], d.type);
  if (hazard === "other") return false;
  return readings.some((r) => r.onlyTitlePlaces || (r.country && hazard === "fits"));
}

/**
 * The disaster's crisis page: the first one, in the index's order and then
 * by slug, that has been read, says its fundraisers are verified and
 * matches the disaster (hubMatches); null when none does.
 */
export function matchHub(cache: GoFundMeCache, d: Pick<Disaster, "countries" | "type">, ctx: Pick<DonationContext, "countryNameIndex" | "eventWords">): GoFundMeHub | null {
  const rank = (h: GoFundMeHub) => {
    const i = cache.index.slugs.indexOf(h.slug);
    return i < 0 ? Infinity : i;
  };
  const hubs = Object.values(cache.hubs).sort((a, b) => rank(a) - rank(b) || a.slug.localeCompare(b.slug));
  return hubs.find((h) => h.fetched !== null && h.verified && hubMatches(h, d, ctx)) ?? null;
}

/** The event a crisis page is for, from its heading: "How to help: Hurricane Melissa relief" -> "Hurricane Melissa"; null when it does not read as one. */
export function hubEventName(title: string): string | null {
  const t = cleanText(title, 160)
    .replace(/\s*[|–—-]\s*GoFundMe\s*$/i, "")
    .replace(/^(?:how\s+(?:to|you\s+can)\s+help|ways\s+to\s+help)(?:\s+those\s+(?:impacted|affected)\s+by)?\s*:?\s*/i, "")
    .replace(/^donate\s+to\s+/i, "")
    .replace(/\s+(?:relief(?:\s+fundraisers)?|fundraisers)$/i, "")
    .trim();
  return t && t.length <= 60 && !/[:|]/.test(t) ? t : null;
}

/** A GoFundMe link for the event. */
function gofundmeLink(label: string, url: string, note: string, kind: "fundraiser" | "project" = "fundraiser", org = "GoFundMe"): DonationLink {
  return { label, url, org, kind, note, via: "platform", forEvent: true };
}

/**
 * GoFundMe's links for a disaster from its crisis page, at most three: the
 * page itself, the fund its Donate button leads to, then its verified
 * fundraisers, those whose names speak of schools first, then of homes and
 * families, then the most donated to. Fundraisers are listed only when the
 * feed named them. None when the page does not say they are verified.
 */
export function gofundmeLinks(hub: GoFundMeHub): DonationLink[] {
  if (!hub.verified) return [];
  const event = hubEventName(hub.title);
  const out = [gofundmeLink(event ? `Verified fundraisers for ${event}` : "Verified fundraisers on GoFundMe", hubUrl(hub.slug), VERIFIED_NOTE)];
  const fundSlug = hub.fund ? fundraiserSlugOf(hub.fund) : null;
  const fund = fundSlug ? hub.fundraisers.find((f) => f.slug === fundSlug) : undefined;
  if (fund) out.push(gofundmeLink(fund.name, fundraiserUrl(fund.slug), "Featured by GoFundMe on its verified page for this disaster"));
  const verified = hub.slugs;
  const picks = hub.fundraisers
    .filter((f) => f.slug !== fundSlug && verified.includes(f.slug))
    .map((f) => ({ f, rank: FOCUS_RANK[focusOf(f.name)], i: verified.indexOf(f.slug) }))
    .sort((a, b) => a.rank - b.rank || b.f.donations - a.f.donations || a.i - b.i);
  for (const { f } of picks) if (out.length < 3) out.push(gofundmeLink(f.name, fundraiserUrl(f.slug), VERIFIED_NOTE));
  return out;
}

/** The partners a crisis page lists, as project links: schools first, then homes and families, then in the page's order; at most two. */
export function partnerLinks(hub: GoFundMeHub): DonationLink[] {
  if (!hub.verified) return [];
  return hub.partners
    .map((p, i) => ({ p, i }))
    .sort((a, b) => FOCUS_RANK[a.p.focus] - FOCUS_RANK[b.p.focus] || a.i - b.i)
    .slice(0, 2)
    .map(({ p }) => gofundmeLink(`Donate to ${p.name}`, p.url, "A nonprofit GoFundMe lists as a vetted partner for this disaster", "project", p.name));
}

// ---------------------------------------------------------------------------
// GlobalGiving
// ---------------------------------------------------------------------------

/** A GlobalGiving project or fund page (/projects/<slug>/ or /fundraisers/<slug>/), at its usual address; null for any other URL. */
export function globalGivingPage(raw: string): { url: string; slug: string } | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || (url.hostname !== "www.globalgiving.org" && url.hostname !== "globalgiving.org") || url.username || url.password || url.port) return null;
  const m = /^\/(projects|fundraisers)\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/i.exec(url.pathname);
  return m ? { url: `https://www.globalgiving.org/${m[1].toLowerCase()}/${m[2].toLowerCase()}/`, slug: m[2].toLowerCase() } : null;
}

/** A search result's title without the site's name: "Hurricane Melissa Relief Fund - GlobalGiving" -> "Hurricane Melissa Relief Fund". */
function projectTitle(title: string): string {
  return cleanText(title, 160).replace(/\s*[-|–—]\s*GlobalGiving\s*$/i, "");
}

/** Four-digit years among words. */
function yearsIn(words: readonly string[]): number[] {
  return words.filter((w) => /^(?:19|20)\d\d$/.test(w)).map(Number);
}

/**
 * Why a GlobalGiving page the direct search found may not be shown for
 * this disaster, or null when it may. Its slug or the search result's title
 * must name one of the disaster's countries or a place word of its title,
 * and neither may name another country; it must name the disaster's hazard
 * (and no other kind, unless it names a title place), a place word of its
 * title (a storm's name) or a year no older than last year; and an older
 * year in its slug, or only older years in its title, mark an earlier
 * disaster's project.
 */
export function globalGivingProblem(page: Pick<DirectPage, "url" | "title">, d: Pick<Disaster, "countries" | "type">, ctx: Pick<DonationContext, "countryNameIndex" | "eventWords">, now: string): string | null {
  const gg = globalGivingPage(page.url);
  if (!gg) return "not a GlobalGiving project page";
  const slug = slugWords(gg.slug);
  const title = slugWords(projectTitle(page.title ?? ""));
  const readings = [readWords(slug, d.countries, ctx), readWords(title, d.countries, ctx)];
  if (readings.some((r) => r.foreign)) return "names another country";
  const titlePlace = readings.some((r) => r.titlePlace);
  if (!titlePlace && !readings.some((r) => r.country)) return "names none of the disaster's places";
  const lastYear = new Date(now).getUTCFullYear() - 1;
  const old = yearsIn(slug).filter((y) => y < lastYear);
  const titleYears = yearsIn(title);
  if (old.length > 0 || (titleYears.length > 0 && titleYears.every((y) => y < lastYear))) return `an earlier disaster's project (${[...old, ...titleYears][0]})`;
  const hazard = hazardFit([...slug, ...title], d.type);
  if (hazard === "other" && !titlePlace) return "names another kind of disaster";
  const recent = [...yearsIn(slug), ...titleYears].some((y) => y >= lastYear);
  if (hazard !== "fits" && !titlePlace && !recent) return "names neither the hazard, a place in the title nor a recent year";
  return null;
}

/** The link for a GlobalGiving page that passed globalGivingProblem, labelled by its title when it reads as the project's. */
export function globalGivingLink(page: Pick<DirectPage, "url" | "title">): DonationLink | null {
  const gg = globalGivingPage(page.url);
  if (!gg) return null;
  const title = projectTitle(page.title ?? "");
  const slug = new Set(gg.slug.split("-").filter((w) => w.length >= 4));
  const fromSlug = gg.slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  const label = slugWords(title).some((w) => slug.has(w)) ? cleanText(title, 90) : cleanText(fromSlug, 90);
  return { label, url: gg.url, org: "GlobalGiving", kind: "project", note: GLOBALGIVING_NOTE, via: "research", forEvent: true };
}

// ---------------------------------------------------------------------------
// Local groups' own pages
// ---------------------------------------------------------------------------

/** Social networks and messaging apps beyond donate.ts's SHARED_HOSTS. */
export const SOCIAL_HOSTS: readonly string[] = [
  "reddit.com", "threads.net", "threads.com", "pinterest.com", "snapchat.com", "vk.com", "ok.ru", "weibo.com", "weixin.qq.com", "line.me",
  "discord.com", "discord.gg", "bsky.app", "mastodon.social", "truthsocial.com", "kakao.com", "band.us", "xiaohongshu.com", "douyin.com",
  "bilibili.com", "quora.com", "messenger.com", "signal.me", "viber.com",
];

/**
 * Crowdfunding and giving platforms, where anyone can raise money: a page
 * there is not a local group's own. GoFundMe's pages come only from its
 * crisis pages, GlobalGiving's by their own rule.
 */
export const CROWDFUNDING_HOSTS: readonly string[] = [
  "gofundme.com", "gofund.me", "gofundme.org", "globalgiving.org", "globalgiving.co.uk", "justgiving.com", "kickstarter.com", "indiegogo.com",
  "givebutter.com", "donorbox.org", "givelively.org", "every.org", "fundly.com", "fundrazr.com", "crowdrise.com", "classy.org", "mightycause.com",
  "chuffed.org", "ulule.com", "kisskissbankbank.com", "leetchi.com", "helloasso.com", "betterplace.org", "kitabisa.com", "ketto.org", "milaap.org",
  "impactguru.com", "vakinha.com.br", "kickante.com.br", "benfeitoria.com", "catarse.me", "donadora.org", "goteo.org", "verkami.com",
  "givealittle.co.nz", "mycause.com.au", "patreon.com", "ko-fi.com", "buymeacoffee.com", "paypal.com", "paypal.me", "venmo.com", "cash.app",
  "zeffy.com", "givesendgo.com", "spotfund.com", "gogetfunding.com", "pledge.to", "raisely.com", "funraise.org", "thegivingblock.com",
  "networkforgood.org", "benevity.org", "charitynavigator.org", "globalgiving.com", "idealist.org", "youcaring.com", "generosity.com",
  "bonfire.com", "booster.com", "onecause.com", "givebig.org", "donately.com", "flipcause.com", "qgiv.com", "fundrise.com", "crowdfunder.co.uk",
  "crowdfunder.com", "startsomegood.com", "whydonate.com", "whydonate.nl", "gofundme.co.uk",
];

/** News sites and aggregators; the site's own news hosts are added per run. */
export const NEWS_HOSTS: readonly string[] = [
  "bbc.co.uk", "bbc.com", "cnn.com", "reuters.com", "apnews.com", "aljazeera.com", "aljazeera.net", "theguardian.com", "nytimes.com",
  "washingtonpost.com", "bloomberg.com", "france24.com", "dw.com", "euronews.com", "abc.net.au", "cbc.ca", "nbcnews.com", "cbsnews.com",
  "abcnews.go.com", "foxnews.com", "usatoday.com", "independent.co.uk", "telegraph.co.uk", "ndtv.com", "indiatimes.com", "hindustantimes.com",
  "thehindu.com", "inquirer.net", "gmanetwork.com", "rappler.com", "abs-cbn.com", "philstar.com", "kompas.com", "detik.com", "tempo.co",
  "scmp.com", "japantimes.co.jp", "nhk.or.jp", "yna.co.kr", "xinhuanet.com", "news.cn", "cgtn.com", "rt.com", "tass.com", "elpais.com",
  "elmundo.es", "clarin.com", "infobae.com", "eluniversal.com.mx", "milenio.com", "globo.com", "uol.com.br", "lemonde.fr", "lefigaro.fr",
  "spiegel.de", "bild.de", "corriere.it", "repubblica.it", "ansa.it", "nation.africa", "news24.com", "allafrica.com", "reliefweb.int",
  "wikipedia.org", "msn.com", "yahoo.com", "news.google.com", "jamaica-gleaner.com", "jamaicaobserver.com", "elnacional.com", "efectococuyo.com",
];

/** Marketplaces, whatever their country domain: amazon.co.jp, mercadolibre.com.ve. */
const MARKETPLACE = /(?:^|\.)(?:amazon|ebay|etsy|aliexpress|alibaba|mercadolibre|mercadolivre|shopee|lazada|tokopedia|rakuten|walmart|temu|craigslist|olx|jumia|flipkart|taobao|tmall)\.[a-z.]+$/;
/** Government and military hosts anywhere, and international bodies (.int): not a local group's. */
const GOVERNMENT_HOST = /(?:^|\.)(?:gov|gob|gouv|govt|gub|mil)(?:\.[a-z]{2})?$|\.(?:gov|mil|int)$|(?:^|\.)go\.[a-z]{2}$/;

/** What localUrlProblem needs: the disaster's allowlist context, every society's sites and the run's news hosts. */
export interface LocalContext {
  /** The disaster's allowlist context (donationContext): official sites are listed with the official links. */
  donation: DonationContext;
  /** Every Red Cross and Red Crescent society's sites in the registry (RegistrySociety.hosts). */
  societyHosts?: readonly string[];
  /** Hosts of the site's own news articles, which are news sites. */
  newsHosts?: ReadonlySet<string>;
}

/** True for host or a subdomain of one in the list. */
function onAny(host: string, list: Iterable<string>): boolean {
  for (const d of list) if (hostMatches(host, d.split("/")[0])) return true;
  return false;
}

/**
 * Why a URL may not be shown as a local group's donation page, or null
 * when it may: https only; no credentials, port, IP address, punycode or
 * shortener (donationUrlProblem's hygiene); not a social network or a site
 * anyone can publish on, a crowdfunding or giving platform, a marketplace
 * or a news site; not an official site (the disaster's allowlist, any Red
 * Cross or Red Crescent society, a government or an international body),
 * which belongs with the official links; never a blood donation, listing,
 * search or home page.
 */
export function localUrlProblem(raw: string, ctx: LocalContext): string | null {
  if (typeof raw !== "string" || !raw || raw.length > 2048) return "not a URL";
  if (/[\s\u0000-\u001f\u007f-\u009f]/.test(raw)) return "has spaces or control characters";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "not a URL";
  }
  if (url.protocol !== "https:") return "not https";
  if (url.username || url.password) return "has credentials";
  if (url.port) return "has a port";
  const host = url.hostname;
  if (host.startsWith("[") || /^\d+(\.\d+){3}$/.test(host)) return "IP address host";
  if (host.split(".").some((l) => l.startsWith("xn--"))) return "punycode host";
  if (!isPlainHostname(host)) return "unusual host";
  if (SHORTENERS.some((s) => hostMatches(host, s))) return "URL shortener";
  if (onAny(host, SHARED_HOSTS) || onAny(host, SOCIAL_HOSTS)) return "social network or a site anyone can publish on";
  if (onAny(host, CROWDFUNDING_HOSTS)) return "crowdfunding or giving platform";
  if (MARKETPLACE.test(host)) return "marketplace";
  if (onAny(host, NEWS_HOSTS) || onAny(host, ctx.newsHosts ?? [])) return "news site";
  if (hostClass(url, ctx.donation) || onAny(host, ctx.societyHosts ?? []) || GOVERNMENT_HOST.test(host)) return "official site, listed with the official links";
  if (isBloodDonationPath(url)) return "blood donation page";
  if (isListingPage(url)) return "listing or search page";
  if (isGeneralPage(url.toString(), new Set())) return "home page, not a page for this disaster";
  return null;
}

/** True when two hosts are one site: the same host with or without "www.", or one a subdomain of the other (never a registry suffix such as co.uk). */
export function sameSite(a: string, b: string): boolean {
  const x = a.replace(/^www\./, "");
  const y = b.replace(/^www\./, "");
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return !isRegistrySuffix(short) && short.includes(".") && hostMatches(long, short);
}

/**
 * The names a local group's page must use to be about the disaster's
 * place: each country's English name and its name in its press language
 * (pipeline/config/languages.json), the disaster's places and the place
 * words of its title; each once, at least three letters (or in a script
 * written without spaces).
 */
export function placeNames(
  d: Pick<Disaster, "countries" | "places">,
  countryNames: Record<string, string>,
  pressNames: Record<string, string> = {},
  titleWords: readonly string[] = [],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (name: unknown) => {
    const n = cleanText(name, 80).replace(/\*/g, "");
    const key = foldText(n);
    if (!n || seen.has(key) || ([...n].length < 3 && !/[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(n))) return;
    seen.add(key);
    out.push(n);
  };
  for (const c of d.countries) {
    add(Object.hasOwn(countryNames, c) ? countryNames[c] : "");
    add(Object.hasOwn(pressNames, c) ? pressNames[c] : "");
  }
  for (const p of d.places ?? []) add(p.name);
  titleWords.forEach(add);
  return out;
}

/**
 * The place words of a title as written there, runs of them joined:
 * "Bangladesh: Monsoon Depression in Cox's Bazar" with ["cox", "bazar"]
 * -> ["Cox's Bazar"], so a note can name the place as the title does.
 */
export function titlePlaces(title: string, words: readonly string[]): string[] {
  const place = new Set(words);
  const out: string[] = [];
  let start = -1;
  let end = -1;
  for (const m of title.matchAll(/[\p{L}\p{M}][\p{L}\p{M}'’.-]*/gu)) {
    const parts = asciiWords(m[0]).filter((w) => w !== "s");
    if (parts.length > 0 && parts.every((w) => place.has(w))) {
      if (start < 0) start = m.index;
      end = m.index + m[0].length;
    } else if (start >= 0) {
      out.push(title.slice(start, end));
      start = -1;
    }
  }
  if (start >= 0) out.push(title.slice(start, end));
  return out;
}

/** The first of the names that a page uses, as a whole word (or anywhere, in scripts without spaces); null when it uses none. */
export function placeNamedIn(html: string, names: readonly string[]): string | null {
  const text = foldText(pageText(html));
  return names.find((n) => compileTerm(n).re.test(text)) ?? null;
}

/** True when a redirect hop stays on the page's own site and is itself allowed (localUrlProblem): a moved page may not turn into a home page or another site. */
export function hopAllowed(start: string, hop: string, ctx: LocalContext): boolean {
  try {
    return sameSite(start, new URL(hop).hostname) && localUrlProblem(hop, ctx) === null;
  } catch {
    return false;
  }
}

/** One pass of the live check of a local group's page; "retry" when the network or server failed. */
async function checkLocalOnce(url: string, deps: FetchDeps, ctx: LocalContext, names: readonly string[]): Promise<PageCheck | "retry"> {
  const chain = [url];
  const fail = (reason: string): PageCheck => ({ ok: false, reason, chain: [...chain] });
  const start = new URL(url).hostname;
  let current = url;
  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      res = await deps.fetch(current, {
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" },
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      deps.log(`Local page ${current}: ${err instanceof Error ? err.message : String(err)}`);
      return "retry";
    }
    if (res.status >= 300 && res.status < 400) {
      res.body?.cancel().catch(() => {});
      const location = res.headers.get("location");
      if (!location) return fail(`redirect ${res.status} without a location`);
      if (hop >= MAX_REDIRECTS) return fail(`more than ${MAX_REDIRECTS} redirects`);
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return fail("redirect to a bad URL");
      }
      chain.push(next.toString());
      if (!hopAllowed(start, next.toString(), ctx)) return fail("redirect leaves the site or reaches a page that may not be shown");
      current = next.toString();
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      res.body?.cancel().catch(() => {});
      deps.log(`Local page ${current}: HTTP ${res.status}`);
      return "retry";
    }
    if (res.status !== 200) {
      res.body?.cancel().catch(() => {});
      return fail(`HTTP ${res.status}`);
    }
    const type = res.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml\+xml/i.test(type)) {
      res.body?.cancel().catch(() => {});
      return fail(`not an HTML page (${type || "no type"})`);
    }
    let html: string;
    try {
      html = (await res.text()).slice(0, MAX_PAGE_CHARS);
    } catch (err) {
      deps.log(`Local page ${current}: ${err instanceof Error ? err.message : String(err)}`);
      return "retry";
    }
    const words = donationWordsIn(html);
    if (words.length === 0) return fail("no donation word on the page");
    const place = placeNamedIn(html, names);
    if (!place) return fail("names none of the disaster's places");
    return { ok: true, reason: `donation word "${words[0]}", names "${place}"`, chain, place };
  }
}

/**
 * The live check of a local group's page: fetched like a reader's browser,
 * following at most three redirects by hand, each on the same site and
 * itself allowed (localUrlProblem); passes when the final answer is 200
 * HTML with a donation word and one of the disaster's place names. A bot
 * wall (401, 403) fails: an unknown group's page is never taken unseen.
 * Network failures, 429 and 5xx are tried once more after retryMs; null
 * when both attempts fail (no verdict).
 */
export async function checkLocalPage(url: string, deps: FetchDeps, ctx: LocalContext, names: readonly string[], retryMs = 2_000): Promise<PageCheck | null> {
  const problem = localUrlProblem(url, ctx);
  if (problem) return { ok: false, reason: problem, chain: [url] };
  for (let i = 1; i <= 2; i++) {
    const result = await checkLocalOnce(url, deps, ctx, names);
    if (result !== "retry") return result;
    if (i === 1) await deps.sleep(retryMs);
  }
  deps.log(`Local page ${url}: both attempts failed; not shown this run`);
  return null;
}

/** The registry's verdict key for a local group's page, per disaster, since the place test is the disaster's. */
export function localVerdictKey(disasterId: string, url: string): string {
  return `local:${disasterId}:${urlKey(url)}`;
}

/**
 * The live check with its cache in registry.verdicts (the caller writes
 * the registry): a pass is reused for 7 days, a failure for 1. A URL
 * localUrlProblem refuses fails at once and is not cached.
 */
export async function verifyLocalPage(
  url: string,
  disasterId: string,
  deps: FetchDeps,
  ctx: LocalContext,
  names: readonly string[],
  registry: DonationRegistry,
  now: string,
): Promise<boolean> {
  if (localUrlProblem(url, ctx)) return false;
  const key = localVerdictKey(disasterId, url);
  const cached = registry.verdicts[key];
  if (cached && verdictFresh(cached, now)) return cached.ok;
  const result = await checkLocalPage(url, deps, ctx, names);
  if (!result) return false;
  registry.verdicts[key] = { ...result, checked: now };
  deps.log(`Local page ${url}: ${result.ok ? "accepted" : "rejected"} (${result.reason})`);
  return result.ok;
}

/** The note on a local group's page. */
export function localNote(place: string | undefined): string {
  return `A local group's own page. Global View checked it is live and names ${place || "the disaster's place"}, but cannot vouch for the group.`;
}

// ---------------------------------------------------------------------------
// The direct links for one disaster
// ---------------------------------------------------------------------------

export interface DirectInput {
  disaster: Pick<Disaster, "id" | "countries" | "type" | "title" | "places">;
  /** Its research entry, with the direct search's pages (ResearchEntry.direct). */
  entry: ResearchEntry | undefined;
  gofundme: GoFundMeCache;
  /** The disaster's allowlist context (donationContext with its title and every country's name). */
  ctx: DonationContext;
  /** Every globe country's English name, and each country's name in its press language. */
  countryNames: Record<string, string>;
  pressNames?: Record<string, string>;
  /** Hosts of the site's own news articles. */
  newsHosts?: ReadonlySet<string>;
}

function localContext(input: DirectInput, registry: DonationRegistry): LocalContext {
  return { donation: input.ctx, societyHosts: Object.values(registry.societies).flatMap((s) => s.hosts), newsHosts: input.newsHosts };
}

/** Projects from two sources taken in turn, so both are seen within their shared cap. */
function alternate<T>(a: T[], b: T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) out.push(...(i < a.length ? [a[i]] : []), ...(i < b.length ? [b[i]] : []));
  return out;
}

/**
 * A disaster's direct links from the caches alone, for buildDonations to
 * order and cap: GoFundMe's from its crisis page; projects, GlobalGiving's
 * and the crisis page's partners' in turn; then local groups' pages with a
 * fresh passing verdict whose every hop is still allowed (the URL rules
 * apply to cached verdicts too).
 */
export function buildDirectLinks(input: DirectInput, registry: DonationRegistry, now: string): DonationLink[] {
  const hub = matchHub(input.gofundme, input.disaster, input.ctx);
  const pages = input.entry?.direct ?? [];
  const globalGiving = pages
    .filter((p) => p.kind === "globalgiving" && globalGivingProblem(p, input.disaster, input.ctx, now) === null)
    .map(globalGivingLink)
    .filter((l): l is DonationLink => l !== null);
  const local = localContext(input, registry);
  const locals: DonationLink[] = [];
  for (const p of pages) {
    if (p.kind !== "local" || localUrlProblem(p.url, local)) continue;
    const v = registry.verdicts[localVerdictKey(input.disaster.id, p.url)];
    if (!v?.ok || !verdictFresh(v, now)) continue;
    const start = new URL(p.url).hostname;
    if (!v.chain.every((u) => hopAllowed(start, u, local))) continue;
    const org = cleanText(p.org, 80) || start.replace(/^www\./, "");
    locals.push({ label: `Donate to ${org}`, url: p.url, org, kind: "local", note: localNote(v.place), via: "research", forEvent: true });
  }
  return [...(hub ? gofundmeLinks(hub) : []), ...alternate(globalGiving, hub ? partnerLinks(hub) : []), ...locals];
}

export interface PrepareDirectOptions {
  /** Most live checks for this disaster (cached verdicts do not count). */
  maxChecks?: number;
  pauseMs?: number;
  /** URL keys no verdict could be had for this run, shared across disasters (see donate.ts PrepareOptions). */
  unreachable?: Set<string>;
}

/**
 * Live-checks the local groups' pages a disaster's direct search found
 * that have no fresh verdict (at most maxChecks, pausing between them),
 * then builds its direct links. Records verdicts in registry.verdicts; the
 * caller writes the registry.
 */
export async function prepareDirectLinks(input: DirectInput, registry: DonationRegistry, deps: FetchDeps, now: string, opts: PrepareDirectOptions = {}): Promise<DonationLink[]> {
  const local = localContext(input, registry);
  const words = input.ctx.eventWords ?? [];
  const names = placeNames(input.disaster, input.countryNames, input.pressNames, [...titlePlaces(input.disaster.title, words), ...words]);
  const unreachable = opts.unreachable ?? new Set<string>();
  let checks = 0;
  for (const p of input.entry?.direct ?? []) {
    if (p.kind !== "local" || checks >= (opts.maxChecks ?? MAX_LOCAL_CHECKS)) continue;
    const problem = localUrlProblem(p.url, local);
    if (problem) {
      deps.log(`Local page ${p.url}: rejected (${problem})`);
      continue;
    }
    const key = localVerdictKey(input.disaster.id, p.url);
    const cached = registry.verdicts[key];
    if ((cached && verdictFresh(cached, now)) || unreachable.has(urlKey(p.url))) continue;
    checks++;
    await verifyLocalPage(p.url, input.disaster.id, deps, local, names, registry, now);
    if (!registry.verdicts[key]) unreachable.add(urlKey(p.url));
    await deps.sleep(opts.pauseMs ?? 500);
  }
  return buildDirectLinks(input, registry, now);
}
