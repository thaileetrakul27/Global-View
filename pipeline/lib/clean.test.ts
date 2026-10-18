import { describe, expect, it } from "vitest";
import { dedupeArticles, normalizeTitle, titleKey } from "./clean";
import type { Article } from "./googlenews";

function art(url: string, title: string): Article {
  return { url, title, outlet: "Outlet", outletUrl: null, published: "2026-10-18T00:00:00.000Z" };
}

describe("normalizeTitle and titleKey", () => {
  it("ignores case, punctuation and spacing", () => {
    expect(normalizeTitle("Budget  passes: after late-night vote!")).toBe("budget passes after late night vote");
    expect(normalizeTitle("“Budget passes” — after vote")).toBe("budget passes after vote");
  });
  it("ignores spacing in the key, which matters for Thai", () => {
    expect(titleKey("สภาผ่านงบประมาณหลังอภิปรายดึก")).toBe(titleKey("สภาผ่านงบประมาณ หลังอภิปรายดึก!"));
    expect(titleKey("Budget passes")).toBe("budgetpasses");
  });
});

describe("dedupeArticles", () => {
  it("drops duplicate urls and near-duplicate headlines, keeping the first", () => {
    const kept = dedupeArticles([
      art("u1", "Budget passes"),
      art("u2", "BUDGET PASSES!"),
      art("u1", "Something else"),
      art("u3", "Other story"),
      art("u4", "Other  story"),
      art("u5", "   "),
    ]);
    expect(kept.map((a) => a.url)).toEqual(["u1", "u3"]);
  });
});
