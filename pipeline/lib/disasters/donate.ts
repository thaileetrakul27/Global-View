// Donation pages for each disaster.
//
// The site must never show a scam or a wrong donation link, so a link
// reaches a disaster in one of two ways only:
//
//   registry  official lists read by fixed rule: each country's Red Cross
//             or Red Crescent society from IFRC GO, its page on the Red
//             Cross Red Crescent donation platform that IFRC runs (found by
//             probing a fixed URL, and kept only when the page it lands on
//             collects for the society's own campaign), its own website
//             (shown only over https and after the live check below, since
//             a listed domain can lapse to a squatter), UN Crisis Relief's
//             per-country pages from its sitemap, IFRC's page for an appeal
//             by its code, and two global fallbacks (UN Crisis Relief and
//             IFRC's donation page) so every disaster has at least two links;
//   research  a page web research suggested, kept only when its URL passes
//             the allowlist (isAllowedDonationUrl) AND a live check
//             (verifyDonationPage): fetched over https, every redirect hop
//             on the allowlist, status 200, HTML, and a donation word on
//             the page.
//
// The registry and the live-check verdicts are cached in
// cache/donation-registry.json. The integrator refreshes the registry once
// per run (refreshRegistry), checks researched pages (prepareDonations or
// verifyDonationPage), and builds each disaster's list (buildDonations).
//
// Live findings (2026-10-19) behind these rules:
//   - donate.redcrossredcrescent.org/<cc>/default/ answers 303 with a
//     relative location: "/jp/default/~my-donation?_cv=1" when the society
//     may be on the platform, "/?lang=&_cv=1" when it is not. Of 26 such
//     paths, 5 (AM CH LB NL UA) land on IFRC's movement-wide campaign and 1
//     (BA) on an unfinished template, so the landing page is read too;
//   - IFRC lists 138 of 164 society websites first as http://; Bolivia's
//     redirects to a betting site and Saint Lucia's serves a lottery page;
//   - crisisrelief.un.org pages 302 to an /en/ copy and are JavaScript
//     apps whose donation words sit in inline script data;
//   - www.ifrc.org answers scripted clients with a Cloudflare challenge
//     (403), so ifrc.org pages cannot be live-checked; its pages here come
//     from the registry only. There is no donation page per appeal code;
//     the stable per-appeal page is www.ifrc.org/appeals?appeal_code=<code>
//     (the appeal's documents), and www.ifrc.org/donate lets donors pick an
//     emergency.
import fs from "node:fs";
import type { FetchDeps } from "../googlenews";
import { USER_AGENT } from "../googlenews";
import { writeJson } from "../io";
import type { CountryResolver } from "../resolve";
import type { AppealRef, DonationKind, DonationLink } from "./types";

export const GO_COUNTRIES_URL = "https://goadmin.ifrc.org/api/v2/country/?limit=500";
export const PLATFORM_HOST = "donate.redcrossredcrescent.org";
export const PLATFORM_ORIGIN = `https://${PLATFORM_HOST}`;
export const UNCR_SITEMAP = "https://crisisrelief.un.org/sitemap.xml";
export const UNCR_HOME = "https://crisisrelief.un.org/";
export const IFRC_DONATE = "https://www.ifrc.org/donate";
export const IFRC_APPEAL_PAGE = "https://www.ifrc.org/appeals?appeal_code=";
export const REGISTRY_PATH = "cache/donation-registry.json";
export const DOMAINS_PATH = "pipeline/config/donation-domains.json";

/** Societies asked about per run: the platform rate-limits after about fifty requests. */
export const PLATFORM_BATCH = 40;
/** Most platform requests per run, landing pages included (see probePlatform). */
export const PLATFORM_MAX_REQUESTS = 45;
/** A platform answer is asked again after this many days. */
export const RECHECK_DAYS = 7;
/** A passing live-check verdict is trusted for this many days. */
export const VERDICT_DAYS = 7;
/**
 * A failing verdict is kept for one day only: a page can fail for a while
 * (a bot wall, an outage; seen live on the Thai Red Cross and the Turkish
 * Red Crescent), and a week would hide a good page for too long.
 */
export const FAILED_VERDICT_DAYS = 1;
/** Most links per disaster. */
export const MAX_LINKS = 6;
/** Most researched links per disaster. */
export const MAX_RESEARCHED = 3;
/** Most redirects a live check follows. */
export const MAX_REDIRECTS = 3;
/** Pages longer than this are cut before the keyword check. */
const MAX_PAGE_CHARS = 2_000_000;
const DAY_MS = 86_400_000;
const TIMEOUT_MS = 30_000;
const PAGE_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Registry shapes
// ---------------------------------------------------------------------------

/** A country's own Red Cross or Red Crescent society, as IFRC GO lists it. */
export interface RegistrySociety {
  /** e.g. "Philippine Red Cross". */
  name: string;
  /** IFRC's name for the country, e.g. "Philippines". */
  country: string;
  /** The society's own website, as IFRC lists it. */
  url: string | null;
  /** Its page in IFRC's national society directory. */
  directory: string | null;
  /**
   * The allowlist's society entries, one per site of its own: the host with
   * "www." removed, or host and folder for a site that is one folder of a
   * bigger host ("sld.cu/sitios/cruzroja"; see siteScope).
   */
  hosts: string[];
  /** Its page on the Red Cross Red Crescent donation platform, when it is on it. */
  donate: string | null;
  /** When the platform was last asked about it; null until asked. */
  checked: string | null;
  /** A territory without its own society: the code of the society IFRC names for it (PR -> US). */
  parent?: string;
}

/** A UN Crisis Relief page for one country. */
export interface UncrPage {
  url: string;
  /** Country name as the label shows it, e.g. "Sudan" or "the Central African Republic". */
  name: string;
}

/** The result of one live check of a researched page. */
export interface DonationVerdict {
  ok: boolean;
  /** Why, in a few words, for the run log. */
  reason: string;
  /** ISO time of the check. */
  checked: string;
  /** The URL and every redirect hop that was followed. */
  chain: string[];
  /** The site answered 401 or 403 on an allowlisted URL: a bot wall, not a verdict on the page. */
  blocked?: boolean;
}

export interface DonationRegistry {
  updated: string | null;
  /** Last successful fetch per source. */
  fetched: { societies: string | null; uncr: string | null };
  /** By country code (ISO 3166-1 alpha-2, as IFRC GO and the globe use). */
  societies: Record<string, RegistrySociety>;
  /** UN Crisis Relief per-country pages, by country code. */
  uncr: Record<string, UncrPage>;
  /** UN Crisis Relief's general emergency fund page, when the sitemap lists one. */
  uncrGeneral: string | null;
  /** Live-check verdicts by urlKey(). */
  verdicts: Record<string, DonationVerdict>;
}

