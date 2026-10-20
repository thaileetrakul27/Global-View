// The site's name, address and one-line description, shared by the page
// metadata, the link preview, the sitemap and robots.txt.

/**
 * The site's own address. Netlify sets URL at build time to the site's main
 * address (its custom domain once there is one); local builds use the dev
 * server. Link previews and the sitemap need it to be absolute.
 */
export const SITE_URL = (process.env.URL || process.env.DEPLOY_PRIME_URL || "http://localhost:3000").replace(/\/+$/, "");

export const SITE_NAME = "Global View";

/**
 * What the site is, in a sentence: for search results and link previews.
 * "Top news stories", not "what people read": the lists are each edition's
 * top stories feed, not reader counts.
 */
export const SITE_DESCRIPTION =
  "A 3D globe of the top news stories in each country right now, and of the natural disasters happening now, with official places to give.";

/**
 * Codes that prove to Google Search Console and Bing Webmaster Tools that
 * this is the owner's site. Set as Netlify environment variables, so adding
 * one needs no code change; left out of the page when unset.
 */
export function siteVerification(env: Record<string, string | undefined> = process.env): { google?: string; other?: Record<string, string> } | undefined {
  const google = env.GOOGLE_SITE_VERIFICATION?.trim();
  const bing = env.BING_SITE_VERIFICATION?.trim();
  if (!google && !bing) return undefined;
  return { ...(google ? { google } : {}), ...(bing ? { other: { "msvalidate.01": bing } } : {}) };
}

/** The link preview image in public/, 1200 x 630. */
export const OG_IMAGE = { url: "/og.png", width: 1200, height: 630, alt: "Global View: a globe with lines joining countries reading the same story" };
