// Direct giving for each disaster: pages that take money straight to the
// people, schools and groups it hit, listed before the official links of
// donate.ts. Three sources, each held to its own fixed rules; a model only
// ever suggests pages, never picks one, names one or labels one:
//
//   GoFundMe      GoFundMe's crisis pages (https://www.gofundme.com/c/act/
//                 <slug>), read by fixed rule without a model. From the page
//                 that belongs to a disaster (hubMatches: its slug or title
//                 names the disaster's country with a hazard of its own
//                 kind, or only place words of its title; hubDatesFit: the
//                 page was published close to the disaster's start): the
//                 page itself, the fund its Donate button leads to and the
//                 fundraisers its Trust & Safety team verified that took
//                 donations since the disaster began, schools and families
//                 first (kind "fundraiser"); and up to two of the nonprofits
//                 it lists as partners, with their pages for the event (kind
//                 "project"). Pages come from GoFundMe's index of current
//                 crises and from any crisis page a disaster's research
//                 found. Cached in cache/gofundme.json, read again at most
//                 every 12 hours, a handful of requests a run; a page, the
//                 index or a feed that failed is not asked for again for 12
//                 hours, a page that moved or is gone for 7 days.
//   GlobalGiving  a project or fund on www.globalgiving.org that the direct
//                 search (research.ts) returned, kept only when its slug or
//                 title names the disaster's place and its hazard (a named
//                 storm by its name), no other country, kind of hazard or
//                 older year, and its storm's name or a recent year dates it
//                 to this disaster; the search's own date is no proof
//                 (globalGivingProblem). GlobalGiving vets its local
//                 partners. It refuses many scripted clients, so there is no
//                 live check.
//   local         a charity's or a local organisation's, school's, parish's
//                 or community group's own donation page for this disaster
//                 that the direct search returned, or that the research or
//                 the official donation search found off donate.ts's
//                 allowlist (allowlistMisses), kept only when
//                 its URL is on no shared, social, blog, site-builder,
//                 marketplace, news, crowdfunding, payment or official site,
//                 has no official body's name in its host and no person's
//                 page's or article's shape in its path (localUrlProblem),
//                 and a live check passes: 200 HTML on the same site, no
//                 news article, no official body's name in its own name,
//                 title or heading (in its own language and script too, the
//                 UN's and regional governments' among them) and no word
//                 mixing Latin with Cyrillic or Greek letters, no request
//                 for crypto, gift card codes or transfers to a person, no
//                 platform's invitation to start a fundraiser, nothing that
//                 dates or names it for an earlier or another disaster (its
//                 own date, other calendars and other countries' names in
//                 its own language included), a donation word, a title
//                 without the site's name, heading or address about this
//                 disaster (its hazard, or a place of its title as a whole
//                 phrase, not just the country) and a name of the
//                 disaster's place, in any script (verifyLocalPage).
//                 It is shown by the site's own name (og:site_name, else its
//                 host) and title, never by the model's words. Verdicts are
//                 cached with donate.ts's, per disaster and rules version.
//
// The integrator refreshes the GoFundMe cache once per run
// (refreshGoFundMe), checks local pages (prepareDirectLinks) and passes the
// links to donate.ts buildDonations, which orders and caps them. Each
// disaster with candidates gets one line in the log (how many passed, were
// refused or wait for a live check), and each refused page one line with
// its reason, at most MAX_PAGE_LOG_LINES of those a run (cappedLog).
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
//     and Node's fetch 200, so a live check there would be unreliable;
//     its project pages carry no date either;
//   - every crisis page dates itself in its JSON-LD (datePublished:
//     Hurricane Melissa 2025-10-28, Venezuela earthquakes 2026-06-26), and
//     old ones stay up and verified: Morocco's 2023 earthquake page
//     (2023-09-09) still lists 80 verified fundraisers. Its slug alone
//     would match any later earthquake in Morocco;
//   - a retired crisis page answers 301 to its new slug (/c/act/
//     hurricane-beryl -> /c/act/hurricane-beryl-help) or 404;
//   - WordPress (Yoast) marks every page og:type "article", GoFundMe's
//     crisis pages too, and gives a group's own posts an Article node and
//     article:published_time, so only a NewsArticle (or a news publisher's
//     node) marks news; its WebPage node's datePublished dates the page;
//   - the first live run (GitHub Actions run 40200477306) listed no direct
//     page: seven direct searches kept none, while the research had found
//     Penny Appeal USA's appeal for the Nuristan floods (pennyappealusa.org/
//     campaigns/emergency-alert-flash-floods-hit-nuristan-afghanistan/,
//     published 2026-07-24) and donate.ts turned it away as off its
//     allowlist. It passes every rule here, so such pages are now offered
//     to these checks too (allowlistMisses).
// A review of these rules (2026-10-25) found general charity pages, other
// countries' and old disasters' pages, look-alikes in other languages and
// scripts, and pages asking for crypto or Zelle accepted, and schools'
// and groups' own pages refused for "news", "gov" or "un" inside a word,
// WordPress paths and posts, founding years and their own scripts. A second
// review found UN look-alikes, other countries named in a page's own
// language, general pages let in by a group's own name, Buddhist, Japanese
// and Nepali years, crypto tickers and addresses, platforms the lists
// missed and search-dated GlobalGiving funds accepted, and US states,
// rewritten donate pages, PAGASA's storm names, founding years in other
// languages and Morocco's names in three scripts refused; the tests hold
// each of those pages.
import fs from "node:fs";
import type { ResearchResult } from "../ai";
import type { FetchDeps } from "../googlenews";
import { USER_AGENT } from "../googlenews";
import { writeJson } from "../io";
import {
  MAX_REDIRECTS,
  NOT_ALLOWLISTED,
  NOT_EVENT_WORDS,
  SHARED_HOSTS,
  SHORTENERS,
  STORM_WORDS,
  asciiWords,
  cleanText,
  compileTerm,
  countriesNamedIn,
  countrySpans,
  decodeEntities,
  donationUrlProblem,
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
  type DonationVerdict,
  type PageCheck,
} from "./donate";
import type { DirectPage, DirectPageKind, ResearchEntry } from "./research";
import { splitScripts } from "./geocode";
import type { Disaster, DisasterType, DonationLink, Place } from "./types";

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
/** A crisis page, the index or a feed that failed to load (an error, a bot wall, a server fault) is not asked for again for this many hours. */
export const FAILED_RETRY_HOURS = 12;
/** A crisis page that is gone (404, 410) or moved to another slug is not asked for again for this many days. */
export const GONE_RETRY_DAYS = 7;
/**
 * A crisis page belongs to a disaster only when GoFundMe published it at
 * most this many days before the disaster started (a feed may date a start
 * a little late) ...
 */
export const HUB_BEFORE_DAYS = 14;
/** ... and at most this many days after: GoFundMe opens one within days of a sudden disaster. */
export const HUB_AFTER_DAYS = 45;
/** Slow disasters get a crisis page later: floods, heat and cold waves months in, a drought within the year. */
const HUB_AFTER_DAYS_SLOW: Partial<Record<DisasterType, number>> = { flood: 120, heatwave: 120, coldwave: 120, dust: 120, drought: 365 };
/** A GlobalGiving or local page the search dated more than this many days before its disaster started is an earlier one's. */
export const PAGE_BEFORE_DAYS = 14;
/** Crisis page URLs kept from one research. */
export const MAX_FOUND_HUBS = 5;
/** Live checks of local groups' pages per disaster per run; the rest use cached verdicts. */
export const MAX_LOCAL_CHECKS = 3;
/** Most log lines a run gives single direct pages (a page refused and why, a page the direct search's parse named but could not keep); the rest are counted. */
export const MAX_PAGE_LOG_LINES = 40;
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

/**
 * Hazard words in crisis page, project and local page slugs and titles,
 * with the disaster types each can name. Strict, so an earthquake page is
 * no landslide's or flood's: an earthquake's words name an earthquake or
 * its tsunami, a flood's only a flood, a storm's a cyclone or a storm (and,
 * by the storm's name, the floods it brings: see stormAftermath).
 */
const HAZARD_WORDS: readonly (readonly [string, readonly DisasterType[]])[] = [
  ["earthquake earthquakes quake quakes seismic terremoto terremotos sismo sismos seisme deprem gempa erdbeben lindol tetemeko cutremur", ["earthquake", "tsunami"]],
  ["tsunami tsunamis", ["tsunami", "earthquake"]],
  ["hurricane hurricanes typhoon typhoons cyclone cyclones huracan huracanes tifon ouragan ciclon furacao uragano kimbunga bagyo bagyong topan siklon", ["cyclone", "storm"]],
  ["storm storms tornado tornadoes tornados windstorm hailstorm tormenta tempete tempestade tempesta sturm orkan badai", ["storm", "cyclone"]],
  ["flood floods flooding floodwaters inundacion inundaciones inondation inondations monsoon banjir enchente enchentes cheias inundacao inundacoes", ["flood"]],
  ["alluvione alluvioni hochwasser uberschwemmung flut mafuriko powodz povodne inundatii riada riadas", ["flood"]],
  ["landslide landslides mudslide mudslides deslizamiento deslizamientos deslizamento deslizamentos glissement longsor frana frane", ["landslide"]],
  ["erdrutsch deslave derrumbe derrumbes huayco heyelan", ["landslide"]],
  ["wildfire wildfires fire fires bushfire bushfires incendio incendios incendie incendies waldbrand kebakaran yangin queimadas", ["wildfire"]],
  ["volcano volcanoes volcanic eruption eruptions volcan volcanes vulcao vulcano vulkan erupcion erupsi letusan", ["volcano"]],
  ["drought droughts famine sequia secheresse kekeringan kemarau ukame durre kuraklik", ["drought"]],
  ["heatwave heatwaves heat canicule hitzewelle", ["heatwave"]],
  ["coldwave cold winter", ["coldwave"]],
  ["blizzard blizzards snowstorm snowstorms", ["coldwave", "storm"]],
  ["sandstorm duststorm dust", ["dust"]],
];
const HAZARD_TYPES: ReadonlyMap<string, ReadonlySet<DisasterType>> = (() => {
  const map = new Map<string, Set<DisasterType>>();
  for (const [words, types] of HAZARD_WORDS) for (const w of words.split(" ")) map.set(w, new Set([...(map.get(w) ?? []), ...types]));
  return map;
})();
/**
 * Hazards named in scripts written without the Latin alphabet, or in more
 * than one word, by the English hazard word they stand for: 地震 and
 * زلزال for an earthquake, น้ำท่วม for a flood, "tremblement de terre".
 * Matched in folded text as donation words are (compileTerm: anywhere in
 * scripts without spaces, else as whole words; "*" ends a stem).
 */
const LOCAL_HAZARD_TERMS: Readonly<Record<string, readonly string[]>> = {
  earthquake: [
    "地震", "지진", "แผ่นดินไหว", "ແຜ່ນດິນໄຫວ", "រញ្ជួយដី", "ငလျင်", "زلزال", "زلازل", "زلزله", "भूकंप", "भूकम्प", "ভূমিকম্প", "землетрясени*", "землетрус*", "σεισμ*",
    "רעידת אדמה", "tremblement de terre", "trzęsienie ziemi", "động đất", "gempa bumi",
  ],
  tsunami: ["津波", "海啸", "海嘯", "쓰나미", "해일", "สึนามิ", "تسونامي", "सुनामी", "цунами"],
  cyclone: ["台風", "台风", "颱風", "태풍", "ไต้ฝุ่น", "إعصار", "चक्रवात", "ঘূর্ণিঝড়", "ураган*", "тайфун*", "циклон*", "κυκλων*", "cơn bão", "siêu bão"],
  storm: ["暴風", "风暴", "風暴", "폭풍", "พายุ", "عاصفة", "तूफान", "तूफ़ान", "буря", "шторм*", "καταιγ*"],
  flood: [
    "洪水", "水害", "豪雨", "浸水", "冠水", "大雨", "水灾", "洪灾", "内涝", "水災", "홍수", "수해", "침수", "폭우", "น้ำท่วม", "อุทกภัย", "ນ້ຳຖ້ວມ", "ទឹកជំនន់",
    "ရေကြီး", "فيضان", "فيضانات", "سيول", "سیلاب", "बाढ़", "बाढ", "बाढी", "বন্যা", "наводнени*", "паводк*", "паводок", "повін*", "повен*", "πλημμυρ*", "שיטפון", "lũ lụt",
    "ngập lụt",
  ],
  landslide: [
    "土砂崩れ", "土砂災害", "山崩れ", "がけ崩れ", "滑坡", "泥石流", "산사태", "ดินถล่ม", "انهيار أرضي", "انهيارات أرضية", "भूस्खलन", "पहिरो", "ভূমিধস", "оползн*", "оползень", "κατολισθ*",
    "sạt lở", "tanah longsor", "glissement de terrain",
  ],
  wildfire: [
    "山火事", "林野火災", "森林火灾", "森林火災", "山火", "산불", "ไฟป่า", "حرائق", "حريق", "डढेलो", "দাবানল", "пожар*", "πυρκαγι*", "שריפ*", "kebakaran hutan", "incendio forestal",
    "incendios forestales", "orman yangını",
  ],
  volcano: ["噴火", "火山", "화산", "ภูเขาไฟ", "بركان", "ज्वालामुखी", "вулкан*", "ηφαιστει*", "gunung api"],
  drought: ["干ばつ", "干旱", "旱灾", "旱災", "가뭄", "ภัยแล้ง", "جفاف", "सूखा", "খরা", "засух*", "ξηρασι*"],
  heatwave: ["熱波", "猛暑", "热浪", "熱浪", "폭염", "คลื่นความร้อน", "موجة حر", "लू", "жара", "καυσων*", "ola de calor", "onda de calor", "vague de chaleur"],
  coldwave: ["寒波", "寒潮", "한파", "ภัยหนาว", "موجة برد", "शीत लहर", "ola de frío", "vague de froid", "onda de frio"],
  dust: ["沙尘暴", "砂嵐", "黄砂", "황사", "عاصفة ترابية", "عاصفة رملية"],
};
const COMPILED_HAZARD_TERMS: readonly { word: string; term: ReturnType<typeof compileTerm> }[] = Object.entries(LOCAL_HAZARD_TERMS).flatMap(([word, terms]) =>
  terms.map((t) => ({ word, term: compileTerm(t) })),
);

/** The English hazard words for the hazards a text names in other scripts or in several words ("ช่วยน้ำท่วมเชียงราย" -> ["flood"]), each once. */
export function hazardWordsIn(text: string): string[] {
  const t = foldText(text);
  const out = new Set<string>();
  for (const { word, term } of COMPILED_HAZARD_TERMS) if (t.includes(term.needle) && term.re.test(t)) out.add(word);
  return [...out];
}

/** Whether words name a hazard, and whether it can be this type: "none", "fits" or "other". */
export function hazardFit(words: readonly string[], type: DisasterType): "none" | "fits" | "other" {
  const named = words.map((w) => HAZARD_TYPES.get(w)).filter((t): t is ReadonlySet<DisasterType> => t !== undefined);
  if (named.length === 0) return "none";
  return named.some((t) => t.has(type)) ? "fits" : "other";
}

/**
 * True for a storm's page read for the floods or landslides it brings:
 * the disaster is a flood or landslide, the words name a storm, and every
 * other hazard they name is of the disaster's kind. Only a page that also
 * names the storm itself (a place word of the disaster's title, as
 * "Jamaica: Floods after Hurricane Melissa") is taken this way.
 */
export function stormAftermath(words: readonly string[], type: DisasterType): boolean {
  if (type !== "flood" && type !== "landslide") return false;
  const named = words.filter((w) => HAZARD_TYPES.has(w));
  return named.some((w) => STORM_WORDS.has(w)) && named.every((w) => STORM_WORDS.has(w) || HAZARD_TYPES.get(w)?.has(type));
}

/** Words of crisis page titles that name nothing: "How you can help: Venezuela earthquakes". */
const HUB_FILLER = new Set("how you can help those impacted affected donate verified fundraiser fundraisers gofundme official ways way give giving page".split(" "));

/** Words that follow a storm word without naming a storm: "hurricane relief", "storm season", "typhoon survivors". */
const STORM_FOLLOWERS: ReadonlySet<string> = new Set(
  [
    "relief recovery response season seasons victims survivors survivor damage damages damaged appeal fund funds aid emergency donations donate help",
    "support impact impacts impacted affected aftermath warning warnings watch preparedness prepare shelter shelters cleanup clean rebuild rebuilding",
    "repair repairs kits supplies center centre centers hits hit strikes struck batters battered approaches update updates news live tracker path",
    "category landfall families family homes home schools school efforts effort ravaged zone areas area causes cause project projects fundraiser",
    "fundraisers drive crisis disaster disasters names name force victim and the for with after from",
  ]
    .join(" ")
    .split(" "),
);

/**
 * The storms a disaster's title names: each place word of the title
 * (eventWords) that follows a storm word, and their other names
 * (stormNames: PAGASA's "tino" for Typhoon Kalmaegi). "Hurricane Melissa"
 * -> ["melissa"]; "Philippines: Southwest Monsoon enhanced by Tropical
 * Cyclones Maymay and Dolphin" -> ["maymay"]; "Flood in Poland" -> [].
 */
export function disasterStorms(ctx: Pick<DonationContext, "eventWords" | "title" | "stormNames">): string[] {
  const place = new Set(ctx.eventWords ?? []);
  const words = asciiWords(ctx.title ?? "");
  return [...new Set([...words.filter((w, i) => i > 0 && STORM_WORDS.has(words[i - 1]) && place.has(w)), ...(ctx.stormNames ?? [])])];
}

/**
 * The name of a storm the words name that is not the disaster's: a storm
 * word ("hurricane", "storm", "huracan") followed by a word of three or
 * more letters that is no place word of the disaster's title, no country's
 * name, no hazard or generic word and no word that follows storms
 * ("relief", "season"). ["hurricane", "beryl"] for Hurricane Melissa ->
 * "beryl"; null when there is none. Only a storm (type cyclone or storm),
 * or a disaster whose title names a storm (disasterStorms), has another
 * storm: for "Flood in Poland", "Storm Boris flood relief" names the storm
 * that brought the flood.
 */
export function otherStorm(words: readonly string[], ctx: MatchContext, type?: DisasterType): string | null {
  if (type !== "cyclone" && type !== "storm" && disasterStorms(ctx).length === 0) return null;
  const title = new Set(ctx.eventWords ?? []);
  for (let i = 0; i + 1 < words.length; i++) {
    if (!STORM_WORDS.has(words[i])) continue;
    const next = words[i + 1];
    if (!/^[a-z]{3,}$/.test(next) || title.has(next) || NOT_EVENT_WORDS.has(next) || HUB_FILLER.has(next) || STORM_FOLLOWERS.has(next) || HAZARD_TYPES.has(next)) continue;
    if (ctx.countryNameIndex && countriesNamedIn([next], ctx.countryNameIndex).length > 0) continue;
    return next;
  }
  return null;
}

/** Folded words and numbers of a slug or title: "Hurricane-Melissa-2025" -> ["hurricane", "melissa", "2025"]. */
export function slugWords(text: string): string[] {
  return foldText(text).split(/[^a-z0-9]+/).filter(Boolean);
}

/** What the matching rules read of a disaster's allowlist context: every country's names, its title, the title's place words and its storms' other names. */
export type MatchContext = Pick<DonationContext, "countryNameIndex" | "eventWords" | "title" | "stormNames">;

/**
 * Words before a year that say when a group began or was registered, not
 * when a disaster struck, in folded text: "since 1952", "est. 1998",
 * "fundada en 1985", "Reg. 1995", Indonesian "sejak 1990", Swahili "tangu
 * 1990", Tagalog "itinatag noong 1990", Turkish "kuruluş 1990", Russian
 * "основан в 1990", Arabic "منذ 1990" and "تأسست عام 1990", Hindi and
 * Nepali "स्थापना 1990".
 */