export function emptyRegistry(): DonationRegistry {
  return { updated: null, fetched: { societies: null, uncr: null }, societies: {}, uncr: {}, uncrGeneral: null, verdicts: {} };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

/** Fills in anything missing from a registry read from disk, so older or damaged files still load. */
export function normaliseRegistry(raw: unknown): DonationRegistry {
  const reg = emptyRegistry();
  if (!isRecord(raw)) return reg;
  reg.updated = str(raw.updated);
  if (isRecord(raw.fetched)) reg.fetched = { societies: str(raw.fetched.societies), uncr: str(raw.fetched.uncr) };
  if (isRecord(raw.societies)) {
    for (const [code, s] of Object.entries(raw.societies)) {
      if (!isRecord(s) || !str(s.name)) continue;
      reg.societies[code] = {
        name: String(s.name),
        country: str(s.country) ?? code,
        url: str(s.url),
        directory: str(s.directory),
        hosts: Array.isArray(s.hosts) ? s.hosts.filter((h): h is string => typeof h === "string") : [],
        donate: str(s.donate),
        checked: str(s.checked),
        ...(str(s.parent) ? { parent: String(s.parent) } : {}),
      };
    }
  }
  if (isRecord(raw.uncr)) {
    for (const [code, p] of Object.entries(raw.uncr)) if (isRecord(p) && str(p.url) && str(p.name)) reg.uncr[code] = { url: String(p.url), name: String(p.name) };
  }
  reg.uncrGeneral = str(raw.uncrGeneral);
  if (isRecord(raw.verdicts)) {
    for (const [key, v] of Object.entries(raw.verdicts)) {
      if (!isRecord(v) || typeof v.ok !== "boolean" || !str(v.checked) || !Array.isArray(v.chain)) continue;
      reg.verdicts[key] = {
        ok: v.ok,
        reason: str(v.reason) ?? "",
        checked: String(v.checked),
        chain: v.chain.filter((u): u is string => typeof u === "string"),
        ...(v.blocked === true ? { blocked: true } : {}),
      };
    }
  }
  return reg;
}

/** Reads the cached registry; an empty one when the file is missing or unreadable. */
export function readRegistry(path = REGISTRY_PATH): DonationRegistry {
  try {
    return normaliseRegistry(JSON.parse(fs.readFileSync(path, "utf8")));
  } catch {
    return emptyRegistry();
  }
}

export function writeRegistry(reg: DonationRegistry, path = REGISTRY_PATH): void {
  writeJson(path, reg);
}

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------

/** True when host is domain or a subdomain of it, matched at a dot ("evilgov.uk" is not under "gov.uk"). */
export function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** A plain DNS name: letters, digits and hyphens, at least two labels, an alphabetic TLD, no punycode, no IP. */
export function isPlainHostname(host: string): boolean {
  if (!host || host.length > 253 || host.endsWith(".")) return false;
  const labels = host.split(".");
  if (labels.length < 2) return false;
  if (!/^[a-z]{2,63}$/.test(labels[labels.length - 1])) return false;
  return labels.every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l) && !l.startsWith("xn--"));
}

/**
 * Hosts where anyone can publish a page. A society site listed on one of
 * these (a Facebook page, a blog) is never trusted as a society host,
 * since the allowlist would then accept every page on that platform.
 */
export const SHARED_HOSTS: readonly string[] = [
  "facebook.com", "fb.com", "fb.me", "instagram.com", "twitter.com", "x.com", "linkedin.com", "youtube.com", "youtu.be",
  "tiktok.com", "whatsapp.com", "wa.me", "t.me", "telegram.me", "google.com", "blogspot.com", "wordpress.com", "wixsite.com",
  "wix.com", "weebly.com", "over-blog.com", "over-blog.org", "squarespace.com", "github.io", "medium.com", "tumblr.com",
  "linktr.ee", "jimdo.com", "jimdosite.com", "webnode.com", "carrd.co", "canva.site", "netlify.app", "vercel.app",
  "pages.dev", "herokuapp.com", "azurewebsites.net", "cloudfront.net", "amazonaws.com", "web.app", "firebaseapp.com",
  "000webhostapp.com", "godaddysites.com",
];

/** URL shorteners: a donation link must name its real destination. */
export const SHORTENERS: readonly string[] = [
  "bit.ly", "bitly.com", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "v.gd", "buff.ly", "rebrand.ly", "cutt.ly",
  "shorturl.at", "tiny.cc", "tiny.one", "s.id", "lnkd.in", "rb.gy", "t.ly", "bl.ink", "short.io", "shorte.st", "adf.ly",
  "bit.do", "qr.ae", "trib.al", "dlvr.it", "ift.tt", "lnk.to", "x.co", "go.usa.gov", "linktr.ee",
];

/** The Red Cross and Red Crescent movement's international bodies. */
export const MOVEMENT_DOMAINS: readonly string[] = ["ifrc.org", "icrc.org"];
/** The UN itself, its crisis fundraising site and its coordination office. */
export const UN_DOMAINS: readonly string[] = ["un.org", "unocha.org"];
/** UN agencies that take public donations for emergencies. */
export const UN_AGENCY_DOMAINS: readonly string[] = ["unicef.org", "wfp.org", "unhcr.org", "who.int", "iom.int", "undp.org", "unfpa.org"];

/** Host of a society website with "www." removed; null when it is not a plain, single-owner host. */
export function siteHost(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    if (!isPlainHostname(host)) return null;
    if (SHARED_HOSTS.some((s) => hostMatches(host, s))) return null;
    return host;
  } catch {
    return null;
  }
}

/** Path segments that only choose a language or a home page, not a site of its own: "en", "pt-br", "home", "index.php". */
const HOME_SEGMENT = /^(?:[a-z]{2}(?:[-_][a-z]{2})?|home|inicio|accueil|start|main|(?:index|default|home)\.[a-z]{2,5})$/i;

/**
 * A society site's allowlist entry. Normally its host ("redcross.org.uk",
 * also for "https://www.mdais.org/en/"). When IFRC lists a folder on a
 * bigger host ("http://www.sld.cu/sitios/cruzroja/", on Cuba's health
 * network), the folder too, so the rest of that host is not taken for the
 * society's site. Null when siteHost refuses the host.
 */
export function siteScope(url: string): string | null {
  const host = siteHost(url);
  if (!host) return null;
  const segments = new URL(url).pathname.split("/").filter(Boolean);
  while (segments.length > 0 && HOME_SEGMENT.test(segments[segments.length - 1]) && !/^[a-z]{2}(?:[-_][a-z]{2})?$/i.test(segments[segments.length - 1])) segments.pop();
  if (segments.every((seg) => HOME_SEGMENT.test(seg))) return host;
  return `${host}/${segments.join("/").toLowerCase()}`;
}

/**
 * True when url lies inside a society entry from siteScope: on the host or
 * a subdomain of it, or, for a folder entry, on that very host (www. aside)
 * and inside the folder.
 */
export function inSiteScope(url: URL, scope: string): boolean {
  const slash = scope.indexOf("/");
  if (slash < 0) return hostMatches(url.hostname, scope);
  if (url.hostname.replace(/^www\./, "") !== scope.slice(0, slash)) return false;
  // Encoded slashes, backslashes or dots, and "..;" segments, are left in
  // the path by the URL parser but undone by some servers, which could then
  // serve a page outside the folder; such a path is never in it.
  if (/%2f|%5c|%2e|;/i.test(url.pathname)) return false;
  const folder = scope.slice(slash).toLowerCase();
  const path = url.pathname.toLowerCase();
  return path === folder || path.startsWith(`${folder}/`);
}

/** One website as IFRC lists it, cleaned: scheme added when missing ("www.cra.dz"), junk ("projet en suspend") dropped. */
export function normaliseSiteUrl(raw: string): string | null {
  const t = raw.trim().replace(/[.,;]+$/, "");
  if (!t || /\s/.test(t)) return null;
  const withScheme = /^https?:\/\//i.test(t) ? t : /^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(t) ? `http://${t}` : null;
  if (!withScheme) return null;
  try {
    const u = new URL(withScheme);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password || u.port) return null;
    return siteHost(u.toString()) ? u.toString() : null;
  } catch {
    return null;
  }
}

/** IFRC sometimes lists two sites in one field: "http://www.croix-rouge.be, http://www.rodekruis.be". */
function splitSites(v: unknown): string[] {
  return typeof v === "string" ? v.split(/[,;\s]+/).filter(Boolean) : [];
}

// ---------------------------------------------------------------------------
// Societies from IFRC GO
// ---------------------------------------------------------------------------

/** One row of IFRC GO's country list, as this module reads it. */
export interface GoCountryRow {
  iso?: string | null;
  record_type?: number;
  independent?: boolean | null;
  name?: string | null;
  society_name?: string | null;
  society_url?: string | null;
  website?: string | null;
  url_ifrc?: string | null;
}

