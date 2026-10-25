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
//                 older year, and something dates it to this disaster: a
//                 recent year, the storm's name, or the search's own date for
//                 the page together with a place of its title
//                 (globalGivingProblem). GlobalGiving vets its local
//                 partners. It refuses many scripted clients, so there is no
//                 live check.
//   local         a local organisation's, school's or community group's own
//                 donation page the direct search returned, kept only when
//                 its URL is on no shared, social, blog, site-builder,
//                 marketplace, news, crowdfunding, payment or official site,
//                 has no official body's name in its host and no person's
//                 page's or article's shape in its path (localUrlProblem),
//                 and a live check passes: 200 HTML on the same site, no
//                 news article, no official body's name in its own name,
//                 title or heading (in its own language and script too), no
//                 request for crypto, gift cards or transfers to a person,
//                 nothing that dates or names it for an earlier or another
//                 disaster (its own date included), a donation word, a
//                 title, heading or address about this disaster (its hazard
//                 or a place of its title, not just the country) and a name
//                 of the disaster's place, in any script (verifyLocalPage).
//                 It is shown by the site's own name (og:site_name, else its
//                 host) and title, never by the model's words. Verdicts are
//                 cached with donate.ts's, per disaster and rules version.
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
//     node) marks news; its WebPage node's datePublished dates the page.
// A review of these rules (2026-10-25) found general charity pages, other
// countries' and old disasters' pages, look-alikes in other languages and
// scripts, and pages asking for crypto or Zelle accepted, and schools'
// and groups' own pages refused for "news", "gov" or "un" inside a word,
// WordPress paths and posts, founding years and their own scripts; the
// tests hold each of those pages.
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
  type DonationVerdict,
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
  ["hurricane hurricanes typhoon typhoons cyclone cyclones huracan huracanes tifon ouragan ciclon furacao uragano kimbunga bagyo topan siklon", ["cyclone", "storm"]],
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
    "ရေကြီး", "فيضان", "فيضانات", "سيول", "سیلاب", "बाढ़", "बाढ", "বন্যা", "наводнени*", "паводк*", "паводок", "повін*", "повен*", "πλημμυρ*", "שיטפון", "lũ lụt",
    "ngập lụt",
  ],
  landslide: [
    "土砂崩れ", "土砂災害", "山崩れ", "がけ崩れ", "滑坡", "泥石流", "산사태", "ดินถล่ม", "انهيار أرضي", "انهيارات أرضية", "भूस्खलन", "ভূমিধস", "оползн*", "оползень", "κατολισθ*",
    "sạt lở", "tanah longsor", "glissement de terrain",
  ],
  wildfire: [
    "山火事", "林野火災", "森林火灾", "森林火災", "山火", "산불", "ไฟป่า", "حرائق", "حريق", "দাবানল", "пожар*", "πυρκαγι*", "שריפ*", "kebakaran hutan", "incendio forestal",
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

/** Words that come before a storm's name: "Hurricane Melissa", "Storm Boelo", "huracán Beryl". */
const STORM_WORDS: ReadonlySet<string> = new Set("hurricane hurricanes typhoon typhoons cyclone cyclones huracan huracanes tifon ouragan ciclon storm storms tormenta tempete".split(" "));

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
 * (eventWords) that follows a storm word. "Hurricane Melissa" ->
 * ["melissa"]; "Philippines: Southwest Monsoon enhanced by Tropical
 * Cyclones Maymay and Dolphin" -> ["maymay"]; "Flood in Poland" -> [].
 */
export function disasterStorms(ctx: Pick<DonationContext, "eventWords" | "title">): string[] {
  const place = new Set(ctx.eventWords ?? []);
  const words = asciiWords(ctx.title ?? "");
  return words.filter((w, i) => i > 0 && STORM_WORDS.has(words[i - 1]) && place.has(w));
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

/** What the matching rules read of a disaster's allowlist context: every country's names, its title and the title's place words. */
export type MatchContext = Pick<DonationContext, "countryNameIndex" | "eventWords" | "title">;

/** Words before a year that say when a group began, not when a disaster struck: "since 1952", "est. 1998", "fundada en 1985". */
const FOUNDED_YEAR =
  /\b(?:since|est|estd|established|founded|serving\s+since|desde|depuis|seit|fondee?|fundad[ao]|cread[ao]|gegrundet)\.?\s*(?:in\s+|en\s+|em\s+|el\s+|le\s+|im\s+|:\s*)?(?:(?:19|20)\d\d)(?![a-z0-9])/g;
/** A season or financial year that runs across two years: "2025-26", "2025/2026", "2025–26". */
const YEAR_SPAN = /(?<![a-z0-9])((?:19|20)\d\d)\s*[-/–—]\s*((?:19|20)?\d\d)(?![a-z0-9])/g;

/**
 * The years a text gives for an event, as four-digit numbers: a founding
 * year ("since 1952", "est. 1998") is no event's, and a season that runs
 * across two years ("2025-26 Bushfire Appeal") counts as its second year.
 * "Hurricane Relief 2024" -> [2024].
 */
export function eventYearsIn(text: string): number[] {
  const t = foldText(text)
    .replace(FOUNDED_YEAR, " ")
    .replace(YEAR_SPAN, (m, a: string, b: string) => {
      const start = Number(a);
      const end = b.length === 2 ? Math.floor(start / 100) * 100 + Number(b) : Number(b);
      return end === start + 1 ? ` ${end} ` : m;
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

function readWords(words: readonly string[], countries: readonly string[], ctx: MatchContext): Reading {
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
export function hubMatches(hub: Pick<GoFundMeHub, "slug" | "title">, d: Pick<Disaster, "countries" | "type">, ctx: MatchContext): boolean {
  if (!ctx.countryNameIndex || d.countries.length === 0) return false;
  const slug = hub.slug.split("-").filter(Boolean);
  const title = asciiWords(hub.title).filter((w) => !HUB_FILLER.has(w));
  const readings = [readWords(slug, d.countries, ctx), readWords(title, d.countries, ctx)];
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
 *   - be dated to this disaster: by the storm's name, by a year no older
 *     than the disaster's, or by the search's own date for the page
 *     (published) no earlier than two weeks before it started when it also
 *     names a place of its title. A fund named only for a country and a
 *     hazard, such as "turkey-earthquake-relief-fund" or "nepal-earthquake-
 *     relief-fund", is otherwise an earlier disaster's as likely as this
 *     one's: GlobalGiving keeps such funds open for years, and the search's
 *     date can be the day the page last changed.
 */
export function globalGivingProblem(
  page: Pick<DirectPage, "url" | "title" | "published">,
  d: Pick<Disaster, "countries" | "type" | "started">,
  ctx: MatchContext,
): string | null {
  const gg = globalGivingPage(page.url);
  if (!gg) return "not a GlobalGiving project page";
  const slug = slugWords(gg.slug);
  const title = slugWords(projectTitle(page.title ?? ""));
  const readings = [readWords(slug, d.countries, ctx), readWords(title, d.countries, ctx)];
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
  const searchDated = Boolean(page.published && Number.isFinite(Date.parse(page.published)) && !datedBefore(page.published, d));
  const dated = byStormName || (minYear !== null && years.some((y) => y >= minYear)) || (searchDated && titlePlace);
  if (!dated) return "nothing dates it to this disaster (no storm name or recent year, nor a search date with a place of its title)";
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
  "unicef", "unhcr", "unocha", "acnur", "gofundme", "globalgiving", "justgiving", "proteccioncivil", "defensacivil", "defesacivil",
  "protezionecivile", "protectioncivile", "civilprotection", "civildefence", "civildefense", "prefeitura", "ayuntamiento", "pemerintah",
  "kementerian", "gobierno", "gouvernement",
];
/** Short names that count only as a whole part of a host label, or its start or end ("wfpusa", "ifrc-jamaica"). */
const PROTECTED_PART_EDGE: readonly string[] = ["ifrc", "icrc", "wfp", "undp", "unfpa"];
/** Government words that count as a whole part of a host label or its end ("jamaica-gov-relief", "jamaicagov"), never its start ("govindfoundation", "govardhan-trust"). */
const GOVERNMENT_PARTS: readonly string[] = ["gov", "govt", "gouv", "gob"];
/** Names that count only as a whole part of a host label ("ocha-relief"; never "mocha"). */
const PROTECTED_PART_WHOLE: readonly string[] = ["ocha"];
/** Words after "un-" that make it the UN's ("un-relief.org"); so does a country's name ("un-jamaica.org"). "un-techo-para-mi-pais" is Spanish for "a roof". */
const UN_FOLLOWERS: ReadonlySet<string> = new Set(
  "relief aid appeal appeals donate donation donations emergency emergencies crisis help fund funds agency mission women habitat refugees refugee food".split(" "),
);

/**
 * The official body or platform a host claims to be, or null:
 * "jamaicaredcrossrelief.org" -> "redcross". "un" counts as a whole label,
 * or as a part followed by an aid word or (with every country's names) a
 * country's name.
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
  "កាកបាទក្រហម", "ກາແດງ", "රතු කුරුස", "செஞ்சிலுவை", "ቀይ መስቀል",
];
/** The UN, its agencies and the giving platforms, in the languages of the disasters' countries. */
const UN_NAMES: readonly string[] = [
  "united nations", "naciones unidas", "nations unies", "nações unidas", "nazioni unite", "vereinte nationen", "الأمم المتحدة", "联合国", "聯合國", "国連",
  "国際連合", "유엔", "국제연합", "สหประชาชาติ", "оон", "unicef", "unhcr", "acnur", "unocha", "ocha", "wfp", "world food programme", "world food program",
  "programa mundial de alimentos", "programme alimentaire mondial", "undp", "pnud", "unfpa", "world health organization", "gofundme", "globalgiving",
  "justgiving",
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
];
const PROTECTED_TERMS = [...MOVEMENT_NAMES, ...UN_NAMES, ...GOVERNMENT_NAMES].map(compileTerm);
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
 * The official body or platform a name claims, or null: "Jamaica Red
 * Cross" -> "red cross", "日本赤十字社 支援窓口" -> "赤十字", "Ministry of
 * Health" -> "ministry". The movement's names (MOVEMENT_NAMES), the UN's
 * and the giving platforms', governments' and their offices' (a
 * "Government Girls High School" aside), ministries by their portfolio,
 * and the registry's society names (societyNames) all count. A local
 * group's page may not use one.
 */
export function protectedNameIn(name: string | undefined, societyNames: readonly string[] = []): string | null {
  const text = foldText(name ?? "")
    .replace(/[-_‐‑–—/|:·•]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  const term = [...PROTECTED_TERMS, ...societyNames.map(societyTerm)].find((t) => text.includes(t.needle) && t.re.test(text));
  if (term) return term.term.replace(/\*$/, "");
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
  if (onAny(host, NEWS_HOSTS) || onAny(host, ctx.newsHosts ?? []) || host.split(".").slice(0, -1).some((l) => l.split("-").includes("news"))) return "news site";
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
    (Object.hasOwn(localNames, p.name) ? localNames[p.name] : []).flatMap(nameForms).forEach(add);
  }
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
 * older than the disaster's (rules.minYear; a founding year or a season's
 * first year aside, see eventYearsIn), another country's name (by whole
 * names: "Dona para el terremoto de Ecuador" for a Venezuelan
 * earthquake), another storm's name (otherStorm: "donate-2024-hurricane-
 * beryl" for Hurricane Melissa), or hazards that are all of another kind
 * than the disaster's (strictly, as hubMatches reads them, in any script).
 */
export function earlierEventProblem(texts: readonly string[], rules: Pick<LocalPageRules, "type" | "minYear">, ctx: LocalMatchContext): string | null {
  const { words, hazards } = readTexts(texts);
  const minYear = rules.minYear;
  const old = typeof minYear === "number" ? texts.flatMap(eventYearsIn).filter((y) => y < minYear) : [];
  if (old.length > 0) return `an earlier disaster's page (${old[0]})`;
  if (readWords(words, ctx.countries, ctx).foreign) return "names another country";
  const storm = otherStorm(words, ctx, rules.type);
  if (storm) return `names another storm (${storm})`;
  const all = [...words, ...hazards];
  if (rules.type && hazardFit(all, rules.type) === "other" && !stormAftermath(all, rules.type)) return "names another kind of disaster";
  return null;
}

/**
 * Why a page does not say it is about this disaster, or null. Its title,
 * heading or address (own) must name a place of the disaster's title, in
 * any script (ctx.eventWords, rules.titleNames), or a hazard of its kind
 * (strictly, in any of the languages hazardFit and hazardWordsIn read); a
 * named storm's page that names only the hazard must name the storm
 * somewhere. A page that only names the country, such as a charity's
 * general "Give" page saying "across Jamaica", is no page for the disaster.
 */
export function topicProblem(own: readonly string[], text: string, rules: Pick<LocalPageRules, "type" | "titleNames">, ctx: MatchContext): string | null {
  const { words, hazards } = readTexts(own);
  const title = new Set(ctx.eventWords ?? []);
  const folded = foldText(own.join("\n"));
  if (words.some((w) => title.has(w)) || (rules.titleNames ?? []).some((n) => compileTerm(n).re.test(folded))) return null;
  if (!rules.type || hazardFit([...words, ...hazards], rules.type) !== "fits") return "its title, heading and address name neither the disaster's hazard nor a place of its title";
  if (isNamedStorm({ type: rules.type }, ctx) && !asciiWords(text).some((w) => title.has(w))) return "names the hazard but not the storm";
  return null;
}

/**
 * Why a page's own date says it is an earlier disaster's, or null: it was
 * published (publishedOf: its WebPage's datePublished, as WordPress's SEO
 * plugins give every page, else a post's) more than PAGE_BEFORE_DAYS
 * before the disaster started, and its title, heading and address (own)
 * name neither the disaster's storm nor a year no older than the
 * disaster's, which would show an older page rewritten for it.
 */
export function pageDateProblem(published: string | null, own: readonly string[], rules: Pick<LocalPageRules, "minYear" | "started">, ctx: MatchContext): string | null {
  if (!published || !rules.started || !datedBefore(published, { started: rules.started })) return null;
  const storms = new Set(disasterStorms(ctx));
  if (readTexts(own).words.some((w) => storms.has(w))) return null;
  const minYear = rules.minYear;
  if (typeof minYear === "number" && own.flatMap(eventYearsIn).some((y) => y >= minYear)) return null;
  return `published ${published.slice(0, 10)}, before the disaster`;
}

/**
 * Ways scams ask for money and groups' own donation pages do not: crypto,
 * gift cards, Zelle, Cash App or Venmo, money-transfer services, and
 * transfers to a person's own account. Matched in folded text.
 */
const PAYMENT_ASKS: readonly (readonly [RegExp, string])[] = [
  [/\b(?:bitcoin|ethereum|usdt|tether|litecoin|dogecoin|monero|crypto|cryptocurrenc(?:y|ies)|wallet address)\b/, "crypto"],
  [/\b(?:gift ?cards?|itunes cards?|steam cards?|google play cards?)\b/, "gift cards"],
  [/\bzelle\b/, "Zelle"],
  [/\b(?:cash ?app|venmo)\b/, "Cash App or Venmo"],
  [/\b(?:western union|moneygram|worldremit|remitly|ria money transfer)\b/, "a money-transfer service"],
  [/\b(?:wire|bank|money) transfers? (?:directly )?to (?:me|my|him|her|his)\b|\b(?:my|his|her) (?:personal bank|personal|bank) account\b/, "a transfer to a person's own account"],
  [/\bsend (?:money|funds|it|your donations?) (?:directly )?to (?:me|my|him|her)\b/, "a transfer to a person's own account"],
  [/\b(?:mi|su) cuenta (?:bancaria )?personal\b|\bmon compte personnel\b|\bminha conta pessoal\b/, "a transfer to a person's own account"],
];

/** Why a page asks for money the way scams do, or null (PAYMENT_ASKS): "URGENT: Send Bitcoin/Zelle to help Hurricane Melissa victims". */
export function paymentProblem(text: string): string | null {
  const t = foldText(text).replace(/\s+/g, " ");
  const ask = PAYMENT_ASKS.find(([re]) => re.test(t));
  return ask ? `asks for ${ask[1]}, as scams do` : null;
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

/**
 * Why a URL may not be shown as this disaster's local group page by its
 * address alone, or null: localUrlProblem, then its path
 * (earlierEventProblem; numbers alone in it are no years: readablePath).
 */
export function localAddressProblem(raw: string, ctx: LocalContext, rules: Pick<LocalPageRules, "type" | "minYear">): string | null {
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
export function localPageProblem(p: Pick<DirectPage, "url" | "org" | "published">, d: Pick<Disaster, "started">, ctx: LocalContext, rules: Pick<LocalPageRules, "type" | "minYear">): string | null {
  const address = localAddressProblem(p.url, ctx, rules);
  if (address) return address;
  const claimed = protectedNameIn(p.org, ctx.societyNames);
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
    const claimed = protectedNameIn(self.name, ctx.societyNames) ?? protectedNameIn(self.title, ctx.societyNames) ?? protectedNameIn(self.heading, ctx.societyNames);
    if (claimed) return fail(`its own name, title or heading claims an official body or a platform (${claimed})`);
    const text = visibleText(html);
    const scam = paymentProblem(`${self.title} ${self.heading} ${text}`);
    if (scam) return fail(scam);
    const earlier = earlierEventProblem([titleWithoutSite(self.name, self.title), self.heading], rules, ctx.donation);
    if (earlier) return fail(earlier);
    const own = [self.title, self.heading, readablePath(url), readablePath(current)];
    const dated = pageDateProblem(publishedOf(html), own, rules, ctx.donation);
    if (dated) return fail(dated);
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
 * and heading claim no official body or platform, that asks for no crypto,
 * gift cards, Zelle, money transfers or transfers to a person
 * (paymentProblem), whose title and heading name no older year, other
 * country, other storm or other kind of disaster (earlierEventProblem),
 * whose own date is not well before the disaster (pageDateProblem), and
 * that has a donation word, is about the disaster by its title, heading or
 * address (topicProblem) and names one of the disaster's places. The
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
export const LOCAL_RULES_VERSION = 2;

/** The registry's verdict key for a local group's page, per disaster (the place test is the disaster's) and per version of the rules. */
export function localVerdictKey(disasterId: string, url: string): string {
  return `local${LOCAL_RULES_VERSION}:${disasterId}:${urlKey(url)}`;
}

/**
 * The live check with its cache in registry.verdicts (the caller writes
 * the registry): a pass is reused for 7 days, a failure for 1. A URL
 * localAddressProblem refuses fails at once and is not cached.
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
  deps.log(`Local page ${url}: ${result.ok ? "accepted" : "rejected"} (${result.reason})`);
  return result.ok;
}

/** The note on a local group's page. */
export function localNote(place: string | undefined): string {
  return `A local group's own page. Global View checked it is live and names ${place || "the disaster's place"}, but cannot vouch for the group.`;
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
  /** The places' own names from the geocoder's cache, by place name (geocode.ts localPlaceNames). */
  localNames?: Readonly<Record<string, readonly string[]>>;
}

function localContext(input: DirectInput, registry: DonationRegistry): LocalContext {
  const societies = Object.values(registry.societies);
  return { donation: input.ctx, societyHosts: societies.flatMap((s) => s.hosts), societyNames: societies.map((s) => s.name), newsHosts: input.newsHosts };
}

/** True when a place's name is made of place words of the disaster's title ("Chiang Rai" for "Floods in Chiang Rai, Thailand"). */
function isTitlePlace(name: string, eventWords: ReadonlySet<string>): boolean {
  const words = asciiWords(name).filter((w) => w.length >= 3 && !NOT_EVENT_WORDS.has(w));
  return words.length > 0 && words.every((w) => eventWords.has(w));
}

/**
 * What a disaster's local pages are held to: its place names (placeNames,
 * with its title's places and the places' own names), the names of its
 * title's places in any script (titleNames), its type, its year and its
 * start.
 */
export function localRules(input: Pick<DirectInput, "disaster" | "ctx" | "countryNames" | "pressNames" | "localNames">): LocalPageRules {
  const words = input.ctx.eventWords ?? [];
  const asWritten = titlePlaces(input.disaster.title, words);
  const local = input.localNames ?? {};
  const names = placeNames(input.disaster, input.countryNames, input.pressNames, [...asWritten, ...words], local);
  const title = new Set(words);
  const ownNames = (input.disaster.places ?? []).filter((p) => isTitlePlace(p.name, title)).flatMap((p) => (Object.hasOwn(local, p.name) ? local[p.name] : []).flatMap(nameForms));
  return { names, titleNames: [...new Set([...asWritten, ...ownNames])], type: input.disaster.type, minYear: eventYear(input.disaster), started: input.disaster.started };
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
 * fresh passing verdict under today's rules (localVerdictKey) whose every
 * hop is still allowed and whose own name and title still pass, shown by
 * the page's own name and title.
 */
export function buildDirectLinks(input: DirectInput, registry: DonationRegistry, now: string): DonationLink[] {
  const d = input.disaster;
  const hub = matchHub(input.gofundme, d, input.ctx);
  const pages = input.entry?.direct ?? [];
  const globalGiving = pages
    .filter((p) => p.kind === "globalgiving" && globalGivingProblem(p, d, input.ctx) === null)
    .map(globalGivingLink)
    .filter((l): l is DonationLink => l !== null);
  const local = localContext(input, registry);
  const rules = localRules(input);
  const locals: DonationLink[] = [];
  for (const p of pages) {
    if (p.kind !== "local" || localPageProblem(p, d, local, rules)) continue;
    const v = registry.verdicts[localVerdictKey(d.id, p.url)];
    if (!v?.ok || !verdictFresh(v, now)) continue;
    const start = new URL(p.url).hostname;
    if (!v.chain.every((u) => hopAllowed(start, u, local) && !localAddressProblem(u, local, rules))) continue;
    if (protectedNameIn(v.name, local.societyNames) || protectedNameIn(v.title, local.societyNames) || paymentProblem(v.title ?? "")) continue;
    if (earlierEventProblem([titleWithoutSite(v.name, v.title)], rules, input.ctx)) continue;
    locals.push({ label: localLabel(v, p.url), url: p.url, org: localOrg(v, p.url), kind: "local", note: localNote(v.place), via: "research", forEvent: true });
  }
  return [...(hub ? gofundmeLinks(hub, d.started) : []), ...alternate(globalGiving, hub ? partnerLinks(hub) : []), ...locals];
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
  const rules = localRules(input);
  const unreachable = opts.unreachable ?? new Set<string>();
  let checks = 0;
  for (const p of input.entry?.direct ?? []) {
    if (p.kind !== "local" || checks >= (opts.maxChecks ?? MAX_LOCAL_CHECKS)) continue;
    const problem = localPageProblem(p, input.disaster, local, rules);
    if (problem) {
      deps.log(`Local page ${p.url}: rejected (${problem})`);
      continue;
    }
    const key = localVerdictKey(input.disaster.id, p.url);
    const cached = registry.verdicts[key];
    if ((cached && verdictFresh(cached, now)) || unreachable.has(urlKey(p.url))) continue;
    checks++;
    await verifyLocalPage(p.url, input.disaster.id, deps, local, rules, registry, now);
    if (!registry.verdicts[key]) unreachable.add(urlKey(p.url));
    await deps.sleep(opts.pauseMs ?? 500);
  }
  return buildDirectLinks(input, registry, now);
}
