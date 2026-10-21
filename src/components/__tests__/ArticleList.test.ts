import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Article } from "@/lib/data";
import ArticleList from "@/components/ArticleList";

const art = (url: string, extra: Partial<Article> = {}): Article => ({ title: `Headline ${url}`, url, outlet: "Daily", outletUrl: null, published: "2026-10-21T10:00:00Z", ...extra });
const render = (articles: Article[]) => renderToStaticMarkup(createElement(ArticleList, { articles }));

describe("ArticleList", () => {
  it("shows no outlet count in the meta line", () => {
    expect(render([art("a", { outlets: 6 }), art("b", { outlets: 5, trending: true })])).not.toMatch(/\d outlets</);
  });
  it("tags trending stories, with a tooltip that says what the tag means", () => {
    const html = render([art("a", { outlets: 6, trending: true }), art("b", { outlets: 2 })]);
    expect(html.match(/>Trending</g)).toHaveLength(1);
    expect(html).toContain('title="Recent, and carried by 6 outlets in the feeds read"');
  });
});
