import { useId } from "react";
import type { Disaster } from "@/lib/data";
import { appealFunding, shortDate } from "@/lib/disasters";
import { External, heading, textLink } from "./External";

// The summary in its source's words, the reported figures, and any Red
// Cross appeal with how much of it is funded.
export default function DisasterHappening({ disaster: d }: { disaster: Disaster }) {
  const id = useId();
  if (!d.summary && !d.severityText && !d.figures.length && !d.appeals.length) return null;
  return (
    <section aria-labelledby={id} className="mt-6">
      <h3 id={id} className={heading}>
        {"What's happening"}
      </h3>
      {d.severityText && <p className="mt-2 text-sm font-medium text-ink">{d.severityText}</p>}
      {d.summary && (
        <p className="mt-1.5 text-[0.95rem] leading-relaxed text-ink">
          {d.summary}
          {d.summarySource && (
            <span className="text-xs text-muted">
              {" "}
              Source:{" "}
              <External href={d.summarySource.url} className={textLink}>
                {d.summarySource.name}
              </External>
            </span>
          )}
        </p>
      )}
      {d.figures.length > 0 && (
        <ul className="mt-3 grid grid-cols-2 gap-2">
          {d.figures.map((f, i) => (
            <li key={`${f.label}-${i}`} className="rounded-md border border-line bg-card px-3 py-2">
              <span className="block text-lg leading-tight font-semibold text-ink">{f.value}</span>
              <span className="block text-xs leading-snug text-ink/80">{f.label}</span>
              <span className="mt-0.5 block text-[11px] text-muted">
                <External href={f.sourceUrl} className={textLink}>
                  {f.sourceName}
                </External>
              </span>
            </li>
          ))}
        </ul>
      )}
      {d.appeals.length > 0 && <Appeals disaster={d} />}
    </section>
  );
}

/** IFRC operations for this disaster, each with a bar of funded against requested (Swiss francs). */
function Appeals({ disaster: d }: { disaster: Disaster }) {
  return (
    <>
      <p className="mt-4 text-[11px] font-medium uppercase tracking-wide text-muted">Red Cross appeals</p>
      <ul className="mt-1.5 flex flex-col gap-2">
        {d.appeals.map((a) => {
          const f = appealFunding(a);
          const end = shortDate(a.end);
          return (
            <li key={a.code} className="rounded-md border border-line bg-card px-3 py-2.5">
              <External href={a.url} className={`text-sm font-medium text-ink ${textLink}`}>
                {a.name}
              </External>
              <p className="mt-0.5 text-xs text-muted">
                IFRC {a.kind} {a.code}
                {end ? ` · until ${end}` : ""}
              </p>
              {f.percent !== null && (
                <div aria-hidden="true" className="mt-2 h-1.5 overflow-hidden rounded-full bg-line">
                  <div className="h-full rounded-full bg-accent" style={{ width: `${f.percent}%` }} />
                </div>
              )}
              <p className="mt-1 text-xs text-ink">
                {f.text}
                {f.percent !== null && f.percent < 100 ? ` (${f.percent}%)` : ""}
              </p>
            </li>
          );
        })}
      </ul>
    </>
  );
}
