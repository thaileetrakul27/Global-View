// The site's name, address and one-line description, shared by the page
// metadata, the link preview, the sitemap and robots.txt.

/**
 * The site's own address. Netlify sets URL at build time to the site's main
 * address (its custom domain once there is one); local builds use the dev
 * server. Link previews and the sitemap need it to be absolute.
 */
export const SITE_URL = (process.env.URL || process.env.DEPLOY_PRIME_URL || "http://localhost:3000").replace(/\/+$/, "");

export const SITE_NAME = "Global View";

/** What the site is, in a sentence: for search results and link previews. */
export const SITE_DESCRIPTION =
  "An interactive globe of what each country is reading right now, and of the natural disasters happening now, with official places to give.";

/** The link preview image in public/, 1200 x 630. */
export const OG_IMAGE = { url: "/og.png", width: 1200, height: 630, alt: "Global View: a globe with lines joining countries reading the same story" };