const FOUNDED_BEFORE: readonly string[] = [
  "since", "serving\\s+since", "est", "estd", "established", "founded", "desde", "depuis", "seit", "fondee?", "fundad[ao]", "cread[ao]", "gegrundet",
  "reg", "regd", "registered(?:\\s+(?:charity|society|trust|ngo|nonprofit|non-profit))?(?:\\s+(?:no|number|nr))?", "registration(?:\\s+(?:no|number))?",
  "sejak(?:\\s+tahun)?", "berdiri(?:\\s+sejak)?(?:\\s+tahun)?", "didirikan(?:\\s+pada)?(?:\\s+tahun)?", "ditubuhkan(?:\\s+pada)?(?:\\s+tahun)?",
  "tangu(?:\\s+mwaka)?", "ilianzishwa(?:\\s+mwaka)?", "itinatag(?:\\s+noong)?", "mula\\s+noong", "kurulus(?:\\s+yili)?", "thanh\\s+lap(?:\\s+nam)?",
  "tu\\s+nam", "основан[аоы]?(?:\\s+в)?", "с", "منذ(?:\\s+(?:عام|سنة))?", "تاسست?(?:\\s+(?:عام|سنة|في))?", "स्थापना(?:\\s+वर्ष)?", "स्थापित",
];
/** The same in scripts written without spaces, with or without one before the year: Japanese 設立 and 創立, Thai ตั้งแต่ปี and ก่อตั้ง. */
const FOUNDED_BEFORE_CLOSE: readonly string[] = ["設立", "創立", "創業", "ตั้งแต่(?:ปี)?", "ก่อตั้ง(?:ขึ้น)?(?:เมื่อ)?(?:ปี)?"];
/** Words after a year that say the same: Japanese "1990年設立", Turkish "1990 yılından beri" and "1990'dan beri", Nepali "2047 सालमा स्थापित". */
const FOUNDED_AFTER: readonly string[] = [
  "\\s*年\\s*(?:に)?(?:設立|創立|創業|開設)", "\\s*(?:yilindan\\s+beri|yilinda\\s+kuruldu)", "\\s*['’]?(?:dan|den|tan|ten)\\s+beri", "\\s*(?:मा|में)\\s*(?:स्थापित|स्थापना)",
  "\\s*(?:सालमा|साल\\s+मा)\\s*स्थापित", "\\s*(?:года|г\\.)?\\s*основан",
];
const YEAR_RE = "(?:19|20)\\d\\d";
const FOUNDED_YEAR = new RegExp(
  [
    `(?<![\\p{L}\\p{M}\\p{N}])(?:${FOUNDED_BEFORE.join("|")})\\.?\\s*(?::\\s*)?(?:(?:in|en|em|el|le|im|pada|tahun|noong|nam|в|عام|سنة)\\s+)?${YEAR_RE}(?!\\p{N})`,
    `(?:${FOUNDED_BEFORE_CLOSE.join("|")})\\s*(?:พ\\.?\\s*ศ\\.?\\s*)?${YEAR_RE}(?!\\p{N})`,
    `(?<!\\p{N})${YEAR_RE}(?:${FOUNDED_AFTER.join("|")})`,
  ].join("|"),
  "gu",
);
/** A season, financial year or programme that runs across years: "2025-26", "2025/2026", "2025–2027". */
const YEAR_SPAN = /(?<![a-z0-9])((?:19|20)\d\d)\s*[-/–—]\s*((?:19|20)?\d\d)(?![a-z0-9])/g;

/** The zero of each script whose digits pages write years in: Arabic-Indic, Persian, Devanagari, Bengali, Thai, Lao, Khmer, Myanmar and full-width. */
const DIGIT_ZEROS: readonly number[] = [0x0660, 0x06f0, 0x0966, 0x09e6, 0x0e50, 0x0ed0, 0x17e0, 0x1040, 0xff10];
const OTHER_DIGITS = /[\u0660-\u0669\u06f0-\u06f9\u0966-\u096f\u09e6-\u09ef\u0e50-\u0e59\u0ed0-\u0ed9\u17e0-\u17e9\u1040-\u1049\uff10-\uff19]/g;

/** A text with its digits in other scripts written as ASCII digits: "भूकम्प २०७२" -> "भूकम्प 2072". */
export function asciiDigits(text: string): string {
  return text.replace(OTHER_DIGITS, (ch) => {
    const cp = ch.codePointAt(0) as number;
    return String(cp - (DIGIT_ZEROS.find((z) => cp >= z && cp <= z + 9) ?? cp));
  });
}

/** Japan's eras by the year before their first: 令和元年 is 2019, 平成元年 1989, 昭和元年 1926. */
const ERAS: Readonly<Record<string, number>> = { 令和: 2018, 平成: 1988, 昭和: 1925 };
const KANJI_DIGITS = "一二三四五六七八九";

/** An era's year as written: "元" (its first), "6", "六", "十二", "二十"; null when it reads as none. */
function eraNumber(s: string): number | null {
  if (s === "元") return 1;
  if (/^\d{1,2}$/.test(s)) return Number(s);
  const digit = (c?: string) => (c ? KANJI_DIGITS.indexOf(c) + 1 : 0);
  const m = /^([一二三四五六七八九])?(十)?([一二三四五六七八九])?$/.exec(s);
  if (!m || !s) return null;
  if (!m[2]) return m[1] && !m[3] ? digit(m[1]) : null;
  return (m[1] ? digit(m[1]) : 1) * 10 + digit(m[3]);
}

/**
 * A text with years of other calendars written as the latest Gregorian
 * year they can be (so a year that fits the disaster is never read as an
 * older one): digits in other scripts as ASCII; Japanese era years
 * (令和6年 -> 2024年, 平成7年 -> 1995年); on pages in Thai, Lao or Khmer
 * script, Buddhist Era years (2567 -> 2024); and on pages in Devanagari,
 * Nepal's Bikram Sambat years, which run 56 to 57 years ahead (२०७२, the
 * Gorkha earthquake's year, -> 2016; no Gregorian year a page gives for an
 * event is that far ahead).
 */
export function gregorianYears(text: string): string {
  let t = asciiDigits(text).replace(/(令和|平成|昭和)\s*(元|\d{1,2}|[一二三四五六七八九十]{1,3})\s*年/g, (m, era: string, n: string) => {
    const year = eraNumber(n);
    return year === null ? m : `${ERAS[era] + year}年`;
  });
  if (/[\u0e00-\u0eff\u1780-\u17ff]/.test(t)) t = t.replace(/(?<!\d)(25\d\d)(?!\d)/g, (m, y: string) => String(Number(y) - 543));
  if (/[\u0900-\u097f]/.test(t)) t = t.replace(/(?<!\d)(20[4-9]\d)(?!\d)/g, (m, y: string) => String(Number(y) - 56));
  return t;
}

/**
 * The years a text gives for an event, as four-digit Gregorian numbers
 * (other calendars and scripts read by gregorianYears): a founding or
 * registration year ("since 1952", "est. 1998", "sejak 1990", "1990年設立")
 * is no event's, and a span of up to five years ("2025-26 Bushfire Appeal",
 * "Recovery 2025–2027") counts as its last. "Hurricane Relief 2024" ->
 * [2024]; "บริจาคช่วยน้ำท่วม 2567" -> [2024]; "令和6年能登半島地震" -> [2024].
 */
export function eventYearsIn(text: string): number[] {
  const t = foldText(gregorianYears(text))
    .replace(FOUNDED_YEAR, " ")
    .replace(YEAR_SPAN, (m, a: string, b: string) => {
      const start = Number(a);
      const end = b.length === 2 ? Math.floor(start / 100) * 100 + Number(b) : Number(b);
      return end > start && end - start <= 5 ? ` ${end} ` : m;
    });
  return [...t.matchAll(/(?<![a-z0-9])(?:19|20)\d\d(?![a-z0-9])/g)].map((m) => Number(m[0]));
}

/** A URL path as words can be read from it: escapes undone, and segments that are only a number ("/node/2019", a record's number, not a year) left out. */
export function readablePath(url: string): string {
  let path: string;
  try {
    path = decodeURIComponentSafe(new URL(url).pathname);
  } catch {
    return "";
  }
  return path
    .split("/")
    .filter((seg) => !/^\d+$/.test(seg))
    .join("/");
}