/** IFRC directory page, kept only when it really is on ifrc.org over https. */
function directoryUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === "https:" && hostMatches(u.hostname, "ifrc.org") ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Maps IFRC GO's country list onto societies by country code, carrying
 * over earlier platform answers. The site shown is the first one IFRC
 * lists over https, else the first one (IFRC's second field is often the
 * newer site: "http://www.srcs.org.sa/" is dead, "https://www.srca.org.sa/"
 * is the Saudi Red Crescent today). A territory without a society of its
 * own (record not independent, e.g. Puerto Rico) is linked to the
 * independent society IFRC names for it when the names match exactly
 * (PR -> American Red Cross), and is never probed itself.
 */
export function toSocieties(rows: GoCountryRow[], previous: Record<string, RegistrySociety> = {}): Record<string, RegistrySociety> {
  const out: Record<string, RegistrySociety> = {};
  const independentByName = new Map<string, string>();
  const dependent: string[] = [];
  for (const r of rows) {
    if (!isRecord(r) || r.record_type !== 1 || typeof r.iso !== "string" || !/^[A-Za-z]{2}$/.test(r.iso)) continue;
    const name = cleanText(r.society_name, 120);
    if (!name) continue;
    const code = r.iso.toUpperCase();
    const sites = [...splitSites(r.society_url), ...splitSites(r.website)].map(normaliseSiteUrl).filter((u): u is string => u !== null);
    const hosts = [...new Set(sites.map(siteScope).filter((h): h is string => h !== null))];
    out[code] = {
      name,
      country: cleanText(r.name, 120) || code,
      url: sites.find((u) => u.startsWith("https:")) ?? sites[0] ?? null,
      directory: directoryUrl(r.url_ifrc),
      hosts,
      donate: previous[code]?.donate ?? null,
      checked: previous[code]?.checked ?? null,
    };
    if (r.independent === true) {
      if (!independentByName.has(name.toLowerCase())) independentByName.set(name.toLowerCase(), code);
    } else dependent.push(code);
  }
  for (const code of dependent) {
    const parent = independentByName.get(out[code].name.toLowerCase());
    if (parent && parent !== code) out[code] = { ...out[code], parent, donate: null, checked: null };
  }
  return out;
}

/** A country's society, or the one IFRC names for a territory. */
export function societyOf(code: string, registry: DonationRegistry): RegistrySociety | null {
  const own = registry.societies[code.toUpperCase()];
  if (!own) return null;
  return own.parent ? (registry.societies[own.parent] ?? own) : own;
}

// ---------------------------------------------------------------------------
// The Red Cross Red Crescent donation platform
// ---------------------------------------------------------------------------

/** The platform page that is probed for a society, and linked when it is on the platform. */
export function platformUrl(code: string): string {
  return `${PLATFORM_ORIGIN}/${code.toLowerCase()}/default/`;
}

/**
 * Reads one platform answer. Maybe on the platform: a redirect into the
 * country's own path ("/jp/default/~my-donation?_cv=1"), whose landing
 * page must still be checked (landingAnswer); not on it: a redirect to
 * the front page ("/?lang=&_cv=1"). Anything else, including a redirect
 * off the platform, is unclear (undefined) and leaves the earlier answer
 * in place.
 */
export function platformAnswer(code: string, status: number, location: string | null): string | null | undefined {
  if (status < 300 || status >= 400 || location === null) return undefined;
  let target: URL;
  try {
    target = new URL(location, PLATFORM_ORIGIN);
  } catch {
    return undefined;
  }
  if (target.origin !== PLATFORM_ORIGIN) return undefined;
  if (target.pathname.startsWith(`/${code.toLowerCase()}/`)) return platformUrl(code);
  if (target.pathname === "/" || target.pathname === "") return null;
  return undefined;
}

/**
 * The campaign a platform donation page collects for, from the page's
 * analytics data: 'iRaiserCustomCampaignName': "Kenya Red Cross". Null
 * when the page does not name one.
 */
export function platformCampaign(html: string): string | null {
  const m = /iRaiserCustomCampaignName['"]?\s*:\s*(?:"((?:[^"\\]|\\.){1,200})"|'((?:[^'\\]|\\.){1,200})')/.exec(html);
  if (!m) return null;
  // Written with script escapes: "Cruz Roja Española", "Croix-Rouge l\'..."
  const name = (m[1] ?? m[2] ?? "").replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))).replace(/\\(.)/g, "$1");
  return cleanText(name, 120) || null;
}

/** Campaign names that belong to the whole movement or to IFRC, not to one society. */
const GENERIC_CAMPAIGN = /\b(movement|ifrc|icrc|federation|international|global|worldwide)\b/;
/** Words in a campaign name that say nothing about whose campaign it is. */
const CAMPAIGN_FILLER = new Set(["red", "cross", "crescent", "society", "national", "the", "and", "rcs", "default", "campaign", "donation", "donations", "donate", "general", "main", "page", "test", "form"]);

/**
 * True when a platform campaign belongs to one society: it has a name,
 * the name is not the movement-wide campaign, and it has a word of its
 * own ("Kenya Red Cross", "Cruz Roja Española", "Japanese RC - default
 * campaign"). Seen live (2026-10-19): the paths of Armenia, Lebanon, the
 * Netherlands, Switzerland and Ukraine land on IFRC's "Red Cross and Red
 * Crescent Movement" campaign, and Bosnia and Herzegovina's on an
 * unfinished template with no campaign name, so none of them is a
 * society's own page.
 */
export function isSocietyCampaign(name: string | null): boolean {
  if (!name) return false;
  const folded = foldText(name);
  if (GENERIC_CAMPAIGN.test(folded)) return false;
  return folded.split(/[^\p{L}\p{N}]+/u).some((w) => [...w].length >= 3 && !CAMPAIGN_FILLER.has(w));
}

/**
 * Reads the page a "maybe on the platform" redirect lands on: the
 * society's platform page when it is a 200 page of the society's own
 * campaign; null when it is a page of someone else's campaign, an
 * unfinished page or a client error; undefined (unclear, ask again) for
 * a server error or anything else.
 */
export function landingAnswer(code: string, status: number, html: string): string | null | undefined {
  if (status === 200) return isSocietyCampaign(platformCampaign(html)) ? platformUrl(code) : null;
  if (status >= 400 && status < 500 && status !== 429) return null;
  return undefined;
}

/**
 * The societies to ask about this run: never asked first, then those
 * asked longest ago, skipping answers younger than recheckDays and
 * territories that use another society. `only` limits it to some codes
 * (e.g. the globe's), so the platform's small allowance is not spent on
 * places the map cannot show.
 */
