// Where to send someone who wants to help. The country's own Red Cross or
// Red Crescent society comes first, from IFRC's directory, then a fixed
// set of UN and Red Cross pages that exist for every country, so no
// organisation is ever chosen by the site or by a model.
import type { Alert, Appeal, CrisesFile, HelpFile, Plan, Society, UnwatchedEntry, WatchingEntry } from "./data";

export interface HelpLink {
  label: string;
  url: string;
  note: string;
}

export const IFRC_DIRECTORY = "https://www.ifrc.org/national-societies-directory";

/** The link for a national society: its own site, else its IFRC directory page. */
export function societyLink(society: Society, countryName: string): HelpLink {
  return society.url
    ? { label: society.name, url: society.url, note: `${countryName}'s own Red Cross or Red Crescent society. Its website is the official place to give locally.` }
    : { label: society.name, url: society.directory ?? IFRC_DIRECTORY, note: `${countryName}'s own Red Cross or Red Crescent society, in IFRC's directory.` };
}

export function helpLinks(iso3: string | undefined, name: string, society: Society | null = null): HelpLink[] {
  const links: HelpLink[] = [];
  if (society) links.push(societyLink(society, name));
  if (iso3) {
    links.push({
      label: `ReliefWeb: ${name}`,
      url: `https://reliefweb.int/country/${iso3.toLowerCase()}`,
      note: "The UN's humanitarian information service: situation reports, appeals and who is responding.",
    });
  }
  links.push(
    {
      label: "UN Crisis Relief",
      url: "https://crisisrelief.un.org/",
      note: "Donate to UN-coordinated emergency funds for current crises.",
    },
    {
      label: "Red Cross and Red Crescent emergencies",
      url: "https://www.ifrc.org/emergencies",
      note: "Active emergency appeals from the world's largest humanitarian network.",
    },
  );
  return links;
}

/** Everything the site knows about one country's needs. */
export interface Need {
  alerts: Alert[];
  appeals: Appeal[];
  plans: Plan[];
  watching: WatchingEntry | null;
  unwatched: UnwatchedEntry | null;
  society: Society | null;
  /** True when any alert, appeal, plan or headline signal names the country. */
  any: boolean;
}

export function needFor(code: string, crises: CrisesFile | null, help: HelpFile | null): Need {
  const alerts = crises ? crises.alerts.filter((a) => a.countries.includes(code)) : [];
  const appeals = help ? help.appeals.filter((a) => a.country === code) : [];
  const plans = help ? help.plans.filter((p) => p.countries.includes(code)) : [];
  const watching = crises?.watching.find((w) => w.code === code) ?? null;
  const unwatched = crises?.unwatched.find((u) => u.code === code) ?? null;
  return {
    alerts,
    appeals,
    plans,
    watching,
    unwatched,
    society: help?.societies[code] ?? null,
    any: alerts.length > 0 || appeals.length > 0 || plans.length > 0 || watching !== null || unwatched !== null,
  };
}

/** Single-country UN plans with a known funding level, least funded first. */
export function leastFunded(help: HelpFile | null, limit: number): Plan[] {
  if (!help) return [];
  return help.plans
    .filter((p) => p.countries.length === 1 && p.funded !== null)
    .sort((a, b) => a.funded! / a.required - b.funded! / b.required)
    .slice(0, limit);
}
