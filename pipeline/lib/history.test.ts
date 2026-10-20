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
  it("indexes days sorted and unique", () => {
    expect(addDay(null, "2026-10-18")).toEqual({ dates: ["2026-10-18"] });
    expect(addDay({ dates: ["2026-10-18", "2026-10-16"] }, "2026-10-17")).toEqual({ dates: ["2026-10-16", "2026-10-17", "2026-10-18"] });
    expect(addDay({ dates: ["2026-10-18"] }, "2026-10-18").dates).toHaveLength(1);
    expect(dayOf(now)).toBe("2026-10-18");
  });
});
