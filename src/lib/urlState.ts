// The address bar mirrors what is open, so any view can be shared as a link.
// The site is a static export, so state lives in the query string.

export interface UrlState {
  /** Selected country code. */
  country?: string;
  /** Code the country's list is filtered to ("stories about X"). */
  about?: string;
  /** Open shared story id. */
  story?: string;
}

const CODE = /^[A-Z]{2,3}$/;

/** Parses a query string. Unknown or malformed values are ignored. */
export function readUrlState(search: string): UrlState {
  const p = new URLSearchParams(search);
  const state: UrlState = {};
  const country = p.get("country")?.toUpperCase();
  const about = p.get("about")?.toUpperCase();
  const story = p.get("story");
  if (country && CODE.test(country)) state.country = country;
  if (state.country && about && CODE.test(about)) state.about = about;
  if (!state.country && story && /^[a-z0-9-]{1,80}$/.test(story)) state.story = story;
  return state;
}

/** Builds the query string for a state; empty when nothing is open. */
export function writeUrlState(state: UrlState): string {
  const p = new URLSearchParams();
  if (state.country) {
    p.set("country", state.country);
    if (state.about) p.set("about", state.about);
  } else if (state.story) {
    p.set("story", state.story);
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}
