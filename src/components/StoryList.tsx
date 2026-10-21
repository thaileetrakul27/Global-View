"use client";

import type { SnapshotStory } from "@/lib/data";

interface Props {
  stories: SnapshotStory[];
  /** The story whose panel is open, if any. */
  focusId: string | null;
  onFocus: (id: string | null) => void;
  nameOf: (code: string) => string;
  /** Most stories listed. */
  limit: number;
  /** Archive days have no article detail, so rows are not clickable. */
  interactive?: boolean;
}

// The stories read in the most countries at once, most first. Choosing one
// opens its panel; choosing the open one again closes it. Shared by the
// desktop "Trending today" card and the phone "Trending" sheet.
export default function StoryList({ stories, focusId, onFocus, nameOf, limit, interactive = true }: Props) {
  return (
    <ol className="divide-y divide-line">
      {stories.slice(0, limit).map((s) => {
        const active = focusId === s.id;
        return (
          <li key={s.id}>
            <button
              type="button"
              aria-pressed={active}
              disabled={!interactive}
              onClick={() => onFocus(active ? null : s.id)}
              title={s.countries.map(nameOf).join(", ")}
              className={`w-full py-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                active ? "text-accent" : interactive ? "text-ink hover:text-accent" : "text-ink"
              }`}
            >
              <span className="block font-serif text-[0.95rem] leading-snug">{s.title}</span>
              <span className="mt-0.5 block text-xs text-muted">
                {s.subject ? `About ${nameOf(s.subject)} · ` : ""}
                read in {s.countries.length} countries
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
