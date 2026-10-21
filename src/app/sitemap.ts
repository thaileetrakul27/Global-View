import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

// sitemap.xml: the site is one page (every view is a query on it), refreshed
// every two hours by the data job. Written once at build time.
export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: `${SITE_URL}/`, changeFrequency: "hourly", priority: 1 }];
}
