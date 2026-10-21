import { describe, expect, it } from "vitest";
import type { Article } from "@/lib/data";
import { isRanked, listFooter, outletsLabel } from "@/lib/ranking";

const art = (extra: Partial<Article> = {}): Article => ({ title: "t", url: "u", outlet: "O", outletUrl: null, published: "2026-10-21T10:00:00Z", ...extra });
const source = (name: string) => ({ name, edition: "TH:th", url: "https://news.google.com/rss" });

describe("outletsLabel", () => {
  it("counts outlets only when there is more than one", () => {
    expect(outletsLabel(5)).toBe("5 outlets");
    expect(outletsLabel(2)).toBe("2 outlets");
    expect(outletsLabel(1)).toBeNull();
    expect(outletsLabel(undefined)).toBeNull();
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
  it("says a local list is grouped and ranked, from the sources that answered", () => {
    expect(listFooter({ kind: "local", source: source("Google News and Bing News"), articles: ranked }, "Thailand")).toBe(
      "From Google News top stories and sections and Bing News, grouped by story and ranked by how recent it is and how many outlets carry it. Translations are automatic. Links open the publisher.",
    );
    expect(listFooter({ kind: "local", source: source("Google News"), articles: ranked }, "Thailand")).toMatch(/^From Google News top stories and sections, grouped by story/);
    expect(listFooter({ kind: "local", source: source("Bing News"), articles: ranked }, "Thailand")).toMatch(/^From Bing News, grouped by story/);
  });
  it("keeps the old wording for files from before the ranking, which are all local unless marked", () => {
    expect(listFooter({ source: source("Google News"), articles: [art()] }, "Thailand")).toBe(
      "Ranked by Google News top stories, Thailand edition. Translations are automatic. Links open the publisher.",
    );
  });
  it("calls world coverage a search, ranked or not", () => {
    expect(listFooter({ kind: "world", source: source("Bing News and Google News"), articles: ranked }, "Chad")).toBe(
      "Recent Bing News and Google News search results about Chad, grouped by story and ranked by how recent they are and how many outlets carry them. Translations are automatic. Links open the publisher.",
    );
    expect(listFooter({ kind: "world", source: source("Bing News and Google News"), articles: [art()] }, "Chad")).toBe(
      "Recent Bing News and Google News search results about Chad. Translations are automatic. Links open the publisher.",
    );
  });
});
