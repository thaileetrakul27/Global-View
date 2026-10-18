import type { UnwatchedEntry, WatchingEntry } from "@/lib/data";
import { helpLinks } from "@/lib/help";

interface Props {
  name: string;
  iso3?: string;
  watching?: WatchingEntry | null;
  unwatched?: UnwatchedEntry | null;
}

// Shown on a country's panel when the headlines suggest an emergency:
// either the world has suddenly turned to the country, or its own news is
// an emergency that almost nobody else is reading about.
export default function HelpBlock({ name, iso3, watching, unwatched }: Props) {
  if (!watching && !unwatched) return null;
  const links = helpLinks(iso3, name);
  return (
    <section aria-label="How to help" className="mt-3 rounded-lg border border-accent/40 bg-card p-4">
      <h3 className="text-xs font-medium uppercase tracking-wide text-accent">How to help</h3>
      <p className="mt-1.5 text-sm leading-snug text-ink">
        {watching
          ? `${name} is in the top stories of ${watching.editions} countries right now${
              watching.baseline !== null ? `, up from about ${Math.round(watching.baseline)}` : ""
            }, and ${Math.round(watching.share * 100)}% of those stories describe an emergency.`
          : unwatched
            ? `${unwatched.matching} of ${name}'s own ${unwatched.total} top stories describe an emergency, and ${
                unwatched.editions === 0 ? "no other country" : `only ${unwatched.editions} other ${unwatched.editions === 1 ? "country" : "countries"}`
              } has ${name} in its top stories.`
            : null}
      </p>
      <ul className="mt-3 flex flex-col gap-2">
        {links.map((l) => (
          <li key={l.url}>
            <a
              href={l.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {l.label}
            </a>
            <span className="block text-xs text-muted">{l.note}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[11px] leading-snug text-muted">
        Estimated from headlines alone. Links go to the UN and the Red Cross movement; Global View takes no donations and chooses no charities.
      </p>
    </section>
  );
}
