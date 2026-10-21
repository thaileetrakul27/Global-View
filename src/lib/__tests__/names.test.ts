import { describe, expect, it } from "vitest";
import { displayName, possessive } from "@/lib/names";

describe("displayName", () => {
  it("prefers the short name, then the map's label, then the code", () => {
    expect(displayName("US", "United States of America")).toBe("United States");
    expect(displayName("TH", "Thailand")).toBe("Thailand");
    expect(displayName("XX", undefined)).toBe("XX");
  });
});

describe("possessive", () => {
  it("adds 's, or only the apostrophe after a final s", () => {
    expect(possessive("Thailand")).toBe("Thailand's");
    expect(possessive("Philippines")).toBe("Philippines'");
    expect(possessive("United States")).toBe("United States'");
  });
});
