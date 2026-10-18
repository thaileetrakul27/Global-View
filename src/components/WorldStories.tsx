"use client";

import type { SnapshotStory } from "@/lib/data";

interface Props {
  stories: SnapshotStory[];
  focusId: string | null;
  onFocus: (id: string | null) => void;
  nameOf: (code: string) => string;
  /** Archive days have no article detail, so rows are not clickable. */
  heading?: string;
  interactive?: boolean;
}

/** How many shared stories the landing card lists. */
const LIMIT = 6;

// Landing card: the stories most countries are reading at once. Clicking one
// opens the story's panel and draws only its arcs on the globe.
export default function WorldStories({ stories, focusId, onFocus, nameOf, heading = "Stories the world shares", interactive = true }: Props) {
  const top = stories.slice(0, LIMIT);
  if (!top.length) return null;
  return (
    <section
      aria-label="Stories the world shares"
      className="pointer-events-auto w-80 rounded-lg border border-line bg-card/90 p-4 backdrop-blur-sm"
    >
      <h2 className="text-xs font-medium uppercase tracking-wide text-muted">{heading}</h2>
      <ol className="mt-2 divide-y divide-line">
        {top.map((s) => {
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
    </section>
  );
}
