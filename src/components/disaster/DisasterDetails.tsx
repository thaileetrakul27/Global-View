import { useId } from "react";
import type { Disaster, DisasterSource } from "@/lib/data";
import { centreLabel, coordText, locationLine, placeDetail, shortDate, sinceLine } from "@/lib/disasters";
import { External, heading, ring, textLink } from "./External";

const SOURCE_NAME: Record<DisasterSource, string> = {
  gdacs: "GDACS",
  usgs: "USGS",
  eonet: "NASA EONET",
  ifrc: "IFRC GO",
  news: "news reports",
};

/** "typhoon warning" -> "Typhoon warning". */
const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** One button per country the disaster touches, each opening that country's stories. */
export function CountryChips({
  disaster: d,
  nameOf,
  onSelectCountry,
  className = "",
}: {
  disaster: Disaster;
  nameOf: (code: string) => string;
  onSelectCountry: (code: string) => void;
  className?: string;
}) {
  if (!d.countries.length) return null;
  return (
    <ul aria-label="Countries affected" className={`-mx-0.5 flex flex-wrap gap-1.5 p-0.5 ${className}`}>
      {d.countries.map((code) => (
        <li key={code} className="shrink-0">
          <button
            type="button"
            onClick={() => onSelectCountry(code)}
            aria-label={`${nameOf(code)}: open its top stories`}
            // 36 px tall on touch screens, compact with a mouse.
            className={`rounded-full border border-line bg-card px-3 py-2 text-xs whitespace-nowrap text-ink hover:border-accent hover:text-accent md:px-2.5 md:py-1 ${ring}`}
          >
            {nameOf(code)}
          </button>
        </li>
      ))}
    </ul>
  );
}

// The affected places with what happened there. When only the country is
// known the location is flagged as approximate. In the phone sheet the
// dates and country buttons live here, below Donate, so Donate shows first.
export function DisasterWhere({
  disaster: d,
  nameOf,
  onSelectCountry,
}: {
  disaster: Disaster;
  nameOf: (code: string) => string;
  onSelectCountry: (code: string) => void;
}) {
  const id = useId();
  const approximate = d.precision === "country";
  const fallback = locationLine(d, nameOf, { countries: 50 });
  return (
    <section aria-labelledby={id} className="mt-6">
      <h3 id={id} className={heading}>
        Where
      </h3>
      <div className="md:hidden">
        <p className="mt-2 text-xs text-muted">{sinceLine(d)}</p>
        <CountryChips disaster={d} nameOf={nameOf} onSelectCountry={onSelectCountry} className="mt-2" />
      </div>
      {approximate && (
        <p className="mt-2 rounded-md border border-line bg-paper px-3 py-2 text-xs leading-snug text-muted">
          Approximate location: only the country is known so far.
        </p>
      )}
      {d.places.length > 0 ? (
        <ul className="mt-1 divide-y divide-line">
          {d.places.map((p, i) => {
            const detail = placeDetail(p, nameOf);
            return (
              <li key={`${p.name}-${i}`} className="py-2">
                <p className="text-sm font-medium text-ink">{p.name}</p>
                {detail && <p className="text-xs text-muted">{detail}</p>}
                {p.impact && <p className="mt-0.5 text-sm leading-snug text-ink/80">{capitalise(p.impact)}</p>}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-ink">{fallback || "No affected places named yet."}</p>
      )}
      {d.precision === "exact" && (
        <p className="mt-2 text-xs text-muted">
          {centreLabel(d.type)}: {coordText(d.lat, d.lng)}
        </p>
      )}
    </section>
  );
}

// Every source the disaster was built from, and which feeds reported it.
export function DisasterSources({ disaster: d }: { disaster: Disaster }) {
  const id = useId();
  const reported = [...new Set(d.reportedBy.map((s) => SOURCE_NAME[s] ?? s))];
  if (!d.sources.length && !reported.length) return null;
  return (
    <section aria-labelledby={id} className="mt-6">
      <h3 id={id} className={heading}>
        Sources
      </h3>
      {d.sources.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1.5">
          {d.sources.map((s, i) => (
            <li key={`${s.url}-${i}`} className="text-sm text-ink">
              <External href={s.url} className={textLink}>
                {s.name}
              </External>
            </li>
          ))}
        </ul>
      )}
      {reported.length > 0 && <p className="mt-2 text-xs text-muted">Reported by {reported.join(", ")}.</p>}
      {d.research && <p className="mt-1 text-xs text-muted">Some places and pages were found by web research on {shortDate(d.research.at)}.</p>}
    </section>
  );
}
