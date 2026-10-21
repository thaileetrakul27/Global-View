import { describe, expect, it } from "vitest";
import { buildBingUrl, fetchBingFeed, parseBingFeed, publisherUrl } from "./bingnews";
import type { FetchDeps } from "./googlenews";

const item = (title: string, target: string, source = "Alwihda Info", date = "Mon, 19 Oct 2026 07:44:00 GMT") =>
  `<item><title>${title}</title><link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;aid=&amp;url=${encodeURIComponent(target)}&amp;c=1</link><description>x</description><pubDate>${date}</pubDate><News:Source>${source}</News:Source></item>`;
const feed = (items: string[]) => `<?xml version="1.0" encoding="utf-8" ?><rss version="2.0" xmlns:News="https://www.bing.com/news"><channel><title>Tchad - Bing</title>${items.join("")}</channel></rss>`;

describe("buildBingUrl", () => {
  it("encodes the query and market, adding first only for later pages", () => {
    expect(buildBingUrl("Tchad", "td", "fr")).toBe("https://www.bing.com/news/search?q=Tchad&format=rss&cc=TD&setlang=fr");
    expect(buildBingUrl("नेपाल", "NP", "ne", 13)).toContain("q=%E0%A4%A8%E0%A5%87%E0%A4%AA%E0%A4%BE%E0%A4%B2&format=rss&cc=NP&setlang=ne&first=13");
  });
});

describe("publisherUrl", () => {
  it("unwraps Bing's redirect and leaves other links alone", () => {
    expect(publisherUrl("http://www.bing.com/news/apiclick.aspx?ref=FexRss&url=https%3a%2f%2fwww.alwihdainfo.com%2fa%2f&c=1")).toBe("https://www.alwihdainfo.com/a/");
    expect(publisherUrl("https://example.com/story")).toBe("https://example.com/story");
    expect(publisherUrl("not a url")).toBe("not a url");
  });
});

describe("parseBingFeed", () => {
  it("reads title, publisher link, outlet and time, decoding entities", () => {
    const out = parseBingFeed(feed([item("Tchad : r&#233;union de s&#233;curit&#233;", "https://www.alwihdainfo.com/tchad-reunion/")]));
    expect(out).toEqual([
      { title: "Tchad : réunion de sécurité", url: "https://www.alwihdainfo.com/tchad-reunion/", outlet: "Alwihda Info", outletUrl: null, published: "2026-10-19T07:44:00.000Z" },
    ]);
  });
  it("skips items without a title, link or valid date, and handles an empty channel", () => {
    const bad = `<item><title>No link</title><pubDate>Mon, 19 Oct 2026 07:44:00 GMT</pubDate></item>`;
    expect(parseBingFeed(feed([bad, item("Ok", "https://a.example/1", "S", "garbage")]))).toEqual([]);
    expect(parseBingFeed(feed([]))).toEqual([]);
  });
  it("rejects a body that is not a feed", () => {
    expect(() => parseBingFeed("<html><body>Blocked</body></html>")).toThrow(/Not a Bing News feed/);
  });
});

describe("fetchBingFeed", () => {
  const deps = (f: (url: string) => Promise<Response>): FetchDeps => ({ fetch: f as unknown as typeof fetch, sleep: async () => {}, log: () => {} });
  const page = (n: number, count: number) => feed(Array.from({ length: count }, (_, i) => item(`Story ${n}-${i}`, `https://x.example/${n}/${i}`)));
  it("reads a second page when the first is full, dropping duplicate links", async () => {
    const calls: string[] = [];
    const f = async (url: string) => {
      calls.push(url);
      return new Response(url.includes("first=13") ? feed([item("Dup", "https://x.example/1/0"), item("New", "https://x.example/2/0")]) : page(1, 12), { status: 200 });
    };
    const out = await fetchBingFeed("Tchad", "TD", "fr", 0, deps(f));
    expect(calls).toHaveLength(2);
    expect(out?.articles).toHaveLength(13);
    expect(out?.url).toBe("https://www.bing.com/news/search?q=Tchad&format=rss&cc=TD&setlang=fr");
  });
  it("stops after a short first page, retries once, and returns null when the first page fails twice", async () => {
    let calls = 0;
    const short = async () => new Response(page(1, 5), { status: 200 });
    expect((await fetchBingFeed("Tchad", "TD", "fr", 0, deps(short)))?.articles).toHaveLength(5);
    const flaky = async () => (++calls === 1 ? new Response("", { status: 503 }) : new Response(page(1, 3), { status: 200 }));
    expect((await fetchBingFeed("Tchad", "TD", "fr", 0, deps(flaky)))?.articles).toHaveLength(3);
    expect(await fetchBingFeed("Tchad", "TD", "fr", 0, deps(async () => new Response("", { status: 429 })))).toBeNull();
  });
  it("reads one page when asked to, without waiting after it", async () => {
    const calls: string[] = [];
    const waits: number[] = [];
    const f = async (url: string) => {
      calls.push(url);
      return new Response(page(1, 12), { status: 200 });
    };
    const out = await fetchBingFeed("ประเทศไทย", "TH", "th", 2000, { fetch: f as unknown as typeof fetch, sleep: async (ms) => void waits.push(ms), log: () => {} }, 1);
    expect(out?.articles).toHaveLength(12);
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });
});
