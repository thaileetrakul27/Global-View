import { describe, expect, it, vi } from "vitest";
import { allowedRedirect, buildFeedUrl, buildSearchUrl, buildSectionUrl, fetchFeed, fetchFeedUrl, parseFeed, relatedOutlets, stripOutletSuffix } from "./googlenews";

const edition = { hl: "th", gl: "TH", ceid: "TH:th" };

const sample = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Top stories - Google News</title>
<item><title>Parliament passes budget - Bangkok Post</title><link>https://news.google.com/rss/articles/abc</link>
<pubDate>Sun, 18 Oct 2026 09:56:00 GMT</pubDate><source url="https://www.bangkokpost.com">Bangkok Post</source></item>
<item><title>น้ำท่วมเหนือ - ไทยรัฐ</title><link>https://news.google.com/rss/articles/def</link>
<pubDate>Sun, 18 Oct 2026 08:00:00 GMT</pubDate><source url="https://www.thairath.co.th">ไทยรัฐ</source></item>
<item><title>No date</title><link>https://news.google.com/rss/articles/ghi</link><source url="https://x.example">X</source></item>
</channel></rss>`;

describe("buildFeedUrl", () => {
  it("sets the edition parameters", () => {
    const u = new URL(buildFeedUrl(edition));
    expect(u.origin + u.pathname).toBe("https://news.google.com/rss");
    expect(u.searchParams.get("hl")).toBe("th");
    expect(u.searchParams.get("gl")).toBe("TH");
    expect(u.searchParams.get("ceid")).toBe("TH:th");
  });
});

describe("buildSectionUrl", () => {
  it("asks for an edition's NATION or WORLD section", () => {
    const u = new URL(buildSectionUrl(edition, "NATION"));
    expect(u.origin + u.pathname).toBe("https://news.google.com/rss/headlines/section/topic/NATION");
    expect(u.searchParams.get("hl")).toBe("th");
    expect(u.searchParams.get("gl")).toBe("TH");
    expect(u.searchParams.get("ceid")).toBe("TH:th");
    expect(new URL(buildSectionUrl(edition, "WORLD")).pathname).toBe("/rss/headlines/section/topic/WORLD");
  });
});

describe("buildSearchUrl", () => {
  it("searches the English edition for recent coverage", () => {
    const u = new URL(buildSearchUrl('"Mongolia"'));
    expect(u.pathname).toBe("/rss/search");
    expect(u.searchParams.get("q")).toBe('"Mongolia" when:3d');
    expect(u.searchParams.get("ceid")).toBe("US:en");
  });
});

describe("stripOutletSuffix", () => {
  it("removes the outlet Google appends, and only that", () => {
    expect(stripOutletSuffix("Budget passes - Bangkok Post", "Bangkok Post")).toBe("Budget passes");
    expect(stripOutletSuffix("Budget passes - Bangkok Post", "bangkok post")).toBe("Budget passes");
    expect(stripOutletSuffix("Rates up - markets react - Reuters", "Reuters")).toBe("Rates up - markets react");
    expect(stripOutletSuffix("Rates up - markets react", "Reuters")).toBe("Rates up - markets react");
  });
});

// An item's description as Google sends it, once the XML is decoded: the
// story's coverage, each headline followed by its outlet in grey.
const cluster = (outlets: string[]) =>
  `<ol>${outlets.map((o, i) => `<li><a href="https://news.google.com/rss/articles/${i}" target="_blank">Headline ${i}</a>&nbsp;&nbsp;<font color="#6f6f6f">${o}</font></li>`).join("")}</ol>`;

describe("relatedOutlets", () => {
  it("lists the other outlets once each, decoding entities", () => {
    expect(relatedOutlets(cluster(["BBC", "BBC", "The Guardian", "Sky News", "Ciel &amp; Espace"]), "BBC")).toEqual(["The Guardian", "Sky News", "Ciel & Espace"]);
    expect(relatedOutlets(cluster(["L&#39;Équipe", "Caf&#xE9; News", "Bad &#99999999; Ref"]), "BBC")).toEqual(["L'Équipe", "Café News", "Bad &#99999999; Ref"]);
  });
  it("is empty for a lone article or no list", () => {
    expect(relatedOutlets(`<a href="x">Headline</a>&nbsp;&nbsp;<font color="#6f6f6f">BBC</font>`, "BBC")).toEqual([]);
    expect(relatedOutlets("Google News", "BBC")).toEqual([]);
  });
});

describe("parseFeed", () => {
  it("maps items and skips ones without a usable date", () => {
    const a = parseFeed(sample);
    expect(a).toHaveLength(2);
    expect(a[0]).toEqual({
      title: "Parliament passes budget",
      url: "https://news.google.com/rss/articles/abc",
      outlet: "Bangkok Post",
      outletUrl: "https://www.bangkokpost.com",
      published: "2026-10-18T09:56:00.000Z",
    });
    expect(a[1].title).toBe("น้ำท่วมเหนือ");
    expect(a[1].outlet).toBe("ไทยรัฐ");
  });
  it("reads the related outlets from an item's description", () => {
    const escaped = cluster(["BBC", "The Guardian", "Sky News"]).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const xml = `<rss><channel><item><title>Storm Austen - BBC</title><link>u</link><pubDate>Wed, 21 Oct 2026 09:04:26 GMT</pubDate><description>${escaped}</description><source url="s">BBC</source></item></channel></rss>`;
    expect(parseFeed(xml)[0].related).toEqual(["The Guardian", "Sky News"]);
    expect("related" in parseFeed(sample)[0]).toBe(false);
  });
  it("handles a single item and an empty channel", () => {
    const one = parseFeed(`<rss><channel><item><title>A - B</title><link>u</link><pubDate>Sun, 18 Oct 2026 09:56:00 GMT</pubDate><source url="s">B</source></item></channel></rss>`);
    expect(one).toHaveLength(1);
    expect(parseFeed(`<rss><channel><title>x</title></channel></rss>`)).toEqual([]);
  });
  it("rejects non-feed bodies", () => {
    expect(() => parseFeed("<html><body>Redirecting</body></html>")).toThrow(/no RSS channel/);
    expect(() => parseFeed("<<<")).toThrow(/not XML|no RSS channel/);
  });
});

function response(status: number, body: string, headers: Record<string, string> = {}): Response {
  return { ok: status === 200, status, text: async () => body, headers: new Headers(headers) } as unknown as Response;
}

describe("allowedRedirect", () => {
  const from = buildSectionUrl(edition, "NATION");
  it("follows only further into the Google News feeds", () => {
    expect(allowedRedirect(from, "https://news.google.com/rss/topics/CAAq?hl=th&gl=TH&ceid=TH:th")).toBe("https://news.google.com/rss/topics/CAAq?hl=th&gl=TH&ceid=TH:th");
    expect(allowedRedirect(from, "/rss/topics/CAAq?hl=th")).toBe("https://news.google.com/rss/topics/CAAq?hl=th");
  });
  it("refuses anything else", () => {
    expect(allowedRedirect(from, null)).toBeNull();
    expect(allowedRedirect(from, "https://news.google.com/?hl=th")).toBeNull();
    expect(allowedRedirect(from, "https://news.google.com/rss/../home")).toBeNull();
    expect(allowedRedirect(from, "http://news.google.com/rss/topics/CAAq")).toBeNull();
    expect(allowedRedirect(from, "https://consent.google.com/ml?continue=https://news.google.com/rss/")).toBeNull();
    expect(allowedRedirect(from, "https://news.google.com.evil.example/rss/topics/x")).toBeNull();
    expect(allowedRedirect(from, "https://[bad")).toBeNull();
  });
});

describe("fetchFeed", () => {
  it("returns articles on success without sleeping", async () => {
    const sleep = vi.fn(async () => {});
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(200, sample));
    const r = await fetchFeed(edition, 1000, { fetch, sleep, log: () => {} });
    expect(r?.articles).toHaveLength(2);
    expect(sleep).not.toHaveBeenCalled();
    expect((fetch.mock.calls[0][1] as RequestInit).redirect).toBe("manual");
  });
  it("treats a redirect as a failure, waits, and retries once", async () => {
    const sleep = vi.fn(async () => {});
    const log = vi.fn();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response(302, ""))
      .mockResolvedValueOnce(response(200, sample));
    const r = await fetchFeed(edition, 1000, { fetch, sleep, log });
    expect(r?.articles).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(log.mock.calls[0][0]).toMatch(/attempt 1 failed: HTTP 302/);
  });
  it("gives up after two failures", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("socket hang up"));
    const r = await fetchFeed(edition, 1, { fetch, sleep: async () => {}, log: () => {} });
    expect(r).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("fetchFeedUrl", () => {
  const url = buildSectionUrl(edition, "WORLD");
  const topic = "https://news.google.com/rss/topics/CAAqKggK?hl=th&gl=TH&ceid=TH:th";
  it("follows a section's redirect to its topic feed within one attempt", async () => {
    const sleep = vi.fn(async () => {});
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response(302, "", { location: topic }))
      .mockResolvedValueOnce(response(200, sample));
    const r = await fetchFeedUrl(url, "TH:th WORLD", 1000, { fetch, sleep, log: () => {} });
    expect(r).toEqual({ url, articles: parseFeed(sample) });
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([url, topic]);
    expect((fetch.mock.calls[1][1] as RequestInit).redirect).toBe("manual");
    expect(sleep).not.toHaveBeenCalled();
  });
  it("treats a redirect anywhere else as a failure", async () => {
    const log = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(302, "", { location: "https://news.google.com/?hl=th" }));
    expect(await fetchFeedUrl(url, "TH:th WORLD", 1, { fetch, sleep: async () => {}, log })).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2); // one request per attempt, the redirect not followed
    expect(log.mock.calls[0][0]).toMatch(/TH:th WORLD: attempt 1 failed: HTTP 302/);
  });
  it("follows at most one redirect", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(302, "", { location: topic }));
    expect(await fetchFeedUrl(url, "TH:th WORLD", 1, { fetch, sleep: async () => {}, log: () => {} })).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
