import { describe, expect, it } from "vitest";
import { buildAboutFiles, buildAttention } from "./attention";

const art = (url: string, about?: string[], published = "2026-10-18T10:00:00.000Z") => ({ url, title: "t" + url, outlet: "O", outletUrl: null, published, about });

describe("buildAboutFiles", () => {
  it("collects foreign articles per country, newest first, skipping domestic", () => {
    const out = buildAboutFiles(
      [
        { code: "TH", articles: [art("1", ["TH"]), art("2", ["US"], "2026-10-18T08:00:00.000Z"), art("3", ["US", "CN"], "2026-10-18T09:00:00.000Z")] },
        { code: "GB", articles: [art("4", ["US"], "2026-10-18T11:00:00.000Z")] },
      ],
      "now",
    );
    expect(Object.keys(out).sort()).toEqual(["CN", "US"]);
    expect(out.US.articles.map((a) => a.from + a.url)).toEqual(["GB4", "TH3", "TH2"]);
    expect(out.CN.articles[0]).toMatchObject({ from: "TH", url: "3", title: "t3", outlet: "O" });
    expect(out.CN.articles[0]).not.toHaveProperty("en");
  });
});

describe("buildAttention", () => {
  it("counts foreign mentions per country and skips domestic ones", () => {
    const out = buildAttention(
      [
        { code: "TH", articles: [art("1", ["TH"]), art("2", ["US", "CN"]), art("3", ["US"]), art("4")] },
        { code: "GB", articles: [art("5", ["GB"])] },
      ],
      "now",
    );
    expect(out).toEqual({ updated: "now", mentions: { TH: { US: 2, CN: 1 } } });
  });
});
