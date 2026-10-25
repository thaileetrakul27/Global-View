"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { Disaster } from "@/lib/data";
import { DISASTER_META } from "@/lib/disasterMeta";
import { countByType, locationLine, rankDisasters, typeCountLabel } from "@/lib/disasters";
import DisasterIcon, { SeverityChip } from "./DisasterIcon";

interface Props {
  disasters: Disaster[];
  nameOf: (code: string) => string;
  /** Open a disaster's panel by id. */
  onSelect: (id: string) => void;
  /** Whether every row shows. Held by the parent so it survives a panel opening and closing. */
  expanded: boolean;
  onExpand: (v: boolean) => void;
}

/** Rows shown before "Show all". */
const LIMIT = 8;
const ring = "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent";

// Desktop card on the disaster map: the disasters ongoing now (all
// significant or severe), by type, most severe and recent first. Clicking
// a row opens its panel. The card never runs past the bottom of the
// screen: the rows scroll, the heading and the "Show all" button stay put.
export default function DisasterList({ disasters, nameOf, onSelect, expanded, onExpand }: Props) {
  const headingId = useId();
  const listId = useId();
  const ranked = useMemo(() => rankDisasters(disasters), [disasters]);
  const counts = useMemo(() => countByType(disasters), [disasters]);
  const shown = expanded ? ranked : ranked.slice(0, LIMIT);
  const { ref: listRef, more, onScroll } = useMoreBelow(shown.length);
  if (!disasters.length) return null;

  return (
    <section
      aria-labelledby={headingId}
      className="pointer-events-auto flex max-h-[calc(100dvh-8rem)] w-80 flex-col rounded-lg border border-line bg-card/90 p-4 backdrop-blur-sm"
    >
      <div className="flex shrink-0 items-baseline justify-between gap-3">
        <h2 id={headingId} className="text-xs font-medium uppercase tracking-wide text-muted">
          Disasters now
        </h2>
        <span className="text-xs text-muted">{ranked.length} ongoing</span>
      </div>

      <ul aria-label="By type" className="mt-2 flex shrink-0 flex-wrap gap-x-3 gap-y-1">
        {counts.map((c) => (
          <li key={c.type} className="flex items-center gap-1 text-xs text-muted">
            <DisasterIcon type={c.type} size={14} />
            {typeCountLabel(c)}
          </li>
        ))}
      </ul>

      {/* Fades out at the bottom while more rows are hidden below. */}
      <ol
        id={listId}
        ref={listRef}
        onScroll={onScroll}
        className={`mt-2 min-h-0 flex-1 divide-y divide-line overflow-y-auto overscroll-contain border-t border-line pr-1 ${
          more ? "[mask-image:linear-gradient(to_bottom,black_calc(100%-2rem),transparent)]" : ""
        }`}
      >
        {shown.map((d) => (
          <li key={d.id}>
            <DisasterRow disaster={d} nameOf={nameOf} onSelect={onSelect} />
          </li>
        ))}
      </ol>

      {ranked.length > LIMIT && (
        <div className="mt-1 shrink-0 border-t border-line pt-3">
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={listId}
            onClick={() => onExpand(!expanded)}
            className={`text-xs font-medium text-accent hover:underline ${ring}`}
          >
            {expanded ? "Show fewer" : `Show all ${ranked.length}`}
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * Whether a scrolling list has rows hidden below its bottom edge, kept up
 * to date as it scrolls, resizes or changes length.
 */
function useMoreBelow(length: number) {
  const ref = useRef<HTMLOListElement>(null);
  const [more, setMore] = useState(false);
  const onScroll = useCallback(() => {
    const el = ref.current;
    if (el) setMore(el.scrollTop + el.clientHeight < el.scrollHeight - 2);
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(onScroll);
    ro.observe(el);
    return () => ro.disconnect();
  }, [onScroll, length]);
  return { ref, more, onScroll };
}

/**
 * One disaster: icon, title, where, and a severity chip when it is
 * significant or severe. Also the rows of a country's disasters.
 */
export function DisasterRow({ disaster: d, nameOf, onSelect }: { disaster: Disaster; nameOf: (code: string) => string; onSelect: (id: string) => void }) {
  const where = locationLine(d, nameOf, { places: 1, countries: 2 });
  return (
    <button
      type="button"
      data-disaster-id={d.id}
      onClick={() => onSelect(d.id)}
      className={`flex w-full items-start gap-2.5 py-2 text-left text-ink hover:text-accent ${ring}`}
    >
      <DisasterIcon type={d.type} size={16} className="mt-1 shrink-0" title={DISASTER_META[d.type].label} />
      <span className="min-w-0 flex-1">
        <span className="block font-serif text-[0.95rem] leading-snug">{d.title}</span>
        <span className="mt-0.5 flex items-center gap-2 text-xs text-muted">
          <span className="min-w-0 truncate">{where || DISASTER_META[d.type].label}</span>
          {d.severity >= 2 && <SeverityChip severity={d.severity} />}
        </span>
      </span>
    </button>
  );
}
