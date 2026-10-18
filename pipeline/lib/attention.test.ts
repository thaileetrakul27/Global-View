import { describe, expect, it } from "vitest";
import { buildAttention } from "./attention";

const art = (url: string, about?: string[]) => ({ url, title: "", outlet: "", outletUrl: null, published: "", about });

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
