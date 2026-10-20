import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sleep, writeCompactJson, writeFileAtomic, writeJson } from "./io";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "gv-io-"));

describe("writeFileAtomic", () => {
  it("creates parent folders, replaces the file and leaves no temporary file behind", () => {
    const dir = tmpDir();
    const file = path.join(dir, "a", "b", "x.json");
    writeFileAtomic(file, "one");
    writeFileAtomic(file, "two");
    expect(fs.readFileSync(file, "utf8")).toBe("two");
    expect(fs.readdirSync(path.dirname(file))).toEqual(["x.json"]);
  });
});

describe("writeJson and writeCompactJson", () => {
  it("write pretty and one-line JSON that reads back the same", () => {
    const dir = tmpDir();
    const data = { a: [1, 2], b: { c: "é" } };
    writeJson(path.join(dir, "pretty.json"), data);
    writeCompactJson(path.join(dir, "compact.json"), data);
    const pretty = fs.readFileSync(path.join(dir, "pretty.json"), "utf8");
    const compact = fs.readFileSync(path.join(dir, "compact.json"), "utf8");
    expect(pretty).toBe(JSON.stringify(data, null, 2) + "\n");
    expect(compact).toBe(JSON.stringify(data) + "\n");
    expect(JSON.parse(compact)).toEqual(data);
  });
});

describe("sleep", () => {
  it("resolves after roughly the given time", async () => {
    const start = Date.now();
    await sleep(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });
});
