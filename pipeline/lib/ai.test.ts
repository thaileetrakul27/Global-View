import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { collectResearch, readUsage } from "./ai";

describe("readUsage", () => {
  it("reads tokens, cache and web searches, defaulting missing fields to zero", () => {
    const usage = { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 50, cache_creation_input_tokens: null, server_tool_use: { web_search_requests: 3 } } as unknown as Anthropic.Usage;
    expect(readUsage("m", usage)).toEqual({ model: "m", inputTokens: 1200, outputTokens: 300, cacheReadTokens: 50, cacheWriteTokens: 0, webSearches: 3 });
    expect(readUsage("m", undefined)).toEqual({ model: "m", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0 });
  });
});

describe("collectResearch", () => {
  it("joins text, keeps cited sources and search results once each", () => {
    const content = [
      { type: "text", text: "Floods hit ", citations: null },
      { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "q" } },
      {
        type: "web_search_tool_result",
        tool_use_id: "s1",
        content: [
          { type: "web_search_result", url: "https://a.example/1", title: "A", page_age: "1 day ago", encrypted_content: "x" },
          { type: "web_search_result", url: "https://b.example/2", title: "B", page_age: null, encrypted_content: "y" },
        ],
      },
      { type: "text", text: "Sylhet.", citations: [{ type: "web_search_result_location", url: "https://a.example/1", title: "A", cited_text: "Sylhet flooded", encrypted_index: "i" }] },
      { type: "text", text: " Again.", citations: [{ type: "web_search_result_location", url: "https://a.example/1", title: "A", cited_text: "dup", encrypted_index: "j" }] },
      { type: "web_search_tool_result", tool_use_id: "s2", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } },
    ] as unknown as Anthropic.ContentBlock[];
    const out = collectResearch(content);
    expect(out.text).toBe("Floods hit Sylhet. Again.");
    expect(out.citations).toEqual([{ url: "https://a.example/1", title: "A", citedText: "Sylhet flooded" }]);
    expect(out.results).toEqual([
      { url: "https://a.example/1", title: "A", pageAge: "1 day ago" },
      { url: "https://b.example/2", title: "B", pageAge: undefined },
    ]);
  });
});
