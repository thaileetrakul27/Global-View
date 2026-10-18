"use client";

import { useEffect, useRef } from "react";
import type { Mention } from "@/lib/attention";
import type { CountryFile } from "@/lib/data";
import type { CountryFeature } from "@/lib/geo";
import { relativeTime } from "@/lib/time";
import ArticleList from "./ArticleList";
import AttentionChips, { type AttentionMode } from "./AttentionChips";
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
  attention: { mode: AttentionMode; onMode: (m: AttentionMode) => void; mentions: Mention[] } | null;
  nameOf: (code: string) => string;
  onSelect: (code: string) => void;
  sharedCounts: Map<string, number>;
}

// Contents of the country panel: the name, when the list was refreshed, who
// this country is reading about, and the ranked articles.
export default function CountryPanel({ country, state, onClose, attention, nameOf, onSelect, sharedCounts }: Props) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Move focus to the heading when a new country opens, for keyboard users.
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [country]);

  const data = state.status === "ready" ? state.data : null;
  const name = country.properties.name;

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
            {data ? `Top stories · Updated ${relativeTime(data.updated)}` : "Top stories"}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close panel"
          className="-mr-1 -mt-1 shrink-0 rounded-md p-2 text-muted hover:bg-card hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <svg aria-hidden width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 sm:px-6">
        {state.status === "loading" && (
          <div aria-busy className="divide-y divide-line">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <PlaceholderStoryCard key={i} seed={i} />
            ))}
          </div>
        )}

        {state.status === "none" && (
          <p className="pt-3 text-sm text-muted">
            No stories for {name} yet. Countries are added as their news feeds are checked.
          </p>
        )}

        {state.status === "error" && (
          <p className="pt-3 text-sm text-muted">Could not load stories just now. Try again in a moment.</p>
        )}

        {data && attention && (
          <AttentionChips
            countryName={name}
            mode={attention.mode}
            onMode={attention.onMode}
            mentions={attention.mentions}
            nameOf={nameOf}
            onSelect={onSelect}
          />
        )}

        {data && (
          <div className={attention ? "mt-3 border-t border-line" : ""}>
            <ArticleList articles={data.articles} sharedCounts={sharedCounts} />
          </div>
        )}
      </div>

      <footer className="border-t border-line px-5 py-3 text-xs text-muted sm:px-6">
        {data
          ? `Ranked by ${data.source.name} top stories, ${name} edition. Translations are automatic. Links open the publisher.`
          : "Links open the publisher."}
      </footer>
    </div>
  );
}