export function nextToCheck(
  societies: Record<string, RegistrySociety>,
  now: string,
  batch = PLATFORM_BATCH,
  recheckDays = RECHECK_DAYS,
  only?: string[],
): string[] {
  const allow = only ? new Set(only.map((c) => c.toUpperCase())) : null;
  const nowMs = Date.parse(now);
  return Object.entries(societies)
    .filter(([code, s]) => /^[A-Z]{2}$/.test(code) && !s.parent && (!allow || allow.has(code)))
    .filter(([, s]) => s.checked === null || !(nowMs - Date.parse(s.checked) < recheckDays * DAY_MS))
    .sort(([a, sa], [b, sb]) => (sa.checked ?? "").localeCompare(sb.checked ?? "") || a.localeCompare(b))
    .slice(0, batch)
    .map(([code]) => code);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Lets a response's body go without reading it. */
function discard(res: Response): void {
  res.body?.cancel().catch(() => {});
}

/**
 * Asks the platform about each society, one at a time with a pause. A
 * redirect into the society's path is followed by one more request for
 * the page it lands on, which must be the society's own campaign
 * (landingAnswer). Stops at the first 429 (the rest wait for the next
 * run), after three network failures in a row (the platform is down) or
 * once maxRequests requests are spent. Returns only the clear answers: a
 * platform URL, or null for "not on the platform".
 */
export async function probePlatform(codes: string[], deps: FetchDeps, pauseMs = 500, maxRequests = PLATFORM_MAX_REQUESTS): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  let failures = 0;
  let requests = 0;
  const get = (url: string) => {
    requests++;
    return deps.fetch(url, { headers: { "User-Agent": USER_AGENT }, redirect: "manual", signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) });
  };
  const limited = () => deps.log(`Donation platform: rate limited after ${Object.keys(out).length} answers; the rest wait for the next run`);
  for (const code of codes) {
    if (requests >= maxRequests) {
      deps.log(`Donation platform: ${requests} requests made; the rest wait for the next run`);
      break;
    }
    try {
      const res = await get(platformUrl(code));
      discard(res);
      failures = 0;
      if (res.status === 429) {
        limited();
        break;
      }
      const location = res.headers.get("location");
      let answer = platformAnswer(code, res.status, location);
      if (answer && location !== null) {
        if (requests >= maxRequests) {
          deps.log(`Donation platform ${code}: no requests left to read its page; asked again next run`);
          break;
        }
        await deps.sleep(pauseMs);
        const landing = await get(new URL(location, PLATFORM_ORIGIN).toString());
        if (landing.status === 429) {
          discard(landing);
          limited();
          break;
        }
        let html = "";
        if (landing.status === 200) html = await landing.text();
        else discard(landing);
        answer = landingAnswer(code, landing.status, html);
        if (landing.status === 200) deps.log(`Donation platform ${code}: campaign "${platformCampaign(html) ?? "none"}" ${answer ? "is the society's own" : "is not the society's own; not linked"}`);
      }
      if (answer === undefined) deps.log(`Donation platform ${code}: unclear answer ${res.status} ${location ?? ""}`);
      else out[code] = answer;
    } catch (err) {
      deps.log(`Donation platform ${code}: ${message(err)}`);
      if (++failures >= 3) {
        deps.log("Donation platform: three failures in a row; the rest wait for the next run");
        break;
      }
    }
    await deps.sleep(pauseMs);
  }
  return out;
}

// ---------------------------------------------------------------------------
// UN Crisis Relief
// ---------------------------------------------------------------------------

/** Slugs UN Crisis Relief uses that are not country names. */
const UNCR_ALIASES: Record<string, UncrPage & { code: string }> = {
  opt: { code: "PS", url: "", name: "the Occupied Palestinian Territory" },
  car: { code: "CF", url: "", name: "the Central African Republic" },
  drc: { code: "CD", url: "", name: "the Democratic Republic of the Congo" },
};

function titleCase(words: string): string {
  return words.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** Every <loc> in a sitemap. */
export function parseSitemapLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, "&"));
}

/**
 * UN Crisis Relief's pages from its sitemap: a page whose slug is
 * "donate-<country>-crisis" or "donate-<country>" belongs to that country
 * (regional and campaign pages match no country and are left out), and
 * "donate-global-emergency-fund" is the general fund.
 */
export function toUncr(locs: string[], resolve: CountryResolver): { pages: Record<string, UncrPage>; general: string | null } {
  const pages: Record<string, UncrPage> = {};
  let general: string | null = null;
  for (const raw of locs) {
    const loc = raw.trim();
    const m = /^https:\/\/crisisrelief\.un\.org\/(?:[a-z]{2}\/)?donate-([a-z0-9-]+?)(?:-crisis)?\/?$/.exec(loc);
    if (!m) continue;
    if (m[1] === "global-emergency-fund") {
      general ??= loc;
      continue;
    }
    const words = m[1].replace(/-/g, " ");
    const alias = UNCR_ALIASES[words];
    const code = alias?.code ?? resolve.byName(words);
    if (code && !(code in pages)) pages[code] = { url: loc, name: alias?.name ?? titleCase(words) };
  }
  return { pages, general };
}

// ---------------------------------------------------------------------------
// Fetching the registry
// ---------------------------------------------------------------------------

/** Runs fn, and once more after retryMs when it throws; null when both attempts fail. */
async function attempt<T>(label: string, fn: () => Promise<T>, deps: FetchDeps, retryMs: number): Promise<T | null> {
  for (let i = 1; i <= 2; i++) {
    try {
      return await fn();
    } catch (err) {
      deps.log(`${label} attempt ${i}: ${message(err)}`);
      if (i === 1) await deps.sleep(retryMs);
    }
  }
  deps.log(`${label}: both attempts failed; previous data kept`);
  return null;
}

async function getText(url: string, accept: string, deps: FetchDeps): Promise<string> {
  const res = await deps.fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: accept }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) {
    discard(res);
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.text();
}

/** Most pages of IFRC GO's country list read (one today: limit=500 returns all 281 rows). */
const GO_MAX_PAGES = 10;

/**
 * IFRC GO's country list, following its "next" pages so a smaller page
 * size can never cut the registry short; null when both attempts fail or
 * the list cannot be read to its end.
 */
export async function fetchGoCountries(deps: FetchDeps, retryMs = 5_000): Promise<GoCountryRow[] | null> {
  return attempt(
    "IFRC GO countries",
    async () => {
      const rows: GoCountryRow[] = [];
      let url: string | null = GO_COUNTRIES_URL;
      for (let page = 0; url !== null && page < GO_MAX_PAGES; page++) {
        const body = JSON.parse(await getText(url, "application/json", deps)) as { results?: unknown; next?: unknown };
        if (!Array.isArray(body.results)) throw new Error("no results in the country list");
        rows.push(...(body.results as GoCountryRow[]));
        url = body.next === null || body.next === undefined ? null : String(body.next);
        if (url !== null && !url.startsWith("https://goadmin.ifrc.org/")) throw new Error(`unexpected next page ${url}`);
      }
      if (url !== null) throw new Error(`country list longer than ${GO_MAX_PAGES} pages`);
      if (!rows.length) throw new Error("no results in the country list");
      return rows;
    },
    deps,
    retryMs,
  );
}

/** Every page in UN Crisis Relief's sitemap; null when both attempts fail. */
export async function fetchUncrLocs(deps: FetchDeps, retryMs = 5_000): Promise<string[] | null> {
  return attempt(
    "UN Crisis Relief sitemap",
    async () => {
      const locs = parseSitemapLocs(await getText(UNCR_SITEMAP, "application/xml, text/xml", deps));
      if (!locs.length) throw new Error("sitemap has no pages");
      return locs;
    },
    deps,
    retryMs,
  );
}

/** Drops verdicts that are no longer trusted (see verdictFresh). */
export function pruneVerdicts(verdicts: Record<string, DonationVerdict>, now: string): Record<string, DonationVerdict> {
  const out: Record<string, DonationVerdict> = {};
  for (const [key, v] of Object.entries(verdicts)) if (verdictFresh(v, now)) out[key] = v;
  return out;
}

/** A passing verdict is trusted for VERDICT_DAYS, a failing one for FAILED_VERDICT_DAYS; one with a bad time not at all. */
export function verdictFresh(v: DonationVerdict, now: string): boolean {
  return isFresh(v.checked, now, v.ok ? VERDICT_DAYS : FAILED_VERDICT_DAYS);
}

function isFresh(checked: string, now: string, days: number): boolean {
  const age = Date.parse(now) - Date.parse(checked);
  return Number.isFinite(age) && age >= -DAY_MS && age < days * DAY_MS;
}

export interface RefreshOptions {
  /** Most platform probes this run (default 40). */
  batch?: number;
  /** Days before a platform answer is asked again (default 7). */
  recheckDays?: number;
  /** Probe only these country codes, e.g. the globe's. */
  probeCodes?: string[];
  pauseMs?: number;
  retryMs?: number;
}

/**
 * Refreshes the registry: IFRC GO's societies, up to `batch` platform
 * probes, and UN Crisis Relief's sitemap. Each source that fails, or
 * comes back empty, keeps the previous run's data. Old verdicts are
 * pruned. Never throws.
 */
