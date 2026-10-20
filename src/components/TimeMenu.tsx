"use client";

import { useEffect, useRef, useState } from "react";
import TimeControl, { dayLabel } from "./TimeControl";

interface Props {
  /** Available days, oldest first. */
  dates: string[];
  /** Selected day, or null for now. */
  date: string | null;
  onChange: (date: string | null) => void;
}

// Phones: the day pager folded into a small button beside the search box.
// The button names the day while a past one is shown; Escape or a tap
// elsewhere closes it.
export default function TimeMenu({ dates, date, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    // Handled before the page's own Escape, which would close a panel.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setOpen(false);
      ref.current?.querySelector("button")?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  if (dates.length < 1) return null;
  const short = date ? dayLabel(date).replace(/ \d{4}$/, "") : null;
  return (
    <div ref={ref} className="pointer-events-auto relative shrink-0">
      <button
        type="button"
        aria-expanded={open}
        aria-label={date ? `Showing ${dayLabel(date)}. Choose a day` : "Choose a day"}
        onClick={() => setOpen((v) => !v)}
        className={`flex h-11 items-center gap-1.5 rounded-lg border bg-card px-3 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
          date ? "border-accent text-accent" : "border-line text-muted"
        }`}
      >
        <svg aria-hidden width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
        {short}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-2">
          <TimeControl dates={dates} date={date} onChange={onChange} />
        </div>
      )}
    </div>
  );
}
