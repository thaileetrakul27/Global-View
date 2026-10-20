import { afterEach, describe, expect, it, vi } from "vitest";

/** site.ts reads the environment when it loads, so each case loads it afresh. */
async function load(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v as string);
  return import("../site");
}

afterEach(() => vi.unstubAllEnvs());

describe("SITE_URL", () => {
  it("is the address Netlify gives the build, without a trailing slash", async () => {
    expect((await load({ URL: "https://example.netlify.app/", DEPLOY_PRIME_URL: "https://deploy--example.netlify.app" })).SITE_URL).toBe(
      "https://example.netlify.app",
    );
  });

  it("falls back to the deploy's own address, then to the dev server", async () => {
    expect((await load({ URL: "", DEPLOY_PRIME_URL: "https://deploy--example.netlify.app" })).SITE_URL).toBe("https://deploy--example.netlify.app");
    expect((await load({ URL: "", DEPLOY_PRIME_URL: "" })).SITE_URL).toBe("http://localhost:3000");
  });
});

describe("link preview", () => {
  it("points at the 1200 x 630 image in public/", async () => {
    const { OG_IMAGE, SITE_DESCRIPTION } = await load({});
    expect(OG_IMAGE).toMatchObject({ url: "/og.png", width: 1200, height: 630 });
    expect(SITE_DESCRIPTION.length).toBeLessThanOrEqual(160);
  });
});

describe("siteVerification", () => {
  it("is left out until a code is set", async () => {
    const { siteVerification } = await load({});
    expect(siteVerification({})).toBeUndefined();
    expect(siteVerification({ GOOGLE_SITE_VERIFICATION: "  " })).toBeUndefined();
  });

  it("carries Google's and Bing's codes", async () => {
    const { siteVerification } = await load({});
    expect(siteVerification({ GOOGLE_SITE_VERIFICATION: " abc123 " })).toEqual({ google: "abc123" });
    expect(siteVerification({ BING_SITE_VERIFICATION: "XYZ" })).toEqual({ other: { "msvalidate.01": "XYZ" } });
    expect(siteVerification({ GOOGLE_SITE_VERIFICATION: "g", BING_SITE_VERIFICATION: "b" })).toEqual({ google: "g", other: { "msvalidate.01": "b" } });
  });
});
