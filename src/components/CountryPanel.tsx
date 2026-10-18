"use client";

import { useEffect, useRef } from "react";
import type { CountryFeature } from "@/lib/geo";
import PlaceholderStoryCard from "./PlaceholderStoryCard";

interface Props {
  country: CountryFeature;
  onClose: () => void;
}

// Contents of the country panel. Phase 2 shows the name and placeholder
// story cards; Phase 3 replaces the placeholders with real data.
export default function CountryPanel({ country, onClose }: Props) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Move focus to the heading when a new country opens, for keyboard users.
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [country]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-start justify-between gap-4 px-5 pt-5 pb-4 sm:px-6 md:pt-7">
        <div>
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="font-serif text-3xl leading-none tracking-tight text-ink focus:outline-none"
          >
            {country.properties.name}
          </h2>
          <p className="mt-2 text-sm text-muted">
            Stories and bias labels arrive in the next phase.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close panel"
          className="-mr-1 -mt-1 rounded-md p-2 text-muted hover:bg-card hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <svg
            aria-hidden
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 sm:px-6">
        <ul className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <li key={i}>
              <PlaceholderStoryCard seed={i} />
            </li>
          ))}
        </ul>
      </div>

      <footer className="border-t border-line px-5 py-3 text-xs text-muted sm:px-6">
        <a href="#" className="hover:text-ink">
          How we label bias
        </a>
      </footer>
    </div>
  );
}
