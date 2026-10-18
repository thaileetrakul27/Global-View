"use client";

import { alertLabel } from "@/lib/alerts";
import type { CrisesFile } from "@/lib/data";

interface Props {
  crises: CrisesFile;
  nameOf: (code: string) => string;
  onSelect: (code: string) => void;
}

// Landing card: disasters few are reading about, any country the world
// has suddenly turned to, and emergencies nobody is watching. Clicking a
// country opens its panel with help links.
export default function CrisisCard({ crises, nameOf, onSelect }: Props) {
  const watching = crises.watching.slice(0, 2);
  const quiet = crises.quiet.slice(0, 4).map((q) => ({ ...q, alert: crises.alerts.find((a) => a.id === q.alert) })).filter((q) => q.alert);
  const unwatched = crises.unwatched.slice(0, 3);
  if (!watching.length && !quiet.length && !unwatched.length) return null;
  const row = "w-full py-2 text-left text-ink hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent";
  const heading = (text: string, first: boolean) => (
    <h2 className={`text-xs font-medium uppercase tracking-wide text-muted ${first ? "" : "mt-3"}`}>{text}</h2>
  );
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
                  <span className="block text-xs text-muted">
                    {w.editions} countries · {w.sample[0]}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </>
      )}
      {quiet.length > 0 && (
        <>
          {heading("Disasters few are reading about", !watching.length)}
          <ol className="mt-1 divide-y divide-line">
            {quiet.map((q) => (
              <li key={q.code}>
                <button type="button" onClick={() => onSelect(q.code)} className={row}>
                  <span className="flex items-center gap-2 font-serif text-[0.95rem] leading-snug">
                    <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${q.alert!.level === "Red" ? "bg-red-700" : "bg-amber-500"}`} />
                    {nameOf(q.code)}
                  </span>
                  <span className="block text-xs text-muted">
                    {alertLabel(q.alert!)}
                    {q.alert!.name ? `: ${q.alert!.name}` : ""} · in the top stories of{" "}
                    {q.editions === 0 ? "no other country" : `${q.editions} ${q.editions === 1 ? "country" : "countries"}`}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </>
      )}
      {unwatched.length > 0 && (
        <>
          {heading("Emergencies the world is not watching", !watching.length && !quiet.length)}
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
