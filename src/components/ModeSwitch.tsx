"use client";

import type { MapMode } from "@/lib/urlState";

interface Props {
  mode: MapMode;
  onChange: (mode: MapMode) => void;
}

const LABEL: Record<MapMode, string> = { news: "News", disasters: "Disasters" };

// The two maps the globe can show, one at a time: the news (what each
// country reads and who reads about whom) or the disasters happening now.
export default function ModeSwitch({ mode, onChange }: Props) {
  return (
    <div role="group" aria-label="Map" className="pointer-events-auto inline-flex shrink-0 rounded-full border border-line bg-card/90 p-0.5 text-sm backdrop-blur-sm">
      {(["news", "disasters"] as const).map((m) => (
        <button
          key={m}
          type="button"
          aria-pressed={mode === m}
          onClick={() => onChange(m)}
          className={`min-h-8 rounded-full px-3.5 py-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
            mode === m ? "bg-ink text-paper" : "text-muted hover:text-ink"
          }`}
        >
          {LABEL[m]}
        </button>
      ))}
    </div>
  );
}
