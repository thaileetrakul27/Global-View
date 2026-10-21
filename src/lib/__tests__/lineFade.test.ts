import { describe, expect, it } from "vitest";
import { FADE_FAR, FADE_MIN, FADE_NEAR, readingFade, readingLook } from "@/lib/lineFade";

describe("readingFade", () => {
  it("keeps the lines at full strength from the world view up", () => {
    expect(readingFade(2.1)).toBe(1);
    expect(readingFade(FADE_FAR)).toBe(1);
    expect(readingFade(4)).toBe(1);
  });
  it("fades them to the minimum at a country's close-up and below", () => {
    expect(readingFade(FADE_NEAR)).toBe(FADE_MIN);
    expect(readingFade(0.825)).toBe(FADE_MIN); // Thailand
    expect(readingFade(0.7)).toBe(FADE_MIN); // the closest a country is framed
    expect(readingFade(0.1)).toBe(FADE_MIN);
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
