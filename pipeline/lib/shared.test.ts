import { describe, expect, it, vi } from "vitest";
import type { AiClient } from "./ai";
import { buildSharedPrompt, collectCandidates, findSharedStories, reconcileStories, storyId, storySubject, toStories, type Candidate, type SharedStory } from "./shared";

const now = "2026-10-18T12:00:00.000Z";
const a = (code: string, url: string, en: string) => ({
  code,
  article: { url, title: en, en, outlet: "O", outletUrl: null, published: now, about: [] },
});

const cands: Candidate[] = [a("TH", "t1", "Floods in the north"), a("GB", "g1", "Rates held"), a("US", "u1", "Fed holds rates"), a("TH", "t2", "Fed keeps rates steady"), a("FR", "f1", "Protests in Paris")];
cands[1].article.about = ["US"];
cands[2].article.about = ["US"];
cands[3].article.about = ["US", "TH"];

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
    expect(stories[0]).toMatchObject({ id: "fed-holds-rates", title: "Fed holds rates", subject: "US", since: "" });
    expect(stories[0].countries).toEqual(["GB", "TH", "US"]);
    expect(stories[0].articles.map((x) => x.url)).toEqual(["g1", "u1", "t2"]);
  });
  it("orders countries by article count then code", () => {
    const s = toStories({ stories: [{ title: "x", items: [3, 2, 0] }] }, cands);
    expect(s[0].countries).toEqual(["TH", "US"]);
  });
});

describe("reconcileStories", () => {
  const mk = (id: string, title: string, urls: string[], since = ""): SharedStory => ({
    id,
    title,
    since,
    subject: null,
    countries: ["TH", "GB"],
    articles: urls.map((u) => ({ code: "TH", url: u, title: u, en: u, outlet: "O", about: [] })),
  });
  it("keeps the old id, title and first-seen time when most articles match", () => {
    const prev = [mk("old-id", "Old title", ["a", "b", "c"], "2026-10-18T06:00:00.000Z")];
    const out = reconcileStories([mk("new-id", "New title", ["b", "c", "d", "e"])], prev, "now");
    expect(out[0]).toMatchObject({ id: "old-id", title: "Old title", since: "2026-10-18T06:00:00.000Z" });
    expect(out[0].articles).toHaveLength(4);
  });
  it("starts a new story when overlap is small, and never reuses one old story twice", () => {
    const prev = [mk("old", "Old", ["a", "b", "c", "d"], "then")];
    const out = reconcileStories([mk("x", "X", ["a", "b", "c"]), mk("y", "Y", ["a", "q", "r"]), mk("z", "Z", ["m", "n"])], prev, "now");
    expect(out.map((s) => s.id)).toEqual(["old", "y", "z"]);
    expect(out[1].since).toBe("now");
  });
  it("handles no previous file", () => {
    expect(reconcileStories([mk("x", "X", ["a"])], undefined, "now")[0].since).toBe("now");
  });
});

describe("storySubject", () => {
  it("picks the most common country, ties by code, null when none", () => {
    expect(storySubject([{ about: ["FR"] }, { about: ["FR", "BE"] }, { about: ["BE"] }, { about: ["FR"] }])).toBe("FR");
    expect(storySubject([{ about: ["FR"] }, { about: ["BE"] }])).toBe("BE"); // tie: alphabetical
    expect(storySubject([{ about: [] }])).toBeNull();
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
