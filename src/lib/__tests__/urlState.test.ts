import { describe, expect, it } from "vitest";
import { readUrlState, writeUrlState } from "@/lib/urlState";

describe("readUrlState", () => {
  it("reads a country, with an optional filter", () => {
    expect(readUrlState("?country=th")).toEqual({ country: "TH" });
    expect(readUrlState("?country=TH&about=us")).toEqual({ country: "TH", about: "US" });
  });
  it("reads a story only when no country is set", () => {
    expect(readUrlState("?story=france-riots")).toEqual({ story: "france-riots" });
    expect(readUrlState("?country=TH&story=france-riots")).toEqual({ country: "TH" });
  });
  it("ignores malformed values", () => {
    expect(readUrlState("?country=thailand&about=1&story=../x")).toEqual({});
    expect(readUrlState("")).toEqual({});
  });
});

describe("writeUrlState", () => {
  it("round-trips", () => {
    for (const s of [{ country: "TH" }, { country: "TH", about: "US" }, { story: "a-b" }, {}]) {
      expect(readUrlState(writeUrlState(s))).toEqual(s);
    }
    expect(writeUrlState({})).toBe("");
    expect(writeUrlState({ story: "x", about: "US" })).toBe("?story=x");
  });
});
