import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WORLD_ALTITUDE, countryFocus, type CountryCollection } from "@/lib/geo";
import { FADE_FAR, FADE_MIN, FADE_NEAR, readingFade, readingLook } from "@/lib/lineFade";

// The country shapes the site ships, as the globe frames them when selected.
const shipped = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../public/geo/countries.geojson", import.meta.url)), "utf8"),
) as CountryCollection;

describe("readingFade", () => {
  it("keeps the lines at full strength from the world view up", () => {
    expect(readingFade(WORLD_ALTITUDE)).toBe(1);
    expect(readingFade(FADE_FAR)).toBe(1);
    expect(readingFade(4)).toBe(1);
  });
  it("fades them to the minimum at a country's close-up and below", () => {
    expect(readingFade(FADE_NEAR)).toBe(FADE_MIN);
    expect(readingFade(0.825)).toBe(FADE_MIN); // Thailand
    expect(readingFade(0.7)).toBe(FADE_MIN); // the closest a country is framed
    expect(readingFade(0.1)).toBe(FADE_MIN);
  });
  it("is faintest at every shipped country's close-up below the world view", () => {
    const below = shipped.features.map((f) => ({ code: f.properties.code, altitude: countryFocus(f).altitude })).filter((c) => c.altitude < WORLD_ALTITUDE);
    expect(below.length).toBeGreaterThan(150);
    // The largest ones, which sit closest to the world view, included.
    for (const code of ["CN", "CA", "US", "BR", "AU", "IN", "MX", "AR", "KZ", "TH", "GB"]) expect(below.map((c) => c.code)).toContain(code);
    expect(below.filter((c) => readingFade(c.altitude) !== FADE_MIN)).toEqual([]);
  });
  it("keeps full lines where a country is framed from above the world view (Russia)", () => {
    const russia = shipped.features.find((f) => f.properties.code === "RU")!;
    expect(countryFocus(russia).altitude).toBeGreaterThan(WORLD_ALTITUDE);
    expect(readingFade(countryFocus(russia).altitude)).toBe(1);
  });
  it("fades smoothly in a few fixed steps, never brighter closer in", () => {
    const seen = new Set<number>();
    let prev = 0;
    for (let alt = 0.5; alt <= 2.5; alt += 0.01) {
      const f = readingFade(alt);
      expect(f).toBeGreaterThanOrEqual(prev);
      prev = f;
      seen.add(Math.round(f * 1000));
    }
    expect(seen.size).toBe(5);
  });
  it("is halfway between faintest and full halfway down", () => {
    expect(readingFade((FADE_NEAR + FADE_FAR) / 2)).toBeCloseTo(FADE_MIN + (1 - FADE_MIN) / 2);
  });
  it("treats a missing altitude as the world view", () => {
    expect(readingFade(Number.NaN)).toBe(1);
  });
});

describe("readingLook", () => {
  it("draws unfaded lines as before: stronger is brighter and thicker", () => {
    expect(readingLook(1, 1)).toEqual({ alpha: 0.75, width: 2 });
    expect(readingLook(0.4, 1).alpha).toBeCloseTo(0.48);
    expect(readingLook(0.4, 1).width).toBeCloseTo(1.4);
  });
  it("keeps a fifth of the opacity and about two thirds of the width when faded", () => {
    const near = readingLook(1, FADE_MIN);
    expect(near.alpha).toBeCloseTo(0.15);
    expect(near.width).toBeCloseTo(1.36);
  });
});
