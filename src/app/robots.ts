import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

// robots.txt: everything may be crawled; the sitemap says where the page is.
// Written once at build time, as the site is a static export.
export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", allow: "/" }, sitemap: `${SITE_URL}/sitemap.xml` };
}
