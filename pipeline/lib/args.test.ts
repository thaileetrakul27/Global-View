import { describe, expect, it } from "vitest";
import { DEFAULT_FETCH_ARGS, parseFetchArgs } from "./args";

describe("parseFetchArgs", () => {
  it("uses defaults with no flags", () => {
    expect(parseFetchArgs([])).toEqual(DEFAULT_FETCH_ARGS);
  });
  it("upper-cases and splits --countries", () => {
    expect(parseFetchArgs(["--countries", "th, gb"]).countries).toEqual(["TH", "GB"]);
    expect(parseFetchArgs(["--countries=us"]).countries).toEqual(["US"]);
  });
  it("parses numbers and strings", () => {
    const a = parseFetchArgs(["--timespan", "6h", "--max", "50", "--delay=7000", "--out", "tmp"]);
    expect(a).toMatchObject({ timespan: "6h", maxRecords: 50, delayMs: 7000, outDir: "tmp" });
  });
  it("rejects unknown flags, missing values and bad numbers", () => {
    expect(() => parseFetchArgs(["--nope", "1"])).toThrow(/Unknown flag/);
    expect(() => parseFetchArgs(["--countries"])).toThrow(/needs a value/);
    expect(() => parseFetchArgs(["--max", "zero"])).toThrow(/positive whole number/);
    expect(() => parseFetchArgs(["TH"])).toThrow(/Unexpected argument/);
  });
});
