"use client";

import { alertLabel } from "@/lib/alerts";
import type { CrisesFile, HelpFile } from "@/lib/data";
import { leastFunded } from "@/lib/help";
import { percent } from "@/lib/money";

interface Props {
  crises: CrisesFile;
  help: HelpFile | null;
  nameOf: (code: string) => string;
  onSelect: (code: string) => void;
}

interface Chip {
  code: string;
  label: string;
  tone: "red" | "amber" | "accent";
}

/** The same entries the desktop card shows, as one short list for a chip row. */
export function crisisChips(crises: CrisesFile, help: HelpFile | null): Chip[] {
  const chips: Chip[] = [];
  const add = (c: Chip) => {
    if (!chips.some((x) => x.code === c.code)) chips.push(c);
  };
  for (const w of crises.watching.slice(0, 2)) add({ code: w.code, label: `in ${w.editions} countries' news`, tone: "accent" });
  for (const q of crises.quiet.slice(0, 4)) {
    const a = crises.alerts.find((x) => x.id === q.alert);
    if (a) add({ code: q.code, label: alertLabel(a), tone: a.level === "Red" ? "red" : "amber" });
  }
  for (const p of leastFunded(help, 3)) add({ code: p.countries[0], label: `UN plan ${percent(p.funded!, p.required)}% funded`, tone: "accent" });
  for (const u of crises.unwatched.slice(0, 2)) add({ code: u.code, label: "emergency few are reading about", tone: "accent" });
  return chips;
}

// Phone landing: a scrollable row of chips, one per crisis, above the
// globe hint. Tapping one opens the country with its help links.
export default function CrisisStrip({ crises, help, nameOf, onSelect }: Props) {
  const chips = crisisChips(crises, help);
  if (!chips.length) return null;
  const dot = { red: "bg-red-700", amber: "bg-amber-500", accent: "bg-accent" };
  return (
    <nav aria-label="Crises" className="pointer-events-auto flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
      {chips.map((c) => (
        <button
          key={c.code}
          type="button"
          onClick={() => onSelect(c.code)}
          className="flex shrink-0 items-center gap-2 rounded-full border border-line bg-card/90 px-3 py-1.5 text-left text-xs text-ink backdrop-blur-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${dot[c.tone]}`} />
          <span className="font-medium">{nameOf(c.code)}</span>
          <span className="text-muted">{c.label}</span>
        </button>
      ))}
    </nav>
  );
}
