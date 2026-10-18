// Picks the one thing that matters most in a country right now, from
// everything that names it, and describes it in the source's own words.
import { alertLabel } from "./alerts";
import type { Alert, Appeal, Emergency, HelpFile, Plan } from "./data";
import type { Need } from "./help";
import { money, percent } from "./money";

export interface Lead {
  kind: "appeal" | "plan" | "alert" | "news";
  title: string;
  /** Where the title links: the IFRC emergency, the UN plan, or the GDACS report. */
  url: string | null;
  /** Who describes it. */
  source: string;
  summary: string | null;
  figures: { number: string; label: string; source: string | null }[];
  /** "CHF 50M asked, 37% funded" style line, when money is involved. */
  funding: string | null;
  /** Red, Orange or Yellow as the source grades it. */
  severity: string | null;
}

const SEVERITY: Record<string, number> = { Red: 3, Orange: 2, Yellow: 1 };

function fundingLine(funded: number | null, required: number, currency: "USD" | "CHF"): string | null {
  if (required <= 0) return null;
  const asked = `${money(required, currency)} ${currency === "CHF" ? "asked" : "needed"}`;
  if (funded === null) return asked;
  return `${asked}, ${funded >= required ? "fully funded" : `${percent(funded, required)}% funded`}`;
}

function fromAppeal(a: Appeal, e: Emergency | undefined): Lead {
  return {
    kind: "appeal",
    title: e?.name ?? a.name,
    url: a.url,
    source: "IFRC",
    summary: e?.summary ?? null,
    figures: e?.figures ?? [],
    funding: fundingLine(a.funded, a.requested, "CHF"),
    severity: e?.severity ?? null,
  };
}

function fromPlan(p: Plan): Lead {
  return { kind: "plan", title: p.name, url: p.url, source: "UN OCHA", summary: null, figures: [], funding: fundingLine(p.funded, p.required, "USD"), severity: null };
}

function fromAlert(a: Alert): Lead {
  return {
    kind: "alert",
    title: `${alertLabel(a)}${a.name ? `: ${a.name}` : ""}`,
    url: a.url,
    source: "GDACS",
    summary: a.description,
    figures: [],
    funding: null,
    severity: a.level,
  };
}

/**
 * Scores every item that names the country and returns the top one.
 * Graded severity counts most, then the size of the response, so a Red
 * IFRC emergency outranks a regional plan and a cyclone alert outranks a
 * continent-wide drought.
 */
export function leadCrisis(need: Need, help: HelpFile | null, name: string): Lead | null {
  const ranked: { score: number; lead: Lead }[] = [];
  for (const a of need.appeals) {
    const e = a.event !== null ? help?.events[String(a.event)] : undefined;
    const sev = SEVERITY[e?.severity ?? ""] ?? 1;
    ranked.push({ score: 20 + sev * 10 + Math.log10(Math.max(a.requested, 1)), lead: fromAppeal(a, e) });
  }
  for (const p of need.plans) {
    ranked.push({ score: (p.countries.length === 1 ? 35 : 15) + Math.log10(Math.max(p.required, 1)), lead: fromPlan(p) });
  }
  for (const a of need.alerts) {
    ranked.push({ score: (a.level === "Red" ? 45 : 32) - (a.countries.length > 6 ? 12 : 0), lead: fromAlert(a) });
  }
  if (!ranked.length && need.watching) {
    ranked.push({
      score: 1,
      lead: {
        kind: "news",
        title: need.watching.sample[0] ?? `${name} in the world's news`,
        url: null,
        source: "headlines",
        summary: `${name} is in the top stories of ${need.watching.editions} countries right now, and ${Math.round(need.watching.share * 100)}% of those stories describe an emergency. No disaster alert, appeal or UN plan names ${name}, so this comes from headlines alone.`,
        figures: [],
        funding: null,
        severity: null,
      },
    });
  }
  if (!ranked.length && need.unwatched) {
    const u = need.unwatched;
    ranked.push({
      score: 1,
      lead: {
        kind: "news",
        title: u.sample[0] ?? `${name}'s own emergency`,
        url: null,
        source: "headlines",
        summary: `${u.matching} of ${name}'s own ${u.total} top stories describe an emergency, and ${u.editions === 0 ? "no other country" : `only ${u.editions} other ${u.editions === 1 ? "country" : "countries"}`} has ${name} in its top stories. No disaster alert, appeal or UN plan names ${name}, so this comes from headlines alone.`,
        figures: [],
        funding: null,
        severity: null,
      },
    });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked[0]?.lead ?? null;
}
