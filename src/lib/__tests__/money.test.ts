import { describe, expect, it } from "vitest";
import { count, money, percent } from "../money";

describe("money", () => {
  it("formats compact dollar and franc amounts", () => {
    expect(money(2866228593, "USD")).toBe("$2.9B");
    expect(money(318976221, "USD")).toBe("$319M");
    expect(money(1500000, "CHF")).toBe("CHF 1.5M");
    expect(money(90800, "CHF")).toBe("CHF 91k");
    expect(money(1200, "USD")).toBe("$1.2k");
    expect(money(850, "USD")).toBe("$850");
  });
});

describe("percent", () => {
  it("rounds and clamps the funded share", () => {
    expect(percent(1245443086, 2866228593)).toBe(43);
    expect(percent(5, 0)).toBe(0);
    expect(percent(120, 100)).toBe(100);
  });
});

describe("count", () => {
  it("adds thousands separators", () => {
    expect(count(50000)).toBe("50,000");
  });
});
