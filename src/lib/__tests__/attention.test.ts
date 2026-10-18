import { describe, expect, it } from "vitest";
import { inbound, mostWatched, outbound, tintMap } from "@/lib/attention";
import type { AttentionFile } from "@/lib/data";

const att: AttentionFile = {
  updated: "now",
  mentions: { TH: { US: 3, CN: 1, JP: 1 }, GB: { US: 5, TH: 2 }, US: { TH: 1 } },
};

describe("attention", () => {
  it("lists outbound mentions most first, ties by code", () => {
    expect(outbound(att, "TH")).toEqual([{ code: "US", count: 3 }, { code: "CN", count: 1 }, { code: "JP", count: 1 }]);
    expect(outbound(att, "XX")).toEqual([]);
    expect(outbound(null, "TH")).toEqual([]);
  });
  it("lists inbound mentions", () => {
    expect(inbound(att, "TH")).toEqual([{ code: "GB", count: 2 }, { code: "US", count: 1 }]);
    expect(inbound(att, "US", 1)).toEqual([{ code: "GB", count: 5 }]);
  });
  it("sums inbound mentions to find the most-watched countries", () => {
    expect(mostWatched(att, 2)).toEqual([{ code: "US", count: 8 }, { code: "TH", count: 3 }]);
    expect(mostWatched(null)).toEqual([]);
  });
  it("scales tints to the largest count", () => {
    const t = tintMap(outbound(att, "TH"));
    expect(t.get("US")).toBe(1);
    expect(t.get("CN")).toBeCloseTo(1 / 3);
  });
});
