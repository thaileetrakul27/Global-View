import { describe, expect, it, vi } from "vitest";
import { buildGdeltUrl, fetchGdelt, gdeltDateToIso, parseGdeltResponse } from "./gdelt";

const sample = JSON.stringify({
  articles: [
    {
      url: "https://news.example/a",
      url_mobile: "",
      title: "Budget passes",
      seendate: "20261018T093000Z",
      socialimage: "",
      domain: "news.example",
      language: "Thai",
      sourcecountry: "Thailand",
    },
  ],
});

describe("buildGdeltUrl", () => {
  it("sets every parameter the plan asks for", () => {
    const url = new URL(buildGdeltUrl({ gdeltCode: "UK", timespan: "12h", maxRecords: 75 }));
    expect(url.origin + url.pathname).toBe("https://api.gdeltproject.org/api/v2/doc/doc");
    expect(url.searchParams.get("query")).toBe("sourcecountry:UK");
    expect(url.searchParams.get("mode")).toBe("ArtList");
    expect(url.searchParams.get("format")).toBe("json");
    expect(url.searchParams.get("timespan")).toBe("12h");
    expect(url.searchParams.get("maxrecords")).toBe("75");
  });
  it("caps records at GDELT's limit of 250", () => {
    expect(new URL(buildGdeltUrl({ gdeltCode: "TH", timespan: "1d", maxRecords: 999 })).searchParams.get("maxrecords")).toBe("250");
  });
});

describe("parsing", () => {
  it("converts dates and field names", () => {
    expect(gdeltDateToIso("20261018T093000Z")).toBe("2026-10-18T09:30:00Z");
    expect(parseGdeltResponse(sample)).toEqual([
      { url: "https://news.example/a", title: "Budget passes", domain: "news.example", language: "Thai", seen: "2026-10-18T09:30:00Z", sourceCountry: "Thailand" },
    ]);
  });
  it("treats an empty body as no articles", () => {
    expect(parseGdeltResponse("{}")).toEqual([]);
  });
  it("turns GDELT's plain-text errors into exceptions", () => {
    expect(() => parseGdeltResponse("Please limit requests to one every 5 seconds")).toThrow(/did not return JSON: Please limit/);
    expect(() => gdeltDateToIso("yesterday")).toThrow(/Unexpected GDELT date/);
  });
});

function response(status: number, body: string): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => body } as unknown as Response;
}

describe("fetchGdelt", () => {
  const q = { gdeltCode: "TH", timespan: "12h", maxRecords: 75 };

  it("returns articles on the first try without sleeping", async () => {
    const sleep = vi.fn(async () => {});
    const fetch = vi.fn(async () => response(200, sample));
    const result = await fetchGdelt(q, 5000, { fetch: fetch as unknown as typeof globalThis.fetch, sleep, log: () => {} });
    expect(result?.articles).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("waits and retries once after a rate limit, then succeeds", async () => {
    const sleep = vi.fn(async () => {});
    const log = vi.fn();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(429, "Please limit requests"))
      .mockResolvedValueOnce(response(200, sample));
    const result = await fetchGdelt(q, 5000, { fetch: fetch as unknown as typeof globalThis.fetch, sleep, log });
    expect(result?.articles).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(5000);
    expect(log.mock.calls[0][0]).toMatch(/attempt 1 failed: HTTP 429/);
  });

  it("gives up after two failures", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("socket hang up"));
    const result = await fetchGdelt(q, 1, { fetch: fetch as unknown as typeof globalThis.fetch, sleep: async () => {}, log: () => {} });
    expect(result).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("sends a user agent", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(200, sample));
    await fetchGdelt(q, 1, { fetch, sleep: async () => {}, log: () => {} });
    const init = fetch.mock.calls[0][1];
    expect((init?.headers as Record<string, string>)["User-Agent"]).toMatch(/GlobalView/);
  });
});
