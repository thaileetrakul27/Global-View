"use client";

import { useEffect, useRef } from "react";
import type { CountryFile } from "@/lib/data";
import type { CountryFeature } from "@/lib/geo";
import { countBalance, relativeTime } from "@/lib/stories";
import BalanceBar from "./BalanceBar";
import PlaceholderStoryCard from "./PlaceholderStoryCard";
import StoryCard from "./StoryCard";

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
}

/** Most stories the panel shows for one country. */
const MAX_STORIES = 5;

// Contents of the country panel: name, axis line, update time, overall
// balance and up to five story cards.
export default function CountryPanel({ country, state, onClose }: Props) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Move focus to the heading when a new country opens, for keyboard users.
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [country]);

  const data = state.status === "ready" ? state.data : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-start justify-between gap-4 px-5 pt-5 pb-3 sm:px-6 md:pt-7">
        <div className="min-w-0">
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="font-serif text-3xl leading-none tracking-tight text-ink focus:outline-none"
          >
            {country.properties.name}
          </h2>
          {data && (
            <>
              <p className="mt-2 text-sm leading-snug text-muted">{data.axis.summary}</p>
              <p className="mt-1 text-xs text-muted">Updated {relativeTime(data.updated)}</p>
            </>
          )}
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
          <ul aria-busy className="flex flex-col gap-3 pt-2">
            {[0, 1, 2].map((i) => (
              <li key={i}>
                <PlaceholderStoryCard seed={i} />
              </li>
            ))}
          </ul>
        )}

        {state.status === "none" && (
          <p className="pt-2 text-sm text-muted">
            No stories for {country.properties.name} yet. Countries are switched on a few at a time while the labels are checked.
          </p>
        )}

        {state.status === "error" && (
          <p className="pt-2 text-sm text-muted">Could not load stories just now. Try again in a moment.</p>
        )}

        {data && (
          <>
            <section aria-label="Coverage balance" className="pt-2">
              <BalanceBar balance={balanceOf(data)} axis={data.axis} />
            </section>
            <ul className="mt-5 flex flex-col gap-3">
              {data.stories.slice(0, MAX_STORIES).map((s) => (
                <li key={s.id}>
                  <StoryCard story={s} axis={data.axis} />
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <footer className="flex items-center justify-between border-t border-line px-5 py-3 text-xs text-muted sm:px-6">
        <a href="#" className="hover:text-ink">
          How we label bias
        </a>
        <span>Labels are estimates</span>
      </footer>
    </div>
  );
}


/** Overall balance across every article in the country's stories. */
function balanceOf(data: CountryFile) {
  return countBalance(data.stories.flatMap((s) => s.articles));
}
