import { useId } from "react";
import type { Disaster, DonationLink } from "@/lib/data";
import { groupDonations } from "@/lib/disasters";
import { External, ExternalIcon, ring, textLink } from "./External";

const UN_CRISIS_RELIEF = "https://crisisrelief.un.org/";

// The official donation pages, first in the panel and large enough to tap.
// Pages for this disaster itself (its IFRC appeal, checked pages researched
// for it) come first under "For this disaster"; the general pages follow,
// grouped by who runs them. Only https pages reach the page; with none
// left, UN Crisis Relief's general fund.
export default function DisasterDonate({ disaster: d }: { disaster: Disaster }) {
  const id = useId();
  const groups = groupDonations(d.donate);
  return (
    <section aria-labelledby={id} className="mt-1 rounded-lg border border-accent/40 bg-card p-4">
      <h3 id={id} className="text-sm font-semibold uppercase tracking-wide text-accent">
        Donate
      </h3>
      {groups.length === 0 ? (
        <p className="mt-1.5 text-sm leading-snug text-ink">
          No official donation page is listed for this disaster yet.{" "}
          <External href={UN_CRISIS_RELIEF} className={`font-medium text-accent ${textLink}`}>
            UN Crisis Relief
          </External>{" "}
          takes donations for current emergencies.
        </p>
      ) : (
        groups.map((g) => (
          <div key={g.key} className="mt-2.5">
            {/* The event's own pages are always named; other groups only when there are several. */}
            {(g.key === "event" || groups.length > 1) && (
              <p className={`text-[11px] font-medium uppercase tracking-wide ${g.key === "event" ? "text-accent" : "text-muted"}`}>{g.label}</p>
            )}
            <ul className="mt-1.5 flex flex-col gap-2">
              {g.links.map((l) => (
                <li key={l.url}>
                  <DonationRow link={l} />
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
      <p className="mt-3 text-[11px] leading-snug text-muted">
        Global View takes no donations and chooses no charities.
        {groups.length > 0 && " These pages come from the Red Cross and UN registries, or are official pages checked against an allowlist."}
      </p>
    </section>
  );
}

/** One donation page as a whole-row link: who runs it, what it is for, and a note. */
function DonationRow({ link }: { link: DonationLink }) {
  const label = link.label.trim();
  const showLabel = label && label.toLowerCase() !== link.org.trim().toLowerCase();
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      className={`group flex min-h-12 items-start gap-3 rounded-md border border-line bg-card px-3 py-2.5 hover:border-accent hover:bg-accent/5 ${ring}`}
    >
      <span className="min-w-0 flex-1 break-words">
        <span className="block text-sm font-semibold text-ink">{link.org}</span>
        {showLabel && <span className="block text-sm text-accent group-hover:underline">{label}</span>}
        {link.note && <span className="mt-0.5 block text-xs leading-snug text-muted">{link.note}</span>}
        {link.via === "research" && <span className="mt-1 block text-[11px] text-muted">Found by research and checked as an official page</span>}
      </span>
      <ExternalIcon className="mt-0.5 shrink-0 text-muted group-hover:text-accent" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}
