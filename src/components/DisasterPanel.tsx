"use client";

import { useEffect, useRef, type ReactNode } from "react";
import type { Disaster } from "@/lib/data";
import { DISASTER_META } from "@/lib/disasterMeta";
import { sinceLine } from "@/lib/disasters";
import DisasterIcon, { SeverityChip } from "./DisasterIcon";
import DisasterDonate from "./disaster/DisasterDonate";
import DisasterHappening from "./disaster/DisasterHappening";
import { CountryChips, DisasterSources, DisasterWhere } from "./disaster/DisasterDetails";
import { External, ring, textLink } from "./disaster/External";

interface Props {
  disaster: Disaster;
  nameOf: (code: string) => string;
  onClose: () => void;
  /** Open a country's own panel. */
  onSelectCountry: (code: string) => void;
  /** Extra header buttons (such as a copy-link button), shown before Close. */
  actions?: ReactNode;
}

// One disaster: the pages to donate to come first, then what is
// happening, where, and the sources. The map draws its footprint; this
// panel is what opens when the footprint or its marker is clicked.
export default function DisasterPanel({ disaster, nameOf, onClose, onSelectCountry, actions }: Props) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Header disaster={disaster} nameOf={nameOf} onClose={onClose} onSelectCountry={onSelectCountry} actions={actions} />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 sm:px-6">
        <DisasterDonate disaster={disaster} />
        <DisasterHappening disaster={disaster} />
        <DisasterWhere disaster={disaster} nameOf={nameOf} onSelectCountry={onSelectCountry} />
        <DisasterSources disaster={disaster} />
      </div>
      <footer className="border-t border-line px-5 py-3 text-xs text-muted sm:px-6">
        Data: GDACS, USGS, NASA EONET, IFRC GO, news reports. Places ©{" "}
        <External href="https://www.openstreetmap.org/copyright" className={textLink}>
          OpenStreetMap contributors
        </External>
        .
      </footer>
    </div>
  );
}

// Type, severity and title, plus (on wider screens) the dates and the
// countries it touches; in the phone sheet those move below Donate so the
// donation pages show at the sheet's first height. Focus moves to the title
// when a new disaster opens, for keyboard users.
function Header({ disaster: d, nameOf, onClose, onSelectCountry, actions }: Props) {
  const meta = DISASTER_META[d.type];
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, [d.id]);

  return (
    <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3 sm:px-6 md:pt-7">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted">
          <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md" style={{ backgroundColor: `${meta.light}66` }}>
            <DisasterIcon type={d.type} size={16} />
          </span>
          {meta.label}
          <SeverityChip severity={d.severity} className="normal-case tracking-normal" />
        </p>
        <h2 ref={titleRef} tabIndex={-1} className="mt-2 font-serif text-xl leading-tight tracking-tight break-words text-ink focus:outline-none sm:text-2xl">
          {d.title}
        </h2>
        <div className="max-md:hidden">
          <p className="mt-2 text-xs text-muted">{sinceLine(d)}</p>
          <CountryChips disaster={d} nameOf={nameOf} onSelectCountry={onSelectCountry} className="mt-2" />
        </div>
      </div>
      <div className="-mr-1.5 -mt-1.5 flex shrink-0 items-start">
        {actions}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close disaster"
          className={`grid h-10 w-10 shrink-0 place-items-center rounded-md text-muted hover:bg-card hover:text-ink ${ring}`}
        >
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </div>
    </div>
  );
}
