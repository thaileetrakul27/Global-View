import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SnapshotStory } from "@/lib/data";
import TrendingStrip from "@/components/TrendingStrip";

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
  });
});
