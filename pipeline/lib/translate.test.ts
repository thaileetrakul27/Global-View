import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AiClient } from "./ai";
import type { Article } from "./googlenews";
import { applyCache, buildTranslationPrompt, normaliseAbout, pruneCache, readCache, translateNew, type HeadlineCache } from "./translate";

const TH = { code: "TH", name: "Thailand" };
const valid = new Set(["TH", "US", "CN", "GB"]);
const now = "2026-10-18T12:00:00.000Z";

function art(url: string, title: string): Article {
  return { url, title, outlet: "O", outletUrl: null, published: now };
}

function fakeAi(reply: unknown | null): AiClient & { parse: ReturnType<typeof vi.fn> } {
  const parse = vi.fn(async () => reply);
  return { parse, calls: 0 } as unknown as AiClient & { parse: ReturnType<typeof vi.fn> };
}

describe("buildTranslationPrompt", () => {
  it("numbers headlines and names the country", () => {
    const { system, user } = buildTranslationPrompt(TH, ["ก", "ข"]);
    expect(user).toBe("0\tก\n1\tข");
    expect(system).toContain("Thailand (TH)");
    expect(system).toContain("copy it unchanged");
  });
});

describe("normaliseAbout", () => {
  it("keeps valid globe codes only, once each", () => {
    expect(normaliseAbout(["th", "US", "us", "XX", "USA", " cn "], valid)).toEqual(["TH", "US", "CN"]);
  });
});

describe("translateNew", () => {
  it("sends only uncached headlines and stores valid replies", async () => {
    const cache: HeadlineCache = { u1: { en: "Old", about: [], seen: now } };
    const ai = fakeAi({ items: [{ i: 0, en: "Rain warning", about: ["th"] }, { i: 1, en: "", about: [] }, { i: 9, en: "Bad index", about: [] }] });
    const n = await translateNew(ai, TH, [art("u1", "x"), art("u2", "ฝน"), art("u3", "ว่าง")], cache, valid, now);
    expect(n).toBe(1);
    expect(cache.u2).toEqual({ en: "Rain warning", about: ["TH"], seen: now });
    expect(cache.u3).toBeUndefined();
    expect(ai.parse).toHaveBeenCalledTimes(1);
    expect(ai.parse.mock.calls[0][0].user).toBe("0\tฝน\n1\tว่าง");
  });
  it("makes no call when everything is cached", async () => {
    const ai = fakeAi({ items: [] });
    const cache: HeadlineCache = { u1: { en: "A", about: [], seen: now } };
    expect(await translateNew(ai, TH, [art("u1", "a")], cache, valid, now)).toBe(0);
    expect(ai.parse).not.toHaveBeenCalled();
  });
  it("leaves headlines untranslated when the model fails, to retry next run", async () => {
    const cache: HeadlineCache = {};
    expect(await translateNew(fakeAi(null), TH, [art("u1", "a")], cache, valid, now)).toBe(0);
    expect(cache).toEqual({});
  });
  it("splits large lists into batches of 40", async () => {
    const ai = fakeAi({ items: [] });
    const many = Array.from({ length: 85 }, (_, i) => art(`u${i}`, `h${i}`));
    await translateNew(ai, TH, many, {}, valid, now);
    expect(ai.parse).toHaveBeenCalledTimes(3);
  });
});

describe("cache", () => {
  it("applies translations and refreshes seen", () => {
    const cache: HeadlineCache = { u1: { en: "A", about: ["US"], seen: "2026-10-17T00:00:00.000Z" } };
    const out = applyCache([art("u1", "ก"), art("u2", "ข")], cache, now);
    expect(out[0]).toMatchObject({ en: "A", about: ["US"] });
    expect(out[1].en).toBeUndefined();
    expect(cache.u1.seen).toBe(now);
  });
  it("prunes entries older than the grace period", () => {
    const cache: HeadlineCache = {
      fresh: { en: "", about: [], seen: "2026-10-18T00:00:00.000Z" },
      stale: { en: "", about: [], seen: "2026-10-15T00:00:00.000Z" },
    };
    expect(Object.keys(pruneCache(cache, now))).toEqual(["fresh"]);
  });
});

describe("readCache", () => {
  const file = (text: string | null) => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gv-headlines-")), "headlines.json");
    if (text !== null) fs.writeFileSync(f, text);
    return f;
  };

  it("reads a saved cache, and is empty when there is none", () => {
    const entry = { en: "Floods in Sylhet", about: ["BD"], at: "2026-10-20T00:00:00.000Z" };
    expect(readCache(file(JSON.stringify({ "https://x.example/a": entry })))).toEqual({ "https://x.example/a": entry });
    expect(readCache(file(null))).toEqual({});
  });

  it("starts empty rather than crash every run on a broken file", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(readCache(file('{"https://x.example/a": {"en": "Flo'))).toEqual({});
    expect(readCache(file("[1, 2]"))).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
