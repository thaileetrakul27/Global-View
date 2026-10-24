import type { NextConfig } from "next";

// The site is a pure static export: `next build` writes plain HTML, JS and
// JSON into /out, which Cloudflare serves as static assets (wrangler.jsonc).
// Nothing here runs on a server.
const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
