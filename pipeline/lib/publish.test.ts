import { describe, expect, it } from "vitest";
import { mergeIndex, type IndexFile } from "./publish";

const prev: IndexFile = {
  updated: "2026-10-18T06:00:00.000Z",
  countries: {
    TH: { name: "Thailand", kind: "local", articles: 30, updated: "2026-10-18T06:00:00.000Z" },
    GB: { name: "United Kingdom", kind: "local", articles: 28, updated: "2026-10-18T06:00:00.000Z" },
    XX: { name: "Removed", kind: "world", articles: 5, updated: "2026-10-18T06:00:00.000Z" },
  },
};

describe("mergeIndex", () => {
  it("uses fresh entries, keeps old ones for failures, drops the rest", () => {
    const fresh = { TH: { name: "Thailand", kind: "local" as const, articles: 29, updated: "2026-10-18T09:00:00.000Z" } };
    const out = mergeIndex(prev, fresh, ["GB"], "2026-10-18T09:00:00.000Z");
    expect(out.updated).toBe("2026-10-18T09:00:00.000Z");
    expect(out.countries.TH.articles).toBe(29);
    expect(out.countries.GB).toEqual(prev.countries.GB);
    expect(out.countries.XX).toBeUndefined();
  });
  it("works with no previous index", () => {
    const out = mergeIndex(null, {}, ["GB"], "now");
    expect(out).toEqual({ updated: "now", countries: {} });
  });
});
