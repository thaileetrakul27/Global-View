"use client";

import { useId, useState, type ReactNode } from "react";
import type { Mention } from "@/lib/attention";

interface Props {
  countryName: string;
  /** Other countries in this country's top stories, most first. */
  outbound: Mention[];
  /** How many countries have this country in their top stories. */
  readers: number;
  nameOf: (code: string) => string;
  /** Narrows this country's list to its stories about a code; the active chip again clears it. */
  onFilter: (code: string) => void;
  /** Chip currently used as a filter, if any. */
  activeCode: string | null;
  /** Whether "Who reads about X" is open. The globe tints those countries while it is. */
  readersOpen: boolean;
  onReaders: (open: boolean) => void;
  /** Leave out the first section: world coverage is not the country's own news. */
  inboundOnly?: boolean;
  /** The "who reads about" list, shown while that section is open. */
  children?: ReactNode;
}

// "Who is reading about whom", folded away below a country's stories so the
// stories come first: the other countries in its news (chips that narrow the
// list above), and the countries whose news is about it.
export default function AttentionChips({
  countryName,
  outbound,
  readers,
  nameOf,
  onFilter,
  activeCode,
  readersOpen,
  onReaders,
  inboundOnly,
  children,
}: Props) {
  // Open from the start when a shared link arrived with a filter, so its chip shows.
  const [open, setOpen] = useState(activeCode !== null);
  const countries = (n: number) => `${n} ${n === 1 ? "country" : "countries"}`;
  return (
    <div className="mt-4 border-t border-line">
      {!inboundOnly && (
        <Section
          label={outbound.length ? `In ${countryName}'s news: ${countries(outbound.length)}` : `In ${countryName}'s news`}
          open={open}
          onToggle={() => setOpen((v) => !v)}
        >
          {outbound.length ? (
            <>
              <p className="text-xs text-muted">Countries in {countryName}&apos;s top stories, with the number of stories. Pick one to narrow the list.</p>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {outbound.map((m) => (
                  <li key={m.code}>
                    <button
                      type="button"
                      aria-pressed={activeCode === m.code}
                      onClick={() => onFilter(m.code)}
                      className={`rounded-full border px-2.5 py-1 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                        activeCode === m.code ? "border-accent bg-accent text-paper" : "border-line bg-card text-ink hover:border-accent hover:text-accent"
                      }`}
                    >
                      {nameOf(m.code)} <span className={activeCode === m.code ? "text-paper/80" : "text-muted"}>{m.count}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-xs text-muted">None right now: {countryName}&apos;s top stories are all domestic.</p>
          )}
        </Section>
      )}
      <Section
        label={readers ? `Who reads about ${countryName}: ${countries(readers)}` : `Who reads about ${countryName}`}
        open={readersOpen}
        onToggle={() => onReaders(!readersOpen)}
      >
        {children}
      </Section>
    </div>
  );
}

/** A folded section: a full-width button with a chevron, and its contents while open. */
function Section({ label, open, onToggle, children }: { label: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  const id = useId();
  return (
    <section className="border-b border-line">
      <h3>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={onToggle}
          className="flex w-full items-center justify-between gap-3 py-3 text-left text-sm text-ink hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <span>{label}</span>
          <svg
            aria-hidden
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`}
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </h3>
      <div id={id} hidden={!open} className="pb-3">
        {open && children}
      </div>
    </section>
  );
}
