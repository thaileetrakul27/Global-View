import { describe, expect, it, vi } from "vitest";
import { buildFeedUrl, buildSearchUrl, fetchFeed, parseFeed, stripOutletSuffix } from "./googlenews";

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

function response(status: number, body: string): Response {
  return { ok: status === 200, status, text: async () => body } as unknown as Response;
}

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
