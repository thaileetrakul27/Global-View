"use client";

import { useEffect, useRef } from "react";
import type { Mention } from "@/lib/attention";
import type { AboutArticle, Article, CountryFile, CountryNeed, SnapshotArticle } from "@/lib/data";
import type { Lead } from "@/lib/crisis";
import type { Need } from "@/lib/help";
import HelpBlock from "./HelpBlock";
import AboutList from "./AboutList";
import type { CountryFeature } from "@/lib/geo";
import { relativeTime } from "@/lib/time";
import ArticleList, { type SharedRef } from "./ArticleList";
import AttentionChips, { type AttentionMode } from "./AttentionChips";
import CopyLink from "./CopyLink";
import PlaceholderStoryCard from "./PlaceholderStoryCard";

/** Shape of a country's data as the panel sees it. */
export type CountryState =
  | { status: "loading" }
  | { status: "ready"; data: CountryFile }
  | { status: "none" }
  | { status: "error" };

interface Props {
  country: CountryFeature;
  state: CountryState;
  onClose: () => void;
  /** Null when the pipeline has not produced attention data yet. */
  attention: {
    mode: AttentionMode;
    onMode: (m: AttentionMode) => void;
    mentions: Mention[];
    inboundOnly?: boolean;
  } | null;
  nameOf: (code: string) => string;
  /** Open another country, optionally showing only its stories about `about`. */
  onSelect: (code: string, about?: string) => void;
  /** Only show this country's stories about this code. */
  filterAbout: string | null;
  onFilter: (code: string | null) => void;
  shared: Map<string, SharedRef>;
  onStory: (id: string) => void;
  /** Display name for this country. */
  name: string;
  /** Archive view: the day's label and that day's articles (null when none archived). */
  history?: { label: string; articles: SnapshotArticle[] | null } | null;
  /** Foreign top stories about this country (null while loading) and how many editions exist. */
  about?: { articles: AboutArticle[] | null; editions: number };
  /** What is needed here and where to give; undefined while loading. */
  need?: Need;
  /** The biggest crisis right now, or null when nothing names the country. */
  lead?: Lead | null;
  /** Long-term needs from the latest UN figures. */
  needs?: CountryNeed[];
}

