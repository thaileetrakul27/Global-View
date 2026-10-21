"use client";

import { useId } from "react";
import type { SnapshotStory } from "@/lib/data";

interface Props {
  stories: SnapshotStory[];
  /** How many stories to list: three, or two on a short screen. */
  rows: number;
  /** Opens a story's panel. */
  onStory: (id: string) => void;
  /** Opens the full "Trending today" list in the sheet. */
  onOpen: () => void;
}

const ring = "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent";

// Phones, on the news map with nothing open: a compact "Trending today" card
// in the band under the globe, the top stories one line each. A story opens
// its panel; "See all" opens the full list in the sheet, and focus comes
// back to it (data-trending-button) when the sheet closes.
export default function TrendingStrip({ stories, rows, onStory, onOpen }: Props) {
  const headingId = useId();
  if (!stories.length) return null;
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
