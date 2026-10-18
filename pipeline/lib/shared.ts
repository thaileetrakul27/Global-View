// Finds stories that several countries are reading at the same time.
import { z } from "zod";
import type { AiClient } from "./ai";
import type { EnrichedArticle } from "./translate";

export interface SharedArticle {
  code: string;
  url: string;
  title: string;
  en: string;
  outlet: string;
  /** Countries this headline is about. */
  about: string[];
}

export interface SharedStory {
  id: string;
  /** Short neutral English title for the event. */
  title: string;
  /** When this story was first seen, ISO 8601. */
  since: string;
  /** The country the story is mostly about, or null when no country dominates. */
  subject: string | null;
  /** Country codes reading it, most first. */
  countries: string[];
  articles: SharedArticle[];
}

export interface SharedFile {
  updated: string;
  stories: SharedStory[];
}

export const sharedSchema = z.object({
  stories: z.array(
    z.object({
      title: z.string(),
      items: z.array(z.number().int()),
    }),
  ),
});

export interface Candidate {
  code: string;
  article: EnrichedArticle & { en: string };
}

/**
 * Translated articles that could plausibly be shared across borders: those
 * about a country that articles from at least two different editions are
 * also about. Purely domestic stories are left out, which keeps the single
 * grouping call small enough to answer in full.
 */
export function collectCandidates(countries: { code: string; articles: EnrichedArticle[] }[]): Candidate[] {
  // Which editions mention each country code.
  const editionsByTopic = new Map<string, Set<string>>();
  for (const c of countries) {
    for (const a of c.articles) {
      for (const topic of a.about ?? []) {
        let set = editionsByTopic.get(topic);
        if (!set) editionsByTopic.set(topic, (set = new Set()));
        set.add(c.code);
      }
    }
  }
  const crossBorder = (topic: string) => (editionsByTopic.get(topic)?.size ?? 0) >= 2;

  const out: Candidate[] = [];
  for (const c of countries) {
    for (const a of c.articles) {
      if (a.en && (a.about ?? []).some(crossBorder)) {
        out.push({ code: c.code, article: a as EnrichedArticle & { en: string } });
      }
    }
  }
  return out;
}

export function buildSharedPrompt(candidates: Candidate[]) {
  const system = [
    "You are given today's top headlines from many countries, one per line as: number, tab, country code, tab, English headline.",
    "Group headlines that report the same specific news event. Only form a group when it spans at least two different country codes; headlines that appear in a single country are not reported.",
    "A headline belongs to at most one group. Do not group headlines that merely share a topic; they must be about the same event.",
    "For each group give a short, neutral English title of at most ten words, and list the headline numbers in items.",
    "Return at most 80 groups, largest first. Output only the JSON.",
  ].join(" ");
  const user = candidates.map((c, i) => `${i}\t${c.code}\t${c.article.en}`).join("\n");
  return { system, user };
}

/** A stable-looking id from the title. */
export function storyId(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

/** The country most of a story's headlines are about, if any. */
export function storySubject(articles: { about: string[] }[]): string | null {
  const counts = new Map<string, number>();
  for (const a of articles) for (const code of a.about) counts.set(code, (counts.get(code) ?? 0) + 1);
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return best ? best[0] : null;
}

/**
 * Turns the model's groups into stories, dropping bad indices, repeats and
 * groups that do not span two countries. Sorted by how many countries share them.
 */
export function toStories(groups: z.infer<typeof sharedSchema>, candidates: Candidate[]): SharedStory[] {
  const used = new Set<number>();
  const stories: SharedStory[] = [];
  for (const g of groups.stories) {
    const articles: SharedArticle[] = [];
    const counts = new Map<string, number>();
    for (const i of g.items) {
      const c = candidates[i];
      if (!c || used.has(i)) continue;
      used.add(i);
      articles.push({
        code: c.code,
        url: c.article.url,
        title: c.article.title,
        en: c.article.en,
        outlet: c.article.outlet,
        about: c.article.about ?? [],
      });
      counts.set(c.code, (counts.get(c.code) ?? 0) + 1);
    }
    if (counts.size < 2 || !g.title.trim()) continue;
    const countries = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([code]) => code);
    stories.push({ id: storyId(g.title), title: g.title.trim(), since: "", subject: storySubject(articles), countries, articles });
  }
  stories.sort((a, b) => b.countries.length - a.countries.length || b.articles.length - a.articles.length);
  return stories;
}

/** Share of the smaller story's articles that also appear in the other. */
function overlap(a: SharedStory, b: { articles: { url: string }[] }): number {
  const urls = new Set(b.articles.map((x) => x.url));
  const hits = a.articles.filter((x) => urls.has(x.url)).length;
  return hits / Math.min(a.articles.length, b.articles.length || 1);
}

/**
 * Carries ids, titles and first-seen times over from the previous run when
 * a new story is mostly the same articles, so links and titles stay stable
 * while the grouping is redone every few hours. Unmatched stories start now.
 */
export function reconcileStories(fresh: SharedStory[], previous: SharedStory[] | undefined, now: string): SharedStory[] {
  const used = new Set<string>();
  return fresh.map((story) => {
    let best: SharedStory | null = null;
    let bestScore = 0;
    for (const old of previous ?? []) {
      if (used.has(old.id)) continue;
      const score = overlap(story, old);
      if (score > bestScore) {
        best = old;
        bestScore = score;
      }
    }
    if (best && bestScore >= 0.5) {
      used.add(best.id);
      return { ...story, id: best.id, title: best.title, since: best.since || now };
    }
    return { ...story, since: now };
  });
}

/**
 * One model call for the whole world. Null when the call fails or there is
 * nothing to compare, so the caller keeps the previous file.
 */
export async function findSharedStories(ai: AiClient, candidates: Candidate[]): Promise<SharedStory[] | null> {
  if (candidates.length < 2) return null;
  const { system, user } = buildSharedPrompt(candidates);
  // 16k is the most the SDK allows without streaming; with candidates limited
  // to cross-border topics, 80 short groups fit comfortably.
  const result = await ai.parse({ schema: sharedSchema, system, user, maxTokens: 16000, effort: "low" });
  return result ? toStories(result, candidates) : null;
}
