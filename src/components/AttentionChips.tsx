"use client";

import type { Mention } from "@/lib/attention";

export type AttentionMode = "outbound" | "inbound";

interface Props {
  countryName: string;
  mode: AttentionMode;
  onMode: (m: AttentionMode) => void;
  mentions: Mention[];
  nameOf: (code: string) => string;
  onSelect: (code: string) => void;
}

// "Who is reading about whom", as a row of clickable country chips. The
// toggle flips between countries in this country's news and countries
// whose news is about this country.
export default function AttentionChips({ countryName, mode, onMode, mentions, nameOf, onSelect }: Props) {
  return (
    <section aria-label="Attention" className="pt-3">
      <div className="flex gap-1 text-xs" role="tablist">
        {(["outbound", "inbound"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => onMode(m)}
            className={`rounded-full px-2.5 py-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
              mode === m ? "bg-ink text-paper" : "text-muted hover:text-ink"
            }`}
          >
            {m === "outbound" ? `In ${countryName}'s news` : `Talking about ${countryName}`}
          </button>
        ))}
      </div>
      {mentions.length ? (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {mentions.map((m) => (
            <li key={m.code}>
              <button
                type="button"
                onClick={() => onSelect(m.code)}
                className="rounded-full border border-line bg-card px-2.5 py-1 text-xs text-ink hover:border-accent hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                {nameOf(m.code)} <span className="text-muted">{m.count}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-muted">
          {mode === "outbound"
            ? `No other countries in ${countryName}'s top stories right now.`
            : `No other country's top stories are about ${countryName} right now.`}
        </p>
      )}
    </section>
  );
}
