"use client";

import type { AboutArticle } from "@/lib/data";
import ArticleList from "./ArticleList";

interface Props {
  countryName: string;
  /** Null while loading; empty when nobody's top stories mention the country. */
  articles: AboutArticle[] | null;
  /** How many editions were checked. */
  editions: number;
  nameOf: (code: string) => string;
  onSelect: (code: string) => void;
}

// "Who reads about X": the foreign top stories about X, grouped by the
// country they were read in.
export default function AboutList({ countryName, articles, editions, nameOf, onSelect }: Props) {
  if (articles === null) return <p className="mt-2 text-xs text-muted">Loading…</p>;
  const byCountry = new Map<string, AboutArticle[]>();
  for (const a of articles) byCountry.set(a.from, [...(byCountry.get(a.from) ?? []), a]);
  const groups = [...byCountry.entries()].sort((a, b) => b[1].length - a[1].length || nameOf(a[0]).localeCompare(nameOf(b[0])));

  return (
    <div>
      <p className="mt-1.5 text-xs text-muted">
        {groups.length
          ? `${countryName} is in the top stories of ${groups.length} of ${editions} countries right now: ${articles.length} ${articles.length === 1 ? "story" : "stories"}, newest first.`
          : `None of the other ${editions} countries has ${countryName} in its top stories right now.`}
      </p>
      {groups.map(([code, list]) => (
        <section key={code} aria-label={nameOf(code)} className="mt-3">
          <button
            type="button"
            onClick={() => onSelect(code)}
            className="text-xs font-medium uppercase tracking-wide text-muted hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Read in {nameOf(code)}
            <span aria-hidden className="ml-1">→</span>
          </button>
          <ArticleList articles={list.map((a) => ({ ...a, outletUrl: null }))} />
        </section>
      ))}
    </div>
  );
}
