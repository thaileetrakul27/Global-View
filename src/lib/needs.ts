// Wording and official donation pages for the long-term needs the
// pipeline reads from the World Bank. The pages are a fixed table of UN
// agencies by kind of need, never chosen per country.
import type { CountryNeed, NeedsFile } from "./data";
import type { HelpLink } from "./help";

interface NeedText {
  /** Sentence for the figure, e.g. "48% of people lack basic drinking water". */
  sentence: (value: number) => string;
  source: string;
  /** Which UN agencies take donations for this kind of need. */
  pages: string[];
}

const pct = (v: number) => `${Math.round(v)}%`;

export const NEED_TEXT: Record<string, NeedText> = {
  water: { sentence: (v) => `${pct(v)} of people lack basic drinking water`, source: "WHO/UNICEF", pages: ["unicef"] },
  sanitation: { sentence: (v) => `${pct(v)} of people lack basic sanitation`, source: "WHO/UNICEF", pages: ["unicef"] },
  electricity: { sentence: (v) => `${pct(v)} of people have no electricity`, source: "World Bank", pages: [] },
  hunger: { sentence: (v) => `${pct(v)} of people are undernourished`, source: "FAO", pages: ["wfp"] },
  poverty: { sentence: (v) => `${pct(v)} of people live in extreme poverty`, source: "World Bank", pages: [] },
  school: { sentence: (v) => `${pct(v)} of primary-age children are out of school`, source: "UNESCO", pages: ["ecw", "unicef"] },
  literacy: { sentence: (v) => `${pct(v)} of adults cannot read`, source: "UNESCO", pages: ["ecw", "unicef"] },
  mortality: { sentence: (v) => `${Math.round(v)} in every 1,000 children die before age five`, source: "UN IGME", pages: ["unicef", "who"] },
};

export const NEED_PAGES: Record<string, HelpLink> = {
  unicef: { label: "UNICEF", url: "https://help.unicef.org/", note: "The UN children's agency: water, sanitation, schooling and child health programmes." },
  wfp: { label: "World Food Programme", url: "https://www.wfp.org/support-us", note: "The UN's food assistance agency." },
  ecw: { label: "Education Cannot Wait", url: "https://www.educationcannotwait.org/", note: "The UN's global fund for education in emergencies and protracted crises." },
  who: { label: "WHO Foundation", url: "https://who.foundation/", note: "The World Health Organization's fundraising foundation." },
};

export function needsFor(needs: NeedsFile | null, code: string): CountryNeed[] {
  return needs?.countries[code] ?? [];
}

/** "48% of people lack basic drinking water" for a need; falls back to the key for one the site does not know. */
export function needSentence(n: CountryNeed): string {
  return NEED_TEXT[n.key]?.sentence(n.value) ?? `${n.key}: ${n.value}`;
}

export function needSource(n: CountryNeed): string {
  const src = NEED_TEXT[n.key]?.source ?? "World Bank";
  return `${n.year} · ${src === "World Bank" ? src : `${src} via World Bank`}`;
}

/** The UN agency pages for a country's needs, each once, in order of the needs. */
export function needPages(needs: CountryNeed[]): HelpLink[] {
  const out: HelpLink[] = [];
  for (const n of needs) {
    for (const id of NEED_TEXT[n.key]?.pages ?? []) {
      const page = NEED_PAGES[id];
      if (page && !out.includes(page)) out.push(page);
    }
  }
  return out;
}
