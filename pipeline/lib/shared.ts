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
}

export interface SharedStory {
  id: string;
  /** Short neutral English title for the event. */
  title: string;
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

/** Every translated article across all countries, in a stable order. */
export function collectCandidates(countries: { code: string; articles: EnrichedArticle[] }[]): Candidate[] {
  const out: Candidate[] = [];
  for (const c of countries) {
    for (const a of c.articles) {
      if (a.en) out.push({ code: c.code, article: a as EnrichedArticle & { en: string } });
    }
  }
  return out;
}

export function buildSharedPrompt(candidates: Candidate[]) {
  const system = [
    "You are given today's top headlines from many countries, one per line as: number, tab, country code, tab, English headline.",
    "Group headlines that report the same specific news event. Only form a group when it spans at least two different country codes; headlines that appear in a single country are not reported.",
    "A headline belongs to at most one group. Do not group headlines that merely share a topic; they must be about the same event.",
    "For each group give a short, neutral English title of at most twelve words, and list the headline numbers in items.",
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
      articles.push({ code: c.code, url: c.article.url, title: c.article.title, en: c.article.en, outlet: c.article.outlet });
      counts.set(c.code, (counts.get(c.code) ?? 0) + 1);
    }
    if (counts.size < 2 || !g.title.trim()) continue;
    const countries = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([code]) => code);
    stories.push({ id: storyId(g.title), title: g.title.trim(), countries, articles });
  }
  stories.sort((a, b) => b.countries.length - a.countries.length || b.articles.length - a.articles.length);
  return stories;
}

/**
 * One model call for the whole world. Null when the call fails or there is
 * nothing to compare, so the caller keeps the previous file.
 */
export async function findSharedStories(ai: AiClient, candidates: Candidate[]): Promise<SharedStory[] | null> {
  if (candidates.length < 2) return null;
  const { system, user } = buildSharedPrompt(candidates);
  const result = await ai.parse({ schema: sharedSchema, system, user, maxTokens: 16000, effort: "medium" });
  return result ? toStories(result, candidates) : null;
}
