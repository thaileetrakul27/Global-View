"use client";

import type { Mention } from "@/lib/attention";
import type { SharedStory } from "@/lib/data";

interface Props {
  topStory: SharedStory | null;
  mostWatched: Mention | null;
  nameOf: (code: string) => string;
  onStory: (id: string) => void;
  onCountry: (code: string) => void;
}

// One sentence that says what the world is paying attention to right now.
export default function WorldSummary({ topStory, mostWatched, nameOf, onStory, onCountry }: Props) {
  if (!topStory && !mostWatched) return null;
  const link = "rounded-sm font-medium text-ink underline decoration-line underline-offset-2 hover:text-accent hover:decoration-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent";
  return (
    <p className="pointer-events-auto mt-3 max-w-md text-sm leading-snug text-muted">
      {topStory && (
        <>
          Right now {topStory.countries.length} countries are reading about{" "}
          <button type="button" className={link} onClick={() => onStory(topStory.id)}>
            {topStory.subject ? nameOf(topStory.subject) : topStory.title}
          </button>
          .{" "}
        </>
      )}
      {mostWatched && (
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
