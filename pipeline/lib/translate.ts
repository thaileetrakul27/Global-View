// Translates headlines into English and notes which countries each is about.
// Results are cached by article link so a headline is only ever sent once.
import fs from "node:fs";
import { z } from "zod";
import type { AiClient } from "./ai";
import type { Article } from "./googlenews";

export interface Enrichment {
  /** English headline; identical to the original when it was already English. */
  en: string;
  /** ISO 3166-1 alpha-2 codes of countries the headline is about. */
  about: string[];
}

export interface CacheEntry extends Enrichment {
  /** When the link was last seen in a feed. */
  seen: string;
}

export type HeadlineCache = Record<string, CacheEntry>;

/** Articles as published, with translation fields when known. */
export type EnrichedArticle = Article & Partial<Enrichment>;

export const translationSchema = z.object({
  items: z.array(
    z.object({
      i: z.number().int(),
      en: z.string(),
      about: z.array(z.string()),
    }),
  ),
});

/** Headlines per model call. Keeps each call small enough to be reliable. */
export const BATCH_SIZE = 40;

/** The headline cache; empty when the file is missing or unreadable (the headlines are then translated again). */
export function readCache(path: string): HeadlineCache {
  if (!fs.existsSync(path)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(path, "utf8")) as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as HeadlineCache) : {};
  } catch (err) {
    console.warn(`${path} is unreadable (${err instanceof Error ? err.message : String(err)}); starting an empty headline cache`);
    return {};
  }
}

export function buildTranslationPrompt(country: { code: string; name: string }, headlines: string[]) {
  const system = [
    "You translate news headlines into clear, natural English and note which countries each headline is about.",
    `The headlines come from the ${country.name} (${country.code}) edition of a news service, so unnamed places and institutions are usually in ${country.name}.`,
    "Return exactly one item per headline, with i set to the headline's number.",
    "en: a faithful English translation of the headline. If it is already in English, copy it unchanged. Do not add, remove or editorialise.",
    `about: ISO 3166-1 alpha-2 codes of the countries the headline is mainly about, including ${country.code} when it concerns ${country.name}. A country, its government, its people or a place in it must be a main subject; do not tag a country only because a company, team or person from it is named. Use an empty list when no country applies.`,
  ].join(" ");
  const user = headlines.map((h, i) => `${i}\t${h}`).join("\n");
  return { system, user };
}

/** Upper-case, two letters, on the globe, no repeats. */
export function normaliseAbout(codes: string[], valid: Set<string>): string[] {
  const out: string[] = [];
  for (const c of codes) {
    const code = c.trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(code) && valid.has(code) && !out.includes(code)) out.push(code);
  }
  return out;
}

/**
 * Translates the articles not yet in the cache, in batches, and writes the
 * results into the cache. Returns how many headlines were translated.
 */
export async function translateNew(
  ai: AiClient,
  country: { code: string; name: string },
  articles: Article[],
  cache: HeadlineCache,
  validCodes: Set<string>,
  now: string,
): Promise<number> {
  const pending = articles.filter((a) => !(a.url in cache));
  let done = 0;
  for (let start = 0; start < pending.length; start += BATCH_SIZE) {
    const batch = pending.slice(start, start + BATCH_SIZE);
    const { system, user } = buildTranslationPrompt(country, batch.map((a) => a.title));
    const result = await ai.parse({ schema: translationSchema, system, user, maxTokens: 6000, effort: "low", purpose: "translate" });
    if (!result) continue;
    for (const item of result.items) {
      const article = batch[item.i];
      if (!article || !item.en.trim() || article.url in cache) continue;
      cache[article.url] = { en: item.en.trim(), about: normaliseAbout(item.about, validCodes), seen: now };
      done++;
    }
  }
  return done;
}

/** Attaches cached translations to articles and marks their links as seen now. */
export function applyCache(articles: Article[], cache: HeadlineCache, now: string): EnrichedArticle[] {
  return articles.map((a) => {
    const hit = cache[a.url];
    if (!hit) return a;
    hit.seen = now;
    return { ...a, en: hit.en, about: hit.about };
  });
}

/** Grace period for links that have dropped out of every feed. */
export const CACHE_GRACE_MS = 48 * 3600 * 1000;

/** Drops entries not seen within the grace period, so the cache stays small. */
export function pruneCache(cache: HeadlineCache, now: string, graceMs = CACHE_GRACE_MS): HeadlineCache {
  const cutoff = Date.parse(now) - graceMs;
  const out: HeadlineCache = {};
  for (const [url, entry] of Object.entries(cache)) {
    if (Date.parse(entry.seen) >= cutoff) out[url] = entry;
  }
  return out;
}
