import { alertDate, alertLabel } from "@/lib/alerts";
import type { Alert } from "@/lib/data";
import { helpLinks, type Need } from "@/lib/help";
import { count, money, percent } from "@/lib/money";

interface Props {
  name: string;
  iso3?: string;
  need: Need;
}

const link = "font-medium text-ink underline decoration-line underline-offset-2 hover:decoration-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent";
const heading = "mt-3 text-[11px] font-medium uppercase tracking-wide text-muted";

// Shown on a country's panel when something names it: a GDACS disaster
// alert, a Red Cross or Red Crescent appeal, a UN response plan, or the
// headlines (the world has turned to it, or its own news is an emergency
// nobody else is reading about). Lists what is happening, what each
// response needs, and where to give.
export default function HelpBlock({ name, iso3, need }: Props) {
  if (!need.any) return null;
  const { alerts, appeals, plans, watching, unwatched } = need;
  const links = helpLinks(iso3, name, need.society);
  const dot = (a: Alert) => (a.level === "Red" ? "bg-red-700" : "bg-amber-500");
  const funded = (f: number, r: number) => (r > 0 && f >= r ? "fully funded" : `${percent(f, r)}% funded`);
  return (
    <section aria-label="How to help" className="mt-3 rounded-lg border border-accent/40 bg-card p-4">
      <h3 className="text-xs font-medium uppercase tracking-wide text-accent">How to help</h3>

      {alerts.length > 0 && (
        <>
          <p className={heading}>Disaster alerts</p>
          <ul className="mt-1 flex flex-col gap-2">
            {alerts.map((a) => (
              <li key={a.id} className="flex items-start gap-2 text-sm leading-snug">
                <span aria-hidden="true" className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot(a)}`} />
                <span>
                  <a href={a.url} target="_blank" rel="noopener noreferrer" className={link}>
                    {alertLabel(a)}
                    {a.name ? `: ${a.name}` : ""}
                  </a>
                  {a.description && <span className="block text-xs text-ink/80">{a.description}</span>}
                  <span className="block text-xs text-muted">
                    Since {alertDate(a.from)}
                    {a.countries.length > 1 ? ` · covers ${a.countries.length} countries` : ""} · GDACS
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {appeals.length > 0 && (
        <>
          <p className={heading}>Red Cross and Red Crescent appeals</p>
          <ul className="mt-1 flex flex-col gap-2">
            {appeals.map((a) => (
              <li key={a.code} className="text-sm leading-snug">
                <a href={a.url} target="_blank" rel="noopener noreferrer" className={link}>
                  {a.name}
                </a>
                <span className="block text-xs text-muted">
                  {a.kind} · {a.disaster}
                  {a.requested > 0 ? ` · ${money(a.requested, "CHF")} asked, ${funded(a.funded, a.requested)}` : ""}
                  {a.people ? ` · for ${count(a.people)} people` : ""} · to {alertDate(a.end)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {plans.length > 0 && (
        <>
          <p className={heading}>UN response plans</p>
          <ul className="mt-1 flex flex-col gap-2">
            {plans.map((p) => (
              <li key={p.id} className="text-sm leading-snug">
                <a href={p.url} target="_blank" rel="noopener noreferrer" className={link}>
                  {p.name}
                </a>
                <span className="block text-xs text-muted">
                  {money(p.required, "USD")} needed{p.funded !== null ? `, ${funded(p.funded, p.required)}` : ""}
                  {p.countries.length > 1 ? ` · covers ${p.countries.length} countries` : ""} · UN OCHA
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {(watching || unwatched) && (
        <p className="mt-3 text-sm leading-snug text-ink">
          {watching
            ? `${name} is in the top stories of ${watching.editions} countries right now${
                watching.baseline !== null ? `, up from about ${Math.round(watching.baseline)}` : ""
              }, and ${Math.round(watching.share * 100)}% of those stories describe an emergency.`
            : unwatched
              ? `${unwatched.matching} of ${name}'s own ${unwatched.total} top stories describe an emergency, and ${
                  unwatched.editions === 0 ? "no other country" : `only ${unwatched.editions} other ${unwatched.editions === 1 ? "country" : "countries"}`
                } has ${name} in its top stories.`
              : null}
          {!alerts.length && !appeals.length && !plans.length ? ` No disaster alert, appeal or UN plan names ${name}, so this signal comes from headlines alone.` : ""}
        </p>
      )}

      <p className={heading}>Where to give</p>
      <ul className="mt-1 flex flex-col gap-2">
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
        Alerts come from GDACS, appeals and societies from IFRC, plans from UN OCHA; the attention signal is estimated from headlines. Global View takes no
        donations and chooses no charities.
      </p>
    </section>
  );
}
