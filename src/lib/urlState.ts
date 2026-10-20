// The address bar mirrors what is open, so any view can be shared as a link.
// The site is a static export, so state lives in the query string.

export interface UrlState {
  /** Selected country code. */
  country?: string;
  /** Code the country's list is filtered to ("stories about X"). */
  about?: string;
  /** Open shared story id. */
  story?: string;
  /** Open disaster id. Disasters are current only, so it never comes with a date. */
  disaster?: string;
  /** A past day being viewed, YYYY-MM-DD. */
  date?: string;
}

const CODE = /^[A-Z]{2,3}$/;
const STORY = /^[a-z0-9-]{1,80}$/;
/** Disaster ids carry source ids, some with underscores (eonet-cyclone-eonet_25340). */
const DISASTER = /^[a-z0-9_-]{1,120}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parses a query string. Unknown or malformed values are ignored. Only one
 * panel can be open: a country wins over a story, and a story over a
 * disaster. A disaster drops the date, since past days have no disasters.
 */
export function readUrlState(search: string): UrlState {
  const p = new URLSearchParams(search);
  const state: UrlState = {};
  const country = p.get("country")?.toUpperCase();
  const about = p.get("about")?.toUpperCase();
  const story = p.get("story");
  const disaster = p.get("disaster");
  if (country && CODE.test(country)) state.country = country;
  if (state.country && about && CODE.test(about)) state.about = about;
  if (!state.country && story && STORY.test(story)) state.story = story;
  if (!state.country && !state.story && disaster && DISASTER.test(disaster)) state.disaster = disaster;
  const date = p.get("date");
  if (!state.disaster && date && DATE.test(date)) state.date = date;
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
  } else if (state.disaster) {
    p.set("disaster", state.disaster);
  }
  if (state.date && !p.has("disaster")) p.set("date", state.date);
  const s = p.toString();
  return s ? `?${s}` : "";
}