export async function refreshRegistry(
  prev: DonationRegistry | null,
  deps: FetchDeps,
  now: string,
  resolve: CountryResolver,
  opts: RefreshOptions = {},
): Promise<DonationRegistry> {
  const base = prev ?? emptyRegistry();
  const retryMs = opts.retryMs ?? 5_000;
  const rows = await fetchGoCountries(deps, retryMs);
  const fresh = rows ? toSocieties(rows, base.societies) : {};
  const gotSocieties = Object.keys(fresh).length > 0;
  if (rows && !gotSocieties) deps.log("IFRC GO countries: no societies in the list; previous data kept");
  const societies: Record<string, RegistrySociety> = gotSocieties ? fresh : { ...base.societies };

  try {
    const codes = nextToCheck(societies, now, opts.batch ?? PLATFORM_BATCH, opts.recheckDays ?? RECHECK_DAYS, opts.probeCodes);
    const answers = await probePlatform(codes, deps, opts.pauseMs ?? 500);
    for (const [code, donate] of Object.entries(answers)) societies[code] = { ...societies[code], donate, checked: now };
  } catch (err) {
    deps.log(`Donation platform: ${message(err)}`);
  }

  const locs = await fetchUncrLocs(deps, retryMs);
  const uncr = locs ? toUncr(locs, resolve) : null;
  const gotUncr = uncr !== null && Object.keys(uncr.pages).length > 0;
  if (uncr && !gotUncr) deps.log("UN Crisis Relief sitemap: no country pages; previous data kept");

  return {
    updated: now,
    fetched: { societies: gotSocieties ? now : base.fetched.societies, uncr: gotUncr ? now : base.fetched.uncr },
    societies,
    uncr: gotUncr ? uncr.pages : base.uncr,
    uncrGeneral: gotUncr ? uncr.general : base.uncrGeneral,
    verdicts: pruneVerdicts(base.verdicts, now),
  };
}

// ---------------------------------------------------------------------------
// The allowlist
// ---------------------------------------------------------------------------

export interface DonationContext {
  /** The disaster's globe country codes. */
  countries: string[];
  /** Registry society entries for those countries: hosts, or host and folder (see siteScope). */
  societyHosts: string[];
  /**
   * Codes whose paths on the donation platform are allowed: those of the
   * disaster's societies (a territory's parent's) that the probe found on
   * the platform. None when left out: other paths can land on IFRC's
   * movement-wide campaign, which is no society's own page.
   */
  platformCodes?: string[];
  /** Government suffixes by country; defaults to pipeline/config/donation-domains.json. */
  governmentDomains?: Record<string, string[]>;
}

const domainCache = new Map<string, Record<string, string[]>>();

/** Government domain suffixes by country code, from pipeline/config/donation-domains.json (cached). */
export function loadGovernmentDomains(path = DOMAINS_PATH): Record<string, string[]> {
  let domains = domainCache.get(path);
  if (!domains) {
    const raw = JSON.parse(fs.readFileSync(path, "utf8")) as { domains?: Record<string, unknown> };
    domains = {};
    for (const [code, list] of Object.entries(raw.domains ?? {})) {
      if (Array.isArray(list)) domains[code.toUpperCase()] = list.filter((d): d is string => typeof d === "string").map((d) => d.toLowerCase());
    }
    domainCache.set(path, domains);
  }
  return domains;
}

/** The allowlist context for a disaster in these countries. */
export function donationContext(countries: string[], registry: DonationRegistry, governmentDomains = loadGovernmentDomains()): DonationContext {
  const societyHosts = new Set<string>();
  const platformCodes = new Set<string>();
  for (const code of countries) {
    const own = registry.societies[code.toUpperCase()];
    const society = societyOf(code, registry);
    society?.hosts.forEach((h) => societyHosts.add(h));
    if (society?.donate) platformCodes.add(own?.parent && registry.societies[own.parent] ? own.parent : code.toUpperCase());
  }
  return { countries, societyHosts: [...societyHosts], platformCodes: [...platformCodes], governmentDomains };
}

/** What kind of official site a host belongs to, for this disaster; null when it is on no list. */
export type HostClass = "society" | "platform" | "un" | "agency" | "government";

/** Classifies an already parsed https URL against the allowlist. */
export function hostClass(url: URL, ctx: DonationContext): HostClass | null {
  const host = url.hostname;
  if (host === PLATFORM_HOST) {
    const cc = url.pathname.split("/")[1]?.toUpperCase() ?? "";
    return (ctx.platformCodes ?? []).some((c) => c.toUpperCase() === cc) ? "platform" : null;
  }
  if (ctx.societyHosts.some((h) => inSiteScope(url, h))) return "society";
  if (UN_DOMAINS.some((d) => hostMatches(host, d))) return "un";
  if (UN_AGENCY_DOMAINS.some((d) => hostMatches(host, d)) || MOVEMENT_DOMAINS.some((d) => hostMatches(host, d))) return "agency";
  const gov = ctx.governmentDomains ?? loadGovernmentDomains();
  if (ctx.countries.some((c) => (gov[c.toUpperCase()] ?? []).some((d) => hostMatches(host, d)))) return "government";
  return null;
}

/** Blood-donation pages share words with money donation on society sites; they are never a donation link here. */
export function isBloodDonationPath(url: URL): boolean {
  let path = url.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep the raw path
  }
  return /blood|sangre|sangue|blut|bloed|blod|krew|kraujo|d[eu]-sang|kan-?bag|献血|헌혈|เลือด/i.test(foldText(path));
}

/**
 * Why a URL may not be shown as a donation link, or null when it may.
 * https only; no credentials, port, IP address, punycode or shortener;
 * the host must be a registry society host of one of the disaster's
 * countries, that society's path on the donation platform (only when the
 * probe found it there), the IFRC / ICRC / UN family, or a government
 * domain of one of the countries.
 */
export function donationUrlProblem(raw: string, ctx: DonationContext): string | null {
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
  if (!hostClass(url, ctx)) return "host not on the allowlist";
  if (isBloodDonationPath(url)) return "blood donation page";
  return null;
}

/** True when a URL may be shown as a donation link for this disaster (see donationUrlProblem). */
export function isAllowedDonationUrl(url: string, ctx: DonationContext): boolean {
  return donationUrlProblem(url, ctx) === null;
}

// ---------------------------------------------------------------------------
// The donation-word check
// ---------------------------------------------------------------------------

/**
 * Words and phrases that mean "donate" on a page, by language. A page
 * passes when it has one of them. "word*" is a stem (any ending); other
 * terms must stand alone. Words written without spaces between them
 * (Chinese, Japanese, Korean, Thai, Lao, Khmer, Burmese) and words that
 * take attached prefixes (Arabic, Persian, Urdu, Hebrew) match anywhere.
 * Plain "give", "contribute" and "appeal" are left out on purpose: a real
 * gov.uk page about tribunal appeals has both "appeal" and "contribute".
 * The check only shows a page is about giving; the allowlist is what
 * makes it safe.
 */
