"use client";

import { useEffect, useRef } from "react";
import type { SnapshotStory } from "@/lib/data";
import StoryList from "./StoryList";

interface Props {
  stories: SnapshotStory[];
  nameOf: (code: string) => string;
  /** Opens a story's panel. */
  onStory: (id: string) => void;
  onClose: () => void;
}

/** How many stories the phone sheet lists; it scrolls, so more than the desktop card. */
const LIMIT = 10;

// Phones: "Trending today" in the bottom sheet, the same list as the
// desktop landing card. Choosing a story opens its panel.
export default function TrendingPanel({ stories, nameOf, onStory, onClose }: Props) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Focus the heading when the sheet opens, as the other panels do.
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-start justify-between gap-4 px-5 pt-5 pb-2 sm:px-6">
        <div className="min-w-0">
          <h2 ref={headingRef} tabIndex={-1} className="font-serif text-2xl leading-none tracking-tight text-ink focus:outline-none">
            Trending today
          </h2>
          <p className="mt-2 text-xs text-muted">Stories read in the most countries right now</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close trending stories"
          className="-mr-1.5 -mt-1.5 grid h-10 w-10 shrink-0 place-items-center rounded-md text-muted hover:bg-card hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <svg aria-hidden width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 sm:px-6">
        <StoryList stories={stories} focusId={null} onFocus={(id) => id && onStory(id)} nameOf={nameOf} limit={LIMIT} />
      </div>
    </div>
  );
}
