"use client";

import { useEffect, useRef } from "react";
import type { Disaster } from "@/lib/data";
import { possessive } from "@/lib/names";
import CopyLink from "./CopyLink";
import { DisasterRow } from "./DisasterList";

interface Props {
  /** Display name of the selected country. */
  name: string;
  /** Its disasters ongoing now, most severe first; null while the list loads. */
  disasters: Disaster[] | null;
  nameOf: (code: string) => string;
  /** Open a disaster's panel by id. */
  onSelect: (id: string) => void;
  /** Switch to the news map, which shows this country's stories. */
  onNews: () => void;
  onClose: () => void;
}

const ring = "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent";

// The country panel on the disaster map: the disasters ongoing in the
// selected country now, each opening its own panel with where to donate, or
// a note that there are none. Either way one button goes back to the
// country's news.
export default function CountryDisasters({ name, disasters, nameOf, onSelect, onNews, onClose }: Props) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Move focus to the heading when a country opens, as the news panel does.
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [name]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-start justify-between gap-4 px-5 pt-5 pb-2 sm:px-6 md:pt-7">
        <div className="min-w-0">
          <h2 ref={headingRef} tabIndex={-1} className="font-serif text-3xl leading-none tracking-tight text-ink focus:outline-none">
            {name}
          </h2>
          <p className="mt-2 text-xs text-muted">Disasters in {name} now</p>
        </div>
        <div className="-mr-1.5 -mt-1.5 flex shrink-0 items-start">
          <CopyLink label={`Copy link to disasters in ${name}`} />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close panel"
            className={`grid h-10 w-10 shrink-0 place-items-center rounded-md text-muted hover:bg-card hover:text-ink ${ring}`}
          >
            <svg aria-hidden width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 sm:px-6">
        {disasters === null && <p className="pt-3 text-sm text-muted">Loading the disasters happening now…</p>}
        {disasters?.length === 0 && <p className="pt-3 text-sm text-muted">No ongoing disasters in {name} right now.</p>}
        {disasters && disasters.length > 0 && (
          <ol aria-label={`Disasters in ${name} now`} className="divide-y divide-line">
            {disasters.map((d) => (
              <li key={d.id}>
                <DisasterRow disaster={d} nameOf={nameOf} onSelect={onSelect} />
              </li>
            ))}
          </ol>
        )}
        <button
          type="button"
          onClick={onNews}
          className={`mt-4 inline-flex min-h-10 items-center rounded-full border border-line bg-card px-4 text-sm text-ink hover:text-accent ${ring}`}
        >
          See {possessive(name)} news
        </button>
      </div>

      <footer className="border-t border-line px-5 py-3 text-xs text-muted sm:px-6">
        Data: GDACS, USGS, NASA EONET, IFRC GO, news reports.
      </footer>
    </div>
  );
}