/** What texts name: their folded words and numbers, and the hazards they name in other scripts or in several words (hazardWordsIn). */
function readTexts(texts: readonly string[]): { words: string[]; hazards: string[] } {
  return { words: texts.flatMap((t) => slugWords(t)), hazards: [...new Set(texts.flatMap(hazardWordsIn))] };
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

/**
 * Countries whose names are a disaster country's place names too: for a
 * disaster in the United States, Georgia and Jersey ("South Georgia",
 * "the Jersey Shore") are its states' names, so a page that names them
 * names no other country.
 */
const STATE_NAMES: Readonly<Record<string, readonly string[]>> = { US: ["GE", "JE"] };

/** The countries a disaster's pages may name as their own, and the countries whose names are the disaster's states' (STATE_NAMES). */
function ownCodes(countries: readonly string[]): { own: Set<string>; states: Set<string> } {
  const own = new Set(countries.map((c) => c.toUpperCase()));
  return { own, states: new Set([...own].flatMap((c) => STATE_NAMES[c] ?? [])) };
}

/**
 * The keys of the country names inside a disaster's own place names (its
 * places, their provinces, their own names and its title's places), which
 * name no other country: "Panama City" holds "panama", "Jersey Shore
 * Region" holds "jersey".
 */
function placeKeys(places: readonly string[], index: Record<string, string[]> | undefined): Set<string> {
  if (!index) return new Set();
  return new Set(places.flatMap((p) => countrySpans(asciiWords(p), index).map((s) => s.key)));
}

/**
 * What a run of words says of a disaster's countries and its title's
 * places. A country's name inside one of the disaster's own place names
 * (ownPlaces: "Panama City" for a Florida hurricane) and, for a disaster
 * in the United States, Georgia and Jersey (STATE_NAMES) are not read as
 * countries.
 */
function readWords(words: readonly string[], countries: readonly string[], ctx: MatchContext, ownPlaces: readonly string[] = []): Reading {
  const { own, states } = ownCodes(countries);
  const skip = placeKeys(ownPlaces, ctx.countryNameIndex);
  const named = (ctx.countryNameIndex ? countrySpans(words, ctx.countryNameIndex) : [])
    .filter((s) => !skip.has(s.key) && !(s.codes.some((c) => states.has(c)) && !s.codes.some((c) => own.has(c))))
    .map((s) => s.codes);
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

/** A disaster's own place names, as readWords and foreignCountryIn leave them be: its places' names and provinces. */
function disasterPlaceNames(d: Partial<Pick<Disaster, "places">>): string[] {
  return (d.places ?? []).flatMap((p) => [p.name, p.admin ?? ""]).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Country names in other languages
// ---------------------------------------------------------------------------

/** Languages every local page is read in for other countries' names, besides its disaster's countries' own. */
export const FOREIGN_NAME_LANGUAGES: readonly string[] = ["es", "fr", "pt", "ar", "id", "tr", "ru", "zh", "ja", "th", "de", "it"];

/** A country's main language as CLDR has it ("MA" -> "ar", "TW" -> "zh-Hant"); null when it has none. */
function mainLanguage(code: string): string | null {
  try {
    const locale = new Intl.Locale(`und-${code}`).maximize();
    return locale.script && locale.language === "zh" ? `${locale.language}-${locale.script}` : locale.language;
  } catch {
    return null;
  }
}

/**
 * The languages a disaster's local pages are read in for other countries'
 * names: each of its countries' press language (pipeline/config/
 * languages.json) and main language, then FOREIGN_NAME_LANGUAGES; only
 * those the runtime names countries in, each once.
 */
export function nameLanguages(countries: readonly string[], pressLanguages: Readonly<Record<string, string>> = {}): string[] {
  const out: string[] = [];
  const add = (lang: string | null | undefined) => {
    const l = (lang ?? "").trim();
    if (!l || out.includes(l)) return;
    try {
      if (Intl.DisplayNames.supportedLocalesOf([l]).length > 0) out.push(l);
    } catch {
      // not a language tag
    }
  };
  for (const c of countries) {
    add(Object.hasOwn(pressLanguages, c) ? pressLanguages[c] : null);
    add(mainLanguage(c));
  }
  FOREIGN_NAME_LANGUAGES.forEach(add);
  return out;
}

/**
 * Text as country names are matched in it: folded (foldText), Arabic and
 * Persian letters in one spelling (ٱ as ا, ى and ی as ي, ک as ك, a last ة as
 * ا: سورية and سوريا), Japanese ・ dropped, and apostrophes, hyphens, dots and
 * other punctuation as spaces.
 */
export function nameText(text: string): string {
  return foldText(text)
    .replace(/ٱ/g, "ا")
    .replace(/[ىی]/g, "ي")
    .replace(/ک/g, "ك")
    .replace(/ة(?![\p{L}\p{M}])/gu, "ا")
    .replace(/[ـ・]/g, "")
    .replace(/[’'`´‐‑–—\-_/\\.,:;!?()（）［］[\]{}|"«»“”„]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Countries' names that are also common words, people's or places' names
 * in other countries, as nameText writes them, which are never read as
 * countries: Maurice and Dominique (first names, and French for Mauritius
 * and Dominica), Granada and Franca (cities in Spain and Brazil), German
 * Island (Iceland) and French Chili (Chile), which English pages use as
 * words ("island families", a church's chili supper), equateur
 * and equador (the equator), Portuguese ira (anger) and fãs (fans), gana
 * (Spanish "wins"), Turkish cad (street) and cin, Somali (a people and
 * Ethiopia's Somali Region), Arabic and Persian مالي (financial), Russian
 * того ("of that"), Thai มาลี and ชาด, Hindi माली (gardener), and Korean
 * words such as 수단 (means), 이란 and 인도 (인도적, humanitarian).
 */
const NOT_COUNTRY_NAMES: ReadonlySet<string> = new Set([
  "maurice", "mauricio", "mauricia", "dominique", "granada", "grenade", "equateur", "equador", "franca", "ira", "fas", "gana", "cad", "cin", "somali",
  "island", "chili",
  "مالي", "того", "มาลี", "ชาด", "माली", "가나", "말리", "수단", "이란", "오만", "피지", "인도",
]);
/** Saints' names, which countless churches, schools and towns bear: "Saint-Martin", "Santa Lucía", "São Tomé", "セントルシア". */
const SAINT_NAME = /^(?:saint|sainte|san|santa|santo|sao|st|sankt|sint|sv|سان|سانت|セント|サン|세인트|생|圣|聖|เซนต์|सेंट|सेन्ट|сен|сент|санкт|о в)(?:\s|$|(?=[\p{Script=Katakana}\p{Script=Han}\p{Script=Hangul}\p{Script=Thai}]))/u;
/** Lookarounds for names that are part of other words: 中国地方 (western Japan), インド洋 (the Indian Ocean), ลาวา (lava). */
const NAME_EXCEPTIONS: Readonly<Record<string, { before?: string; after?: string }>> = {
  中国: { after: "地方|四国|山地|地域|自動車道|電力|新聞" },
  インド: { after: "洋" },
  印度: { after: "洋" },
  ลาว: { after: "า" },
  อินเดีย: { before: "มหาสมุทร" },
};

/** One country's name in another language, compiled. */
interface CountryName {
  /** As nameText writes it. */
  name: string;
  codes: string[];
  needle: string;
  re: RegExp;
}

const NO_SPACE_SCRIPTS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

function escapeName(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * The regex for one name, by its script: anywhere in Chinese, Japanese,
 * Korean, Thai and the like (Katakana between other letters than
 * Katakana: タイ is Thailand, タイトル a title); in Arabic script as a
 * whole word with its prefixes (و ف ب ك ل: بالمغرب, للمغرب); in Cyrillic
 * with a case ending (Турции); else as a whole word.
 */
function compileName(name: string): { needle: string; re: RegExp } {
  const ex = NAME_EXCEPTIONS[name] ?? {};
  const before = ex.before ? `(?<!${ex.before})` : "";
  const after = ex.after ? `(?!${ex.after})` : "";
  const body = escapeName(name);
  if (/^[\p{Script=Katakana}ー\s]+$/u.test(name)) return { needle: name, re: new RegExp(`(?<![\\p{Script=Katakana}ー])${before}${body}${after}(?![\\p{Script=Katakana}ー])`, "gu") };
  if (NO_SPACE_SCRIPTS.test(name)) return { needle: name, re: new RegExp(`${before}${body}${after}`, "gu") };
  if (/\p{Script=Arabic}/u.test(name)) {
    const core = name.startsWith("ال") ? `(?:${body}|ل${escapeName(name.slice(1))})` : body;
    return { needle: name.replace(/^ال/, ""), re: new RegExp(`(?<![\\p{L}\\p{M}])(?:[وف])?(?:[بكل])?${core}(?![\\p{L}\\p{M}])`, "gu") };
  }
  if (/\p{Script=Cyrillic}/u.test(name) && [...name].length >= 5) {
    const stem = /[ая]$/.test(name) ? name.slice(0, -1) : name;
    return { needle: stem, re: new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${escapeName(stem)}[а-яё]{0,2}(?![\\p{L}\\p{M}\\p{N}])`, "gu") };
  }
  return { needle: name, re: new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${before}${body}${after}(?![\\p{L}\\p{M}\\p{N}])`, "gu") };
}

const countryNameCache = new Map<string, CountryName[]>();

/**
 * Every country's name in these languages, from the runtime's CLDR data
 * (Intl.DisplayNames), compiled once per set of languages: "Algérie" and
 * "الجزائر" for Algeria, "Turquía" and "トルコ" for Turkey. A name is read
 * up to its first bracket, comma or " - " ("Congo - Kinshasa" -> "Congo",
 * so both Congos share it), and its bracketed name too when no country
 * has that one ("Myanmar (Birmanie)" -> "Birmanie"). Left out: names the
 * English index already reads (countryNameIndex: "Georgia", "Panamá",
 * "Jersey", whose rules for a disaster's own states and places apply),
 * Latin names shorter than four letters, saints' names (SAINT_NAME) and
 * names that are common words or names elsewhere (NOT_COUNTRY_NAMES). A
 * name two countries share names both.
 */
export function countryNamesIn(languages: readonly string[], index: Record<string, string[]>): CountryName[] {
  const codes = [...new Set(Object.values(index).flat())].filter((c) => /^[A-Z]{2}$/.test(c)).sort();
  const key = `${languages.join(",")}|${codes.join(",")}`;
  const cached = countryNameCache.get(key);
  if (cached) return cached;
  const mains = new Map<string, Set<string>>();
  const brackets: [string, string][] = [];
  for (const lang of languages) {
    let names: Intl.DisplayNames;
    try {
      names = new Intl.DisplayNames([lang], { type: "region", fallback: "none" });
    } catch {
      continue;
    }
    for (const code of codes) {
      const raw = names.of(code) ?? "";
      const main = raw.split(/\s*[(（,，]/)[0].split(/\s+[-–—]\s+/)[0].trim();
      if (main) mains.set(main, new Set([...(mains.get(main) ?? []), code]));
      const inner = /[(（]([^)）]+)[)）]/.exec(raw)?.[1]?.trim();
      if (inner) brackets.push([inner, code]);
    }
  }
  const byName = new Map<string, Set<string>>();
  const add = (raw: string, list: Iterable<string>) => {
    const name = nameText(raw);
    if (!name || NOT_COUNTRY_NAMES.has(name) || SAINT_NAME.test(name)) return;
    if (/^[a-z ]+$/.test(name)) {
      const joined = name.replace(/ /g, "");
      if (joined.length < 4 || Object.hasOwn(index, joined)) return;
    }
    byName.set(name, new Set([...(byName.get(name) ?? []), ...list]));
  };
  for (const [name, list] of mains) add(name, list);
  const mainNames = new Set([...mains.keys()].map(nameText));
  for (const [inner, code] of brackets) if ([...nameText(inner)].length >= 4 && !mainNames.has(nameText(inner))) add(inner, [code]);
  const out = [...byName].map(([name, list]) => ({ name, codes: [...list], ...compileName(name) }));
  countryNameCache.set(key, out);
  return out;
}

/** What foreignCountryIn reads of a disaster: its countries, every country's names and its storms. */
export type ForeignContext = Pick<DonationContext, "countries" | "countryNameIndex">;

/**
 * The first name of another country than the disaster's that texts give
 * in another language (countryNamesIn: "Faites un don pour le séisme en
 * Algérie" for an earthquake in Morocco, "تبرع لضحايا زلزال تركيا وسوريا"),
 * or null. The longest name wins ("Soudan du Sud" names South Sudan, not
 * Sudan); a name inside one of the disaster's own place names (ownPlaces)
 * names none, nor, for a disaster in the United States, Georgia's or
 * Jersey's (STATE_NAMES).
 */
export function foreignCountryIn(texts: readonly string[], ctx: ForeignContext, languages: readonly string[], ownPlaces: readonly string[] = []): string | null {
  if (!ctx.countryNameIndex) return null;
  const text = nameText(texts.join(" | "));
  if (!text) return null;
  const { own, states } = ownCodes(ctx.countries);
  const places = ownPlaces.map(nameText).filter(Boolean);
  const found: { start: number; end: number; name: CountryName }[] = [];
  for (const name of countryNamesIn(languages, ctx.countryNameIndex)) {
    if (!text.includes(name.needle)) continue;
    for (const m of text.matchAll(name.re)) found.push({ start: m.index, end: m.index + m[0].length, name });
  }
  const inside = (a: (typeof found)[number], b: (typeof found)[number]) => a !== b && b.start <= a.start && a.end <= b.end && b.end - b.start > a.end - a.start;
  for (const f of found.sort((a, b) => a.start - b.start)) {
    if (found.some((o) => inside(f, o))) continue;
    const { name, codes } = f.name;
    if (codes.some((c) => own.has(c)) || codes.every((c) => states.has(c)) || places.some((p) => p.includes(name))) continue;
    return name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// GoFundMe: URLs
// ---------------------------------------------------------------------------

/** True for www.gofundme.com or gofundme.com over https, without credentials or port. */
function onGoFundMe(url: URL): boolean {
  return url.protocol === "https:" && (url.hostname === GOFUNDME_HOST || url.hostname === "gofundme.com") && !url.username && !url.password && !url.port;
}

/**
 * Where a crisis page's redirect leads when it stays on GoFundMe's crisis
 * pages: the slug, and the URL to ask for. A page in another language
 * ("/en-gb/c/act/<slug>") or with a trailing slash counts; null for
 * anything else.
 */
export function hubRedirect(location: string, from: string): { slug: string; url: string } | null {
  let url: URL;
  try {
    url = new URL(location.trim(), from);
  } catch {
    return null;
  }
  if (!onGoFundMe(url)) return null;
  const m = /^(?:\/[a-z]{2}(?:-[a-z]{2})?)?\/c\/act\/([a-z0-9-]{1,120})\/?$/.exec(url.pathname);
  return m && HUB_SLUG.test(m[1]) ? { slug: m[1], url: url.toString() } : null;
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
  /** When GoFundMe published it (its JSON-LD's datePublished), as an ISO time; null when it gives none. */
  published: string | null;
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

/** An ISO time for a date a page or feed gives, or null when it is none. */
function isoTime(v: unknown): string | null {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** The nodes of a JSON-LD block: a list, a @graph, or the one object. */
function ldNodes(data: unknown): Record<string, unknown>[] {
  const list = Array.isArray(data) ? data : isObject(data) && Array.isArray(data["@graph"]) ? data["@graph"] : [data];
  return list.filter(isObject);
}

/** True when a JSON-LD node is of one of these types ("@type" may be a list). */
function ldTypeIs(node: Record<string, unknown>, types: ReadonlySet<string>): boolean {
  const t = node["@type"];
  return (Array.isArray(t) ? t : [t]).some((x) => typeof x === "string" && types.has(x));
}

/** Every JSON-LD node of a page, from its application/ld+json scripts; blocks that are not JSON are skipped. */
function ldOf(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const m of html.matchAll(/<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    try {
      out.push(...ldNodes(JSON.parse(m[1])));
    } catch {
      // not JSON
    }
  }
  return out;
}

/**
 * When a page was published: its JSON-LD WebPage's datePublished (as
 * GoFundMe's crisis pages give it), else any node's, else its
 * article:published_time; null when it gives none.
 */
export function publishedOf(html: string): string | null {
  const nodes = ldOf(html);
  const page = nodes.find((n) => ldTypeIs(n, new Set(["WebPage"])) && isoTime(n.datePublished)) ?? nodes.find((n) => isoTime(n.datePublished));
  if (page) return isoTime(page.datePublished);
  return isoTime(decodeEntities(/<meta\b[^>]*\bproperty\s*=\s*["']article:published_time["'][^>]*\bcontent\s*=\s*["']([^"']*)["']/i.exec(html)?.[1] ?? ""));
}

/**
 * Reads a crisis page: its heading (else its title), whether it says its
 * fundraisers are verified by Trust & Safety, the verified fundraisers'
 * slugs from the grid's data-slugs (ranked, see HubPage.slugs), the
 * fundraiser the hero section's Donate button leads to, its partners and
 * when it was published.
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
  return {
    title,
    verified,
    slugs: bySlugFocus([...all]).slice(0, MAX_SLUGS),
    listed: all.size,
    fund: fundSlug ? fundraiserUrl(fundSlug) : null,
    partners: parsePartners(html),
    published: publishedOf(html),
  };
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

/**
 * The last request for a crisis page that did not read it: when, and how.
 * gone: it answered 404 or 410, or moved off GoFundMe's crisis pages for
 * good. moved: it redirects to another crisis page (to). failed: a network
 * error, a bot wall, a server fault or any other answer.
 */
export interface HubFailure {
  at: string;
  kind: "gone" | "moved" | "failed";
  /** For moved: the slug of the crisis page it redirects to. */
  to?: string;
}

/** One crisis page as cached. */
export interface GoFundMeHub extends HubPage {
  slug: string;
  /** Names of the fundraisers last asked about (feedSlugs). */
  fundraisers: GoFundMeFundraiser[];
  /** When the page was last read; null when it is only known by its URL. */
  fetched: string | null;
  /** When the feed was last read for it; null until it has been. */
  feedFetched: string | null;
  /** When the feed last failed for it (an error, a refusal, an answer that is not JSON), since it was last read; missing or null when it has not. */
  feedFailed?: string | null;
  /** When it was last on the index or found by research. */
  seen: string;
  /** The last request that did not read it, since it was last read; null when there is none. */
  failure: HubFailure | null;
}

export interface GoFundMeCache {
  /** GoFundMe's index of current crises: when last read, the pages it listed, and when it last failed since (missing or null when it has not). */
  index: { fetched: string | null; slugs: string[]; failed?: string | null };
  hubs: Record<string, GoFundMeHub>;
}

export function emptyGoFundMeCache(): GoFundMeCache {
  return { index: { fetched: null, slugs: [], failed: null }, hubs: {} };
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

/** A cached failure record, or null when it does not check out. */
function cachedFailure(v: unknown): HubFailure | null {
  if (!isObject(v) || !time(v.at) || (v.kind !== "gone" && v.kind !== "moved" && v.kind !== "failed")) return null;
  if (v.kind !== "moved") return { at: String(v.at), kind: v.kind };
  return typeof v.to === "string" && HUB_SLUG.test(v.to) ? { at: String(v.at), kind: "moved", to: v.to } : null;
}

/** A cache read from disk with every field checked, so older or damaged files still load. */
export function normaliseGoFundMeCache(raw: unknown): GoFundMeCache {
  const cache = emptyGoFundMeCache();
  if (!isObject(raw)) return cache;
  if (isObject(raw.index)) cache.index = { fetched: time(raw.index.fetched), slugs: stringList(raw.index.slugs, (s) => HUB_SLUG.test(s)), failed: time(raw.index.failed) };
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
      published: isoTime(h.published),
      fundraisers: cachedFundraisers(h.fundraisers),
      fetched: time(h.fetched),
      feedFetched: time(h.feedFetched),
      feedFailed: time(h.feedFailed),
      seen: String(h.seen),
      failure: cachedFailure(h.failure),
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

/** True while a failed request still bars asking again: 12 hours after a failure, 7 days after a page went or moved. */
export function failureHolds(failure: HubFailure | null, now: string): boolean {
  if (!failure) return false;
  return !stale(failure.at, now, failure.kind === "failed" ? FAILED_RETRY_HOURS * HOUR_MS : GONE_RETRY_DAYS * DAY_MS);
}

export interface RefreshGoFundMeOptions {
  /** Crisis page URLs the run's research found (ResearchEntry.hubs). */
  found?: readonly string[];
  /** True when a crisis page belongs to one of the run's disasters (see hubWanted). */
  wanted?: (hub: GoFundMeHub) => boolean;
  maxRequests?: number;
  pauseMs?: number;
}

/** A crisis page known only by its slug. */
export function blankHub(slug: string, seen: string): GoFundMeHub {
  return { slug, title: "", verified: false, slugs: [], listed: 0, fund: null, partners: [], published: null, fundraisers: [], fetched: null, feedFetched: null, feedFailed: null, seen, failure: null };
}

/**
 * True for a 200 answer that reads as the crisis page: it dates itself in
 * its JSON-LD, and it still lists verified fundraisers when it listed some
 * before. A bot wall or a maintenance page answering 200 does neither, and
 * is taken as a failure, so the page keeps its data.
 */
export function isHubPage(page: Pick<HubPage, "published" | "listed">, before: Pick<HubPage, "listed">): boolean {
  return page.published !== null && (page.listed > 0 || before.listed === 0);
}

/**
 * Refreshes the GoFundMe cache with at most maxRequests requests, a pause
 * of at least a second between them, with the pipeline's user agent:
 *   1. the index, when it was read 12 hours ago or more and has not
 *      failed in the last 12 hours;
 *   2. each crisis page a disaster wants (wanted), the index's first: the
 *      page when it was never read or read 12 hours ago or more, then
 *      right away the feed for its fundraisers, when the page says they
 *      are verified, it still belongs to the disaster and the feed was
 *      read 12 hours ago or more and has not failed in the last 12;
 *   3. then the other pages: those never read, then those read 7 days ago
 *      or more.
 * A page that failed (an error, a refusal, or a 200 that is no crisis
 * page: isHubPage) is not asked for again for 12 hours, one that is gone
 * (404, 410) or moved for 7 days (failureHolds); a failure keeps the
 * page's previous data, a page that is gone or moved loses it. A redirect
 * to another crisis page (www.gofundme.com/c/act/<slug>, in any of its
 * languages) is followed: the new page is read next; a redirect to the
 * same page at another address (a trailing slash, a language) is
 * followed at once, at most three times. Pages neither on the index nor
 * found by research for 30 days, and wanted by no disaster, are
 * forgotten. Never throws.
 */
export async function refreshGoFundMe(prev: GoFundMeCache, deps: FetchDeps, now: string, opts: RefreshGoFundMeOptions = {}): Promise<GoFundMeCache> {
  const cache: GoFundMeCache = { index: { ...prev.index }, hubs: { ...prev.hubs } };
  const wanted = opts.wanted ?? (() => false);
  const max = opts.maxRequests ?? GOFUNDME_MAX_REQUESTS;
  const pause = Math.max(1_000, opts.pauseMs ?? GOFUNDME_PAUSE_MS);
  let requests = 0;
  // One request: the status (0 for a network error), the body of a 200 and a redirect's location; null when none are left.
  const get = async (url: string, accept: string): Promise<{ status: number; text: string; location: string | null } | null> => {
    if (requests >= max) return null;
    if (requests > 0) await deps.sleep(pause);
    requests++;
    try {
      const res = await deps.fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: accept }, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.status !== 200) {
        res.body?.cancel().catch(() => {});
        deps.log(`GoFundMe ${url}: HTTP ${res.status}`);
        return { status: res.status, text: "", location: res.headers.get("location") };
      }
      return { status: 200, text: (await res.text()).slice(0, MAX_PAGE_CHARS), location: null };
    } catch (err) {
      deps.log(`GoFundMe ${url}: ${err instanceof Error ? err.message : String(err)}`);
      return { status: 0, text: "", location: null };
    }
  };
  // Adds a crisis page by its slug, or marks a known one seen.
  const see = (slug: string) => {
    cache.hubs[slug] = { ...(cache.hubs[slug] ?? blankHub(slug, now)), seen: now };
  };

  // Reads one crisis page; returns the slug of the crisis page it moved to, if any.
  const readPage = async (slug: string): Promise<string | null> => {
    const h = cache.hubs[slug];
    let url = hubUrl(slug);
    for (let hop = 0; ; hop++) {
      const res = await get(url, "text/html");
      if (!res) return null;
      if (res.status === 200) {
        const page = parseHub(res.text);
        if (!isHubPage(page, h)) {
          cache.hubs[slug] = { ...h, failure: { at: now, kind: "failed" } };
          deps.log(`GoFundMe: ${slug} answered 200 with no crisis page (a bot wall or a broken page); its previous data kept, asked for again after ${FAILED_RETRY_HOURS} h`);
          return null;
        }
        // Names already read stay while the page still lists them.
        const kept = new Set([...page.slugs, ...(page.fund ? [fundraiserSlugOf(page.fund)] : [])]);
        cache.hubs[slug] = { ...h, ...page, fundraisers: h.fundraisers.filter((f) => kept.has(f.slug)), fetched: now, failure: null };
        deps.log(`GoFundMe: read ${slug} ("${page.title}", published ${page.published ?? "on no date"}, ${page.listed} verified fundraisers, ${page.partners.length} partners)`);
        return null;
      }
      const target = res.status >= 300 && res.status < 400 && res.location ? hubRedirect(res.location, url) : null;
      if (target && target.slug !== slug) {
        cache.hubs[slug] = { ...blankHub(slug, h.seen), failure: { at: now, kind: "moved", to: target.slug } };
        see(target.slug);
        deps.log(`GoFundMe: ${slug} moved to ${target.slug}`);
        return target.slug;
      }
      // The same page at another address: a trailing slash, another language.
      if (target && hop < MAX_REDIRECTS && target.url !== url) {
        url = target.url;
        continue;
      }
      if (!target && (res.status === 404 || res.status === 410 || res.status === 301 || res.status === 308)) {
        cache.hubs[slug] = { ...blankHub(slug, h.seen), failure: { at: now, kind: "gone" } };
        deps.log(`GoFundMe: ${slug} is gone; not asked for again for ${GONE_RETRY_DAYS} days`);
        return null;
      }
      cache.hubs[slug] = { ...h, failure: { at: now, kind: "failed" } };
      deps.log(`GoFundMe: ${slug} could not be read; its previous data kept, asked for again after ${FAILED_RETRY_HOURS} h`);
      return null;
    }
  };

  // Reads the feed for a page's fundraisers; a failure is noted, so the feed is not asked for again for 12 hours.
  const readFeed = async (slug: string): Promise<void> => {
    const h = cache.hubs[slug];
    const slugs = feedSlugs(h);
    const res = await get(feedUrl(slugs), "application/json");
    if (!res) return;
    let fundraisers: GoFundMeFundraiser[] | null = null;
    try {
      if (res.status === 200) fundraisers = parseFeed(JSON.parse(res.text));
    } catch {
      // not JSON: a failure
    }
    if (!fundraisers) {
      cache.hubs[slug] = { ...cache.hubs[slug], feedFailed: now };
      deps.log(`GoFundMe: the feed for ${slug} could not be read; previous names kept, asked for again after ${FAILED_RETRY_HOURS} h`);
      return;
    }
    cache.hubs[slug] = { ...cache.hubs[slug], fundraisers, feedFetched: now, feedFailed: null };
    deps.log(`GoFundMe: named ${fundraisers.length} of ${slugs.length} fundraisers for ${slug}`);
  };

  const pageDue = (h: GoFundMeHub) => !failureHolds(h.failure, now) && (h.fetched === null || stale(h.fetched, now, wanted(h) ? GOFUNDME_REFRESH_HOURS * HOUR_MS : UNMATCHED_RECHECK_DAYS * DAY_MS));
  const feedDue = (h: GoFundMeHub | undefined) =>
    Boolean(h?.fetched && h.verified && wanted(h) && feedSlugs(h).length > 0) &&
    stale(h?.feedFetched ?? null, now, GOFUNDME_REFRESH_HOURS * HOUR_MS) &&
    stale(h?.feedFailed ?? null, now, FAILED_RETRY_HOURS * HOUR_MS);
  const rank = (h: GoFundMeHub) => {
    const i = cache.index.slugs.indexOf(h.slug);
    return i < 0 ? Infinity : i;
  };
  const byOrder = (a: GoFundMeHub, b: GoFundMeHub) => rank(a) - rank(b) || a.slug.localeCompare(b.slug);

  try {
    if (stale(cache.index.fetched, now, GOFUNDME_REFRESH_HOURS * HOUR_MS) && stale(cache.index.failed ?? null, now, FAILED_RETRY_HOURS * HOUR_MS)) {
      const res = await get(GOFUNDME_INDEX, "text/html");
      const slugs = res?.status === 200 ? parseHubIndex(res.text) : [];
      if (slugs.length > 0) {
        cache.index = { fetched: now, slugs, failed: null };
        deps.log(`GoFundMe: the index lists ${slugs.length} crisis pages (${slugs.join(", ")})`);
      } else if (res) {
        cache.index = { ...cache.index, failed: now };
        deps.log(`GoFundMe: the index could not be read; its previous list kept, asked for again after ${FAILED_RETRY_HOURS} h`);
      }
    }
    const found = (opts.found ?? []).map(hubSlugOf).filter((s): s is string => s !== null);
    for (const slug of [...cache.index.slugs, ...found]) {
      see(slug);
      // A page research keeps finding that moved keeps its new page too.
      const to = cache.hubs[slug].failure?.to;
      if (to) see(to);
    }

    // The pages disasters want, each with its feed, before any other.
    const done = new Set<string>();
    const queue = Object.values(cache.hubs).filter(wanted).sort(byOrder).map((h) => h.slug);
    while (queue.length > 0 && requests < max) {
      const slug = queue.shift() as string;
      if (done.has(slug) || !cache.hubs[slug]) continue;
      done.add(slug);
      if (pageDue(cache.hubs[slug])) {
        const moved = await readPage(slug);
        if (moved) queue.unshift(moved);
      }
      if (feedDue(cache.hubs[slug])) await readFeed(slug);
    }

    // Then the others: never read first.
    const rest = Object.values(cache.hubs)
      .filter((h) => !done.has(h.slug) && pageDue(h))
      .sort((a, b) => Number(a.fetched !== null) - Number(b.fetched !== null) || byOrder(a, b))
      .map((h) => h.slug);
    while (rest.length > 0 && requests < max) {
      const slug = rest.shift() as string;
      if (done.has(slug) || !cache.hubs[slug] || !pageDue(cache.hubs[slug])) continue;
      done.add(slug);
      const moved = await readPage(slug);
      if (moved) rest.unshift(moved);
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
 * True when a crisis page is about this disaster by its name, by fixed
 * rule on its slug and title (the way isIfrcEventCampaign reads IFRC's
 * campaigns): neither names a country that is not the disaster's (by whole
 * names, see countriesNamedIn) or a storm that is not the disaster's
 * (otherStorm), no hazard either names is of another kind (strictly: an
 * earthquake page is no landslide's, a flood page no cyclone's; a storm's
 * page is a flood's only by the storm's name, see stormAftermath), and one
 * of them is made only of place words of the disaster's title, or names one
 * of its countries together with a hazard of its kind. So
 * "hurricane-melissa" is Hurricane Melissa's and
 * "venezuela-earthquake-relief" the Venezuela earthquake's (not a flood or
 * a landslide in Venezuela nor an earthquake in Colombia), while
 * "wildfire-relief" and "public-officials" are no disaster's. Whether the
 * page is of the disaster's time is hubDatesFit's to say. False without
 * the context's countryNameIndex.
 */
export function hubMatches(hub: Pick<GoFundMeHub, "slug" | "title">, d: Pick<Disaster, "countries" | "type"> & Partial<Pick<Disaster, "places">>, ctx: MatchContext): boolean {
  if (!ctx.countryNameIndex || d.countries.length === 0) return false;
  const slug = hub.slug.split("-").filter(Boolean);
  const title = asciiWords(hub.title).filter((w) => !HUB_FILLER.has(w));
  const own = disasterPlaceNames(d);
  const readings = [readWords(slug, d.countries, ctx, own), readWords(title, d.countries, ctx, own)];
  if (readings.some((r) => r.foreign) || otherStorm(slug, ctx, d.type) || otherStorm(title, ctx, d.type)) return false;
  const words = [...slug, ...title];
  const hazard = hazardFit(words, d.type);
  const byTitle = readings.some((r) => r.onlyTitlePlaces);
  if (hazard === "other" && !(byTitle && stormAftermath(words, d.type))) return false;
  return byTitle || readings.some((r) => r.country && hazard === "fits");
}

/** Days from b to a. */
function daysBetween(a: string, b: string): number {
  return (Date.parse(a) - Date.parse(b)) / DAY_MS;
}

/**
 * True when GoFundMe published a crisis page close to the disaster's start:
 * at most 14 days before it, and at most 45 days after (120 for a flood,
 * heat or cold wave or dust storm, a year for a drought). An older page,
 * such as Morocco's 2023 earthquake page, is no later earthquake's, and a
 * newer one is a later event's. False when the page gives no date.
 */
export function hubDatesFit(hub: Pick<HubPage, "published">, d: Pick<Disaster, "started" | "type">): boolean {
  if (!hub.published || !Number.isFinite(Date.parse(d.started))) return false;
  const days = daysBetween(hub.published, d.started);
  return days >= -HUB_BEFORE_DAYS && days <= (HUB_AFTER_DAYS_SLOW[d.type] ?? HUB_AFTER_DAYS);
}

/**
 * True when a crisis page belongs to the disaster as far as is known: by
 * its name (hubMatches), and, once it has been read, by its date
 * (hubDatesFit). The refresh reads such pages first.
 */
export function hubWanted(hub: Pick<GoFundMeHub, "slug" | "title" | "published" | "fetched">, d: Pick<Disaster, "countries" | "type" | "started">, ctx: MatchContext): boolean {
  return hubMatches(hub, d, ctx) && (hub.fetched === null || hubDatesFit(hub, d));
}

/**
 * The disaster's crisis page: the first one, in the index's order and then
 * by slug, that has been read, says its fundraisers are verified, matches
 * the disaster by name (hubMatches) and was published close to its start
 * (hubDatesFit); null when none does.
 */
export function matchHub(cache: GoFundMeCache, d: Pick<Disaster, "countries" | "type" | "started">, ctx: MatchContext): GoFundMeHub | null {
  const rank = (h: GoFundMeHub) => {
    const i = cache.index.slugs.indexOf(h.slug);
    return i < 0 ? Infinity : i;
  };
  const hubs = Object.values(cache.hubs).sort((a, b) => rank(a) - rank(b) || a.slug.localeCompare(b.slug));
  return hubs.find((h) => h.fetched !== null && h.verified && hubMatches(h, d, ctx) && hubDatesFit(h, d)) ?? null;
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

/** The time of a fundraiser's last donation as GoFundMe gives it ("2026-01-27 03:13:54", UTC), in ms; NaN when unknown. */
function donationTime(at: string | null): number {
  return at ? Date.parse(`${at.trim().replace(" ", "T")}${/[zZ]|[+-]\d\d:?\d\d$/.test(at.trim()) ? "" : "Z"}`) : NaN;
}

/**
 * True unless the feed says a fundraiser's last donation came before the
 * disaster started (a day's grace): a fundraiser nobody has given to since
 * is an earlier event's.
 */
export function givenSince(f: Pick<GoFundMeFundraiser, "lastDonation">, started: string | undefined): boolean {
  const last = donationTime(f.lastDonation);
  const start = started ? Date.parse(started) : NaN;
  return !Number.isFinite(last) || !Number.isFinite(start) || last >= start - DAY_MS;
}

/**
 * GoFundMe's links for a disaster from its crisis page, at most three: the
 * page itself, the fund its Donate button leads to, then its verified
 * fundraisers, those whose names speak of schools first, then of homes and
 * families, then the most donated to. Fundraisers are listed only when the
 * feed named them, and not when their last donation came before the
 * disaster started (givenSince). None when the page does not say they are
 * verified.
 */
export function gofundmeLinks(hub: GoFundMeHub, started?: string): DonationLink[] {
  if (!hub.verified) return [];
  const event = hubEventName(hub.title);
  const out = [gofundmeLink(event ? `Verified fundraisers for ${event}` : "Verified fundraisers on GoFundMe", hubUrl(hub.slug), VERIFIED_NOTE)];
  const fundSlug = hub.fund ? fundraiserSlugOf(hub.fund) : null;
  const fund = fundSlug ? hub.fundraisers.find((f) => f.slug === fundSlug && givenSince(f, started)) : undefined;
  if (fund) out.push(gofundmeLink(fund.name, fundraiserUrl(fund.slug), "Featured by GoFundMe on its verified page for this disaster"));
  const verified = hub.slugs;
  const picks = hub.fundraisers
    .filter((f) => f.slug !== fundSlug && verified.includes(f.slug) && givenSince(f, started))
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

/**
 * The earliest year a page for this disaster may name: the year it
 * started, or the year before when it started in its first month (so a
 * page may still say 2025 for a disaster dated early in 2026). A page that
 * names an older year is an earlier disaster's. Null without a start.
 */
export function eventYear(d: Pick<Disaster, "started">): number | null {
  const t = Date.parse(d.started);
  return Number.isFinite(t) ? new Date(t - 30 * DAY_MS).getUTCFullYear() : null;
}

/**
 * True for a named storm: a cyclone or storm whose title has place words
 * (eventWords), which for a storm are its name ("Hurricane Melissa",
 * "Super Typhoon Champi", "Storm Boelo in the UK"). Its pages must name it:
 * the country and the hazard alone also fit last year's storm.
 */
export function isNamedStorm(d: Pick<Disaster, "type">, ctx: Pick<DonationContext, "eventWords">): boolean {
  return (d.type === "cyclone" || d.type === "storm") && (ctx.eventWords?.length ?? 0) > 0;
}

/** True when the search dated a page more than PAGE_BEFORE_DAYS before the disaster started. */
function datedBefore(published: string | undefined, d: Pick<Disaster, "started">): boolean {
  return Boolean(published && Number.isFinite(Date.parse(published)) && Number.isFinite(Date.parse(d.started)) && daysBetween(published, d.started) < -PAGE_BEFORE_DAYS);
}

/**
 * Why a GlobalGiving page the direct search found may not be shown for
 * this disaster, or null when it may. By its slug and the search result's
 * title, it must:
 *   - name one of the disaster's countries or a place word of its title,
 *     and no other country or storm (otherStorm);
 *   - name no year older than the disaster's (eventYear), and not be dated
 *     by the search well before the disaster started;
 *   - name the disaster's hazard (strictly; a storm's page for its floods
 *     only by the storm's name, see stormAftermath) or a place word of its
 *     title, and a named storm by its name: "help-jamaica-recover-from-
 *     hurricane-beryl" is no page for Hurricane Melissa;
 *   - be dated to this disaster: by the storm's name or by a year no older
 *     than the disaster's. The search's own date for the page is no proof:
 *     it can be the day the page last changed, and GlobalGiving keeps funds
 *     open for years, so a fund named only for a country or a place and a
 *     hazard ("turkey-earthquake-relief-fund", "nepal-earthquake-relief-
 *     fund" from 2015, "kerala-flood-relief-fund" from 2018,
 *     "chiang-rai-flood-relief" from 2024) is an earlier disaster's as
 *     likely as this one's, and is not shown.
 */
export function globalGivingProblem(
  page: Pick<DirectPage, "url" | "title" | "published">,
  d: Pick<Disaster, "countries" | "type" | "started"> & Partial<Pick<Disaster, "places">>,
  ctx: MatchContext,
): string | null {
  const gg = globalGivingPage(page.url);
  if (!gg) return "not a GlobalGiving project page";
  const slug = slugWords(gg.slug);
  const title = slugWords(projectTitle(page.title ?? ""));
  const own = disasterPlaceNames(d);
  const readings = [readWords(slug, d.countries, ctx, own), readWords(title, d.countries, ctx, own)];
  if (readings.some((r) => r.foreign)) return "names another country";
  const storm = otherStorm(slug, ctx, d.type) ?? otherStorm(title, ctx, d.type);
  if (storm) return `names another storm (${storm})`;
  const titlePlace = readings.some((r) => r.titlePlace);
  if (!titlePlace && !readings.some((r) => r.country)) return "names none of the disaster's places";
  const minYear = eventYear(d);
  const years = [...eventYearsIn(gg.slug), ...eventYearsIn(projectTitle(page.title ?? ""))];
  const old = minYear === null ? [] : years.filter((y) => y < minYear);
  if (old.length > 0) return `an earlier disaster's project (${old[0]})`;
  if (datedBefore(page.published, d)) return `dated ${page.published?.slice(0, 10)}, before the disaster`;
  const words = [...slug, ...title];
  const hazard = hazardFit(words, d.type);
  if (hazard === "other" && !(titlePlace && stormAftermath(words, d.type))) return "names another kind of disaster";
  const namedStorm = isNamedStorm(d, ctx);
  if (namedStorm && !titlePlace) return "does not name the storm";
  if (hazard !== "fits" && !titlePlace) return "names neither the hazard nor a place in the title";
  // A storm's name dates a page: names are not given again for years.
  const byStormName = titlePlace && (namedStorm || stormAftermath(words, d.type));
  const dated = byStormName || (minYear !== null && years.some((y) => y >= minYear));
  if (!dated) return "nothing dates it to this disaster (no storm name or recent year)";
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

/** Social networks, messaging apps and portals beyond donate.ts's SHARED_HOSTS. */
export const SOCIAL_HOSTS: readonly string[] = [
  "reddit.com", "threads.net", "threads.com", "pinterest.com", "snapchat.com", "vk.com", "ok.ru", "weibo.com", "weixin.qq.com", "line.me",
  "discord.com", "discord.gg", "bsky.app", "mastodon.social", "truthsocial.com", "kakao.com", "band.us", "xiaohongshu.com", "douyin.com",
  "bilibili.com", "quora.com", "messenger.com", "signal.me", "viber.com", "zhihu.com", "douban.com", "qq.com", "baidu.com", "sohu.com", "163.com",
  "sina.com.cn", "toutiao.com", "naver.com", "daum.net", "nextdoor.com", "meetup.com", "mixi.jp", "plurk.com", "dcard.tw", "ptt.cc", "dzen.ru",
  "livejournal.com", "change.org", "avaaz.org",
];

/**
 * Blogs, newsletters, site builders, form builders, link pages, file
 * hosts and archives beyond SHARED_HOSTS: anyone can put a page there, so
 * a page there is a person's, not a group's own site.
 */
export const PUBLISHING_HOSTS: readonly string[] = [
  "ameblo.jp", "ameba.jp", "note.com", "note.mu", "hatenablog.com", "hatenablog.jp", "hatena.ne.jp", "hateblo.jp", "livedoor.blog", "livedoor.jp",
  "blog.jp", "fc2.com", "seesaa.net", "exblog.jp", "goo.ne.jp", "jugem.jp", "tistory.com", "brunch.co.kr", "substack.com", "ghost.io",
  "beehiiv.com", "mailchi.mp", "mailchimp.com", "list-manage.com", "campaign-archive.com", "brevo.com", "sendinblue.com", "constantcontact.com",
  "flodesk.com", "webflow.io", "square.site", "squareup.com", "strikingly.com", "mystrikingly.com", "notion.site", "notion.so", "wixstudio.io",
  "editorx.io", "site123.me", "yolasite.com", "webnode.page", "ueniweb.com", "business.site", "framer.website", "framer.app", "tilda.ws",
  "tilda.cc", "ucraft.site", "simplesite.com", "jotform.com", "typeform.com", "forms.office.com", "forms.microsoft.com", "surveymonkey.com",
  "tally.so", "formstack.com", "cognitoforms.com", "wufoo.com", "123formbuilder.com", "paperform.co", "formsite.com", "zohopublic.com",
  "archive.org", "archive.ph", "archive.today", "archive.is", "archive.li", "padlet.com", "canva.com", "gamma.app", "linkin.bio", "bio.link",
  "beacons.ai", "lnk.bio", "taplink.cc", "about.me", "eventbrite.com", "eventbrite.co.uk", "eventbrite.ca", "eventbrite.com.au", "github.com",
  "gitlab.io", "glitch.me", "replit.app", "onrender.com", "fly.dev", "surge.sh", "neocities.org", "tripod.com", "angelfire.com",
  "sharepoint.com", "dropbox.com", "1drv.ms", "box.com", "scribd.com", "issuu.com", "yumpu.com", "slideshare.net", "blogger.com", "forms.gle",
];

/**
 * Crowdfunding and giving platforms, where anyone (or any charity) can
 * raise money: a page there is not a local group's own. GoFundMe's pages
 * come only from its crisis pages, GlobalGiving's by their own rule.
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
  // Japan, China, Korea and Taiwan: READYFOR, CAMPFIRE, Waterdrop, Qingsongchou, Tumblbug, Wadiz, Happybean (naver.com).
  "readyfor.jp", "camp-fire.jp", "motion-gallery.net", "makuake.com", "greenfunding.jp", "kibidango.com", "congrant.com", "syncable.biz",
  "shuidichou.com", "qschou.com", "qingsongchou.com", "tumblbug.com", "wadiz.kr", "flyingv.cc", "zeczec.com",
  // Africa: BackaBuddy, GivenGain, Thundafund, M-Changa.
  "backabuddy.co.za", "givengain.com", "thundafund.com", "mchanga.africa", "changa.co.ke",
  // The UK, Australia, New Zealand, Canada and the US.
  "virginmoneygiving.com", "everydayhero.com", "gofundraise.com.au", "givenow.com.au", "pozible.com", "pledgeme.co.nz", "localgiving.org",
  "enthuse.com", "canadahelps.org", "causevox.com", "rally.org", "givegab.com", "givesmart.com", "bloomerang.co", "kindful.com",
  "donorperfect.net", "blackbaud.com", "blackbaudhosting.com", "donordrive.com", "tiltify.com", "kiva.org", "donorschoose.org", "spacehive.com",
  "crowdjustice.com", "plumfund.com", "giveforms.com", "givingfuel.com", "ammado.com", "experiment.com",
  // Europe and Latin America: Leetchi's peers and their like.
  "lepotcommun.fr", "cotizup.com", "okpal.com", "papayoux-solidarite.com", "startnext.com", "viele-schaffen-mehr.de", "eppela.com",
  "produzionidalbasso.com", "retedeldono.it", "migranodearena.org", "teaming.net", "doneeractie.nl", "geef.nl", "zrzutka.pl", "pomagam.pl",
  "siepomaga.pl", "patronite.pl", "donio.cz", "darujme.cz", "startovac.cz", "hithit.com", "planeta.ru", "boomstarter.ru", "fongogo.com",
  "zoomaal.com", "yomken.com", "benihbaik.com", "sharethemeal.org", "donatekart.com", "giveindia.org", "give.do", "fueladream.com", "idea.me",
  "fondeadora.mx", "vaki.co", "recaudia.com",
  // Found by regional searches: LaunchGood, betterplace.me, SimplyGiving, TotalGiving, GivingWay, Apoia.se, PPL, Taejai, Yahoo! JAPAN's
  // donations, Give.asia, for Good, Kitabisa's .org; then their peers (gooddo, furusato nozei sites, Giving.sg, Evoé, FundraiseUp, ...).
  "launchgood.com", "betterplace.me", "simplygiving.com", "totalgiving.co.uk", "givingway.com", "apoia.se", "ppl.pt", "taejai.com",
  "donation.yahoo.co.jp", "give.asia", "for-good.net", "kitabisa.org", "gooddo.jp", "polca.jp", "furusato-tax.jp", "satofull.jp", "furunavi.jp",
  "giving.sg", "rayofhope.sg", "danamojo.org", "saweria.co", "trakteer.id", "sociabuzz.com", "evoe.cc", "abacashi.com", "doare.org",
  "fundraiseup.com", "givecloud.co", "kindest.com", "givelify.com", "tithe.ly", "pushpay.com", "anedot.com", "actblue.com", "winred.com",
  "altruja.de", "fundraisingbox.com", "endaoment.org", "gitcoin.co", "gumroad.com", "ehsan.sa",
  // Found by the 2026-10-25 review: Cotizi (Morocco), iSupportJamaica, Fonzip (Turkey), Juntos (Brazil), BitGiving (India), Sharing
  // Happiness, Amal Sholeh and WeCare (Indonesia), CAF Donate (the UK), HipGive (Latin America); then the donation-form hosts of nonprofit
  // CRMs (Neon, EveryAction, MobileCause, Salsa, Charidy, CauseMatch, JGive), whose pages are a form, not a group's own site.
  "cotizi.com", "isupportjamaica.com", "fonzip.com", "juntos.com.vc", "bitgiving.com", "sharinghappiness.org", "amalsholeh.com", "wecare.id",
  "cafdonate.cafonline.org", "hipgive.org", "neoncrm.com", "everyaction.com", "mobilecause.com", "salsalabs.org", "salsalabs.com", "charidy.com",
  "causematch.com", "jgive.com", "yourcause.com", "benevity.com", "donorsee.com",
];

/**
 * Payment, checkout, money-transfer, crypto and shop services: a page
 * there takes money for whoever made it, and is never a group's own page.
 */
export const PAYMENT_HOSTS: readonly string[] = [
  "stripe.com", "sumup.com", "square.link", "paystack.com", "paystack.shop", "flutterwave.com", "razorpay.com", "rzp.io", "instamojo.com",
  "payu.in", "paytm.com", "phonepe.com", "payfast.co.za", "yoco.com", "snapscan.co.za", "pesapal.com", "paymongo.com", "gcash.com", "maya.ph",
  "xendit.co", "midtrans.com", "omise.co", "momo.vn", "zalopay.vn", "picpay.com", "picpay.me", "pagseguro.uol.com.br", "wise.com", "revolut.me",
  "revolut.com", "monzo.me", "skrill.com", "payoneer.com", "westernunion.com", "moneygram.com", "remitly.com", "worldremit.com",
  "riamoneytransfer.com", "xoom.com", "zellepay.com", "zelle.com", "coinbase.com", "binance.com", "crypto.com", "blockchain.com",
  "nowpayments.io", "bitpay.com", "opennode.com", "btcpayserver.org", "shopify.com", "myshopify.com", "bigcartel.com", "paypay.ne.jp",
  "toss.me", "kakaopay.com", "alipay.com",
  // Found by the 2026-10-25 review: payment links in Brazil (Asaas, InfinitePay, Pagar.me), India (Cashfree, Instamojo), Jamaica (WiPay),
  // Nepal (Khalti, eSewa, Fonepay), the Philippines (PayMaya) and the Netherlands (Tikkie); then their peers in Pakistan and Bangladesh.
  "asaas.com", "infinitepay.io", "pagar.me", "cashfree.com", "instamojo.in", "wipayfinancial.com", "khalti.com", "esewa.com.np", "fonepay.com",
  "paymaya.com", "tikkie.me", "payumoney.com", "jazzcash.com.pk", "easypaisa.com.pk", "bkash.com", "nagad.com.bd", "ccavenue.com", "paytabs.com",
  "hyperpay.com", "cmi.co.ma",
];
/** Payment brands whatever their country domain: mercadopago.com.ar, pagseguro.com.br, paypal.de. */
const PAYMENT_BRAND = /(?:^|\.)(?:mercadopago|mercadopay|pagseguro|paypal|stripe|sumup|venmo|cashapp)\.[a-z.]+$/;

/** News sites and aggregators; any host with "news" as a part of a label ("jamaica-news.org", not "newstorycharity.org"), and the site's own news hosts, are news sites too. */
export const NEWS_HOSTS: readonly string[] = [
  "bbc.co.uk", "bbc.com", "cnn.com", "reuters.com", "apnews.com", "aljazeera.com", "aljazeera.net", "theguardian.com", "nytimes.com",
  "washingtonpost.com", "bloomberg.com", "france24.com", "dw.com", "euronews.com", "abc.net.au", "cbc.ca", "nbcnews.com", "cbsnews.com",
  "abcnews.go.com", "foxnews.com", "usatoday.com", "independent.co.uk", "telegraph.co.uk", "ndtv.com", "indiatimes.com", "hindustantimes.com",
  "thehindu.com", "inquirer.net", "gmanetwork.com", "rappler.com", "abs-cbn.com", "philstar.com", "kompas.com", "detik.com", "tempo.co",
  "scmp.com", "japantimes.co.jp", "nhk.or.jp", "yna.co.kr", "xinhuanet.com", "news.cn", "cgtn.com", "rt.com", "tass.com", "elpais.com",
  "elmundo.es", "clarin.com", "infobae.com", "eluniversal.com.mx", "milenio.com", "globo.com", "uol.com.br", "lemonde.fr", "lefigaro.fr",
  "spiegel.de", "bild.de", "corriere.it", "repubblica.it", "ansa.it", "nation.africa", "news24.com", "allafrica.com", "reliefweb.int",
  "wikipedia.org", "msn.com", "yahoo.com", "news.google.com", "jamaica-gleaner.com", "jamaicaobserver.com", "elnacional.com", "efectococuyo.com",
  "loopnews.com", "loopjamaica.com", "gleanerjm.com", "jamaicastar.com", "nationwideradiojm.com", "tvj.com", "sun-sentinel.com", "miamiherald.com",
];

/** Marketplaces, whatever their country domain: amazon.co.jp, mercadolibre.com.ve. */
const MARKETPLACE = /(?:^|\.)(?:amazon|ebay|etsy|aliexpress|alibaba|mercadolibre|mercadolivre|shopee|lazada|tokopedia|rakuten|walmart|temu|craigslist|olx|jumia|flipkart|taobao|tmall)\.[a-z.]+$/;
/** Government and military hosts anywhere, and international bodies (.int): not a local group's. */
const GOVERNMENT_HOST = /(?:^|\.)(?:gov|gob|gouv|govt|gub|mil)(?:\.[a-z]{2})?$|\.(?:gov|mil|int)$|(?:^|\.)go\.[a-z]{2}$/;

/**
 * Official bodies' and giving platforms' names that a local group's host
 * may not contain, matched with its dots and hyphens taken out: a
 * look-alike such as jamaicaredcrossrelief.org or hilalahmar-maroc.org. The
 * movement's names as its societies write them in Latin letters (Croissant-
 * Rouge, Media Luna Roja, Palang Merah, Kızılhaç; Sekijūji and Nisseki for
 * the Japanese Red Cross, Hongshizi and Jeoksipja for the Chinese and
 * Korean), the UN's agencies, giving platforms, civil protection and
 * government words.
 */
const PROTECTED_IN_HOST: readonly string[] = [
  "redcross", "redcrescent", "redcrystal", "cruzroja", "medialunaroja", "croixrouge", "croissantrouge", "rotkreuz", "roteskreuz", "rotenkreuz",
  "roterhalbmond", "crocerossa", "mezzalunarossa", "cruzvermelha", "crescentevermelho", "rodekruis", "rodehalvemaan", "rodekors", "rodakorset",
  "punainenristi", "czerwonykrzyz", "cervenykriz", "voroskereszt", "crucearosie", "crvenikriz", "crvenikrst", "kizilay", "kizilhac", "hilalahmar",
  "helalahmar", "palangmerah", "bulansabitmerah", "krusnapula", "chuthapdo", "magendavidadom", "sekijuji", "nisseki", "hongshizi", "jeoksipja",
  "unicef", "unhcr", "unocha", "acnur", "unrwa", "undrr", "unops", "unesco", "unwomen", "unhabitat", "uncrisisrelief", "gofundme", "globalgiving",
  "justgiving", "proteccioncivil", "defensacivil", "defesacivil",
  "protezionecivile", "protectioncivile", "civilprotection", "civildefence", "civildefense", "prefeitura", "ayuntamiento", "pemerintah",
  "kementerian", "gobierno", "gouvernement",
];
/** Short names that count only as a whole part of a host label, or its start or end ("wfpusa", "ifrc-jamaica"). */
const PROTECTED_PART_EDGE: readonly string[] = ["ifrc", "icrc", "wfp", "undp", "unfpa"];
/** Government words that count as a whole part of a host label or its end ("jamaica-gov-relief", "jamaicagov"), never its start ("govindfoundation", "govardhan-trust"). */
const GOVERNMENT_PARTS: readonly string[] = ["gov", "govt", "gouv", "gob"];
/** Names that count only as a whole part of a host label ("ocha-relief", "iom-haiti"; never "mocha" or "radiom"). */
const PROTECTED_PART_WHOLE: readonly string[] = ["ocha", "iom"];
/** Words after "un-" that make it the UN's ("un-relief.org", "un-hurricane-relief.org"); so does a country's name ("un-jamaica.org"). "un-techo-para-mi-pais" is Spanish for "a roof". */
const UN_FOLLOWERS: ReadonlySet<string> = new Set(
  [
    "relief aid appeal appeals donate donation donations emergency emergencies crisis help fund funds agency mission women habitat refugees refugee food",
    "humanitarian migration disaster disasters hurricane typhoon cyclone earthquake flood floods tsunami",
  ]
    .join(" ")
    .split(" "),
);
/** Words that make a label starting "un" the UN's when joined to it: "uncrisisrelief", "unhumanitarian", "unwomen". */
const UN_JOINED = /^un(?:crisis|relief|humanitarian|appeal|emergenc|refugee|women|habitat|migration|disaster|donat|hurricane|typhoon|cyclone|earthquake|flood|tsunami)/;

/**
 * The official body or platform a host claims to be, or null:
 * "jamaicaredcrossrelief.org" -> "redcross". "un" counts as a whole label,
 * as a part before an aid or hazard word or (with every country's names)
 * a country's name, or joined to an aid word at a part's start
 * ("uncrisisrelief-jamaica.org").
 */
export function protectedNameInHost(host: string, countryNameIndex?: Record<string, string[]>): string | null {
  const labels = host.toLowerCase().replace(/^www\./, "").split(".");
  // The last label is the top-level domain (.gov is caught by GOVERNMENT_HOST).
  const own = labels.slice(0, -1);
  const joined = own.join("").replace(/-/g, "");
  const long = PROTECTED_IN_HOST.find((n) => joined.includes(n));
  if (long) return long;
  for (const label of own) {
    const parts = label.split("-");
    for (const [i, part] of parts.entries()) {
      const edge = PROTECTED_PART_EDGE.find((n) => part === n || part.startsWith(n) || part.endsWith(n));
      if (edge) return edge;
      const gov = GOVERNMENT_PARTS.find((n) => part === n || part.endsWith(n));
      if (gov) return gov;
      if (PROTECTED_PART_WHOLE.includes(part)) return part;
      if (UN_JOINED.test(part)) return "un";
      if (part !== "un") continue;
      const rest = parts.slice(i + 1);
      if (label === "un" || UN_FOLLOWERS.has(rest[0] ?? "") || (countryNameIndex && rest.length > 0 && countriesNamedIn(rest, countryNameIndex).length > 0)) return "un";
    }
  }
  return null;
}

/**
 * The Red Cross and Red Crescent movement's names as its societies write
 * them, in Latin letters and in their own scripts. IFRC GO lists every
 * society in English, French, Spanish and Arabic, and these cover all of
 * those names; the rest are the movement's name in the languages of its
 * other societies (日本赤十字社, 대한적십자사, สภากาชาดไทย, Palang Merah
 * Indonesia, Türk Kızılay, Российский Красный Крест).
 */
const MOVEMENT_NAMES: readonly string[] = [
  "red cross", "redcross", "red crescent", "redcrescent", "red crystal", "cruz roja", "media luna roja", "croix rouge", "croissant rouge", "cristal rouge",
  "rotes kreuz", "roten kreuz", "rotkreuz", "roter halbmond", "croce rossa", "mezzaluna rossa", "cruz vermelha", "crescente vermelho", "rode kruis",
  "rode halve maan", "røde kors", "roda korset", "punainen risti", "czerwony krzyż", "czerwonego krzyża", "červený kříž", "červený kríž", "vöröskereszt",
  "crucea roșie", "crveni križ", "crveni krst", "rdeči križ", "kryqi i kuq", "raudonasis kryžius", "sarkanais krusts", "punane rist", "kızılhaç",
  "kızılay", "hilal ahmar", "helal ahmar", "hilal e ahmar", "palang merah", "bulan sabit merah", "krus na pula", "chữ thập đỏ", "msalaba mwekundu",
  "kwa wouj", "bisha cas", "magen david adom", "sociedad de la media luna", "ifrc", "icrc", "cicr", "ficr", "赤十字", "红十字", "紅十字", "적십자", "กาชาด",
  // Arabic words take their article and prepositions in front ("للصليب الأحمر"), so the names are matched without them.
  "هلال الأحمر", "هلال احمر", "ہلال احمر", "صليب الأحمر", "صليب احمر", "ماجن دافيد أدوم", "نجمة داود الحمراء", "צלב אדום", "מגן דוד אדום",
  "красный крест", "красного креста", "красный полумесяц", "красного полумесяца",
  "червоний хрест", "червоного хреста", "червен кръст", "црвени крст", "ερυθρος σταυρος", "ερυθρου σταυρου", "წითელი ჯვარი", "կարմիր խաչ",
  "улаан загалмай", "қызыл жарты ай", "qizil yarim oy", "qızıl aypara", "रेड क्रॉस", "रेडक्रस", "रेड क्रस", "রেড ক্রস", "রেড ক্রিসেন্ট", "ကြက်ခြေနီ",
  // Pashto, Tajik, Kyrgyz, Uzbek (Cyrillic) and Turkmen: "د افغانستان د سره میاشتې ټولنه", "Ҳилоли Аҳмари Тоҷикистон".
  "سره میاشت", "ҳилоли аҳмар*", "хилоли ахмар*", "кызыл жарым ай", "қизил ярим ой", "gyzyl yarymay",
  "កាកបាទក្រហម", "ກາແດງ", "රතු කුරුස", "செஞ்சிலுவை", "ቀይ መስቀል",
];
/** The UN, its agencies and the giving platforms, in the languages of the disasters' countries ("UN" itself is read apart, in capitals: UN_WORD). */
const UN_NAMES: readonly string[] = [
  "united nations", "un crisis relief", "uncrisisrelief", "naciones unidas", "nations unies", "nações unidas", "nazioni unite", "vereinte nationen", "birleşmiş milletler", "perserikatan bangsa bangsa",
  "liên hợp quốc", "umoja wa mataifa", "الأمم المتحدة", "سازمان ملل", "اقوام متحدہ", "संयुक्त राष्ट्र", "জাতিসংঘ", "联合国", "聯合國", "国連", "国際連合", "유엔",
  "국제연합", "สหประชาชาติ", "оон", "unicef", "ユニセフ", "유니세프", "يونيسف", "юнисеф", "ยูนิเซฟ", "यूनिसेफ", "unhcr", "acnur", "unrwa", "undrr", "unops",
  "unesco", "unocha", "ocha", "iom", "un women", "unwomen", "unhabitat", "wfp", "world food programme", "world food program",
  "programa mundial de alimentos", "programme alimentaire mondial", "برنامج الأغذية العالمي", "undp", "pnud", "unfpa", "world health organization",
  "gofundme", "globalgiving", "justgiving",
];
/**
 * Governments, their offices and civil protection, in the languages of
 * the disasters' countries ("government" itself is read apart: a
 * "Government Girls High School" is a school). Word endings are kept
 * apart: सरकार is a government, सरकारी विद्यालय a government school.
 */
const GOVERNMENT_NAMES: readonly string[] = [
  "gobierno", "gouvernement", "governo", "pemerintah", "kementerian", "prefeitura", "ayuntamiento", "alcaldía", "mairie", "comune di",
  "protección civil", "defensa civil", "defesa civil", "protezione civile", "protection civile", "civil protection", "civil defence", "civil defense",
  "national disaster management", "disaster management agency", "disaster management authority", "emergency management agency", "bnpb", "bpbd",
  "ndrrmc", "ndma", "odpem", "fema", "afad", "conred", "copeco", "sinaproc", "senapred", "indeci", "bakanlığı", "valiliği", "belediyesi", "chính phủ",
  "ủy ban nhân dân", "pamahalaan", "kagawaran", "bundesregierung", "landesregierung", "bundesministerium", "ministerium", "stadtverwaltung",
  "政府", "県庁", "市役所", "区役所", "町役場", "村役場", "정부", "시청", "도청", "รัฐบาล", "กระทรวง", "ศาลากลาง", "حكومة", "وزارة", "правительств*",
  "министерств*", "мчс", "मंत्रालय", "सरकार", "সরকার",
  // Regional, local and royal governments: Spain's, Colombia's, Portugal's and Latin America's, kingdoms by name.
  "generalitat", "xunta de galicia", "junta de andalucía", "junta de castilla", "junta de extremadura", "junta de galicia", "junta de comunidades",
  "gobernación", "diputación provincial", "diputación de", "cabildo insular", "câmara municipal", "municipalidad", "intendencia de",
  "ajuntament", "concello", "gouvernorat", "conseil régional", "conseil départemental", "royaume", "reino de españa", "reino de marruecos", "koninkrijk",
  "kingdom of morocco", "kingdom of thailand", "kingdom of cambodia", "kingdom of jordan", "kingdom of saudi arabia", "kingdom of bahrain",
  "kingdom of spain", "kingdom of the netherlands", "kingdom of bhutan", "kingdom of tonga", "kingdom of eswatini", "kingdom of lesotho",
  "ราชอาณาจักร", "المملكة المغربية", "المملكة العربية", "المملكة الأردنية", "مملكة البحرين",
  // Heads of government's relief funds: Kerala's Chief Minister's Distress Relief Fund (CMDRF), India's PMNRF and PM CARES.
  "cmdrf", "pmnrf", "pm cares", "cmrf", "मुख्यमंत्री", "प्रधानमंत्री", "മുഖ്യമന്ത്രി", "முதலமைச்சர்", "মুখ্যমন্ত্রী", "প্রধানমন্ত্রী",
];
const PROTECTED_TERMS = [...MOVEMENT_NAMES, ...UN_NAMES, ...GOVERNMENT_NAMES].map(compileTerm);
/** A head of government's or state's relief fund: "Chief Minister's Distress Relief Fund", "Prime Minister's National Relief Fund", "President's Relief Fund". */
const LEADER_FUND = /\b(?:chief minister|prime minister|president|governor|premier|cm|pm)['’]?s?\s+(?:[a-z]+\s+){0,3}?(?:relief|disaster|calamity|emergency|distress|national)\s+(?:[a-z]+\s+){0,2}?fund\b/;
/** A school's, students' or young people's government, which every Philippine high school has: "Supreme Student Government", "SSLG", "gobierno escolar". */
const STUDENT_GOVERNMENT =
  /\b(?:supreme\s+)?(?:secondary\s+)?(?:student|students|pupil|pupils|learner|learners|youth|school|campus)['’]?\s+government\b|\b(?:gobierno|governo)\s+(?:escolar|estudiantil|estudantil|juvenil|do gremio)\b/g;
/** "Government" with up to three words and then a school's, college's or hospital's: a government school, not the government. */
const GOVERNMENT_SCHOOL =
  /\b(?:government|govt\.?)\s+(?:[a-z.'’]+\s+){0,3}?(?:schools?|colleges?|hospitals?|polytechnic|universit(?:y|ies)|institute|academy|vidyalaya|madras+a|clinic|dispensary|primary|secondary|high)\b/g;
/** Portfolios a ministry or department is named for: "Ministry of Health", "Ministerio de Salud"; a church's "Ministry of Hope" or "Ministerio de Alabanza" names none. */
const PORTFOLIOS = [
  "health education finance interior home foreign social labour labor agriculture defence defense local national security economy economic environment",
  "housing transport works public women gender family welfare disaster disasters humanitarian planning justice tourism culture information water energy",
  "industry trade science salud sante saude salute educacion educacao istruzione hacienda fazenda economia interieur defensa defesa desarrollo",
  "desenvolvimento vivienda trabajo travail trabalho agricultura ambiente environnement obras seguridad securite seguranca mujer mulher familia famille",
  "bienestar cultura turismo justicia justica energia transporte transports gobernacion relaciones relations exteriores asuntos affaires proteccion",
  "protecao solidaridad solidarite solidariedade inclusion cidadania ciudadania integracion integracao",
]
  .join(" ")
  .split(" ");
const MINISTRY = new RegExp(
  `\\b(?:ministry|ministries|department|ministerio|ministere|ministero|secretaria)\\s+(?:of|de|da|do|des|du|del|della|dell)\\s+(?:(?:the|la|el|l|a|o|le|lo)\\s+)?(?:${PORTFOLIOS.join("|")})\\b`,
);

/**
 * "UN" or "ONU" as a word in capitals, in a name that is not all
 * capitals ("UN Crisis Relief", "UN-Habitat Jamaica", "IOM UN Migration";
 * never French or Spanish "un"); in an all-capitals name only before an
 * aid word ("UN HURRICANE RELIEF").
 */
const UN_WORD = /(?<![\p{L}\p{N}])(?:UN|U\.N\.|ONU)(?![\p{L}\p{N}])/u;
const UN_CAPS = /(?<![\p{L}\p{N}])(?:UN|U\.N\.|ONU)[\s-]+(?:CRISIS|RELIEF|WOMEN|HABITAT|MIGRATION|REFUGEES?|AGENCY|HUMANITARIAN|EMERGENCY|APPEAL|FUND|AID|FOOD|DISASTER|HURRICANE|TYPHOON|CYCLONE|EARTHQUAKE|FLOOD)\b/u;

/**
 * A word that mixes Latin letters with Cyrillic or Greek ones, as
 * look-alikes write official names ("Jamaica Rеd Cross" with a Cyrillic
 * е), or null.
 */
export function mixedScriptWord(text: string | undefined): string | null {
  for (const w of (text ?? "").split(/[^\p{L}\p{M}]+/u)) if (/\p{Script=Latin}/u.test(w) && /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(w)) return w;
  return null;
}

/**
 * The short names of Red Cross and Red Crescent societies, from their
 * sites' hosts in the registry (RegistrySociety.hosts): the first label of
 * three to five letters ("pmi.or.id" -> "PMI", "arcs.org.af" -> "ARCS",
 * "nrcs.org" -> "NRCS"), in capitals, each once.
 */
export function societyAcronyms(hosts: readonly string[]): string[] {
  const out = new Set<string>();
  for (const h of hosts) {
    const label = h.split("/")[0].toLowerCase().replace(/^www\./, "").split(".")[0];
    if (/^[a-z]{3,5}$/.test(label)) out.add(label.toUpperCase());
  }
  return [...out];
}

/**
 * The official body or platform a name claims, or null: "Jamaica Red
 * Cross" -> "red cross", "日本赤十字社 支援窓口" -> "赤十字", "Ministry of
 * Health" -> "ministry", "UN Crisis Relief" -> "UN". The movement's names
 * (MOVEMENT_NAMES, Pashto, Tajik, Kyrgyz and Uzbek among them), the UN's
 * and its agencies' in the disasters' languages (ユニセフ, يونيسف) and
 * "UN" in capitals (UN_WORD), the giving platforms', governments' and
 * their offices', regional and royal governments' (Generalitat, Royaume du
 * Maroc) and heads of government's relief funds (CMDRF, "Prime Minister's
 * Relief Fund"), with a "Government Girls High School" and a school's
 * "Supreme Student Government" aside; ministries by their portfolio; the
 * registry's society names (societyNames) and their short names in
 * capitals (acronyms: PMI, ARCS) all count. A local group's page may not
 * use one.
 */
export function protectedNameIn(name: string | undefined, societyNames: readonly string[] = [], acronyms: readonly string[] = []): string | null {
  const raw = cleanText(name, 300);
  const text = foldText(raw)
    .replace(/[-_‐‑–—/|:·•]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(STUDENT_GOVERNMENT, " ");
  if (!text.trim()) return null;
  const term = [...PROTECTED_TERMS, ...societyNames.map(societyTerm)].find((t) => text.includes(t.needle) && t.re.test(text));
  if (term) return term.term.replace(/\*$/, "");
  if (/\p{Ll}/u.test(raw) ? UN_WORD.test(raw) : UN_CAPS.test(raw)) return "UN";
  if (/\p{Ll}/u.test(raw)) {
    const acronym = acronyms.find((a) => new RegExp(`(?<![\\p{L}\\p{N}])${a}(?![\\p{L}\\p{N}])`, "u").test(raw));
    if (acronym) return acronym;
  }
  if (LEADER_FUND.test(text)) return "relief fund";
  if (/\bgovernment\b/.test(text.replace(GOVERNMENT_SCHOOL, " "))) return "government";
  if (MINISTRY.test(text)) return "ministry";
  return null;
}

/** A society's registry name as a term, compiled once. */
const societyTerms = new Map<string, ReturnType<typeof compileTerm>>();
function societyTerm(name: string): ReturnType<typeof compileTerm> {
  let t = societyTerms.get(name);
  if (!t) societyTerms.set(name, (t = compileTerm(foldText(name).replace(/[-_]+/g, " "))));
  return t;
}

/** Path segments that only choose a language or an app's version: "en", "pt-br", "v4". */
const LOCALE_SEGMENT = /^(?:[a-z]{2}(?:[-_][a-z]{2,4})?|v\d+)$/;
/** First path segments, after a language or version, of a person's own page: a user, profile or member page ("/u/name", "/@name"). */
const PERSON_SEGMENT = /^(?:u|users?|profiles?|members?|people|@.+|~.+)$/;
/** Path segments of news articles and blog posts. */
const ARTICLE_SEGMENT = /^(?:news|newsroom|article|articles|story|stories|blogs?|posts?|press|press-releases?|noticias?|nouvelles|actualites|actualidad|nachrichten|notizie|berita|tin-tuc|amp)$/;

/**
 * Why a URL's path is no group's own donation page, or null: a person's
 * page (/u/<name>, /@name, after a language or version segment), or a news
 * article or blog post (/news/, /blog/, /2025/10/). A platform's pages
 * (/campaign/<slug>, /projects/<id>) are known by the platform's host
 * (CROWDFUNDING_HOSTS): on a group's own site, WordPress and its donation
 * plugins put appeals at /campaigns/<slug> and /projects/<slug> too.
 */
export function pathProblem(url: URL): string | null {
  const segments = url.pathname.split("/").filter(Boolean).map((s) => s.toLowerCase());
  const first = segments.length > 1 && LOCALE_SEGMENT.test(segments[0]) ? 1 : 0;
  if (segments.length > first + 1 && PERSON_SEGMENT.test(segments[first])) return `a person's page (/${segments[first]}/...), not a group's own`;
  if (segments.some((s) => ARTICLE_SEGMENT.test(s))) return "a news article or blog post";
  // Dated paths: /2025/10/..., /2025-10-29/...
  if (/\/(?:19|20)\d\d[/-](?:0?[1-9]|1[0-2])(?:[/-]|$)/.test(url.pathname)) return "a news article or blog post";
  return null;
}

/** What localUrlProblem needs: the disaster's allowlist context, every society's sites and the run's news hosts. */
export interface LocalContext {
  /** The disaster's allowlist context (donationContext): official sites are listed with the official links. */
  donation: DonationContext;
  /** Every Red Cross and Red Crescent society's sites in the registry (RegistrySociety.hosts). */
  societyHosts?: readonly string[];
  /** Hosts of the site's own news articles, which are news sites. */
  newsHosts?: ReadonlySet<string>;
  /** Every society's name in the registry (RegistrySociety.name), which a local group may not use (protectedNameIn). */
  societyNames?: readonly string[];
  /** The societies' short names from their hosts (societyAcronyms: PMI, ARCS), which a local group may not use either. */
  societyAcronyms?: readonly string[];
}

/** True for a host label with "news" as one of its parts ("jamaica-news"), but not good news ("good-news-church"). */
function isNewsLabel(label: string): boolean {
  const parts = label.split("-");
  return parts.some((p, i) => p === "news" && parts[i - 1] !== "good");
}

/** True for host or a subdomain of one in the list. */
function onAny(host: string, list: Iterable<string>): boolean {
  for (const d of list) if (hostMatches(host, d.split("/")[0])) return true;
  return false;
}

/**
 * Why a URL may not be shown as a local group's donation page, or null
 * when it may: https only; no credentials, port, IP address, punycode or
 * shortener (donationUrlProblem's hygiene); not a social network, portal,
 * blog, newsletter, site or form builder, file host or archive (sites
 * anyone can publish on), a crowdfunding or giving platform, a payment,
 * checkout, money-transfer or crypto service, a marketplace or a news site
 * (any host with "news" as a part of a label among them); not an official
 * site (the disaster's allowlist, any Red Cross or Red Crescent society, a
 * government or an international body), which belongs with the official
 * links, nor a host that carries an official body's or a platform's name
 * (a look-alike such as jamaicaredcrossrelief.org); never a person's page
 * or a news article or blog post by its path (pathProblem), or a blood
 * donation, listing, search or home page.
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
  if (onAny(host, SHARED_HOSTS) || onAny(host, SOCIAL_HOSTS) || onAny(host, PUBLISHING_HOSTS)) return "social network or a site anyone can publish on";
  if (onAny(host, CROWDFUNDING_HOSTS)) return "crowdfunding or giving platform";
  if (onAny(host, PAYMENT_HOSTS) || PAYMENT_BRAND.test(host)) return "payment, checkout or money-transfer service";
  if (MARKETPLACE.test(host)) return "marketplace";
  if (onAny(host, NEWS_HOSTS) || onAny(host, ctx.newsHosts ?? []) || host.split(".").slice(0, -1).some(isNewsLabel)) return "news site";
  if (hostClass(url, ctx.donation) || onAny(host, ctx.societyHosts ?? []) || GOVERNMENT_HOST.test(host)) return "official site, listed with the official links";
  const claimed = protectedNameInHost(host, ctx.donation.countryNameIndex);
  if (claimed) return `its host carries an official body's or a platform's name (${claimed})`;
  const path = pathProblem(url);
  if (path) return path;
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
 * Words that only say what kind of place a local name is, before it or
 * after it, in the scripts the geocoder's local names come in: Thai
 * จังหวัด (province), อำเภอ (district) and ประเทศ (country), Lao, Khmer and
 * Arabic and Persian province and city words, Japanese 県 and 市,
 * Chinese 省, Korean 도 and 시, Hindi जिला, Bengali জেলা, Burmese and
 * Russian region words. A page names Chiang Rai "เชียงราย", not
 * "จังหวัดเชียงราย".
 */
const NAME_PREFIXES: readonly string[] = [
  "จังหวัด", "อำเภอ", "ตำบล", "เทศบาลนคร", "เทศบาลเมือง", "เทศบาลตำบล", "เมือง", "เขต", "แขวง", "ประเทศ", "ແຂວງ", "ເມືອງ", "ປະເທດ", "ខេត្ត", "ស្រុក", "ក្រុង",
  "ប្រទេស", "محافظة ", "ولاية ", "إقليم ", "اقليم ", "معتمدية ", "مدينة ", "منطقة ", "قضاء ", "عمالة ", "جهة ", "بلدية ", "مديرية ", "ناحية ", "استان ",
  "شهرستان ", "شهر ",
];
const NAME_SUFFIXES: readonly string[] = [
  "特别行政区", "自治区", "自治州", "特別市", "특별자치도", "특별자치시", "광역시", "특별시", "省", "市", "县", "縣", "区", "區", "镇", "鎮", "乡", "鄉", "県", "府", "都",
  "町", "村", "郡", "도", "시", "군", "구", "읍", "면", " जिला", " ज़िला", " जिल्ला", " জেলা", " বিভাগ", " উপজেলা", "တိုင်းဒေသကြီး", "ပြည်နယ်", "မြို့နယ်",
  "မြို့", " область", " край", " район", " oblast",
];
const CLOSE_SCRIPTS = /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/** True for a name long enough to stand alone: two characters in Chinese, Japanese or Korean, three letters otherwise. */
function nameLongEnough(name: string): boolean {
  return [...name].length >= (CLOSE_SCRIPTS.test(name) ? 2 : 3);
}

/**
 * A local name and the shorter forms a page may use for it: without the
 * words that say what kind of place it is (NAME_PREFIXES, NAME_SUFFIXES:
 * "จังหวัดเชียงราย" -> "เชียงราย", "石川県" -> "石川", "محافظة حلب" ->
 * "حلب"), and in Arabic script without a last ا, ة, ه or ى, which
 * spellings vary in ("سوريا", "سورية" -> "سوري"). Each form is long enough
 * to stand alone (two characters in Chinese, Japanese or Korean, three
 * letters otherwise).
 */
export function nameForms(name: string | undefined): string[] {
  const n = cleanText(name, 80);
  if (!n) return [];
  const out = [n];
  let core = n;
  for (let changed = true; changed; ) {
    changed = false;
    for (const prefix of NAME_PREFIXES) {
      const rest = core.startsWith(prefix) ? core.slice(prefix.length).trim() : "";
      if (rest && nameLongEnough(rest)) [core, changed] = [rest, true];
    }
    for (const suffix of NAME_SUFFIXES) {
      const rest = core.endsWith(suffix) ? core.slice(0, -suffix.length).trim() : "";
      if (rest && nameLongEnough(rest)) [core, changed] = [rest, true];
    }
  }
  if (core !== n) out.push(core);
  if (/^[\p{Script=Arabic}\s]+$/u.test(core) && /[اةهى]$/.test(core) && [...core].length >= 4) out.push(core.slice(0, -1));
  return [...new Set(out)];
}

/**
 * A place's own names from the geocoder, each split by script first (one
 * name holding "Marrakech ⵎⵕⵕⴰⴽⵯⵛ مراكش" gives three, see splitScripts),
 * with their shorter forms (nameForms).
 */
function localFormsOf(localNames: Readonly<Record<string, readonly string[]>>, place: string): string[] {
  return (Object.hasOwn(localNames, place) ? localNames[place] : []).flatMap(splitScripts).flatMap(nameForms);
}

/**
 * A country's name in the language most spoken there, from the runtime's
 * CLDR data: "TH" -> ["ไทย"], "MA" -> ["المغرب"], "JP" -> ["日本"]; none
 * when the runtime has no name for it.
 */
export function ownCountryNames(code: string): string[] {
  try {
    const locale = new Intl.Locale(`und-${code}`).maximize();
    const tag = locale.script ? `${locale.language}-${locale.script}` : locale.language;
    const name = new Intl.DisplayNames([tag], { type: "region", fallback: "none" }).of(code.toUpperCase());
    return name ? [name] : [];
  } catch {
    return [];
  }
}

/**
 * The names a local group's page must use to be about the disaster's
 * place: each country's English name, its name in its press language
 * (pipeline/config/languages.json) and in the language most spoken there
 * (ownCountryNames), the disaster's places with their own names from the
 * geocoder (localNames, by place), and the place words of its title; local
 * names also in their shorter forms (nameForms: "ประเทศไทย" -> "ไทย",
 * "จังหวัดเชียงราย" -> "เชียงราย"). Each once, at least three letters (or
 * two characters in Chinese, Japanese or Korean).
 */
export function placeNames(
  d: Pick<Disaster, "countries" | "places">,
  countryNames: Record<string, string>,
  pressNames: Record<string, string> = {},
  titleWords: readonly string[] = [],
  localNames: Readonly<Record<string, readonly string[]>> = {},
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (name: unknown) => {
    const n = cleanText(name, 80).replace(/\*/g, "");
    const key = foldText(n);
    if (!n || seen.has(key) || !nameLongEnough(n)) return;
    seen.add(key);
    out.push(n);
  };
  for (const c of d.countries) {
    add(Object.hasOwn(countryNames, c) ? countryNames[c] : "");
    nameForms(Object.hasOwn(pressNames, c) ? pressNames[c] : "").forEach(add);
    ownCountryNames(c).flatMap(nameForms).forEach(add);
  }
  for (const p of d.places ?? []) {
    add(p.name);
    localFormsOf(localNames, p.name).forEach(add);
  }
  titleWords.forEach(add);
  return out;
}

/** Words that join the parts of a place's name: "Rio Grande do Sul", "Port-au-Prince", "Isle of Wight". Folded. */
const PLACE_CONNECTORS: ReadonlySet<string> = new Set("do da dos das de del della delle dei di du des d la le el al au aux of the von van der den zu".split(" "));

/**
 * The place words of a title as written there, runs of them joined, with
 * the words that join a place's name inside a run ("do" in "Rio Grande do
 * Sul") and never across a comma or other punctuation: "Bangladesh:
 * Monsoon Depression in Cox's Bazar" with ["cox", "bazar"] -> ["Cox's
 * Bazar"]; "Floods in Rio Grande do Sul, Brazil" -> ["Rio Grande do Sul"].
 * A page about the disaster names one of these whole (topicProblem).
 */
export function titlePlaces(title: string, words: readonly string[]): string[] {
  const place = new Set(words);
  const out: string[] = [];
  let start = -1;
  let end = -1;
  let last = 0;
  const close = () => {
    if (start >= 0) out.push(title.slice(start, end));
    start = -1;
  };
  for (const m of title.matchAll(/[\p{L}\p{M}][\p{L}\p{M}'’.-]*/gu)) {
    if (start >= 0 && /[^\s]/u.test(title.slice(last, m.index))) close();
    last = m.index + m[0].length;
    const parts = asciiWords(m[0]).filter((w) => w !== "s");
    const named = parts.filter((w) => !PLACE_CONNECTORS.has(w));
    if (named.length > 0 && named.every((w) => place.has(w))) {
      if (start < 0) start = m.index;
      end = m.index + m[0].length;
    } else if (!(start >= 0 && parts.length > 0 && parts.every((w) => PLACE_CONNECTORS.has(w)))) close();
  }
  close();
  return [...new Set(out)];
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

/** What the live check of a local group's page holds it to, for one disaster. */
export interface LocalPageRules {
  /** Names of the disaster's place, one of which the page must use (placeNames). */
  names: readonly string[];
  /**
   * Names of the places in the disaster's title, as the title writes them
   * and in their own scripts ("Chiang Rai", "เชียงราย"): a title, heading or
   * address that uses one is about the disaster (topicProblem).
   */
  titleNames?: readonly string[];
  /** The disaster's type: a page that names only hazards of other kinds is another disaster's. */
  type?: DisasterType;
  /** The earliest year the page may name (eventYear); null or missing for no limit. */
  minYear?: number | null;
  /** When the disaster started: a page that dates itself well before is an earlier one's (pageDateProblem). */
  started?: string;
  /**
   * The disaster's own place names (its places, their provinces and own
   * names, its title's places): a country's name inside one of them
   * ("Panama City", "Jersey Shore Region") names no other country.
   */
  ownPlaces?: readonly string[];
  /** The languages its pages are read in for other countries' names (nameLanguages); FOREIGN_NAME_LANGUAGES and its countries' main languages when missing. */
  languages?: readonly string[];
}

/** What a page says of itself: its site's name, its title and its main heading, each one line; and whether it marks itself a news article. */
export interface PageSelf {
  name: string;
  title: string;
  heading: string;
  news: boolean;
}

/**
 * JSON-LD types that mark a news article, or a post on a forum or social
 * site, and the type of a news publisher. WordPress's SEO plugins give a
 * group's own posts "Article" or "BlogPosting" nodes and
 * article:published_time, and every page og:type "article", so none of
 * those marks anything: news sites are known by their hosts and paths.
 */
const NEWS_TYPES: ReadonlySet<string> = new Set([
  "NewsArticle", "ReportageNewsArticle", "AnalysisNewsArticle", "BackgroundNewsArticle", "OpinionNewsArticle", "ReviewNewsArticle", "LiveBlogPosting",
  "SocialMediaPosting", "DiscussionForumPosting", "NewsMediaOrganization",
]);

/** The content of a <meta> tag by its property or name, in either attribute order; "" when there is none. */
function metaContent(html: string, key: string): string {
  const k = key.replace(/[.*+?^${}()|[\]\\:]/g, "\\$&");
  const re = new RegExp(`<meta\\b(?=[^>]*\\b(?:property|name)\\s*=\\s*["']${k}["'])[^>]*\\bcontent\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i");
  const m = re.exec(html);
  return m ? (m[1] ?? m[2] ?? "") : "";
}

/**
 * What a page says of itself: its site's name (og:site_name, else
 * application-name), its title (og:title, else <title>), its first <h1>,
 * and whether it is a news article or a forum or social post (NEWS_TYPES
 * in its JSON-LD).
 */
export function readPageSelf(raw: string): PageSelf {
  const html = raw.slice(0, MAX_PAGE_CHARS);
  const name = textOf(metaContent(html, "og:site_name") || metaContent(html, "application-name"), 80);
  const title = textOf(metaContent(html, "og:title") || (/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? ""), 160);
  const heading = textOf(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? "", 160);
  const news = ldOf(html).some((n) => ldTypeIs(n, NEWS_TYPES));
  return { name, title, heading, news };
}

/** The text a reader sees on a page: pageText without its scripts' data. */
function visibleText(html: string): string {
  return pageText(html.slice(0, MAX_PAGE_CHARS).replace(/<script\b[\s\S]*?<\/script\s*>/gi, " "));
}

/** What earlierEventProblem reads of the disaster's context: its countries too, for another country's name. */
export type LocalMatchContext = MatchContext & Pick<DonationContext, "countries">;

/**
 * Why texts about a page (its URL path, title without its site's name, or
 * heading) say it is for an earlier or another disaster, or null: a year
 * older than the disaster's (rules.minYear; a founding year or a span's
 * first year aside, other calendars read too, see eventYearsIn), another
 * country's name, in English by whole names ("Dona para el terremoto de
 * Ecuador" for a Venezuelan earthquake) or in another language
 * (foreignCountryIn: "Séisme en Algérie" for a Moroccan one; a name inside
 * one of the disaster's own places, rules.ownPlaces, is none), another
 * storm's name (otherStorm: "donate-2024-hurricane-beryl" for Hurricane
 * Melissa), or hazards that are all of another kind than the disaster's
 * (strictly, as hubMatches reads them, in any script).
 */
export function earlierEventProblem(texts: readonly string[], rules: Pick<LocalPageRules, "type" | "minYear" | "ownPlaces" | "languages">, ctx: LocalMatchContext): string | null {
  const { words, hazards } = readTexts(texts);
  const minYear = rules.minYear;
  const old = typeof minYear === "number" ? texts.flatMap(eventYearsIn).filter((y) => y < minYear) : [];
  if (old.length > 0) return `an earlier disaster's page (${old[0]})`;
  if (readWords(words, ctx.countries, ctx, rules.ownPlaces).foreign) return "names another country";
  if (foreignCountryIn(texts, ctx, rules.languages ?? nameLanguages(ctx.countries), rules.ownPlaces)) return "names another country";
  const storm = otherStorm(words, ctx, rules.type);
  if (storm) return `names another storm (${storm})`;
  const all = [...words, ...hazards];
  if (rules.type && hazardFit(all, rules.type) === "other" && !stormAftermath(all, rules.type)) return "names another kind of disaster";
  return null;
}

/** Texts folded as a phrase is looked for in them: a path's slashes, hyphens and underscores as spaces. */
function phraseText(texts: readonly string[]): string {
  return foldText(texts.join("\n")).replace(/[-_/+]+/g, " ");
}

/** The places of the disaster's title as phrases (rules.titleNames, else the title's own: titlePlaces), compiled. */
function titlePhrases(rules: Pick<LocalPageRules, "titleNames">, ctx: MatchContext): ReturnType<typeof compileTerm>[] {
  const names = [...(rules.titleNames ?? titlePlaces(ctx.title ?? "", ctx.eventWords ?? [])), ...(ctx.stormNames ?? [])];
  return names.map((n) => compileTerm(foldText(n).replace(/[-_/+]+/g, " ").replace(/\*/g, "")));
}

/** True when texts name a place of the disaster's title as a whole phrase ("Rio Grande do Sul", "เชียงราย"), never by one of its words alone. */
function namesTitlePlace(texts: readonly string[], rules: Pick<LocalPageRules, "titleNames">, ctx: MatchContext): boolean {
  const text = phraseText(texts);
  return titlePhrases(rules, ctx).some((t) => text.includes(t.needle) && t.re.test(text));
}

/** True when texts name a hazard of the disaster's kind (strictly, in any of the languages hazardFit and hazardWordsIn read). */
function namesHazard(texts: readonly string[], type: DisasterType | undefined): boolean {
  const { words, hazards } = readTexts(texts);
  return Boolean(type) && hazardFit([...words, ...hazards], type as DisasterType) === "fits";
}

/**
 * Why a page does not say it is about this disaster, or null. What it says
 * of itself (own: its title without its site's name, see ownTitle, its
 * heading and its address; never the site's own name, which may hold a
 * word of the title, as "Chiang Mai Children's Home" does for floods in
 * Chiang Rai) must name a place of the disaster's title as a whole phrase,
 * in any script (titleNames: "Rio Grande do Sul", "เชียงราย"; a named
 * storm's name or its other names), or a hazard of its kind (strictly, in
 * any of the languages hazardFit and hazardWordsIn read); a named storm's
 * page that names only the hazard must name the storm somewhere. A page
 * that only names the country, such as a charity's general "Give" page
 * saying "across Jamaica", is no page for the disaster.
 */
export function topicProblem(own: readonly string[], text: string, rules: Pick<LocalPageRules, "type" | "titleNames">, ctx: MatchContext): string | null {
  if (namesTitlePlace(own, rules, ctx)) return null;
  if (!namesHazard(own, rules.type)) return "its title, heading and address name neither the disaster's hazard nor a place of its title";
  const title = new Set(ctx.eventWords ?? []);
  if (isNamedStorm({ type: rules.type as DisasterType }, ctx) && !asciiWords(text).some((w) => title.has(w))) return "names the hazard but not the storm";
  return null;
}

/**
 * Why a page's own date says it is an earlier disaster's, or null: it was
 * published (publishedOf: its WebPage's datePublished, as WordPress's SEO
 * plugins give every page, else a post's; else its first <time>) more
 * than PAGE_BEFORE_DAYS before the disaster started, and nothing shows an
 * older page rewritten for it: its title, heading and address (own) name
 * neither the disaster's storm nor a year no older than the disaster's,
 * and it was not changed since (modified: its JSON-LD dateModified, no
 * earlier than PAGE_BEFORE_DAYS before the start) with its title or
 * heading naming both the disaster's hazard and a place of its title. A
 * group's standing /donate/ page, created years ago and rewritten as
 * "Enchentes no Rio Grande do Sul: doe agora", passes; a 2016 page last
 * changed in 2016 does not.
 */
export function pageDateProblem(
  published: string | null,
  own: readonly string[],
  rules: Pick<LocalPageRules, "minYear" | "started" | "type" | "titleNames">,
  ctx: MatchContext,
  modified: string | null = null,
): string | null {
  if (!published || !rules.started || !datedBefore(published, { started: rules.started })) return null;
  const storms = new Set(disasterStorms(ctx));
  if (readTexts(own).words.some((w) => storms.has(w))) return null;
  const minYear = rules.minYear;
  if (typeof minYear === "number" && own.flatMap(eventYearsIn).some((y) => y >= minYear)) return null;
  const rewritten =
    modified !== null &&
    Number.isFinite(Date.parse(modified)) &&
    !datedBefore(modified, { started: rules.started }) &&
    own.slice(0, 2).some((t) => namesHazard([t], rules.type) && namesTitlePlace([t], rules, ctx));
  if (rewritten) return null;
  return `published ${published.slice(0, 10)}, before the disaster`;
}

/**
 * When a page was last changed: its JSON-LD WebPage's dateModified, else
 * any node's, else its article:modified_time; null when it gives none.
 */
export function modifiedOf(html: string): string | null {
  const nodes = ldOf(html.slice(0, MAX_PAGE_CHARS));
  const page = nodes.find((n) => ldTypeIs(n, new Set(["WebPage"])) && isoTime(n.dateModified)) ?? nodes.find((n) => isoTime(n.dateModified));
  if (page) return isoTime(page.dateModified);
  return isoTime(metaContent(html.slice(0, MAX_PAGE_CHARS), "article:modified_time"));
}

/** The first <time datetime> of a page, as an ISO time: Wix, Squarespace and blog themes date a page this way; null when it has none. */
export function timeOf(html: string): string | null {
  return isoTime(decodeEntities(/<time\b[^>]*\bdatetime\s*=\s*["']([^"']+)["']/i.exec(html.slice(0, MAX_PAGE_CHARS))?.[1] ?? ""));
}

/** How much of a page's visible text, from its heading on, is read for the years it gives its disaster. */
const LEAD_CHARS = 1_500;

/**
 * Why the first paragraphs of a page that gives no date of its own say it
 * is an earlier disaster's, or null: a sentence there that names a hazard
 * of the disaster's kind gives a year older than the disaster's, and none
 * gives a recent one ("El 16 de abril de 2016 un terremoto de 7,8 golpeó
 * Ecuador", on a Wix page). The text is read from its heading on (else
 * from its start), LEAD_CHARS of it. A page that names the disaster's
 * storm, or whose title, heading or address names a recent year, passes.
 */
export function leadYearProblem(html: string, own: readonly string[], rules: Pick<LocalPageRules, "type" | "minYear">, ctx: MatchContext): string | null {
  const minYear = rules.minYear;
  if (typeof minYear !== "number" || !rules.type) return null;
  if (own.flatMap(eventYearsIn).some((y) => y >= minYear)) return null;
  const page = html.slice(0, MAX_PAGE_CHARS);
  const h1 = /<h1\b/i.exec(page);
  // Headings, paragraphs and other blocks end sentences too.
  const blocks = (h1 ? page.slice(h1.index) : page).replace(/<\/?(?:p|h[1-6]|div|li|br|tr|td|th|section|article|header|footer|blockquote|figcaption|dd|dt)\b[^>]*>/gi, " ¶ ");
  const lead = visibleText(blocks).slice(0, LEAD_CHARS);
  const storms = new Set(disasterStorms(ctx));
  if (storms.size > 0 && asciiWords(lead).some((w) => storms.has(w))) return null;
  const years = lead
    .split(/[.!?](?=\s|$)|[。！？\n¶]+|\s[-–—]\s/)
    .filter((sentence) => namesHazard([sentence], rules.type))
    .flatMap(eventYearsIn);
  if (years.some((y) => y >= minYear)) return null;
  const old = years.find((y) => y < minYear);
  return old === undefined ? null : `an earlier disaster's page (${old})`;
}

/** Words that say a page asks for money into a bank account, near which "a nombre de" names whose account it is. */
const BANK_WORDS = /\b(?:cuenta|cuentas|conta|contas|banco|bank|compte|account|pix|cbu|cvu|clabe|iban|transferencia|transferencias|deposito|depositos|virement|nequi|daviplata|yape|plin|pago movil)\b/;
/** Words that start a group's own name, after "a nombre de" or "em nome de": the account is the group's, not a person's. */
const GROUP_WORDS: ReadonlySet<string> = new Set(
  [
    "fundacion fundacao fondation asociacion associacao association asociación iglesia igreja eglise parroquia paroquia paroisse colegio escuela escola ecole",
    "liceo instituto institut comite club cooperativa cooperative sociedad sociedade societe corporacion corporacao ong ngo mision missao mission ministerio",
    "caritas red rede centro centre hogar lar casa comunidad comunidade communaute junta union uniao unidad congregacion congregacao diocesis diocese",
    "arquidiocesis arquidiocese organizacion organizacao organisation movimiento movimento proyecto projeto programa universidad universidade universite",
    "consejo conselho federacion federacao amigos amis voluntarios voluntariado grupo groupe vicaria capilla capela obra obras hermandad irmandade",
    "patronato cofradia confraria",
  ]
    .join(" ")
    .split(" "),
);

/**
 * Ways scams ask for money and groups' own donation pages do not, in
 * folded text: crypto by name or ticker (btc, eth, usdc, cripto*,
 * criptomoeda*), gift card codes (iTunes, Steam, Google Play cards, or
 * codes sent: "send the gift card codes"; a supermarket's cards for
 * families are no such ask), Zelle, Cash App or Venmo, money-transfer
 * services, and transfers to a person's own account ("transfer to my
 * account", "deposita en mi cuenta").
 */
const PAYMENT_ASKS: readonly (readonly [RegExp, string])[] = [
  [
    /\b(?:bitcoins?|btc|ethereum|eth|usdt|usdc|tether|litecoin|ltc|dogecoin|doge|monero|xmr|xrp|solana|bnb|trx|tron|binance pay|crypto|cryptos|cryptocurrenc(?:y|ies)|cripto\w*|criptomoeda\w*|kripto\w*|krypto\w*|wallet address(?:es)?|crypto wallet|sol (?:wallet|address))\b/,
    "crypto",
  ],
  [
    /\b(?:itunes|steam|google play|razer gold|apple) (?:gift )?cards?\b|\bgift ?cards? (?:codes?|numbers?|pins?)\b|\b(?:send|email|text|scratch|share|upload)\b(?:\s+\S+){0,4}?\s+(?:gift ?cards?|cards?) (?:codes?|numbers?|pins?)\b|\bsend (?:us |me )?(?:\S+\s+){0,2}gift ?cards\b/,
    "gift cards",
  ],
  [/\bzelle\b/, "Zelle"],
  [/\b(?:cash ?app|venmo)\b/, "Cash App or Venmo"],
  [/\b(?:western union|moneygram|worldremit|remitly|ria money transfer)\b/, "a money-transfer service"],
  [/\b(?:wire|bank|money) transfers? (?:directly )?to (?:me|my|him|her|his)\b|\b(?:my|his|her) (?:personal bank|personal|bank) account\b/, "a transfer to a person's own account"],
  [/\bsend (?:money|funds|it|your donations?) (?:directly )?to (?:me|my|him|her)\b/, "a transfer to a person's own account"],
  [/\b(?:mi|su) cuenta (?:bancaria )?personal\b|\bmon compte personnel\b|\bminha conta pessoal\b/, "a transfer to a person's own account"],
  [
    /\b(?:transfer|transfers|transferring|deposit|deposits|send|wire|pay|deposita|depositar|depositen|deposite|depositem|transfiere|transferir|transfiera|transfieran|transfira|transfiram|envia|envie|enviar|virez|versez)\b(?:\s+\S+){0,5}?\s+(?:to|into|in|en|a|na|no|para|sur|au|on)\s+(?:my|mi|minha|meu|mon|ma)\s+(?:(?:own|personal|personnel|propia|pessoal|bank|bancaria|bancaire|savings|checking)\s+)?(?:account|acct|cuenta|conta|compte)\b/,
    "a transfer to a person's own account",
  ],
];

/** Wallet addresses, in the page's own letters: Bitcoin (bc1..., 1... or 3...), Ethereum and its tokens (0x and 40 hex digits) and Tron (T and 33). */
const WALLET_ADDRESSES: readonly RegExp[] = [
  /(?<![A-Za-z0-9])bc1[02-9ac-hj-np-z]{25,62}(?![A-Za-z0-9])/i,
  /(?<![A-Za-z0-9])0x[0-9a-fA-F]{40}(?![A-Za-z0-9])/,
  /(?<![A-Za-z0-9])T[1-9A-HJ-NP-Za-km-z]{33}(?![A-Za-z0-9])/,
  /(?<![A-Za-z0-9])[13](?=[1-9A-HJ-NP-Za-km-z]*[A-Za-z])(?=[1-9A-HJ-NP-Za-km-z]*\d)[1-9A-HJ-NP-Za-km-z]{25,34}(?![A-Za-z0-9])/,
];

/** True when "a nombre de", "em nome de" or "au nom de" near a bank word names no group: "a nombre de Juan Pérez". */
function personalAccount(t: string): boolean {
  for (const m of t.matchAll(/\b(?:a nombre de|em nome de|au nom de)\s+(?:(?:la|el|los|las|a|o|os|as|le|les|l|da|do|das|dos)\s+)?([a-zÀ-ɏ]+)/g)) {
    const near = t.slice(Math.max(0, m.index - 120), m.index + m[0].length + 40);
    if (BANK_WORDS.test(near) && !GROUP_WORDS.has(m[1])) return true;
  }
  return false;
}

/**
 * Why a page asks for money the way scams do, or null (PAYMENT_ASKS, a
 * wallet address, or a bank account in a person's name): "URGENT: Send
 * Bitcoin/Zelle to help Hurricane Melissa victims", "Donate BTC to
 * bc1q...", "deposita en mi cuenta Banesco ... a nombre de Juan Pérez".
 */
export function paymentProblem(text: string): string | null {
  const t = foldText(text).replace(/\s+/g, " ");
  const ask = PAYMENT_ASKS.find(([re]) => re.test(t));
  if (ask) return `asks for ${ask[1]}, as scams do`;
  if (WALLET_ADDRESSES.some((re) => re.test(text))) return "asks for crypto, as scams do";
  if (personalAccount(t)) return "asks for a transfer to a person's own account, as scams do";
  return null;
}

/**
 * What crowdfunding and giving platforms say on a person's campaign page,
 * and a group's own page does not, in folded text: an invitation to start
 * one's own fundraiser ("Start a fundraiser", "Lancer ma cagnotte", "Crie
 * sua vaquinha", "Crea tu campaña", "Buat galang dana", "Kampanya
 * oluştur") or a person credited as its creator ("Campaign created by",
 * "Campagne créée par", "Vaquinha criada por").
 */
const PLATFORM_TEXT =
  /\b(?:start|create|launch|set up)\s+(?:a|an|your|your own|my|own)\s+(?:fundraiser|fundraising page|campaign|crowdfunding campaign|project|appeal page)\b|\b(?:campaign|fundraiser|project|page)\s+(?:created|started|organi[sz]ed)\s+by\b|\bis organi[sz]ing this fundraiser\b|\b(?:lancer|creer|ouvrir)\s+(?:ma|une|votre|sa)\s+(?:cagnotte|collecte|campagne)\b|\b(?:campagne|cagnotte|collecte)\s+(?:creee|organisee|lancee)\s+par\b|\b(?:crie|criar|crie a|comece|comecar|abra|abrir)\s+(?:sua|uma|a sua)?\s*(?:vaquinha|campanha|vakinha)\b|\b(?:vaquinha|campanha)\s+criada\s+por\b|\b(?:crea|crear|inicia|iniciar|lanza|lanzar)\s+(?:tu|una|su)\s+(?:campana|colecta|recaudacion)\b|\b(?:campana|colecta)\s+(?:creada|organizada|iniciada)\s+por\b|\b(?:buat|mulai|bikin)\s+(?:galang dana|penggalangan dana|campaign)\b|\bkampanya(?:ni|n)?\s+(?:olustur|baslat)\b|\bspendenaktion\s+(?:starten|erstellen)\b|\beigene spendenaktion\b|\b(?:crea|avvia|apri)\s+una\s+raccolta fondi\b|\braccolta fondi\s+creata\s+da\b|プロジェクトを(?:始める|作成|立ち上げる)|クラウドファンディングを始める|起案者/;
/** A person credited with a page as platforms do it, a first name and an initial: "Project by Andre W.", "Campagne de Youssef B.". */
const PERSON_CREDIT = /\b(?:[Pp]roject|[Cc]ampaign|[Ff]undraiser|[Cc]ampagne|[Cc]agnotte|[Vv]aquinha|[Cc]ampanha|[Cc]ampaña)\s+(?:by|par|por|de|from)\s+\p{Lu}\p{Ll}+\s+\p{Lu}\.(?!\p{L})/u;

/**
 * Why a page reads as a person's campaign on a crowdfunding or giving
 * platform, whatever its host, or null: its text invites visitors to start
 * their own fundraiser, or credits a person as its creator (PLATFORM_TEXT,
 * PERSON_CREDIT). Cotizi's "Campagne créée par Youssef B. ... Lancer ma
 * cagnotte" and iSupportJamaica's "Project by Andre W. ... Start a
 * project" are both.
 */
export function platformProblem(text: string): string | null {
  const t = foldText(text).replace(/\s+/g, " ");
  return PLATFORM_TEXT.test(t) || PERSON_CREDIT.test(text) ? "a person's campaign on a crowdfunding platform (it invites visitors to start their own, or credits a person)" : null;
}

/** A page's title without its site's name at either end: "Rebuild Eber Prep | Eber College" -> "Rebuild Eber Prep"; "" when it is only the site's name. */
export function titleWithoutSite(name: string | undefined, title: string | undefined): string {
  const n = cleanText(name, 80);
  let t = cleanText(title, 160);
  if (n) {
    const sep = "\\s*[|–—:·•-]\\s*";
    const e = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    t = t.replace(new RegExp(`${sep}${e}$`, "i"), "").replace(new RegExp(`^${e}${sep}`, "i"), "").trim();
    if (t.toLowerCase() === n.toLowerCase()) t = "";
  }
  return t;
}

/** Letters and digits of a text, folded, nothing else: "Kerala Children's Trust" -> "keralachildrenstrust". */
function compact(text: string): string {
  return foldText(text).replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Labels of hosts that only say what kind of site it is (org, com, co, ac, edu, gov ...), which name no site. */
const SUFFIX_LABEL = /^(?:[a-z]{1,3}|info|asso|gouv|govt|museum|coop|name)$/;

/** The label of a host that names its site, letters only: "www.casadomenor-rj.org.br" -> "casadomenorrj"; "" when there is none. */
function siteLabel(url: string): string {
  try {
    const labels = new URL(url).hostname.toLowerCase().replace(/^www\./, "").split(".");
    for (let i = labels.length - 2; i >= 0; i--) if (!SUFFIX_LABEL.test(labels[i])) return compact(labels[i]);
    return "";
  } catch {
    return "";
  }
}

/**
 * What a page's title says of the page itself: its title without its
 * site's name (titleWithoutSite), and, when it has several parts ("Doe |
 * Casa do Menor Rio de Janeiro"), without a part that is the site's name:
 * one that starts or ends with its og:site_name, or that is its host's
 * name ("Kerala Children's Trust" on keralachildrenstrust.org). A group's
 * own name may hold a word of the disaster's title, and says nothing of
 * the page.
 */
export function ownTitle(self: { name?: string; title?: string }, url: string): string {
  const t = titleWithoutSite(self.name, self.title);
  // " - " between two years is a span ("2025 - 2026"), not a separator.
  const parts = t
    .split(/\s+[|–—·•]\s+|(?<!\d)\s+-\s+(?!\d)|\s*\|\s*|\s*::\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return t;
  const name = compact(self.name ?? "");
  const label = siteLabel(url);
  const isSite = (part: string) => {
    const c = compact(part);
    return Boolean(c) && ((label !== "" && (c === label || (c.length >= 6 && label.includes(c)))) || (name.length >= 4 && (c.startsWith(name) || c.endsWith(name))));
  };
  return parts.some(isSite) ? parts.filter((p) => !isSite(p)).join(" | ") : t;
}

/**
 * Why a URL may not be shown as this disaster's local group page by its
 * address alone, or null: localUrlProblem, then its path
 * (earlierEventProblem; numbers alone in it are no years: readablePath).
 */
export function localAddressProblem(raw: string, ctx: LocalContext, rules: Pick<LocalPageRules, "type" | "minYear" | "ownPlaces" | "languages">): string | null {
  const problem = localUrlProblem(raw, ctx);
  if (problem) return problem;
  return earlierEventProblem([readablePath(raw)], rules, ctx.donation);
}

/** A URL path with its escapes undone, or as it is when they are broken. */
function decodeURIComponentSafe(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/**
 * Why a local page the direct search found may not be shown for this
 * disaster before it is fetched, or null: its address (localAddressProblem),
 * a name the search gave it that claims an official body or a platform
 * (the model's words can only take a page away, never name one), or a date
 * the search gave it from well before the disaster started.
 */
export function localPageProblem(
  p: Pick<DirectPage, "url" | "org" | "published">,
  d: Pick<Disaster, "started">,
  ctx: LocalContext,
  rules: Pick<LocalPageRules, "type" | "minYear" | "ownPlaces" | "languages">,
): string | null {
  const address = localAddressProblem(p.url, ctx, rules);
  if (address) return address;
  const claimed = protectedNameIn(p.org, ctx.societyNames, ctx.societyAcronyms) ?? (mixedScriptWord(p.org) ? "mixed scripts" : null);
  if (claimed) return `the search names it for an official body or a platform (${claimed})`;
  if (datedBefore(p.published, d)) return `dated ${p.published?.slice(0, 10)}, before the disaster`;
  return null;
}

/** One pass of the live check of a local group's page; "retry" when the network or server failed. */
async function checkLocalOnce(url: string, deps: FetchDeps, ctx: LocalContext, rules: LocalPageRules): Promise<PageCheck | "retry"> {
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
      if (!hopAllowed(start, next.toString(), ctx) || localAddressProblem(next.toString(), ctx, rules)) return fail("redirect leaves the site or reaches a page that may not be shown");
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
    const self = readPageSelf(html);
    if (self.news) return fail("a news article");
    const claimed = [self.name, self.title, self.heading].map((t) => protectedNameIn(t, ctx.societyNames, ctx.societyAcronyms)).find((c) => c !== null);
    if (claimed) return fail(`its own name, title or heading claims an official body or a platform (${claimed})`);
    const mixed = [self.name, self.title, self.heading].map(mixedScriptWord).find((w) => w !== null);
    if (mixed) return fail(`its own name, title or heading mixes Latin with Cyrillic or Greek letters in one word (${mixed}), as look-alikes do`);
    const text = visibleText(html);
    const scam = paymentProblem(`${self.title} ${self.heading} ${text}`);
    if (scam) return fail(scam);
    const platform = platformProblem(text);
    if (platform) return fail(platform);
    const title = ownTitle(self, current);
    const earlier = earlierEventProblem([title, self.heading], rules, ctx.donation);
    if (earlier) return fail(earlier);
    const own = [title, self.heading, readablePath(url), readablePath(current)];
    const published = publishedOf(html);
    const dated = pageDateProblem(published ?? timeOf(html), own, rules, ctx.donation, modifiedOf(html));
    if (dated) return fail(dated);
    const lead = published ? null : leadYearProblem(html, own, rules, ctx.donation);
    if (lead) return fail(lead);
    const words = donationWordsIn(html);
    if (words.length === 0) return fail("no donation word on the page");
    const topic = topicProblem(own, text, rules, ctx.donation);
    if (topic) return fail(topic);
    const place = placeNamedIn(html, rules.names);
    if (!place) return fail("names none of the disaster's places");
    return {
      ok: true,
      reason: `donation word "${words[0]}", names "${place}"`,
      chain,
      place,
      ...(self.name ? { name: self.name } : {}),
      ...(self.title ? { title: self.title } : {}),
    };
  }
}

/**
 * The live check of a local group's page: fetched like a reader's browser,
 * following at most three redirects by hand, each on the same site and
 * itself allowed (localAddressProblem). It passes when the final answer is
 * 200 HTML that is no news article (by its JSON-LD), whose own name, title
 * and heading claim no official body or platform (protectedNameIn) and mix
 * no Latin with Cyrillic or Greek letters in a word (mixedScriptWord), that
 * asks for no crypto, gift card codes, Zelle, money transfers or transfers
 * to a person (paymentProblem), that reads as no person's campaign on a
 * platform (platformProblem), whose title without its site's name
 * (ownTitle) and heading name no older year, other country, other storm or
 * other kind of disaster (earlierEventProblem), whose own date is not well
 * before the disaster unless it was rewritten for it (pageDateProblem; for
 * a page without one, leadYearProblem), and that has a donation word, is
 * about the disaster by its own title, heading or address (topicProblem)
 * and names one of the disaster's places. The
 * verdict keeps the page's own name and title, which the site shows. A
 * bot wall (401, 403) fails: an unknown group's page is never taken
 * unseen. Network failures, 429 and 5xx are tried once more after
 * retryMs; null when both attempts fail (no verdict).
 */
export async function checkLocalPage(url: string, deps: FetchDeps, ctx: LocalContext, rules: LocalPageRules, retryMs = 2_000): Promise<PageCheck | null> {
  const problem = localAddressProblem(url, ctx, rules);
  if (problem) return { ok: false, reason: problem, chain: [url] };
  for (let i = 1; i <= 2; i++) {
    const result = await checkLocalOnce(url, deps, ctx, rules);
    if (result !== "retry") return result;
    if (i === 1) await deps.sleep(retryMs);
  }
  deps.log(`Local page ${url}: both attempts failed; not shown this run`);
  return null;
}

/** The version of the live check's rules: verdicts made under older rules are not reused (their keys differ), and age out of the registry. */
export const LOCAL_RULES_VERSION = 3;

/** The registry's verdict key for a local group's page, per disaster (the place test is the disaster's) and per version of the rules. */
export function localVerdictKey(disasterId: string, url: string): string {
  return `local${LOCAL_RULES_VERSION}:${disasterId}:${urlKey(url)}`;
}

/**
 * The live check with its cache in registry.verdicts (the caller writes
 * the registry, and logs the verdict: prepareDirectLinks): a pass is
 * reused for 7 days, a failure for 1. A URL localAddressProblem refuses
 * fails at once and is not cached.
 */
export async function verifyLocalPage(
  url: string,
  disasterId: string,
  deps: FetchDeps,
  ctx: LocalContext,
  rules: LocalPageRules,
  registry: DonationRegistry,
  now: string,
): Promise<boolean> {
  if (localAddressProblem(url, ctx, rules)) return false;
  const key = localVerdictKey(disasterId, url);
  const cached = registry.verdicts[key];
  if (cached && verdictFresh(cached, now)) return cached.ok;
  const result = await checkLocalPage(url, deps, ctx, rules);
  if (!result) return false;
  registry.verdicts[key] = { ...result, checked: now };
  return result.ok;
}

/** The note on a charity's or local group's own page for the disaster. */
export function localNote(place: string | undefined): string {
  return `A charity's or local group's own page for this disaster. Global View checked it is live and names ${place || "the disaster's place"}, but cannot vouch for the group.`;
}

/** The host of a URL without "www.". */
function bareHost(url: string): string {
  return new URL(url).hostname.replace(/^www\./, "");
}

/**
 * The name a local group's page is shown by: its site's own name
 * (og:site_name, as the live check read it), else its host. Never the
 * search's or the model's name for it.
 */
export function localOrg(v: Pick<DonationVerdict, "name">, url: string): string {
  const name = cleanText(v.name, 60);
  return name && !/^https?:|\.[a-z]{2,}\/?$/i.test(name) ? name : bareHost(url);
}

/**
 * The label of a local group's page: its own title without its site's name
 * at either end ("Rebuild Eber Prep | Eber College" -> "Rebuild Eber
 * Prep"), else "Donation page on <host>".
 */
export function localLabel(v: Pick<DonationVerdict, "name" | "title">, url: string): string {
  return cleanText(titleWithoutSite(v.name, v.title), 90) || `Donation page on ${bareHost(url)}`;
}

// ---------------------------------------------------------------------------
// The direct links for one disaster
// ---------------------------------------------------------------------------

export interface DirectInput {
  disaster: Pick<Disaster, "id" | "countries" | "type" | "title" | "places" | "started">;
  /** Its research entry: the direct search's pages (ResearchEntry.direct), and the other searches' (donation, earlierSearch), whose pages off the official allowlist are candidates too (allowlistMisses). */
  entry: ResearchEntry | undefined;
  gofundme: GoFundMeCache;
  /** The disaster's allowlist context (donationContext with its title and every country's name). */
  ctx: DonationContext;
  /** Every globe country's English name, and each country's name in its press language. */
  countryNames: Record<string, string>;
  pressNames?: Record<string, string>;
  /** Hosts of the site's own news articles. */
  newsHosts?: ReadonlySet<string>;
  /** The places' own names from the geocoder's cache, by place name (geocode.ts localPlaceNames). */
  localNames?: Readonly<Record<string, readonly string[]>>;
  /** Each country's press language (pipeline/config/languages.json), in which its pages are read for other countries' names too. */
  pressLanguages?: Readonly<Record<string, string>>;
}

function localContext(input: DirectInput, registry: DonationRegistry): LocalContext {
  const societies = Object.values(registry.societies);
  const hosts = societies.flatMap((s) => s.hosts);
  return { donation: input.ctx, societyHosts: hosts, societyNames: societies.map((s) => s.name), societyAcronyms: societyAcronyms(hosts), newsHosts: input.newsHosts };
}

/** True when a place's name is made of place words of the disaster's title ("Chiang Rai" for "Floods in Chiang Rai, Thailand"). */
function isTitlePlace(name: string, eventWords: ReadonlySet<string>): boolean {
  const words = asciiWords(name).filter((w) => w.length >= 3 && !NOT_EVENT_WORDS.has(w));
  return words.length > 0 && words.every((w) => eventWords.has(w));
}

/**
 * What a disaster's local pages are held to: its place names (placeNames,
 * with its title's places and the places' own names), the names of its
 * title's places in any script and its storms' other names (titleNames),
 * its type, its year and its start, its own place names (ownPlaces: its
 * places, their provinces and own names, its title's places), and the
 * languages its pages are read in for other countries' names
 * (nameLanguages).
 */
export function localRules(input: Pick<DirectInput, "disaster" | "ctx" | "countryNames" | "pressNames" | "localNames" | "pressLanguages">): LocalPageRules {
  const d = input.disaster;
  const words = input.ctx.eventWords ?? [];
  const asWritten = titlePlaces(d.title, words);
  const local = input.localNames ?? {};
  const names = placeNames(d, input.countryNames, input.pressNames, [...asWritten, ...words], local);
  const title = new Set(words);
  const ownNames = (d.places ?? []).filter((p) => isTitlePlace(p.name, title)).flatMap((p) => localFormsOf(local, p.name));
  const inTitle = new Set(asciiWords(d.title));
  const aliases = (input.ctx.stormNames ?? []).filter((n) => !inTitle.has(n));
  const ownPlaces = [...disasterPlaceNames(d), ...(d.places ?? []).flatMap((p: Place) => localFormsOf(local, p.name)), ...asWritten];
  return {
    names,
    titleNames: [...new Set([...asWritten, ...ownNames, ...aliases])],
    type: d.type,
    minYear: eventYear(d),
    started: d.started,
    ownPlaces: [...new Set(ownPlaces)],
    languages: nameLanguages(d.countries, input.pressLanguages),
  };
}

/** Projects from two sources taken in turn, so both are seen within their shared cap. */
function alternate<T>(a: T[], b: T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) out.push(...(i < a.length ? [a[i]] : []), ...(i < b.length ? [b[i]] : []));
  return out;
}

/** A page's kind by its host alone, never a model's word: a page on globalgiving.org is GlobalGiving's, any other a charity's or local group's. */
export function directKindOf(url: string): DirectPageKind {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "local";
  }
  return host === "globalgiving.org" || host.endsWith(".globalgiving.org") ? "globalgiving" : "local";
}

/**
 * Pages the disaster's research or its official donation search found
 * (its entry's earlierSearch, then donation, each URL once) that donate.ts
 * turns away only because their host is on no official allowlist
 * (donationUrlProblem gives NOT_ALLOWLISTED, so the URL is well formed and
 * over https): a charity's own appeal for the disaster, such as Penny
 * Appeal USA's for the Nuristan floods, is no official page but may be a
 * direct one. They are offered to the direct checks as the direct search's
 * pages are, and held to every rule there: their kind goes by their host
 * (directKindOf), the model's org and note come along (the org can only
 * take a page away, see localPageProblem), and they have no title or date,
 * which those searches do not keep. No model is asked again.
 */
export function allowlistMisses(entry: Partial<Pick<ResearchEntry, "donation" | "earlierSearch">> | undefined, ctx: DonationContext): DirectPage[] {
  const out: DirectPage[] = [];
  const keys = new Set<string>();
  for (const r of [...(entry?.earlierSearch ?? []), ...(entry?.donation ?? [])]) {
    if (typeof r?.url !== "string" || donationUrlProblem(r.url, ctx) !== NOT_ALLOWLISTED) continue;
    const key = urlKey(r.url);
    if (keys.has(key)) continue;
    keys.add(key);
    out.push({ url: r.url, org: cleanText(r.org, 100), kind: directKindOf(r.url), note: cleanText(r.note, 200), title: "" });
  }
  return out;
}

/** A disaster's direct candidates: its direct search's pages, then the other searches' pages off the official allowlist (allowlistMisses), each URL once. */
export function directCandidates(input: Pick<DirectInput, "entry" | "ctx">): DirectPage[] {
  const own = input.entry?.direct ?? [];
  const keys = new Set(own.map((p) => urlKey(p.url)));
  return [...own, ...allowlistMisses(input.entry, input.ctx).filter((p) => !keys.has(urlKey(p.url)))];
}

/** A direct candidate left out, and why. */
export interface DirectRefusal {
  url: string;
  reason: string;
  /** It came from the research or the official donation search (allowlistMisses), not the direct search. */
  other: boolean;
}

/** What became of a disaster's direct candidates (directCandidates), and its links. */
export interface DirectOutcome {
  /** GoFundMe's links, the projects and the local pages that passed, for buildDonations to order and cap. */
  links: DonationLink[];
  /** Candidates from the direct search, and from the other searches. */
  fromSearch: number;
  fromOther: number;
  /** GlobalGiving's and local pages that passed. */
  passed: number;
  refused: DirectRefusal[];
  /** Local pages that passed the address rules but have no fresh verdict yet: a live check is still to come. */
  waiting: string[];
}

/**
 * Why a local page with a fresh verdict is not shown under today's rules,
 * or null when it may be: the live check failed, a hop it followed is no
 * longer allowed, its own name or title now claims an official body or a
 * platform or mixes scripts, its title asks for payment as scams do, or
 * its title (without its site's name) names an earlier or another event.
 */
function verdictProblem(v: DonationVerdict, url: string, local: LocalContext, rules: LocalPageRules, ctx: DonationContext): string | null {
  if (!v.ok) return `live check: ${v.reason}`;
  const start = new URL(url).hostname;
  if (!v.chain.every((u) => hopAllowed(start, u, local) && !localAddressProblem(u, local, rules))) return "a redirect it followed may no longer be shown";
  for (const t of [v.name, v.title]) {
    const claimed = protectedNameIn(t, local.societyNames, local.societyAcronyms);
    if (claimed) return `its own name or title claims an official body or a platform (${claimed})`;
    const mixed = mixedScriptWord(t);
    if (mixed) return `its own name or title mixes Latin with Cyrillic or Greek letters in one word (${mixed})`;
  }
  return paymentProblem(v.title ?? "") ?? earlierEventProblem([ownTitle(v, url)], rules, ctx);
}

/**
 * A disaster's direct links from the caches alone, and what became of each
 * candidate: GoFundMe's links from its crisis page; projects,
 * GlobalGiving's that pass globalGivingProblem and the crisis page's
 * partners' in turn; then local pages that pass localPageProblem and have
 * a fresh passing verdict under today's rules (localVerdictKey) whose every
 * hop is still allowed and whose own name and title still pass
 * (verdictProblem), shown by the page's own name and title.
 */
export function directOutcome(input: DirectInput, registry: DonationRegistry, now: string): DirectOutcome {
  const d = input.disaster;
  const hub = matchHub(input.gofundme, d, input.ctx);
  const pages = directCandidates(input);
  const fromSearch = new Set((input.entry?.direct ?? []).map((p) => urlKey(p.url)));
  const refused: DirectRefusal[] = [];
  const refuse = (p: DirectPage, reason: string) => refused.push({ url: p.url, reason, other: !fromSearch.has(urlKey(p.url)) });
  const globalGiving: DonationLink[] = [];
  const locals: DonationLink[] = [];
  const waiting: string[] = [];
  const local = localContext(input, registry);
  const rules = localRules(input);
  for (const p of pages) {
    if (p.kind === "globalgiving") {
      const problem = globalGivingProblem(p, d, input.ctx);
      const link = problem ? null : globalGivingLink(p);
      if (link) globalGiving.push(link);
      else refuse(p, problem ?? "not a GlobalGiving project page");
      continue;
    }
    const problem = localPageProblem(p, d, local, rules);
    if (problem) {
      refuse(p, problem);
      continue;
    }
    const v = registry.verdicts[localVerdictKey(d.id, p.url)];
    if (!v || !verdictFresh(v, now)) {
      waiting.push(p.url);
      continue;
    }
    const why = verdictProblem(v, p.url, local, rules, input.ctx);
    if (why) refuse(p, why);
    else locals.push({ label: localLabel(v, p.url), url: p.url, org: localOrg(v, p.url), kind: "local", note: localNote(v.place), via: "research", forEvent: true });
  }
  return {
    links: [...(hub ? gofundmeLinks(hub, d.started) : []), ...alternate(globalGiving, hub ? partnerLinks(hub) : []), ...locals],
    fromSearch: pages.filter((p) => fromSearch.has(urlKey(p.url))).length,
    fromOther: pages.filter((p) => !fromSearch.has(urlKey(p.url))).length,
    passed: globalGiving.length + locals.length,
    refused,
    waiting,
  };
}

/** Where buildDirectLinks writes what became of the candidates: one line per disaster, and one per refused page (capped per run: cappedLog). */
export interface DirectLogs {
  log: (msg: string) => void;
  page: (msg: string) => void;
}

/**
 * Logs a disaster's outcome: when it had candidates, one line with how
 * many came from each search, passed, were refused and wait for a live
 * check; and one line per refused page with its reason, as donate.ts logs
 * the official pages it refuses.
 */
export function logDirectOutcome(id: string, o: DirectOutcome, logs: DirectLogs): void {
  const total = o.fromSearch + o.fromOther;
  if (total === 0) return;
  logs.log(
    `  direct pages for ${id}: ${total} candidate${total === 1 ? "" : "s"} (${o.fromSearch} from the direct search, ${o.fromOther} from the other searches): ${o.passed} passed, ${o.refused.length} refused, ${o.waiting.length} wait for a live check`,
  );
  for (const r of o.refused) logs.page(`Direct page ${r.url}${r.other ? " (from the research or the donation search)" : ""}: rejected (${r.reason})`);
}

/**
 * A disaster's direct links from the caches alone, for buildDonations to
 * order and cap (directOutcome's links), and its outcome in the log when
 * logs are given.
 */
export function buildDirectLinks(input: DirectInput, registry: DonationRegistry, now: string, logs?: DirectLogs): DonationLink[] {
  const outcome = directOutcome(input, registry, now);
  if (logs) logDirectOutcome(input.disaster.id, outcome, logs);
  return outcome.links;
}

/** A log that passes on at most max lines and counts the rest. */
export interface CappedLog {
  line: (msg: string) => void;
  /** Lines left out so far. */
  omitted: () => number;
}

/** A log for lines about single pages: at most max of them a run (MAX_PAGE_LOG_LINES), so the run's log stays readable. */
export function cappedLog(log: (msg: string) => void, max = MAX_PAGE_LOG_LINES): CappedLog {
  let written = 0;
  let omitted = 0;
  return {
    line: (msg) => {
      if (written < max) {
        written++;
        log(msg);
      } else omitted++;
    },
    omitted: () => omitted,
  };
}

export interface PrepareDirectOptions {
  /** Most live checks for this disaster (cached verdicts do not count). */
  maxChecks?: number;
  pauseMs?: number;
  /** URL keys no verdict could be had for this run, shared across disasters (see donate.ts PrepareOptions). */
  unreachable?: Set<string>;
  /** Where lines about single pages go (a refusal, a live check that could not be made); the run's capped log (cappedLog), else deps.log. */
  pageLog?: (msg: string) => void;
}

/**
 * Live-checks the local pages among a disaster's direct candidates
 * (directCandidates: its direct search's, then the other searches' pages
 * off the official allowlist) that pass the address rules and have no
 * fresh verdict, at most maxChecks, pausing between them; logs each pass.
 * Then builds its direct links and logs what became of every candidate
 * (buildDirectLinks). Records verdicts in registry.verdicts; the caller
 * writes the registry.
 */
export async function prepareDirectLinks(input: DirectInput, registry: DonationRegistry, deps: FetchDeps, now: string, opts: PrepareDirectOptions = {}): Promise<DonationLink[]> {
  const local = localContext(input, registry);
  const rules = localRules(input);
  const unreachable = opts.unreachable ?? new Set<string>();
  const page = opts.pageLog ?? deps.log;
  let checks = 0;
  for (const p of directCandidates(input)) {
    if (p.kind !== "local" || checks >= (opts.maxChecks ?? MAX_LOCAL_CHECKS)) continue;
    // A page the rules refuse is logged with the outcome below.
    if (localPageProblem(p, input.disaster, local, rules)) continue;
    const key = localVerdictKey(input.disaster.id, p.url);
    const cached = registry.verdicts[key];
    if ((cached && verdictFresh(cached, now)) || unreachable.has(urlKey(p.url))) continue;
    checks++;
    await verifyLocalPage(p.url, input.disaster.id, { ...deps, log: page }, local, rules, registry, now);
    const verdict = registry.verdicts[key];
    if (!verdict) unreachable.add(urlKey(p.url));
    else if (verdict.ok) deps.log(`Direct page ${p.url}: accepted (${verdict.reason})`);
    await deps.sleep(opts.pauseMs ?? 500);
  }
  return buildDirectLinks(input, registry, now, { log: deps.log, page });
}
