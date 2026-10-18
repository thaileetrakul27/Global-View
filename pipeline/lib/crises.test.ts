import { describe, expect, it } from "vitest";
import type { AboutFile, AttentionFile } from "./attention";
import { detectCrises, inboundEditions, isCrisisHeadline, loadCrisisTerms } from "./crises";

const terms = { terms: ["flood", "floods", "earthquake", "killed", "death toll", "aid convoy"] };
const now = "2026-10-18T12:00:00.000Z";

describe("isCrisisHeadline", () => {
  it("matches whole words and phrases, not fragments", () => {
    expect(isCrisisHeadline("Floods displace thousands in the north", terms)).toBe(true);
    expect(isCrisisHeadline("Death toll rises after quake", terms)).toBe(true);
    expect(isCrisisHeadline("Aid convoy reaches the city", terms)).toBe(true);
    expect(isCrisisHeadline("Floodlights fail at stadium", terms)).toBe(false);
    expect(isCrisisHeadline("Parliament passes budget", terms)).toBe(false);
  });
});

describe("inboundEditions", () => {
  it("counts distinct editions per country", () => {
    const att: AttentionFile = { updated: now, mentions: { TH: { US: 3, NP: 1 }, GB: { US: 1, NP: 2 }, FR: { NP: 1 } } };
    expect(inboundEditions(att)).toEqual({ US: 2, NP: 3 });
  });
});

function about(code: string, titles: string[]): AboutFile {
  return { code, updated: now, articles: titles.map((t, i) => ({ from: "X" + i, url: code + i, title: t, en: t, outlet: "O", published: now })) };
}
const mentionsFrom = (code: string, n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`E${code}${i}`, { [code]: 1 }]));

describe("detectCrises", () => {
  const quake = ["Earthquake kills hundreds in Nepal", "Nepal death toll rises", "Rescuers dig through rubble as death toll climbs", "Nepal quake: aid convoy arrives"];
  it("flags a country that many editions suddenly cover with emergency headlines", () => {
    const att: AttentionFile = { updated: now, mentions: mentionsFrom("NP", 20) };
    const out = detectCrises({ attention: att, abouts: { NP: about("NP", quake) }, locals: [], baselines: { NP: [1, 2, 1] }, terms, now });
    expect(out.watching).toHaveLength(1);
    expect(out.watching[0]).toMatchObject({ code: "NP", editions: 20, baseline: 1, share: 1 });
    expect(out.watching[0].sample).toHaveLength(3);
  });
  it("needs a higher bar with no history, and ignores non-emergency attention", () => {
    const att: AttentionFile = { updated: now, mentions: { ...mentionsFrom("NP", 10), ...mentionsFrom("US", 30) } };
    const out = detectCrises({
      attention: att,
      abouts: { NP: about("NP", quake), US: about("US", ["Senate passes budget", "Fed holds rates", "Oscars night", "Trade talks resume"]) },
      locals: [],
      baselines: {},
      terms,
      now,
    });
    expect(out.watching).toEqual([]);
  });
  it("lists countries whose own news is an emergency nobody else reads about", () => {
    const own = (about: string[], en: string) => ({ url: en, title: en, en, outlet: "O", outletUrl: null, published: now, about });
    const locals = [
      { code: "SD", articles: [own(["SD"], "Floods kill dozens"), own(["SD"], "Death toll from floods rises"), own(["SD"], "Thousands killed in fighting"), own(["SD"], "Earthquake aftershocks"), own(["SD"], "Football league resumes"), own([], "Weather")] },
      { code: "GB", articles: [own(["GB"], "Rail strike"), own(["GB"], "Budget day"), own(["GB"], "Floods in Yorkshire"), own(["GB"], "Earthquake drill")] },
    ];
    const att: AttentionFile = { updated: now, mentions: { ...mentionsFrom("SD", 1), ...mentionsFrom("GB", 9) } };
    const out = detectCrises({ attention: att, abouts: {}, locals, baselines: {}, terms, now });
    expect(out.unwatched.map((u) => u.code)).toEqual(["SD"]);
    expect(out.unwatched[0]).toMatchObject({ matching: 4, total: 6, editions: 1 });
  });
  it("lists verified alerts whose main country few editions read about, skipping regional ones", () => {
    const alert = (id: string, countries: string[]) => ({ id, type: "flood" as const, level: "Orange" as const, title: id, description: null, name: null, countries, from: now, to: now, url: "u" });
    const att: AttentionFile = { updated: now, mentions: { ...mentionsFrom("MX", 12), ...mentionsFrom("TD", 1) } };
    const alerts = [alert("a", ["MX"]), alert("b", ["TD", "NE"]), alert("c", ["LY"]), alert("d", ["TD"]), alert("e", ["AT", "BE", "CH", "DE", "DK", "ES", "FR"])];
    const out = detectCrises({ attention: att, abouts: {}, locals: [], baselines: {}, terms, alerts, now });
    expect(out.alerts).toHaveLength(5);
    expect(out.quiet).toEqual([
      { code: "TD", alert: "b", editions: 1 },
      { code: "LY", alert: "c", editions: 0 },
    ]);
  });
  it("writes empty alert lists when none are given", () => {
    const out = detectCrises({ attention: { updated: now, mentions: {} }, abouts: {}, locals: [], baselines: {}, terms, now });
    expect(out.alerts).toEqual([]);
    expect(out.quiet).toEqual([]);
  });
  it("loads the real term list", () => {
    expect(loadCrisisTerms().terms).toContain("earthquake");
  });
});
