"use client";

import { useEffect, useRef } from "react";
import type { SharedStory } from "@/lib/data";

interface Props {
  story: SharedStory;
  nameOf: (code: string) => string;
  onClose: () => void;
  onSelectCountry: (code: string) => void;
}

/** True when a translation adds nothing (same headline in English already). */
function sameText(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  return norm(a) === norm(b);
}

// One story the world shares: every country's headline for it, grouped by
// country. Country names open that country's full list.
export default function StoryPanel({ story, nameOf, onClose, onSelectCountry }: Props) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [story.id]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-start justify-between gap-4 px-5 pt-5 pb-3 sm:px-6 md:pt-7">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Shared story</p>
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="mt-1 font-serif text-2xl leading-tight tracking-tight text-ink focus:outline-none"
          >
            {story.title}
          </h2>
          <p className="mt-2 text-xs text-muted">
            Read in {story.countries.length} countries · {story.articles.length} articles
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close story"
          className="-mr-1 -mt-1 shrink-0 rounded-md p-2 text-muted hover:bg-card hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <svg aria-hidden width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 sm:px-6">
        {story.countries.map((code) => {
          const articles = story.articles.filter((a) => a.code === code);
          return (
            <section key={code} aria-label={nameOf(code)} className="border-t border-line py-3 first:border-t-0">
              <button
                type="button"
                onClick={() => onSelectCountry(code)}
                className="text-sm font-medium text-ink hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                {nameOf(code)}
                <span aria-hidden className="ml-1 text-muted">→</span>
              </button>
              <ul className="mt-1.5 flex flex-col gap-2">
                {articles.map((a) => {
                  const translation = a.en && !sameText(a.en, a.title) ? a.en : null;
                  return (
                    <li key={a.url}>
                      <a
                        href={a.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="group block focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                      >
                        <span className="block font-serif text-[1rem] leading-snug text-ink group-hover:text-accent">{a.title}</span>
                        {translation && <span className="mt-0.5 block text-sm leading-snug text-muted">{translation}</span>}
                        <span className="mt-0.5 block text-xs text-muted">{a.outlet}</span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>

      <footer className="border-t border-line px-5 py-3 text-xs text-muted sm:px-6">
        Grouped automatically from each country&apos;s top stories. Links open the publisher.
      </footer>
    </div>
  );
}
