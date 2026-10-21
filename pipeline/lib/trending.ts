// Groups a country's headlines by story and ranks the stories, so recent
// news that many outlets carry rises to the top and old news sinks.
// Purely lexical: no model is called. It runs on the original headlines
// before translation, so only the headlines that are kept get translated.
import type { Article } from "./googlenews";

// --- Grouping ---------------------------------------------------------

/**
 * Scripts written without spaces between words, compared by pairs of
 * characters instead of words. Korean is spaced, but its particles stick
 * to the word ("정부가", "정부는"), so pairs match it better too.
 */
const UNSPACED = "\\p{scx=Han}\\p{scx=Hiragana}\\p{scx=Katakana}\\p{scx=Thai}\\p{scx=Lao}\\p{scx=Khmer}\\p{scx=Myanmar}\\p{scx=Hangul}";
const RUN = new RegExp(`[${UNSPACED}]+|[^${UNSPACED}]+`, "gu");
const UNSPACED_START = new RegExp(`^[${UNSPACED}]`, "u");

/**
 * Two headlines from different outlets are the same story at this weighted
 * similarity or above. Tuned on real feeds in English, German, French,
 * Portuguese, Russian, Thai, Japanese, Korean and Chinese: the same event
 * told by two outlets mostly scores 0.4 to 0.9, different events that
 * share a name or a topic mostly under 0.35. A missed match only repeats
 * a story; a wrong one hides a story, so the bar errs high.
 */
export const STORY_THRESHOLD = 0.38;
/**
 * Higher bar for two headlines from the same outlet, which reuses its own
 * prefixes and suffixes ("Ukraine-Krieg aktuell: …", "Главное из заявлений …").
 */
export const SAME_OUTLET_THRESHOLD = 0.7;
/** Headlines further apart in time than this are never the same story. */
export const STORY_WINDOW_HOURS = 48;
const HOUR = 3_600_000;

/**
 * The words of a headline, or pairs of characters for scripts without
 * spaces, ignoring case and punctuation. A headline split by " | " is read
 * from its longest part: the others are a rubric or a site name
 * ("Ukraine-Krieg aktuell | …", "… | สวพ.FM91") shared by unrelated stories.
 */
export function storyTokens(title: string): string[] {
  const text = title
    .split(" | ")
    .reduce((a, b) => (b.length > a.length ? b : a))
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ");
  const out = new Set<string>();
  for (const chunk of text.split(/\s+/)) {
    for (const run of chunk.match(RUN) ?? []) {
      const chars = [...run];
      if (UNSPACED_START.test(run)) {
        if (chars.length === 1) out.add(run);
        for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i] + chars[i + 1]);
      } else if (chars.length >= 2) {
        // One-letter words ("a", the "s" of "it's") and lone digits say nothing.
        out.add(run);
      }
    }
  }
  return [...out];
}

/**
 * Weight of each token across a batch of headlines: rare tokens (names,
 * places) count for more than common ones ("the", "says", "ที่").
 */
export function tokenWeights(docs: string[][]): (token: string) => number {
  const df = new Map<string, number>();
  for (const doc of docs) for (const t of new Set(doc)) df.set(t, (df.get(t) ?? 0) + 1);
  const n = docs.length;
  return (t) => Math.log((n + 1) / (df.get(t) ?? 1));
}

/**
 * Whether two token lists hold the same figures (tokens with a digit).
 * An outlet's machine-made headlines ("Light mag. 3.3 earthquake - …, at
 * 06:35 pm") differ only in times or figures when they report different
 * events, so from one outlet they must match.
 */
export function sameFigures(a: string[], b: string[]): boolean {
  const figures = (tokens: string[]) => tokens.filter((t) => /\p{N}/u.test(t)).sort().join(" ");
  return figures(a) === figures(b);
}

/** Weighted Dice similarity of two token lists: 0 when nothing is shared, 1 for the same tokens. */
export function similarity(a: string[], b: string[], weight: (token: string) => number = () => 1): number {
  const inB = new Set(b);
  let shared = 0;
  let total = 0;
  for (const t of a) {
    const w = weight(t);
    total += w;
    if (inB.has(t)) shared += w;
  }
  for (const t of b) total += weight(t);
  return total === 0 ? 0 : (2 * shared) / total;
}

