import { describe, expect, it } from "vitest";
import { DEFAULT_UPDATE_ARGS, parseUpdateArgs } from "./args";

describe("parseUpdateArgs", () => {
  it("uses defaults with no flags", () => {
    expect(parseUpdateArgs([])).toEqual(DEFAULT_UPDATE_ARGS);
  });
  it("upper-cases and splits --countries", () => {
    expect(parseUpdateArgs(["--countries", "th, gb"]).countries).toEqual(["TH", "GB"]);
    expect(parseUpdateArgs(["--countries=us"]).countries).toEqual(["US"]);
  });
  it("parses numbers and strings", () => {
    expect(parseUpdateArgs(["--max", "10", "--delay=500", "--out", "tmp"])).toMatchObject({
      maxArticles: 10,
      delayMs: 500,
      outDir: "tmp",
    });
  });
  it("accepts --no-ai without a value", () => {
    expect(parseUpdateArgs(["--no-ai", "--max", "5"])).toMatchObject({ noAi: true, maxArticles: 5 });
  });
  it("rejects unknown flags, missing values and bad numbers", () => {
    expect(() => parseUpdateArgs(["--nope", "1"])).toThrow(/Unknown flag/);
    expect(() => parseUpdateArgs(["--countries"])).toThrow(/needs a value/);
    expect(() => parseUpdateArgs(["--max", "zero"])).toThrow(/positive whole number/);
    expect(() => parseUpdateArgs(["TH"])).toThrow(/Unexpected argument/);
  });
});
