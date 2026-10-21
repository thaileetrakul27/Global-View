import { describe, expect, it } from "vitest";
import { addDay, buildSnapshot, dayOf } from "./history";

const now = "2026-10-18T14:30:00.000Z";
const art = (n: number, en?: string) => ({ url: `u${n}`, title: `t${n}`, outlet: "O", outletUrl: null, published: now, en });

describe("history", () => {
  it("keeps five articles per country and ten stories", () => {
    const stories = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, title: `S${i}`, since: now, subject: null, countries: ["TH", "GB"], articles: [] }));
    const snap = buildSnapshot(now, [{ code: "TH", articles: Array.from({ length: 8 }, (_, i) => art(i, i === 0 ? "en0" : undefined)) }], stories);
    expect(snap.date).toBe("2026-10-18");
    expect(snap.countries.TH).toHaveLength(5);
    expect(snap.countries.TH[0]).toEqual({ title: "t0", en: "en0", url: "u0", outlet: "O" });
    expect(snap.countries.TH[1]).not.toHaveProperty("en");
    expect(snap.stories).toHaveLength(10);
    expect(snap.stories[0]).toEqual({ id: "s0", title: "S0", subject: null, countries: ["TH", "GB"] });
  });
  it("keeps each article's outlet count and trending mark, when it has them", () => {
    const snap = buildSnapshot(now, [{ code: "TH", articles: [{ ...art(0), outlets: 4, trending: true }, { ...art(1), outlets: 1, trending: false }, art(2)] }], []);
    expect(snap.countries.TH[0]).toEqual({ title: "t0", url: "u0", outlet: "O", outlets: 4, trending: true });
    expect(snap.countries.TH[1]).toMatchObject({ outlets: 1, trending: false });
    expect(snap.countries.TH[2]).toEqual({ title: "t2", url: "u2", outlet: "O" });
  });
  it("indexes days sorted and unique", () => {
    expect(addDay(null, "2026-10-18")).toEqual({ dates: ["2026-10-18"] });
    expect(addDay({ dates: ["2026-10-18", "2026-10-16"] }, "2026-10-17")).toEqual({ dates: ["2026-10-16", "2026-10-17", "2026-10-18"] });
    expect(addDay({ dates: ["2026-10-18"] }, "2026-10-18").dates).toHaveLength(1);
    expect(dayOf(now)).toBe("2026-10-18");
  });
});