/** An outlet's name for counting: "Evening Standard on MSN" and "Evening Standard" are one outlet. */
export function outletKey(outlet: string): string {
  return outlet
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+(on|via)\s+msn$/, "")
    .replace(/^www\./, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * Splits articles into stories: each article joins the story holding the
 * headline most like its own, if one is like enough, or starts a new one.
 * Two headlines from one outlet must also share their figures (sameFigures).
 * Stories keep the input order of their first article.
 */
export function groupStories(articles: Article[]): Article[][] {
  const tokens = articles.map((a) => storyTokens(a.title));
  const weight = tokenWeights(tokens);
  const times = articles.map((a) => Date.parse(a.published));
  const keys = articles.map((a) => outletKey(a.outlet));
  const groups: number[][] = [];
  for (let i = 0; i < articles.length; i++) {
    let best = -1;
    let bestSim = 0;
    for (const [g, members] of groups.entries()) {
      for (const j of members) {
        if (Math.abs(times[i] - times[j]) > STORY_WINDOW_HOURS * HOUR) continue;
        const sameOutlet = keys[i] !== "" && keys[i] === keys[j];
        if (sameOutlet && !sameFigures(tokens[i], tokens[j])) continue;
        const sim = similarity(tokens[i], tokens[j], weight);
        const bar = sameOutlet ? SAME_OUTLET_THRESHOLD : STORY_THRESHOLD;
        if (sim >= bar && sim > bestSim) {
          best = g;
          bestSim = sim;
        }
      }
    }
    if (best === -1) groups.push([i]);
    else groups[best].push(i);
  }
  return groups.map((g) => g.map((i) => articles[i]));
}

// --- Ranking ----------------------------------------------------------
// A story's score is recency + coverage + top-stories bonus - staleness.

/** Recency: worth this much when brand new, halving every HALF_LIFE_HOURS. */
export const RECENCY_WEIGHT = 3;
export const HALF_LIFE_HOURS = 6;
/**
 * Coverage: this times the natural log of the number of outlets, so one
 * outlet adds nothing and five add about 1.2. Kept below the top-stories
 * bonus because Google sometimes lists no related coverage for a big story.
 */
export const COVERAGE_WEIGHT = 0.75;
/** Google's top-stories feed: this much for its first item, halving by TOP_POSITION_SCALE. */
export const TOP_WEIGHT = 2;
export const TOP_POSITION_SCALE = 10;
/** Stories whose newest headline is older than this lose STALE_PENALTY, which sinks them below current news. */
export const STALE_HOURS = 36;
export const STALE_PENALTY = 3;
/** A publish time further ahead than this is wrong, so the story counts as stale. */
export const FUTURE_TOLERANCE_HOURS = 1;

/**
 * Trending: carried by at least TRENDING_OUTLETS outlets, with the newest
 * headline published within TRENDING_HOURS. Google lists related coverage
 * under most big stories, so many stories pass; only the best-ranked
 * TRENDING_MAX of them in each list are marked, so the label stays news.
 */
export const TRENDING_OUTLETS = 3;
export const TRENDING_HOURS = 12;
export const TRENDING_MAX = 5;

/** What the ranking needs to know about one story. */
export interface StoryStats {
  /** Distinct outlets carrying it; at least 1. */
  outlets: number;
  /** Publish time of its newest headline, ISO 8601. */
  newest: string;
  /** Best (lowest, from 0) position in Google's top-stories feed, or null when not in it. */
  topPosition: number | null;
}

/**
 * Outlets, newest time and best top-stories position of one story. Its
 * outlets are those of its articles and those Google lists under them as
 * covering the same story.
 */
export function storyStats(story: Article[], topPositions: Map<string, number>): StoryStats {
  const outlets = new Set(story.flatMap((a) => [a.outlet, ...(a.related ?? [])]).map(outletKey).filter(Boolean));
  let newest = story[0].published;
  let topPosition: number | null = null;
  for (const a of story) {
    if (Date.parse(a.published) > Date.parse(newest)) newest = a.published;
    const pos = topPositions.get(a.url);
    if (pos !== undefined && (topPosition === null || pos < topPosition)) topPosition = pos;
  }
  return { outlets: Math.max(1, outlets.size), newest, topPosition };
}

/** Hours since `iso`; Infinity for a time that cannot be read or lies too far ahead. */
export function ageHours(iso: string, now: number): number {
  const age = (now - Date.parse(iso)) / HOUR;
  if (Number.isNaN(age) || age < -FUTURE_TOLERANCE_HOURS) return Infinity;
  return Math.max(0, age);
}

/** The story's ranking score; higher is better. */
export function storyScore(s: StoryStats, now: number): number {
  const age = ageHours(s.newest, now);
  const recency = RECENCY_WEIGHT * 0.5 ** (age / HALF_LIFE_HOURS);
  const coverage = COVERAGE_WEIGHT * Math.log(s.outlets);
  const top = s.topPosition === null ? 0 : TOP_WEIGHT / (1 + s.topPosition / TOP_POSITION_SCALE);
  return recency + coverage + top - (age > STALE_HOURS ? STALE_PENALTY : 0);
}

/** Widely carried and recent enough to be trending (before the TRENDING_MAX cap). */
export function isTrending(s: StoryStats, now: number): boolean {
  return s.outlets >= TRENDING_OUTLETS && ageHours(s.newest, now) <= TRENDING_HOURS;
}

/**
 * A top-stories article is shown for its story only when it is at most
 * this much older than the story's newest headline. Google's top feed
 * keeps leads for days, and a story is ranked and marked trending by its
 * newest headline, so the time shown must stay close to that one.
 */
export const LEAD_LAG_HOURS = 3;

/**
 * The article shown for a story: its best-placed top-stories article
 * from within LEAD_LAG_HOURS of its newest, if it has one, else its newest.
 */
export function representative(story: Article[], topPositions: Map<string, number>): Article {
  const newest = story.reduce((a, b) => (Date.parse(b.published) > Date.parse(a.published) ? b : a));
  const cutoff = Date.parse(newest.published) - LEAD_LAG_HOURS * HOUR;
  const inTop = story.filter((a) => topPositions.has(a.url) && Date.parse(a.published) >= cutoff);
  if (inTop.length) return inTop.reduce((a, b) => (topPositions.get(b.url)! < topPositions.get(a.url)! ? b : a));
  return newest;
}

/**
 * An article's ranking marks (outlets, trending), for copying it into the
 * "about" files and the daily archive. Empty for articles from older files.
 */
export function rankMarks(a: Pick<Article, "outlets" | "trending">): Pick<Article, "outlets" | "trending"> {
  return { ...(a.outlets !== undefined ? { outlets: a.outlets } : {}), ...(a.trending !== undefined ? { trending: a.trending } : {}) };
}

/**
 * One article per story, best first, each marked with how many outlets
 * carry its story and whether it is trending. Google's related-coverage
 * names are dropped here, so they are never published.
 *
 * @param top links in Google's top-stories feed, in its order; empty when
 *   the list has none, as for world coverage.
 */
export function rankStories(articles: Article[], top: string[], now: string): Article[] {
  const at = Date.parse(now);
  const topPositions = new Map<string, number>();
  for (const [i, url] of top.entries()) if (!topPositions.has(url)) topPositions.set(url, i);
  const ranked = groupStories(articles)
    .map((story, order) => {
      const stats = storyStats(story, topPositions);
      return { story, stats, score: storyScore(stats, at), order };
    })
    .sort((a, b) => b.score - a.score || a.order - b.order);
  let marked = 0;
  return ranked.map(({ story, stats }) => {
    const trending = marked < TRENDING_MAX && isTrending(stats, at);
    if (trending) marked++;
    const article: Article = { ...representative(story, topPositions), outlets: stats.outlets, trending };
    delete article.related;
    return article;
  });
}
