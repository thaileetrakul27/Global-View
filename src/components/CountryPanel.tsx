"use client";

import { useEffect, useId, useRef } from "react";
import type { Mention } from "@/lib/attention";
import type { AboutArticle, Article, CountryFile, Disaster, SnapshotArticle } from "@/lib/data";
import { DISASTER_META } from "@/lib/disasterMeta";
import { listFooter } from "@/lib/ranking";
import AboutList from "./AboutList";
import DisasterIcon, { SeverityChip } from "./DisasterIcon";
import type { CountryFeature } from "@/lib/geo";
import { relativeTime } from "@/lib/time";
import ArticleList, { type SharedRef } from "./ArticleList";
import AttentionChips from "./AttentionChips";
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
    /** Other countries in this country's top stories. */
    outbound: Mention[];
    /** How many countries have this country in their top stories. */
    readers: number;
    /** Whether "Who reads about" is open. */
    readersOpen: boolean;
    onReaders: (open: boolean) => void;
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
  /** Disasters happening in this country now, most severe first. */
  disasters?: Disaster[];
  /** Open a disaster's panel by id. */
  onSelectDisaster?: (id: string) => void;
  /** Whether the "+N more" disasters are unfolded; held by the parent so it survives a disaster opening and closing. */
  disastersOpen?: boolean;
  onDisastersOpen?: (open: boolean) => void;
}

// Contents of the country panel: the name, when the list was refreshed, a
// line for any disaster there now, then the articles, one per story,
// ranked by how recent each story is, how many outlets carry it and
// Google's top-stories order. Who this country reads about, and who reads
// about it, are folded away below.
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
  disasters = [],
  onSelectDisaster,
  disastersOpen = false,
  onDisastersOpen = () => {},
}: Props) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

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

  // A chip below the list narrows it; scroll up so the narrowed list shows.
  const onChip = (chip: string) => {
    onFilter(filterAbout === chip ? null : chip);
    scrollRef.current?.scrollTo({ top: 0 });
  };

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
        <div className="-mr-1.5 -mt-1.5 flex shrink-0 items-start">
          <CopyLink label={`Copy link to ${name}`} />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close panel"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-md text-muted hover:bg-card hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
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

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 sm:px-6">
        {!history && onSelectDisaster && disasters.length > 0 && (
          <DisasterLine name={name} disasters={disasters} onSelect={onSelectDisaster} expanded={disastersOpen} onExpand={onDisastersOpen} />
        )}

        {!history && world && (
          <p className="mt-2 text-xs leading-snug text-muted">
            {name} has no Google News edition, so this is a news search: its own outlets in their language, and
            international coverage in English.
          </p>
        )}

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
            refreshes every two hours.
          </p>
        )}

        {!history && data && data.articles.length > 0 && <ArticleList articles={articles} shared={shared} onStory={onStory} />}

        {!history && data && attention && (
          <AttentionChips
            countryName={name}
            outbound={attention.outbound}
            readers={attention.readers}
            nameOf={nameOf}
            onFilter={onChip}
            activeCode={filterAbout}
            readersOpen={attention.readersOpen}
            onReaders={attention.onReaders}
            inboundOnly={attention.inboundOnly}
          >
            {about && (
              <AboutList countryName={name} articles={about.articles} editions={about.editions} nameOf={nameOf} onSelect={(c) => onSelect(c)} />
            )}
          </AttentionChips>
        )}
      </div>

      <footer className="border-t border-line px-5 py-3 text-xs text-muted sm:px-6">
        {history
          ? `From the daily archive: the top five as last seen on ${history.label}. Links open the publisher.`
          : data
            ? listFooter(data, name)
            : "Links open the publisher."}
      </footer>
    </div>
  );
}

// One line for the disasters happening in this country now: the most
// severe, which opens its panel with where to donate, and the rest folded
// behind "+N more".
function DisasterLine({
  name,
  disasters,
  onSelect,
  expanded,
  onExpand,
}: {
  name: string;
  disasters: Disaster[];
  onSelect: (id: string) => void;
  expanded: boolean;
  onExpand: (open: boolean) => void;
}) {
  const listId = useId();
  const [first, ...rest] = disasters;
  const row = "flex min-w-0 items-center gap-2 text-left text-sm text-ink hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent";
  return (
    <section aria-label={`Disasters in ${name} now`} className="mt-2 rounded-lg border border-line bg-card px-3 py-2">
      <div className="flex items-center gap-3">
        <button type="button" data-disaster-id={first.id} onClick={() => onSelect(first.id)} className={`${row} flex-1`}>
          <DisasterIcon type={first.type} size={16} className="shrink-0" title={DISASTER_META[first.type].label} />
          <span className="min-w-0 truncate">{first.title}</span>
          {first.severity >= 2 && <SeverityChip severity={first.severity} />}
        </button>
        {rest.length > 0 && (
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={listId}
            onClick={() => onExpand(!expanded)}
            className="shrink-0 text-xs font-medium text-accent hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {expanded ? "Fewer" : `+${rest.length} more`}
          </button>
        )}
      </div>
      {rest.length > 0 && (
        <ul id={listId} hidden={!expanded} className="mt-1 divide-y divide-line">
          {rest.map((d) => (
            <li key={d.id}>
              <button type="button" data-disaster-id={d.id} onClick={() => onSelect(d.id)} className={`${row} w-full py-2`}>
                <DisasterIcon type={d.type} size={16} className="shrink-0" title={DISASTER_META[d.type].label} />
                <span className="min-w-0 flex-1 truncate">{d.title}</span>
                {d.severity >= 2 && <SeverityChip severity={d.severity} />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
