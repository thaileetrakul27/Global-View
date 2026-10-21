import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SnapshotStory } from "@/lib/data";
import StoryList from "@/components/StoryList";

const story = (id: string): SnapshotStory => ({ id, title: `Story ${id}`, subject: null, countries: ["JP", "GB"] });
const render = (extra: { toggle?: boolean; focusId?: string | null } = {}) =>
  renderToStaticMarkup(
    createElement(StoryList, { stories: [story("a"), story("b")], focusId: null, onFocus: () => {}, nameOf: (c: string) => c, limit: 5, ...extra }),
  );

describe("StoryList", () => {
  it("marks rows as toggle buttons when choosing the open story again closes it", () => {
    const html = render({ focusId: "a" });
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-pressed="false"');
  });
  it("leaves the pressed state out where rows only open a story", () => {
    expect(render({ toggle: false })).not.toContain("aria-pressed");
  });
});
