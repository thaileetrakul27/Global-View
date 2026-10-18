import { describe, expect, it } from "vitest";
import { relativeTime, shortRelativeTime } from "@/lib/time";

const now = Date.parse("2026-10-18T12:00:00Z");

describe("relativeTime", () => {
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

describe("shortRelativeTime", () => {
  it("uses compact units", () => {
    expect(shortRelativeTime("2026-10-18T11:59:50Z", now)).toBe("now");
    expect(shortRelativeTime("2026-10-18T11:25:00Z", now)).toBe("35m");
    expect(shortRelativeTime("2026-10-18T09:00:00Z", now)).toBe("3h");
    expect(shortRelativeTime("2026-10-15T12:00:00Z", now)).toBe("3d");
  });
});
