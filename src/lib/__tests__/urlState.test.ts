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
  it("reads a disaster only when no country or story is set", () => {
    expect(readUrlState("?disaster=gdacs-flood-fl-1104231")).toEqual({ disaster: "gdacs-flood-fl-1104231", mode: "disasters" });
    expect(readUrlState("?disaster=eonet-cyclone-eonet_25340")).toEqual({ disaster: "eonet-cyclone-eonet_25340", mode: "disasters" });
    expect(readUrlState("?country=PK&disaster=usgs-earthquake-us7000q1")).toEqual({ country: "PK" });
    expect(readUrlState("?story=a-b&disaster=usgs-earthquake-us7000q1")).toEqual({ story: "a-b" });
  });
  it("drops the date that comes with a disaster, since past days have none", () => {
    expect(readUrlState("?disaster=news-heatwave-pk&date=2026-10-17")).toEqual({ disaster: "news-heatwave-pk", mode: "disasters" });
  });
  it("reads the disaster map, which also drops a date", () => {
    expect(readUrlState("?map=disasters")).toEqual({ mode: "disasters" });
    expect(readUrlState("?country=PK&map=disasters&date=2026-10-17")).toEqual({ country: "PK", mode: "disasters" });
    expect(readUrlState("?map=news")).toEqual({});
    expect(readUrlState("?map=weather")).toEqual({});
  });
  it("ignores malformed disaster ids", () => {
    expect(readUrlState("?disaster=../x")).toEqual({});
    expect(readUrlState("?disaster=a%20b")).toEqual({});
    expect(readUrlState(`?disaster=${"a".repeat(121)}`)).toEqual({});
    expect(readUrlState("?disaster=")).toEqual({});
  });
  it("reads a date alongside anything else", () => {
    expect(readUrlState("?country=TH&date=2026-10-17")).toEqual({ country: "TH", date: "2026-10-17" });
    expect(readUrlState("?date=yesterday")).toEqual({});
  });
  it("ignores malformed values", () => {
    expect(readUrlState("?country=thailand&about=1&story=../x")).toEqual({});
    expect(readUrlState("")).toEqual({});
  });
});

describe("writeUrlState", () => {
  it("round-trips", () => {
    for (const s of [
      { country: "TH" },
      { country: "TH", about: "US" },
      { story: "a-b" },
      { disaster: "gdacs-flood-fl-1104231", mode: "disasters" as const },
      { mode: "disasters" as const },
      { country: "PK", mode: "disasters" as const },
      { date: "2026-10-17" },
      { country: "TH", date: "2026-10-17" },
      {},
    ]) {
      expect(readUrlState(writeUrlState(s))).toEqual(s);
    }
    expect(writeUrlState({})).toBe("");
    expect(writeUrlState({ story: "x", about: "US" })).toBe("?story=x");
  });
  it("writes one panel only, and no date with a disaster", () => {
    expect(writeUrlState({ country: "PK", disaster: "news-heatwave-pk" })).toBe("?country=PK");
    expect(writeUrlState({ story: "x", disaster: "news-heatwave-pk" })).toBe("?story=x");
    expect(writeUrlState({ disaster: "news-heatwave-pk", date: "2026-10-17" })).toBe("?disaster=news-heatwave-pk");
  });
  it("writes the disaster map without a date, and nothing for the news map", () => {
    expect(writeUrlState({ mode: "disasters" })).toBe("?map=disasters");
    expect(writeUrlState({ country: "PK", mode: "disasters", date: "2026-10-17" })).toBe("?country=PK&map=disasters");
    expect(writeUrlState({ disaster: "x", mode: "disasters" })).toBe("?disaster=x");
    expect(writeUrlState({ country: "PK", mode: "news" })).toBe("?country=PK");
  });
});
