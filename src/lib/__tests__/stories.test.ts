import { describe, expect, it } from "vitest";
import type { Article, Axis } from "@/lib/data";
import {
  blindspotSide,
  countBalance,
  effectiveScore,
  isBlindspot,
  outletLabel,
  outletName,
  relativeTime,
  scoreLabel,
} from "@/lib/stories";

const axis: Axis = { summary: "x to y", left: "reformist", right: "conservative" };

function article(score: Article["article_score"], confidence: Article["confidence"] = "high"): Article {
  return {
    url: "https://a.example/1",
    outlet: "a.example",
    headline_original: "",
    headline_en: "",
    published: "2026-10-18T00:00:00Z",
    outlet_rating: null,
    article_score: score,
    confidence,
    reason: "",
  };
}

describe("effectiveScore", () => {
  it("returns the score when confident", () => {
    expect(effectiveScore(article(1))).toBe(1);
  });
  it("treats low confidence as no score", () => {
    expect(effectiveScore(article(1, "low"))).toBeNull();
  });
  it("passes null through", () => {
    expect(effectiveScore(article(null))).toBeNull();
  });
});

describe("countBalance", () => {
  it("counts each score and the unclear ones", () => {
    const b = countBalance([article(-2), article(-1), article(0), article(0), article(2), article(null), article(1, "low")]);
    expect(b).toEqual({ "-2": 1, "-1": 1, "0": 2, "1": 0, "2": 1, unclear: 2 });
  });
});

describe("isBlindspot", () => {
  it("is false with fewer than three scored articles", () => {
    expect(isBlindspot([article(1), article(2)])).toBe(false);
    expect(isBlindspot([article(1), article(2), article(1, "low")])).toBe(false);
  });
  it("is true when all scored articles are on one side", () => {
    expect(isBlindspot([article(1), article(2), article(1)])).toBe(true);
    expect(isBlindspot([article(-1), article(-2), article(-1), article(null)])).toBe(true);
  });
  it("is false when the centre or the other side appears", () => {
    expect(isBlindspot([article(1), article(2), article(0)])).toBe(false);
    expect(isBlindspot([article(1), article(2), article(-1)])).toBe(false);
  });
  it("names the missing side", () => {
    expect(blindspotSide([article(1), article(2), article(1)], axis)).toBe("reformist");
    expect(blindspotSide([article(-1), article(-2), article(-1)], axis)).toBe("conservative");
    expect(blindspotSide([article(0), article(0), article(0)], axis)).toBeNull();
  });
});

describe("labels", () => {
  it("uses the axis words", () => {
    expect(scoreLabel(-2, axis)).toBe("Strongly reformist");
    expect(scoreLabel(-1, axis)).toBe("Leans reformist");
    expect(scoreLabel(0, axis)).toBe("Centre");
    expect(scoreLabel(2, axis)).toBe("Strongly conservative");
    expect(scoreLabel(null, axis)).toBe("Unclear");
  });
  it("never guesses an outlet rating", () => {
    expect(outletLabel(null, axis)).toBe("Unrated");
    expect(outletLabel(1, axis)).toBe("Leans conservative");
  });
  it("shortens outlet domains", () => {
    expect(outletName("www.siam-tribune.example")).toBe("siam-tribune");
    expect(outletName("example.co.th")).toBe("example");
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-10-18T12:00:00Z");
  it("rounds to the nearest unit", () => {
    expect(relativeTime("2026-10-18T11:59:40Z", now)).toBe("just now");
    expect(relativeTime("2026-10-18T11:59:00Z", now)).toBe("1 minute ago");
    expect(relativeTime("2026-10-18T11:30:00Z", now)).toBe("30 minutes ago");
    expect(relativeTime("2026-10-18T10:00:00Z", now)).toBe("2 hours ago");
    expect(relativeTime("2026-10-17T12:00:00Z", now)).toBe("24 hours ago");
    expect(relativeTime("2026-10-15T12:00:00Z", now)).toBe("3 days ago");
  });
  it("never goes negative", () => {
    expect(relativeTime("2026-10-18T13:00:00Z", now)).toBe("just now");
  });
});