export const DONATION_TERMS: Readonly<Record<string, readonly string[]>> = {
  en: ["donat*", "give now", "give today", "give online", "give monthly", "ways to give", "make a gift", "contribute now", "contribute today", "emergency appeal"],
  fr: ["faire un don", "un don", "je donne", "dons en ligne"],
  ht: ["fè yon don"],
  // not "spende*": English "spender"
  de: ["spende", "spendet", "spenden*"],
  nl: ["doneer*", "doneren", "geef nu"],
  da: ["giv en gave", "indsamling*"],
  no: ["gi en gave", "innsamling*"],
  sv: ["ge en gåva", "insamling*"],
  fi: ["lahjoit*"],
  es: ["donar", "dona ahora", "dona ya", "donac*"],
  // not plain "doar": in Romanian it means "only"
  pt: ["doar agora", "quero doar", "como doar", "doe agora", "doe já", "doaç*"],
  it: ["dona ora", "donaz*"],
  ro: ["donează*"],
  pl: ["darowizn*", "wpłać*"],
  cs: ["daruj*", "darov*"],
  hu: ["adomány*"],
  hr: ["donir*"],
  sq: ["dhuro*", "dhurim*"],
  et: ["anneta*"],
  lv: ["ziedo*"],
  lt: ["aukok*", "aukot*", "paaukok*"],
  el: ["δωρεά", "δωρεές", "δωρεών"],
  tr: ["bağış*"],
  az: ["ianə*"],
  ru: ["пожертв*", "донат*", "задонат*"],
  uk: ["благодійний внесок"],
  be: ["ахвяраван*"],
  bg: ["дарени*", "дари", "дарете"],
  sr: ["донир*", "донаци*"],
  mn: ["хандив*"],
  ka: ["შემოწირულ*", "დონაცი*"],
  hy: ["նվիրատվ*", "նվիրաբեր*"],
  uz: ["xayriya*"],
  ar: ["تبرع"],
  fa: ["کمک مالی", "کمک نقدی", "اهدای کمک"],
  ur: ["عطیہ", "عطیات"],
  he: ["תרומ", "לתרום", "תרמו"],
  hi: ["दान"],
  bn: ["দান"],
  si: ["පරිත්\u200dයාග*"],
  ta: ["நன்கொடை*"],
  te: ["విరాళ*"],
  kn: ["ದೇಣಿಗೆ*"],
  ml: ["സംഭാവന*"],
  gu: ["દાન"],
  pa: ["ਦਾਨ"],
  id: ["donasi", "sumbang*"],
  ms: ["derma", "dermakan"],
  tl: ["donasyon"],
  vi: ["quyên góp", "ủng hộ ngay"],
  th: ["บริจาค"],
  lo: ["ບໍລິຈາກ"],
  km: ["បរិច្ចាគ"],
  my: ["လှူဒါန်း", "အလှူ"],
  zh: ["捐"],
  ja: ["寄付", "寄附", "募金", "義援金"],
  ko: ["기부", "성금", "후원하기"],
  sw: ["changia", "toa mchango"],
  am: ["ልገሳ*", "ይለግሱ"],
  so: ["tabaruc*"],
};

/**
 * Folds text so spellings line up: lower case, Latin/Greek/Cyrillic
 * accents and Arabic/Hebrew vowel marks removed, zero-width joiners
 * dropped, Turkish dotless i made plain. Applied to terms and pages alike.
 */
export function foldText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u064b-\u065f\u0670\u0591-\u05c7]/g, "")
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
    .replace(/ı/g, "i")
    .normalize("NFC");
}

const ANYWHERE_SCRIPTS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Arabic}\p{Script=Hebrew}]/u;

interface CompiledTerm {
  term: string;
  /** Cheap substring test before the regex. */
  needle: string;
  re: RegExp;
}

/** Escapes regex syntax characters (only those: unicode-mode regexes reject other escapes such as "\-"). */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** Turns one DONATION_TERMS entry into a regex over folded text. */
export function compileTerm(term: string): CompiledTerm {
  const stem = term.endsWith("*");
  const word = foldText(stem ? term.slice(0, -1) : term);
  const parts = word.split(/\s+/);
  const body = parts.map(escapeRegExp).join("\\s+");
  if (ANYWHERE_SCRIPTS.test(word)) return { term, needle: parts[0], re: new RegExp(body, "u") };
  const edge = "[\\p{L}\\p{M}\\p{N}]";
  return { term, needle: parts[0], re: new RegExp(`(?<!${edge})${body}${stem ? "" : `(?!${edge})`}`, "u") };
}

const COMPILED_TERMS: CompiledTerm[] = Object.values(DONATION_TERMS).flat().map(compileTerm);

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Decodes numeric and the common named HTML entities. */
export function decodeEntities(s: string): string {
  const cp = (n: number, m: string) => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m);
  return s
    .replace(/&#x([0-9a-f]{1,6});/gi, (m, h) => cp(parseInt(h, 16), m))
    .replace(/&#(\d{1,7});/g, (m, d) => cp(Number(d), m))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

/**
 * The text a reader or a screen reader meets on a page: the text between
 * tags (inline script data included, since some donation pages are
 * JavaScript apps whose words live there), plus labels in attributes
 * (meta content, title, alt, aria-label, button values). Style sheets,
 * comments and URLs in links are left out.
 */
export function pageText(html: string): string {
  const src = html.slice(0, MAX_PAGE_CHARS).replace(/<style\b[\s\S]*?<\/style\s*>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");
  const attrs = [...src.matchAll(/\s(?:aria-label|alt|title|value|placeholder|content)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map((m) => m[1] ?? m[2] ?? "");
  const text = src.replace(/<[^>]*>/g, " ");
  return decodeEntities(`${attrs.join(" ")} ${text}`).replace(/\s+/g, " ");
}

/** The donation terms found on a page, in DONATION_TERMS order. */
export function donationWordsIn(html: string): string[] {
  const text = foldText(pageText(html));
  return COMPILED_TERMS.filter((t) => text.includes(t.needle) && t.re.test(text)).map((t) => t.term);
}

/** True when the page has a donation word in any listed language. */
export function hasDonationWord(html: string): boolean {
  return donationWordsIn(html).length > 0;
}

// ---------------------------------------------------------------------------
// The live check
// ---------------------------------------------------------------------------

/** A live check's outcome, before it is stamped with a time. */
export type PageCheck = Omit<DonationVerdict, "checked">;

/** One pass of the live check; "retry" when the network or server failed. */
async function checkOnce(url: string, deps: FetchDeps, ctx: DonationContext): Promise<PageCheck | "retry"> {
  const chain = [url];
  const fail = (reason: string): PageCheck => ({ ok: false, reason, chain: [...chain] });
  let current = url;
  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      res = await deps.fetch(current, {
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" },
        redirect: "manual",
        signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
      });
    } catch (err) {
      deps.log(`Donation page ${current}: ${message(err)}`);
      return "retry";
    }
    if (res.status >= 300 && res.status < 400) {
      discard(res);
      const location = res.headers.get("location");
      if (!location) return fail(`redirect ${res.status} without a location`);
      if (hop >= MAX_REDIRECTS) return fail(`more than ${MAX_REDIRECTS} redirects`);
      let next: string;
      try {
        next = new URL(location, current).toString();
      } catch {
        return fail("redirect to a bad URL");
      }
      const problem = donationUrlProblem(next, ctx);
      chain.push(next);
      if (problem) return fail(`redirect leaves the allowlist (${problem})`);
      current = next;
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      discard(res);
      deps.log(`Donation page ${current}: HTTP ${res.status}`);
      return "retry";
    }
    if (res.status === 401 || res.status === 403) {
      // Large societies (American, British, Canadian Red Cross) refuse scripts.
      discard(res);
      return { ...fail(`blocked to scripts (HTTP ${res.status})`), blocked: true };
    }
    if (res.status !== 200) {
      discard(res);
      return fail(`HTTP ${res.status}`);
    }
    const type = res.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml\+xml/i.test(type)) {
      discard(res);
      return fail(`not an HTML page (${type || "no type"})`);
    }
    let html: string;
    try {
      html = await res.text();
    } catch (err) {
      deps.log(`Donation page ${current}: ${message(err)}`);
      return "retry";
    }
    const words = donationWordsIn(html);
    return words.length ? { ok: true, reason: `donation word "${words[0]}"`, chain } : fail("no donation word on the page");
  }
}

/**
 * Fetches a page the way a reader's browser would, following at most
 * three redirects by hand so every hop can be held to the allowlist.
 * Passes when the final answer is 200, HTML, with a donation word.
 * Network failures, 429 and 5xx are tried once more after retryMs; null
 * when both attempts fail (no verdict).
 */
export async function checkDonationPage(url: string, deps: FetchDeps, ctx: DonationContext, retryMs = 2_000): Promise<PageCheck | null> {
  const problem = donationUrlProblem(url, ctx);
  if (problem) return { ok: false, reason: problem, chain: [url] };
  for (let i = 1; i <= 2; i++) {
    const result = await checkOnce(url, deps, ctx);
    if (result !== "retry") return result;
    if (i === 1) await deps.sleep(retryMs);
  }
  deps.log(`Donation page ${url}: both attempts failed; not shown this run`);
  return null;
}

/** Cache key for a URL: host without "www.", path without a trailing slash, query without tracking parameters. */
export function urlKey(raw: string): string {
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^www\./, "");
    let path = u.pathname.replace(/\/+$/, "");
    // UN Crisis Relief redirects every page to a copy under its language: /x -> /en/x.
    if (host === "crisisrelief.un.org") path = path.replace(/^\/[a-z]{2}(?=\/|$)/, "");
    const params = [...u.searchParams].filter(([k]) => !/^(utm_.*|_cv)$/i.test(k));
    return `${host}${path}${params.length ? `?${new URLSearchParams(params)}` : ""}`;
  } catch {
    return raw.trim();
  }
}

