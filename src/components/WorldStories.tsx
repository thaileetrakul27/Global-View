"use client";

import type { SnapshotStory } from "@/lib/data";
import StoryList from "./StoryList";

interface Props {
  stories: SnapshotStory[];
  focusId: string | null;
  onFocus: (id: string | null) => void;
  nameOf: (code: string) => string;
  /** "Trending today", or the archive day's title. */
  heading?: string;
  /** Archive days have no article detail, so rows are not clickable. */
  interactive?: boolean;
}

/** How many shared stories the landing card lists. */
const LIMIT = 6;

// Desktop landing card: the stories trending today, read in the most
// countries at once. Clicking one opens the story's panel and draws only
// its arcs on the globe.
export default function WorldStories({ stories, focusId, onFocus, nameOf, heading = "Trending today", interactive = true }: Props) {
  if (!stories.length) return null;
  return (
    <section aria-label={heading} className="pointer-events-auto w-80 rounded-lg border border-line bg-card/90 p-4 backdrop-blur-sm">
      <h2 className="text-xs font-medium uppercase tracking-wide text-muted">{heading}</h2>
      <div className="mt-2">
        <StoryList stories={stories} focusId={focusId} onFocus={onFocus} nameOf={nameOf} limit={LIMIT} interactive={interactive} />
      </div>
    </section>
  );
}
