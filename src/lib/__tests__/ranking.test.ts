import { describe, expect, it } from "vitest";
import type { Article } from "@/lib/data";
import { isRanked, listFooter, trendingTitle } from "@/lib/ranking";

const art = (extra: Partial<Article> = {}): Article => ({ title: "t", url: "u", outlet: "O", outletUrl: null, published: "2026-10-21T10:00:00Z", ...extra });
const source = (name: string) => ({ name, edition: "TH:th", url: "https://news.google.com/rss" });

describe("trendingTitle", () => {
  it("says what the tag means, with the outlet count when known", () => {
    expect(trendingTitle(6)).toBe("Recent, and carried by 6 outlets in the feeds read");
    expect(trendingTitle(undefined)).toBe("Recent, and carried by many outlets in the feeds read");
    expect(trendingTitle(1)).toBe("Recent, and carried by many outlets in the feeds read");
  });
});

describe("isRanked", () => {
  it("tells ranked lists from older files without outlet counts", () => {
    expect(isRanked([art(), art({ outlets: 1 })])).toBe(true);
    expect(isRanked([art(), art()])).toBe(false);
    expect(isRanked([])).toBe(false);
  });
});

describe("listFooter", () => {
  const ranked = [art({ outlets: 3, trending: true })];
  it("names Google's top stories among the ranking's factors when Google News answered", () => {
    expect(listFooter({ kind: "local", source: source("Google News and Bing News"), articles: ranked }, "Thailand")).toBe(
      "Google News and Bing News, ranked by recency, outlets and Google's top stories. Translations are automatic.",
    );
    expect(listFooter({ kind: "local", source: source("Google News"), articles: ranked }, "Thailand")).toBe(
      "Google News, ranked by recency, outlets and Google's top stories. Translations are automatic.",
    );
  });
  it("leaves Google's top stories out when that feed failed and a section answered first", () => {
    const nation = { name: "Google News and Bing News", edition: "TH:th", url: "https://news.google.com/rss/headlines/section/topic/NATION?hl=th&gl=TH&ceid=TH:th" };
    expect(listFooter({ kind: "local", source: nation, articles: ranked }, "Thailand")).toBe(
      "Google News and Bing News, ranked by recency and outlets. Translations are automatic.",
    );
  });
  it("leaves Google's top stories out of a list only Bing News answered for", () => {
    expect(listFooter({ kind: "local", source: source("Bing News"), articles: ranked }, "Thailand")).toBe(
      "Bing News, ranked by recency and outlets. Translations are automatic.",
    );
  });
  it("describes an empty list by how it would be ranked, never as an edition's top stories", () => {
    expect(listFooter({ kind: "local", source: source("Google News and Bing News"), articles: [] }, "Thailand")).toBe(
      "Google News and Bing News, ranked by recency, outlets and Google's top stories. Translations are automatic.",
    );
    expect(listFooter({ kind: "local", source: source("Bing News"), articles: [] }, "Thailand")).not.toMatch(/edition/);
    expect(listFooter({ kind: "world", source: source("Bing News and Google News"), articles: [] }, "Chad")).toBe(
      "Bing News and Google News search results, ranked by recency and outlets. Translations are automatic.",
    );
  });
  it("keeps the old wording for files from before the ranking, which are all local unless marked", () => {
    expect(listFooter({ source: source("Google News"), articles: [art()] }, "Thailand")).toBe(
      "Ranked by Google News top stories, Thailand edition. Translations are automatic. Links open the publisher.",
    );
    expect(listFooter({ kind: "world", source: source("Bing News and Google News"), articles: [art()] }, "Chad")).toBe(
      "Recent Bing News and Google News search results about Chad. Translations are automatic. Links open the publisher.",
    );
  });
  it("calls world coverage a search, ranked like the local lists but without Google's top stories", () => {
    expect(listFooter({ kind: "world", source: source("Bing News and Google News"), articles: ranked }, "Chad")).toBe(
      "Bing News and Google News search results, ranked by recency and outlets. Translations are automatic.",
    );
  });
  it("fits in about two phone lines", () => {
    const longest = listFooter({ kind: "local", source: source("Google News and Bing News"), articles: ranked }, "Thailand");
    expect(longest.length).toBeLessThanOrEqual(110);
  });
});
