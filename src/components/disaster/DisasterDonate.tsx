import { useId } from "react";
import type { Disaster, DonationLink } from "@/lib/data";
import { donationNote, donationSources, groupDonations, isDirect, type DonationGroupKey } from "@/lib/disasters";
import { External, ExternalIcon, ring, textLink } from "./External";

const UN_CRISIS_RELIEF = "https://crisisrelief.un.org/";

/** Groups about this disaster itself: always named, and in the accent colour. */
const OWN_GROUPS: ReadonlySet<DonationGroupKey> = new Set(["direct", "event"]);

// Where to donate, first in the panel and large enough to tap. Pages that
// give directly to the people affected come first under "Directly to
// people affected" (GoFundMe's verified fundraisers, GlobalGiving and
// vetted partner projects, charities' and local groups' own pages), each
// saying who checked it. Then official pages for this disaster itself (its
// IFRC appeal, checked pages researched for it) under "For this disaster",
// and the general pages grouped by who runs them. Only https pages reach
// the page; with none left, UN Crisis Relief's general fund.
export default function DisasterDonate({ disaster: d }: { disaster: Disaster }) {
  const id = useId();
  const groups = groupDonations(d.donate);
  const sources = donationSources(groups);
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
            {/* This disaster's own pages are always named; other groups only when there are several. */}
            {(OWN_GROUPS.has(g.key) || groups.length > 1) && (
              <p className={`text-[11px] font-medium uppercase tracking-wide ${OWN_GROUPS.has(g.key) ? "text-accent" : "text-muted"}`}>{g.label}</p>
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
        {sources && ` ${sources}`}
      </p>
    </section>
  );
}

/**
 * One donation page as a whole-row link: who runs it, what it is for, and
 * a note. A direct page's note says who checked it (for a charity or local
 * group, that Global View could not vouch for it); an official page found
 * by research says so.
 */
function DonationRow({ link }: { link: DonationLink }) {
  const label = link.label.trim();
  const showLabel = label && label.toLowerCase() !== link.org.trim().toLowerCase();
  const note = donationNote(link);
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
        {note && <span className="mt-0.5 block text-xs leading-snug text-muted">{note}</span>}
        {link.via === "research" && !isDirect(link) && (
          <span className="mt-1 block text-[11px] text-muted">Found by research and checked as an official page</span>
        )}
      </span>
      <ExternalIcon className="mt-0.5 shrink-0 text-muted group-hover:text-accent" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}
