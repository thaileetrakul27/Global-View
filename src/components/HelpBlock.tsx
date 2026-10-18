import { alertDate, alertLabel } from "@/lib/alerts";
import type { Lead } from "@/lib/crisis";
import type { CountryNeed } from "@/lib/data";
import { donationLinks, type Need } from "@/lib/help";
import { count, money, percent } from "@/lib/money";
import { needPages, needSentence, needSource } from "@/lib/needs";

interface Props {
  name: string;
  iso3?: string;
  need: Need;
  /** The biggest thing happening, or null when nothing names the country. */
  lead: Lead | null;
  /** Long-term needs from the latest UN figures, most severe first. */
  needs: CountryNeed[];
}

const link = "font-medium text-ink underline decoration-line underline-offset-2 hover:decoration-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent";
const give = "text-sm font-medium text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent";
const heading = "mt-3 text-[11px] font-medium uppercase tracking-wide text-muted";
const dot = (severity: string | null) => (severity === "Red" ? "bg-red-700" : severity === "Orange" ? "bg-amber-500" : "bg-line");

// Every country's "How to help": the biggest crisis right now in the
// source's own words, the long-term needs the UN's figures show, the
// official donation pages for them, and anything else that names the
// country. Countries with none of these still get their donation pages,
// with a line saying so.
export default function HelpBlock({ name, iso3, need, lead, needs }: Props) {
  const donations = donationLinks(need.society, need.uncr, name);
  const agencies = needPages(needs);
  const sev = (s: number) => (s >= 1 ? "bg-red-700" : s >= 0.5 ? "bg-amber-500" : "bg-line");
  const funded = (f: number, r: number) => (r > 0 && f >= r ? "fully funded" : `${percent(f, r)}% funded`);
  // Everything else, minus the item shown as the lead.
  const otherAlerts = need.alerts.filter((a) => !(lead?.kind === "alert" && lead.url === a.url));
  const otherAppeals = need.appeals.filter((a) => !(lead?.kind === "appeal" && lead.url === a.url));
  const otherPlans = need.plans.filter((p) => !(lead?.kind === "plan" && lead.url === p.url));
  const others = otherAlerts.length + otherAppeals.length + otherPlans.length;
  return (
    <section aria-label="How to help" className={`mt-3 rounded-lg border bg-card p-4 ${lead || needs.length ? "border-accent/40" : "border-line"}`}>
      <h3 className="text-xs font-medium uppercase tracking-wide text-accent">How to help</h3>

      {lead ? (
        <div className="mt-2">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Biggest crisis right now</p>
          <p className="mt-1 flex items-start gap-2 font-serif text-[1.05rem] leading-snug text-ink">
            {lead.severity && <span aria-hidden="true" className={`mt-2 h-2 w-2 shrink-0 rounded-full ${dot(lead.severity)}`} />}
            {lead.url ? (
              <a href={lead.url} target="_blank" rel="noopener noreferrer" className="underline decoration-line underline-offset-2 hover:decoration-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                {lead.title}
              </a>
            ) : (
              <span>{lead.title}</span>
            )}
          </p>
          {lead.summary && <p className="mt-1.5 text-sm leading-snug text-ink/90">{lead.summary}</p>}
          {lead.figures.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
              {lead.figures.map((f) => (
                <li key={f.label} className="text-xs text-muted">
                  <span className="font-medium text-ink">{f.number}</span> {f.label}
                  {f.source ? ` (${f.source})` : ""}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1.5 text-xs text-muted">
            {lead.funding ? `${lead.funding} · ` : ""}
            {lead.severity && lead.kind !== "alert" ? `${lead.severity} emergency · ` : ""}
            {lead.source}
          </p>
        </div>
      ) : (
        <p className="mt-1.5 text-sm leading-snug text-ink">
          No disaster alert, Red Cross appeal or UN response plan names {name} right now.
          {needs.length ? " The latest UN figures do show long-term needs." : " These pages take donations at any time."}
        </p>
      )}

      {needs.length > 0 && (
        <>
          <p className={heading}>Long-term needs</p>
          <ul className="mt-1 flex flex-col gap-1.5">
            {needs.map((n) => (
              <li key={n.key} className="flex items-start gap-2 text-sm leading-snug">
                <span aria-hidden="true" className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${sev(n.severity)}`} />
                <span>
                  <span className="text-ink">{needSentence(n)}</span>
                  <span className="block text-xs text-muted">{needSource(n)}</span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      <p className={heading}>Official donation pages</p>
      <ul className="mt-1 flex flex-col gap-2">
        {[...donations, ...agencies].map((l) => (
          <li key={l.url}>
            <a href={l.url} target="_blank" rel="noopener noreferrer" className={give}>
              {l.label}
            </a>
            <span className="block text-xs text-muted">{l.note}</span>
          </li>
        ))}
        {iso3 && (
          <li>
            <a href={`https://reliefweb.int/country/${iso3.toLowerCase()}`} target="_blank" rel="noopener noreferrer" className={give}>
              ReliefWeb: {name}
            </a>
            <span className="block text-xs text-muted">{"Not a donation page: the UN's situation reports and who is responding, for checking before you give."}</span>
          </li>
        )}
      </ul>

      {others > 0 && (
        <>
          <p className={heading}>Also happening</p>
          <ul className="mt-1 flex flex-col gap-2">
            {otherAlerts.map((a) => (
              <li key={a.id} className="flex items-start gap-2 text-sm leading-snug">
                <span aria-hidden="true" className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot(a.level)}`} />
                <span>
                  <a href={a.url} target="_blank" rel="noopener noreferrer" className={link}>
                    {alertLabel(a)}
                    {a.name ? `: ${a.name}` : ""}
                  </a>
                  <span className="block text-xs text-muted">
                    Since {alertDate(a.from)}
                    {a.countries.length > 1 ? ` · covers ${a.countries.length} countries` : ""} · GDACS
                  </span>
                </span>
              </li>
            ))}
            {otherAppeals.map((a) => (
              <li key={a.code} className="text-sm leading-snug">
                <a href={a.url} target="_blank" rel="noopener noreferrer" className={link}>
                  {a.name}
                </a>
                <span className="block text-xs text-muted">
                  {a.kind} · {a.disaster}
                  {a.requested > 0 ? ` · ${money(a.requested, "CHF")} asked, ${funded(a.funded, a.requested)}` : ""}
                  {a.people ? ` · for ${count(a.people)} people` : ""} · IFRC
                </span>
              </li>
            ))}
            {otherPlans.map((p) => (
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

      <p className="mt-3 text-[11px] leading-snug text-muted">
        Crises come from IFRC, UN OCHA and GDACS, long-term needs from UN figures via the World Bank, and donation pages from a fixed list of UN and Red
        Cross pages. Global View chooses no charities and takes no donations.
      </p>
    </section>
  );
}
