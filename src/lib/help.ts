// Where to send someone who wants to help. A fixed set of pages that exist
// for every country, run by the UN and the Red Cross movement, so no
// organisation is ever chosen by the site or by a model.
export interface HelpLink {
  label: string;
  url: string;
  note: string;
}

export function helpLinks(iso3: string | undefined, name: string): HelpLink[] {
  const links: HelpLink[] = [];
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
