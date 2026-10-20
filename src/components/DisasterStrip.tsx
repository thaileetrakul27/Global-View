"use client";

import { useMemo } from "react";
import type { Disaster } from "@/lib/data";
import { DISASTER_META, SEVERITY_LABEL } from "@/lib/disasterMeta";
import { isMinor, locationLine, rankDisasters, shortTitle } from "@/lib/disasters";
import DisasterIcon from "./DisasterIcon";

interface Props {
  disasters: Disaster[];
  nameOf: (code: string) => string;
  /** Open a disaster's panel by id. */
  onSelect: (id: string) => void;
  /** Whether minor disasters are listed and drawn too. */
  showMinor: boolean;
  onShowMinor: (v: boolean) => void;
}

// Phones, on the disaster map: a sideways-scrolling row of chips, one per
// significant or severe disaster (this is the phone's only list), most
// severe and recent first, and a last chip that adds the minor ones.
// Tapping a disaster opens its panel with where to donate.
export default function DisasterStrip({ disasters, nameOf, onSelect, showMinor, onShowMinor }: Props) {
  const minor = useMemo(() => disasters.filter(isMinor).length, [disasters]);
  const top = useMemo(() => rankDisasters(showMinor ? disasters : disasters.filter((d) => !isMinor(d))), [disasters, showMinor]);
  if (!disasters.length) return null;
  return (
    <nav aria-label="Disasters now" className="pointer-events-auto flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
      {top.map((d) => {
        const where = locationLine(d, nameOf);
        return (
          <button
            key={d.id}
            type="button"
            data-disaster-id={d.id}
            onClick={() => onSelect(d.id)}
            title={where ? `${d.title} · ${where}` : d.title}
            className={`flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border bg-card/90 px-3 py-2.5 text-left text-xs text-ink backdrop-blur-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
              d.severity === 3 ? "border-red-300" : "border-line"
            }`}
          >
            <DisasterIcon type={d.type} size={14} className="shrink-0" />
            <span className="font-medium whitespace-nowrap">{shortTitle(d.title, 28)}</span>
            <span className="sr-only">
              , {SEVERITY_LABEL[d.severity]} {DISASTER_META[d.type].label.toLowerCase()}
              {where ? `, ${where}` : ""}
            </span>
          </button>
        );
      })}
      {minor > 0 && (
        <button
          type="button"
          aria-pressed={showMinor}
          onClick={() => onShowMinor(!showMinor)}
          className="flex min-h-11 shrink-0 items-center rounded-full border border-dashed border-line bg-card/90 px-3 py-2.5 text-xs text-muted backdrop-blur-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {showMinor ? "Hide minor" : `+${minor} minor`}
        </button>
      )}
    </nav>
  );
}
