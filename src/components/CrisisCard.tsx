"use client";

import type { CrisesFile } from "@/lib/data";

interface Props {
  crises: CrisesFile;
  nameOf: (code: string) => string;
  onSelect: (code: string) => void;
}

// Landing card: emergencies the world is not watching, and any it has
// suddenly turned to. Clicking a country opens its panel with help links.
export default function CrisisCard({ crises, nameOf, onSelect }: Props) {
  const unwatched = crises.unwatched.slice(0, 4);
  const watching = crises.watching.slice(0, 2);
  if (!unwatched.length && !watching.length) return null;
  const row = "w-full py-2 text-left text-ink hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent";
  return (
    <section aria-label="Crises" className="pointer-events-auto w-80 rounded-lg border border-line bg-card/90 p-4 backdrop-blur-sm">
      {watching.length > 0 && (
        <>
          <h2 className="text-xs font-medium uppercase tracking-wide text-accent">The world has turned to</h2>
          <ol className="mt-1 divide-y divide-line">
            {watching.map((w) => (
              <li key={w.code}>
                <button type="button" onClick={() => onSelect(w.code)} className={row}>
                  <span className="block font-serif text-[0.95rem] leading-snug">{nameOf(w.code)}</span>
                  <span className="block text-xs text-muted">{w.editions} countries · {w.sample[0]}</span>
                </button>
              </li>
            ))}
          </ol>
        </>
      )}
      {unwatched.length > 0 && (
        <>
          <h2 className={`text-xs font-medium uppercase tracking-wide text-muted ${watching.length ? "mt-3" : ""}`}>
            Emergencies the world is not watching
          </h2>
          <ol className="mt-1 divide-y divide-line">
            {unwatched.map((u) => (
              <li key={u.code}>
                <button type="button" onClick={() => onSelect(u.code)} className={row}>
                  <span className="block font-serif text-[0.95rem] leading-snug">{nameOf(u.code)}</span>
                  <span className="block text-xs text-muted">
                    {u.matching} of its top {u.total} stories · {u.sample[0]}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
