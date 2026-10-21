import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SnapshotStory } from "@/lib/data";
import TrendingStrip, { trendingRows } from "@/components/TrendingStrip";

const story = (id: string): SnapshotStory => ({ id, title: `Story ${id}`, subject: null, countries: ["JP", "GB", "FR"] });
const stories = ["a", "b", "c", "d"].map(story);
const render = (list: SnapshotStory[], rows: number) =>
  renderToStaticMarkup(createElement(TrendingStrip, { stories: list, rows, onStory: () => {}, onOpen: () => {} }));

describe("TrendingStrip", () => {
  it("lists as many stories as there are rows", () => {
    expect(render(stories, 3).match(/<li>/g)).toHaveLength(3);
    expect(render(stories, 2).match(/<li>/g)).toHaveLength(2);
  });
  it("marks See all as the control focus returns to when the sheet closes", () => {
    expect(render(stories, 3)).toMatch(/<button[^>]*data-trending-button[^>]*>See all<\/button>/);
  });
  it("tells screen readers how widely each story is read", () => {
    expect(render(stories, 1)).toContain("read in 3 countries");
  });
  it("renders nothing without stories", () => {
    expect(render([], 3)).toBe("");
    expect(render([], 0)).toBe("");
  });
  it("is only a Trending today button, still marked for focus return, without rows", () => {
    const html = render(stories, 0);
    expect(html).not.toContain("<li>");
    expect(html).not.toContain("See all");
    expect(html).toMatch(/^<button[^>]*data-trending-button[^>]*>.*Trending today<\/button>$/);
  });
});

describe("trendingRows", () => {
  it("lists three stories on a tall phone and two on a shorter one", () => {
    expect(trendingRows(375, 812)).toBe(3);
    expect(trendingRows(430, 932)).toBe(3);
    expect(trendingRows(375, 667)).toBe(2);
    expect(trendingRows(320, 568)).toBe(2);
  });
  it("lists none in landscape or on a very short screen, where the card would cover the globe", () => {
    expect(trendingRows(667, 375)).toBe(0);
    expect(trendingRows(932, 430)).toBe(0);
    expect(trendingRows(740, 600)).toBe(0);
    expect(trendingRows(375, 500)).toBe(0);
  });
});
