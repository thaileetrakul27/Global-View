"use client";

import type { Mention } from "@/lib/attention";
import type { SnapshotStory } from "@/lib/data";

interface Props {
  topStory: SnapshotStory | null;
  mostWatched: Mention | null;
  nameOf: (code: string) => string;
  onStory: (id: string) => void;
  onCountry: (code: string) => void;
  /** A past day's label, e.g. "17 Oct 2026"; null means now. */
  past?: string | null;
}

// One sentence that says what the world is paying attention to right now.
export default function WorldSummary({ topStory, mostWatched, nameOf, onStory, onCountry, past = null }: Props) {
  if (!topStory && !mostWatched) return null;
  const link = "rounded-sm font-medium text-ink underline decoration-line underline-offset-2 hover:text-accent hover:decoration-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent";
  return (
    <p className="pointer-events-auto mt-1.5 max-w-md text-sm leading-snug text-muted">
      {topStory && (
        <>
          {past ? `On ${past}, ${topStory.countries.length} countries were reading about` : `Right now ${topStory.countries.length} countries are reading about`}{" "}
          {past ? (
            <span className="font-medium text-ink">{topStory.subject ? nameOf(topStory.subject) : topStory.title}</span>
          ) : (
            <button type="button" className={link} onClick={() => onStory(topStory.id)}>
              {topStory.subject ? nameOf(topStory.subject) : topStory.title}
            </button>
          )}
          .{" "}
        </>
      )}
      {mostWatched && !past && (
        <>
          The most-watched country is{" "}
          <button type="button" className={link} onClick={() => onCountry(mostWatched.code)}>
            {nameOf(mostWatched.code)}
          </button>
          .
        </>
      )}
    </p>
  );
}
