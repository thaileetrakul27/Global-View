import { describe, expect, it, vi } from "vitest";
import type { AiClient } from "./ai";
import { buildSharedPrompt, collectCandidates, findSharedStories, storyId, toStories, type Candidate } from "./shared";

const now = "2026-10-18T12:00:00.000Z";
const a = (code: string, url: string, en: string) => ({
  code,
  article: { url, title: en, en, outlet: "O", outletUrl: null, published: now, about: [] },
});

const cands: Candidate[] = [a("TH", "t1", "Floods in the north"), a("GB", "g1", "Rates held"), a("US", "u1", "Fed holds rates"), a("TH", "t2", "Fed keeps rates steady"), a("FR", "f1", "Protests in Paris")];

describe("collectCandidates", () => {
  const art = (url: string, about: string[], en = "x") => ({ url, title: en, en, outlet: "O", outletUrl: null, published: now, about });
  it("keeps translated articles about a country that two or more editions cover", () => {
    const out = collectCandidates([
      { code: "TH", articles: [art("t-us", ["US"]), art("t-home", ["TH"]), art("t-fr", ["FR"]), { url: "t-raw", title: "ก", outlet: "O", outletUrl: null, published: now, about: ["US"] }] },
      { code: "GB", articles: [art("g-us", ["US", "GB"]), art("g-home", ["GB"])] },
      { code: "US", articles: [art("u-home", ["US"])] },
    ]);
    // US is covered by TH, GB and US editions; TH and GB only by themselves; FR only by TH.
    expect(out.map((c) => c.article.url)).toEqual(["t-us", "g-us", "u-home"]);
  });
  it("returns nothing when no topic crosses a border", () => {
    expect(collectCandidates([{ code: "TH", articles: [art("a", ["TH"])] }])).toEqual([]);
  });
});

describe("buildSharedPrompt", () => {
  it("lists number, code and English headline", () => {
    expect(buildSharedPrompt(cands.slice(0, 2)).user).toBe("0\tTH\tFloods in the north\n1\tGB\tRates held");
  });
});

describe("toStories", () => {
  it("validates indices, requires two countries, and sorts", () => {
    const stories = toStories(
      {
        stories: [
          { title: "Fed holds rates", items: [1, 2, 3, 3, 99] },
          { title: "Only Thailand", items: [0] },
          { title: "Reuses an index", items: [2, 4] },
          { title: "", items: [4, 0] },
        ],
      },
      cands,
    );
    expect(stories).toHaveLength(1);
    expect(stories[0]).toMatchObject({ id: "fed-holds-rates", title: "Fed holds rates" });
    expect(stories[0].countries).toEqual(["GB", "TH", "US"]);
    expect(stories[0].articles.map((x) => x.url)).toEqual(["g1", "u1", "t2"]);
  });
  it("orders countries by article count then code", () => {
    const s = toStories({ stories: [{ title: "x", items: [3, 2, 0] }] }, cands);
    expect(s[0].countries).toEqual(["TH", "US"]);
  });
});

describe("storyId", () => {
  it("slugs titles", () => {
    expect(storyId("Fed holds rates, markets shrug!")).toBe("fed-holds-rates-markets-shrug");
  });
});

describe("findSharedStories", () => {
  it("returns null when the model fails or there is nothing to compare", async () => {
    const ai = { parse: vi.fn(async () => null), calls: 0 } as unknown as AiClient;
    expect(await findSharedStories(ai, cands)).toBeNull();
    expect(await findSharedStories(ai, cands.slice(0, 1))).toBeNull();
    expect(ai.parse).toHaveBeenCalledTimes(1);
  });
});