/** A fresh, passing verdict for url whose every hop is still on this disaster's allowlist; null otherwise. */
export function passingVerdict(url: string, ctx: DonationContext, registry: DonationRegistry, now: string): DonationVerdict | null {
  if (donationUrlProblem(url, ctx)) return null;
  const v = registry.verdicts[urlKey(url)];
  if (!v || !v.ok || !verdictFresh(v, now)) return null;
  return v.chain.every((u) => isAllowedDonationUrl(u, ctx)) ? v : null;
}

/**
 * The live check with its cache in registry.verdicts (the caller writes
 * the registry): a pass is reused for 7 days, a failure for 1. A URL off
 * the allowlist fails at once. A cached pass counts only while every hop
 * it followed is on this disaster's allowlist. Failures caused by the
 * allowlist itself are not cached, since another disaster's countries may
 * allow them.
 */
export async function verifyDonationPage(url: string, deps: FetchDeps, ctx: DonationContext, registry: DonationRegistry, now: string): Promise<boolean> {
  if (donationUrlProblem(url, ctx)) return false;
  const key = urlKey(url);
  const cached = registry.verdicts[key];
  if (cached && verdictFresh(cached, now)) return cached.ok && cached.chain.every((u) => isAllowedDonationUrl(u, ctx));
  const result = await checkDonationPage(url, deps, ctx);
  if (!result) return false;
  if (!result.reason.startsWith("redirect leaves the allowlist")) registry.verdicts[key] = { ...result, checked: now };
  deps.log(`Donation page ${url}: ${result.ok ? "accepted" : "rejected"} (${result.reason})`);
  return result.ok;
}

// ---------------------------------------------------------------------------
// The links for one disaster
// ---------------------------------------------------------------------------

/** A page web research suggested. Nothing in it is trusted until it passes the allowlist and the live check. */
export interface ResearchedPage {
  url: string;
  org: string;
  kind: string;
  note: string;
}

export interface DonationInput {
  /** Globe country codes, primary first. */
  countries: string[];
  appeals: AppealRef[];
  researched: ResearchedPage[];
}

