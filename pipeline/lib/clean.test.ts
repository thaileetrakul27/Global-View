import { describe, expect, it } from "vitest";
import { cleanArticles, isNewsDomain, loadNonNewsDomains, normalizeTitle, titleKey } from "./clean";
import type { RawArticle } from "./gdelt";

function art(url: string, title: string, domain = "news.example"): RawArticle {
  return { url, title, domain, language: "English", seen: "2026-10-18T00:00:00Z", sourceCountry: "Thailand" };
}

describe("normalizeTitle", () => {
  it("ignores case, punctuation and spacing", () => {
    expect(normalizeTitle("Budget  passes: after late-night vote!")).toBe("budget passes after late night vote");
    expect(normalizeTitle("“Budget passes” — after vote")).toBe("budget passes after vote");
  });
  it("handles Thai text", () => {
    expect(normalizeTitle("งบประมาณผ่านสภา!")).toBe("งบประมาณผ่านสภา");
  });
  it("ignores spacing in the duplicate key, which matters for Thai", () => {
    expect(titleKey("สภาผ่านงบประมาณหลังอภิปรายดึก")).toBe(titleKey("สภาผ่านงบประมาณ หลังอภิปรายดึก!"));
    expect(titleKey("Budget passes")).toBe("budgetpasses");
  });
});

describe("isNewsDomain", () => {
  const blocked = ["youtube.com", "prnewswire.com"];
  it("blocks listed domains and their subdomains only", () => {
    expect(isNewsDomain("youtube.com", blocked)).toBe(false);
    expect(isNewsDomain("m.youtube.com", blocked)).toBe(false);
    expect(isNewsDomain("notyoutube.com", blocked)).toBe(true);
    expect(isNewsDomain("bangkokpost.com", blocked)).toBe(true);
  });
  it("loads the real block list", () => {
    const real = loadNonNewsDomains();
    expect(real).toContain("facebook.com");
    expect(isNewsDomain("www.facebook.com", real)).toBe(false);
  });
});

describe("cleanArticles", () => {
  const blocked = ["youtube.com"];
  it("drops duplicate urls and near-duplicate headlines, keeping the first", () => {
    const { kept, dropped } = cleanArticles(
      [art("u1", "Budget passes"), art("u2", "BUDGET PASSES!"), art("u1", "Something else"), art("u3", "Other story"), art("u4", "Other  story")],
      blocked,
    );
    expect(kept.map((a) => a.url)).toEqual(["u1", "u3"]);
    expect(dropped).toEqual({ duplicates: 3, nonNews: 0, empty: 0 });
  });
  it("drops non-news domains and empty headlines", () => {
    const { kept, dropped } = cleanArticles(
      [art("u1", "Clip", "m.youtube.com"), art("u2", "   "), art("", "No url"), art("u3", "Real story")],
      blocked,
    );
    expect(kept.map((a) => a.url)).toEqual(["u3"]);
    expect(dropped).toEqual({ duplicates: 0, nonNews: 1, empty: 2 });
  });
});
