"use client";

interface Props {
  /** Available days, oldest first. */
  dates: string[];
  /** Selected day, or null for now. */
  date: string | null;
  onChange: (date: string | null) => void;
}

function label(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

// Step through the archive of daily snapshots. "Now" is the live data.
export default function TimeControl({ dates, date, onChange }: Props) {
  if (dates.length < 1) return null;
  const idx = date ? dates.indexOf(date) : dates.length; // dates.length means "now"
  const prev = idx > 0 ? dates[idx - 1] : null;
  const next = idx < dates.length - 1 ? dates[idx + 1] : idx === dates.length - 1 ? "now" : null;
  const btn = "rounded-md px-2 py-1 text-muted hover:text-ink disabled:opacity-30 disabled:hover:text-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent";
  return (
    <div className="pointer-events-auto flex items-center gap-1 rounded-lg border border-line bg-card/90 px-1 py-0.5 text-sm backdrop-blur-sm" role="group" aria-label="Day">
      <button type="button" className={btn} aria-label="Earlier day" disabled={!prev} onClick={() => prev && onChange(prev)}>
        ‹
      </button>
      <span className="min-w-[8.5rem] text-center text-ink">{date ? label(date) : "Now"}</span>
      <button
        type="button"
        className={btn}
        aria-label="Later day"
        disabled={!next}
        onClick={() => next && onChange(next === "now" ? null : next)}
      >
        ›
      </button>
      {date && (
        <button type="button" className={`${btn} text-xs`} onClick={() => onChange(null)}>
          Now
        </button>
      )}
    </div>
  );
}