// Contents of the country panel: the name, when the list was refreshed, who
// this country is reading about, and the ranked articles.
export default function CountryPanel({
  country,
  state,
  onClose,
  attention,
  nameOf,
  onSelect,
  filterAbout,
  onFilter,
  shared,
  onStory,
  name,
  history = null,
  about,
  need,
  lead = null,
  needs = [],
}: Props) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Move focus to the heading when a new country opens, for keyboard users.
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [country]);

  const data = state.status === "ready" ? state.data : null;
  const world = data?.kind === "world";
  const archived: Article[] | null = history?.articles
    ? history.articles.map((a) => ({ ...a, outletUrl: null, published: "" }))
    : null;

  const articles = data
    ? filterAbout
      ? data.articles.filter((a) => a.about?.includes(filterAbout))
      : data.articles
    : [];

  // "X reads about…": a chip narrows this list to X's stories about that country.
  const onChip = (chip: string) => onFilter(filterAbout === chip ? null : chip);
  const inbound = attention?.mode === "inbound";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-start justify-between gap-4 px-5 pt-5 pb-2 sm:px-6 md:pt-7">
        <div className="min-w-0">
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="font-serif text-3xl leading-none tracking-tight text-ink focus:outline-none"
          >
            {name}
          </h2>
          <p className="mt-2 text-xs text-muted">
            {history
              ? `Top stories on ${history.label}`
              : data
                ? `${world ? "World coverage" : "Top stories"} · Updated ${relativeTime(data.updated)}`
                : "Top stories"}
          </p>
        </div>
        <div className="-mr-1 flex shrink-0 items-start">
          <CopyLink label={`Copy link to ${name}`} />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close panel"
            className="-mt-1 shrink-0 rounded-md p-2 text-muted hover:bg-card hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <svg
              aria-hidden
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 sm:px-6">
        {history && archived && <ArticleList articles={archived} />}
        {history && !archived && (
          <p className="pt-3 text-sm text-muted">
            No archive for {name} on {history.label}. Only countries with a
            local news edition are archived, and only from the day they were
            added.
          </p>
        )}

        {!history && state.status === "loading" && (
          <div aria-busy className="divide-y divide-line">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <PlaceholderStoryCard key={i} seed={i} />
            ))}
          </div>
        )}

        {!history && state.status === "none" && (
          <p className="pt-3 text-sm text-muted">
            No stories for {name} yet. Countries are added as their news feeds
            are checked.
          </p>
        )}

        {!history && state.status === "error" && (
          <p className="pt-3 text-sm text-muted">
            Could not load stories just now. Try again in a moment.
          </p>
        )}

        {!history && data && need && (lead || needs.length > 0) && <HelpBlock name={name} iso3={country.properties.iso3} need={need} lead={lead} needs={needs} />}

        {!history && world && (
          <p className="mt-3 rounded-md bg-card px-3 py-2 text-xs leading-snug text-muted">
            {name} has no Google News edition, so this is a news search instead: what
            {name}&apos;s own outlets are publishing, in their language, followed by
            international coverage in English.
          </p>
        )}

        {!history && data && attention && (
          <AttentionChips
            countryName={name}
            mode={attention.mode}
            onMode={attention.onMode}
            mentions={attention.mentions}
            nameOf={nameOf}
            onSelect={onChip}
            activeCode={attention.mode === "outbound" ? filterAbout : null}
            inboundOnly={attention.inboundOnly}
          />
        )}

        {!history && data && attention && inbound && about && (
          <AboutList
            countryName={name}
            articles={about.articles}
            editions={about.editions}
            nameOf={nameOf}
            onSelect={(c) => onSelect(c)}
          />
        )}

        {!history && data && filterAbout && (
          <div className="mt-3 flex items-center justify-between gap-3 rounded-md bg-card px-3 py-2 text-xs text-ink">
            <span>
              {articles.length} {articles.length === 1 ? "story" : "stories"}{" "}
              about {nameOf(filterAbout)}
            </span>
            <button
              type="button"
              onClick={() => onFilter(null)}
              className="shrink-0 text-accent hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              Show all {data.articles.length}
            </button>
          </div>
        )}

        {!history && data && data.articles.length === 0 && (
          <p className="pt-3 text-sm text-muted">
            Nothing usable found about {name} in the last few days. The list
            refreshes every three hours.
          </p>
        )}

        {!history && data && data.articles.length > 0 && !inbound && (
          <div className={attention ? "mt-3 border-t border-line" : ""}>
            <ArticleList articles={articles} shared={shared} onStory={onStory} />
          </div>
        )}
        {!history && data && data.articles.length > 0 && inbound && (
          <div className="mt-5 border-t border-line pt-3">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">
              {world ? `World coverage about ${name}` : `${name}'s own top stories`}
            </p>
            <ArticleList articles={articles} shared={shared} onStory={onStory} />
          </div>
        )}
        {!history && data && need && !lead && needs.length === 0 && <HelpBlock name={name} iso3={country.properties.iso3} need={need} lead={null} needs={[]} />}
      </div>

      <footer className="border-t border-line px-5 py-3 text-xs text-muted sm:px-6">
        {history
          ? `From the daily archive: the top five as last seen on ${history.label}. Links open the publisher.`
          : data
            ? world
              ? `Recent ${data.source.name} search results about ${name}. Translations are automatic. Links open the publisher.`
              : `Ranked by ${data.source.name} top stories, ${name} edition. Translations are automatic. Links open the publisher.`
            : "Links open the publisher."}
      </footer>
    </div>
  );
}