/** One line of model or registry text, safe to show: control and direction-override characters out, whitespace collapsed, cut to max. */
export function cleanText(s: unknown, max: number): string {
  if (typeof s !== "string") return "";
  const t = s
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** "Philippine Red Cross" -> "the Philippine Red Cross"; "The Netherlands Red Cross" -> "the Netherlands Red Cross". */
export function societyLabel(name: string): string {
  return `the ${name.replace(/^the\s+/i, "")}`;
}

/** The kind a researched link is shown as: the given kind when the host backs it up, else the host's own kind. */
export function researchKind(given: string, cls: HostClass): DonationKind {
  const fromHost: DonationKind = cls === "government" ? "government" : cls === "society" || cls === "platform" ? "society" : cls === "un" ? "un" : "agency";
  switch (given.trim().toLowerCase()) {
    case "government":
      return cls === "government" ? "government" : fromHost;
    case "society":
      return cls === "society" || cls === "platform" ? "society" : fromHost;
    case "un":
      return cls === "un" ? "un" : fromHost;
    case "agency":
      return "agency";
    case "appeal":
      return "appeal";
    default:
      return fromHost;
  }
}

/** The appeal to link: an Emergency Appeal before a DREF, then the largest. */
export function pickAppeal(appeals: AppealRef[]): AppealRef | null {
  const valid = appeals.filter((a) => /^[A-Z0-9]{4,16}$/.test(a.code.trim().toUpperCase()));
  const isEmergency = (a: AppealRef) => (/appeal/i.test(a.kind) && !/dref/i.test(a.kind) ? 0 : 1);
  return [...valid].sort((a, b) => isEmergency(a) - isEmergency(b) || b.requested - a.requested)[0] ?? null;
}

function platformLink(s: RegistrySociety, url: string): DonationLink {
  return { label: `Donate to ${societyLabel(s.name)}`, url, org: s.name, kind: "society", note: "On the Red Cross Red Crescent donation platform run by IFRC", via: "registry" };
}

function uncrLink(p: UncrPage): DonationLink {
  return { label: `Donate to UN Crisis Relief for ${p.name}`, url: p.url, org: "UN Crisis Relief", kind: "un", note: `The UN's own donation page for ${p.name}`, via: "registry" };
}

/**
 * The society's own website as IFRC lists it, over https: the link and
 * its live check use https only ("http://www.redcross.org.ph/" becomes
 * "https://www.redcross.org.ph/"). Null when IFRC lists no site.
 */
export function societySiteUrl(s: RegistrySociety): string | null {
  if (!s.url) return null;
  try {
    const u = new URL(s.url);
    if (u.protocol === "http:") u.protocol = "https:";
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The society website to link for a disaster: only when the society is
 * not on the donation platform, and only with a fresh passing live check.
 * IFRC's list is not enough on its own: seen live (2026-10-19), the
 * Bolivian Red Cross's listed domain redirects to a betting site and the
 * Saint Lucia Red Cross's serves a lottery page.
 */
function checkedSocietySite(society: RegistrySociety | null, ctx: DonationContext, registry: DonationRegistry, now: string): { url: string; chain: string[] } | null {
  const url = society && !society.donate ? societySiteUrl(society) : null;
  if (!url) return null;
  const verdict = passingVerdict(url, ctx, registry, now) ?? blockedSocietyVerdict(url, ctx, registry, now);
  return verdict ? { url, chain: verdict.chain } : null;
}

/**
 * The registry's own homepage of a society that refuses scripts (401/403)
 * without leaving its allowlisted host. The page cannot be read, but a
 * hijacked domain would show itself by redirecting elsewhere or serving a
 * page without a donation word, and both of those still fail. Never used
 * for researched deep links, only for the homepage IFRC lists.
 */
function blockedSocietyVerdict(url: string, ctx: DonationContext, registry: DonationRegistry, now: string): DonationVerdict | null {
  const v = registry.verdicts[urlKey(url)];
  if (!v || v.ok || !v.blocked || !verdictFresh(v, now)) return null;
  return v.chain.every((u) => isAllowedDonationUrl(u, ctx)) ? v : null;
}

function societySiteLink(s: RegistrySociety, url: string): DonationLink {
  return { label: `Give to ${societyLabel(s.name)}`, url, org: s.name, kind: "society", note: "Its own website, as listed by IFRC", via: "registry" };
}

function appealLink(a: AppealRef): DonationLink {
  const code = a.code.trim().toUpperCase();
  const name = cleanText(a.name, 80) || code;
  return {
    label: `IFRC appeal: ${name}`,
    url: `${IFRC_APPEAL_PAGE}${encodeURIComponent(code)}`,
    org: "IFRC",
    kind: "appeal",
    note: `The plan and updates for appeal ${code} on ifrc.org; IFRC's donation page lets you give to it`,
    via: "registry",
  };
}

function uncrGeneralLink(registry: DonationRegistry): DonationLink {
  return { label: "Donate to UN Crisis Relief", url: registry.uncrGeneral ?? UNCR_HOME, org: "UN Crisis Relief", kind: "un", note: "The UN's fund for emergencies worldwide", via: "registry" };
}

function ifrcLink(): DonationLink {
  return { label: "Donate to the IFRC", url: IFRC_DONATE, org: "IFRC", kind: "agency", note: "Give to IFRC's global work or choose a specific emergency", via: "registry" };
}

/** Names of the UN and Red Cross bodies on the allowlist, by domain. */
export const KNOWN_ORGS: Readonly<Record<string, string>> = {
  "crisisrelief.un.org": "UN Crisis Relief",
  "unocha.org": "OCHA",
  "un.org": "United Nations",
  "unicef.org": "UNICEF",
  "wfp.org": "World Food Programme",
  "unhcr.org": "UNHCR",
  "who.int": "World Health Organization",
  "iom.int": "IOM",
  "undp.org": "UNDP",
  "unfpa.org": "UNFPA",
  "ifrc.org": "IFRC",
  "icrc.org": "ICRC",
};

/**
 * The organisation behind an allowlisted host, from the registry rather
 * than the model: the society whose site or platform path it is, or the
 * UN or Red Cross body. Null for government sites, whose agency only the
 * page itself names.
 */
export function knownOrg(url: URL, cls: HostClass, countries: string[], registry: DonationRegistry): string | null {
  if (cls === "society" || cls === "platform") {
    const cc = url.pathname.split("/")[1]?.toUpperCase() ?? "";
    for (const code of countries) {
      const s = societyOf(code, registry);
      if (!s) continue;
      const parent = registry.societies[code.toUpperCase()]?.parent;
      if (cls === "platform" ? cc === code.toUpperCase() || cc === parent : s.hosts.some((h) => inSiteScope(url, h))) return s.name;
    }
    return null;
  }
  // Most specific domain first, so crisisrelief.un.org is not named "United Nations".
  const domain = Object.keys(KNOWN_ORGS)
    .sort((a, b) => b.length - a.length)
    .find((d) => hostMatches(url.hostname, d));
  return domain ? KNOWN_ORGS[domain] : null;
}

/** Researched pages with a fresh passing live check, as links (with every URL of their redirect chain, for dedupe). */
export function researchedLinks(input: DonationInput, ctx: DonationContext, registry: DonationRegistry, now: string): { link: DonationLink; urls: string[] }[] {
  const out: { link: DonationLink; urls: string[] }[] = [];
  for (const r of input.researched) {
    if (!r || typeof r.url !== "string") continue;
    const verdict = passingVerdict(r.url, ctx, registry, now);
    const cls = verdict ? hostClass(new URL(r.url), ctx) : null;
    if (!verdict || !cls) continue;
    const url = new URL(r.url);
    const known = knownOrg(url, cls, input.countries, registry);
    const org = known ?? (cleanText(r.org, 80) || url.hostname.replace(/^www\./, ""));
    const label = known && (cls === "society" || cls === "platform") ? `Donate to ${societyLabel(known)}` : `Donate to ${org}`;
    out.push({
      link: { label, url: r.url, org, kind: researchKind(String(r.kind ?? ""), cls), note: cleanText(r.note, 200) || "Found by web research and checked against official sites", via: "research" },
      urls: verdict.chain,
    });
  }
  return out;
}

/**
 * The ordered donation links for one disaster, deduplicated by URL, at
 * most six: the first country's society on the donation platform; UN
 * Crisis Relief's page for the first country that has one; researched
 * pages that passed the live check; the society's own website when it is
 * not on the platform and passed the live check over https (so call
 * prepareDonations, which runs that check, rather than this alone); the
 * IFRC appeal page; then the global fallbacks (UN Crisis Relief's
 * general fund unless a UN Crisis Relief page is already listed, and
 * IFRC's donation page), so there are always two.
 */
export function buildDonations(input: DonationInput, registry: DonationRegistry, now: string, governmentDomains = loadGovernmentDomains()): DonationLink[] {
  const ctx = donationContext(input.countries, registry, governmentDomains);
  const out: DonationLink[] = [];
  const seen = new Set<string>();
  const add = (link: DonationLink, urls: string[] = [link.url]) => {
    const keys = urls.map(urlKey);
    if (out.length >= MAX_LINKS || keys.some((k) => seen.has(k))) return;
    keys.forEach((k) => seen.add(k));
    out.push(link);
  };

  const society = input.countries[0] ? societyOf(input.countries[0], registry) : null;
  if (society?.donate) add(platformLink(society, society.donate));
  const uncr = input.countries.map((c) => registry.uncr[c.toUpperCase()]).find(Boolean);
  if (uncr) add(uncrLink(uncr));
  for (const r of researchedLinks(input, ctx, registry, now).slice(0, MAX_RESEARCHED)) add(r.link, r.urls);
  const site = checkedSocietySite(society, ctx, registry, now);
  if (society && site) add(societySiteLink(society, site.url), [site.url, ...site.chain]);
  const appeal = pickAppeal(input.appeals);
  if (appeal) add(appealLink(appeal));
  if (!out.some((l) => urlKey(l.url).startsWith("crisisrelief.un.org"))) add(uncrGeneralLink(registry));
  add(ifrcLink());
  return out;
}

export interface PrepareOptions {
  /** Most live checks for this disaster (cached verdicts do not count). */
  maxChecks?: number;
  pauseMs?: number;
  governmentDomains?: Record<string, string[]>;
  /**
   * URL keys that could not be reached this run. Share one set across a
   * run's disasters so an unreachable site is tried once, not once per
   * disaster in its country. Not saved: the next run tries again.
   */
  unreachable?: Set<string>;
}

/**
 * Live-checks what a disaster's links need and has no fresh verdict for:
 * the first country's society website over https when the society is not
 * on the platform (one check, shared by every disaster in that country),
 * then its researched pages (at most maxChecks, pausing between them).
 * Then builds its links. Records verdicts in registry.verdicts; the
 * caller writes the registry.
 */
export async function prepareDonations(input: DonationInput, registry: DonationRegistry, deps: FetchDeps, now: string, opts: PrepareOptions = {}): Promise<DonationLink[]> {
  const gov = opts.governmentDomains ?? loadGovernmentDomains();
  const ctx = donationContext(input.countries, registry, gov);
  const unreachable = opts.unreachable ?? new Set<string>();
  // One live check; a URL that gives no verdict (network failure, 5xx) is not tried again this run.
  const check = async (url: string) => {
    const key = urlKey(url);
    if (unreachable.has(key)) return;
    await verifyDonationPage(url, deps, ctx, registry, now);
    if (!registry.verdicts[key]) unreachable.add(key);
    await deps.sleep(opts.pauseMs ?? 500);
  };
  const society = input.countries[0] ? societyOf(input.countries[0], registry) : null;
  const site = society && !society.donate ? societySiteUrl(society) : null;
  const siteVerdict = site ? registry.verdicts[urlKey(site)] : undefined;
  if (site && !(siteVerdict && verdictFresh(siteVerdict, now))) await check(site);
  let checks = 0;
  for (const r of input.researched) {
    if (!r || typeof r.url !== "string") continue;
    const problem = donationUrlProblem(r.url, ctx);
    if (problem) {
      deps.log(`Donation page ${r.url}: rejected (${problem})`);
      continue;
    }
    const cached = registry.verdicts[urlKey(r.url)];
    if ((cached && verdictFresh(cached, now)) || unreachable.has(urlKey(r.url))) continue;
    if (checks >= (opts.maxChecks ?? 4)) break;
    checks++;
    await check(r.url);
  }
  return buildDonations(input, registry, now, gov);
}
