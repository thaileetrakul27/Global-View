"use client";

import { useId } from "react";
import type { SnapshotStory } from "@/lib/data";

interface Props {
  stories: SnapshotStory[];
  /** How many stories to list (see trendingRows); 0 shows only a "Trending today" button. */
  rows: number;
  /** Opens a story's panel. */
  onStory: (id: string) => void;
  /** Opens the full "Trending today" list in the sheet. */
  onOpen: () => void;
}

const ring = "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent";

/** Screens shorter than this (phones in landscape) have no band under the globe for the card. */
export const CARD_MIN_HEIGHT = 560;
/** Screens shorter than this list two stories instead of three. */
export const THREE_ROW_HEIGHT = 780;

/**
 * How many stories the card under the globe lists on a phone of this size:
 * three on a tall screen, two on a shorter one, and none (just a button
 * that opens the list) on a landscape or very short screen, where the card
 * would cover the globe and block dragging it.
 */
export function trendingRows(width: number, height: number): number {
  if (height < CARD_MIN_HEIGHT || width > height) return 0;
  return height < THREE_ROW_HEIGHT ? 2 : 3;
}

// Phones, on the news map with nothing open: a compact "Trending today" card
// in the band under the globe, the top stories one line each. A story opens
// its panel; "See all" opens the full list in the sheet, and focus comes
// back to it (data-trending-button) when the sheet closes. Without room for
// rows, a small button in the corner opens the list instead.
export default function TrendingStrip({ stories, rows, onStory, onOpen }: Props) {
  const headingId = useId();
  if (!stories.length) return null;
  if (rows < 1)
    return (
      <button
        type="button"
        data-trending-button
        onClick={onOpen}
        className={`pointer-events-auto ml-4 inline-flex h-10 items-center gap-1.5 rounded-full border border-line bg-card/90 px-3.5 text-sm text-ink backdrop-blur-sm hover:text-accent ${ring}`}
      >
        <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent">
          <path d="M3 17l6-6 4 4 8-8" />
          <path d="M15 7h6v6" />
        </svg>
        Trending today
      </button>
    );
  return (
    <section aria-labelledby={headingId} className="pointer-events-auto mx-4 rounded-lg border border-line bg-card/90 px-3.5 pb-0.5 backdrop-blur-sm">
      <div className="flex items-center justify-between gap-3">
        <h2 id={headingId} className="text-xs font-medium uppercase tracking-wide text-muted">
          Trending today
        </h2>
        <button
          type="button"
          data-trending-button
          onClick={onOpen}
          className={`-mr-2 min-h-9 rounded-md px-2 text-xs font-medium text-accent hover:underline ${ring}`}
        >
          See all
        </button>
      </div>
      <ol className="divide-y divide-line border-t border-line">
        {stories.slice(0, rows).map((s) => (
          <li key={s.id}>
            <button type="button" onClick={() => onStory(s.id)} className={`flex min-h-10 w-full items-center text-left text-ink hover:text-accent ${ring}`}>
              <span className="min-w-0 truncate font-serif text-[0.95rem]">{s.title}</span>
              <span className="sr-only">, read in {s.countries.length} countries</span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
