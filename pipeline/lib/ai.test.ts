import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FALLBACK_SEARCH_DOMAINS,
  MAX_ALLOWED_DOMAINS,
  cleanAllowedDomains,
  collectResearch,
  createAiClient,
  fallbackDomains,
  readUsage,
  retryAfterRejection,
  searchToolDefinition,
  type WebResearchOptions,
} from "./ai";
import { MOVEMENT_DOMAINS, UN_DOMAINS } from "./disasters/donate";

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

describe("allowed domains for the web search", () => {
  it("cleans the list: trimmed, lower case, each once, at most 64", () => {
    expect(cleanAllowedDomains([" JRC.or.jp ", "jrc.or.jp", "", "ifrc.org"])).toEqual(["jrc.or.jp", "ifrc.org"]);
    expect(cleanAllowedDomains(undefined)).toEqual([]);
    const many = Array.from({ length: 80 }, (_, i) => `site${i}.org`);
    expect(cleanAllowedDomains(many)).toHaveLength(MAX_ALLOWED_DOMAINS);
  });

  it("puts the list on the tool only when there is one", () => {
    expect(searchToolDefinition("web_search_20260209", 3, ["jrc.or.jp", "ifrc.org"])).toEqual({ type: "web_search_20260209", name: "web_search", max_uses: 3, allowed_domains: ["jrc.or.jp", "ifrc.org"] });
    expect(searchToolDefinition("web_search_20250305", 4)).toEqual({ type: "web_search_20250305", name: "web_search", max_uses: 4 });
    expect(searchToolDefinition("web_search_20250305", 4, [])).not.toHaveProperty("allowed_domains");
  });

  it("falls back to the movement and UN domains the caller allowed, and only to a shorter list", () => {
    expect(FALLBACK_SEARCH_DOMAINS).toEqual([...MOVEMENT_DOMAINS, ...UN_DOMAINS]);
    const full = ["jrc.or.jp", "redcrossredcrescent.org", "ifrc.org", "icrc.org", "un.org", "unocha.org", "unicef.org"];
    expect(fallbackDomains(full)).toEqual(["ifrc.org", "icrc.org", "un.org", "unocha.org"]);
    // Never a site the caller left out, and nothing to narrow when the list is already that.
    expect(fallbackDomains(["jrc.or.jp", "un.org"])).toEqual(["un.org"]);
    expect(fallbackDomains(["ifrc.org", "icrc.org", "un.org", "unocha.org"])).toEqual([]);
    expect(fallbackDomains(["jrc.or.jp"])).toEqual([]);
    expect(fallbackDomains([])).toEqual([]);
  });

  it("retries a refused request with the narrower list first, then the basic tool with the full list, then gives up", () => {
    const full = ["jrc.or.jp", "ifrc.org", "un.org"];
    expect(retryAfterRejection({ tool: 0, domains: full }, full)).toEqual({ tool: 0, domains: ["ifrc.org", "un.org"], reason: "domains" });
    expect(retryAfterRejection({ tool: 0, domains: ["ifrc.org", "un.org"] }, full)).toEqual({ tool: 1, domains: full, reason: "tool" });
    expect(retryAfterRejection({ tool: 1, domains: full }, full)).toEqual({ tool: 1, domains: ["ifrc.org", "un.org"], reason: "domains" });
    expect(retryAfterRejection({ tool: 1, domains: ["ifrc.org", "un.org"] }, full)).toBeNull();
    // Without a list, only the tool can change.
    expect(retryAfterRejection({ tool: 0, domains: [] }, [])).toEqual({ tool: 1, domains: [], reason: "tool" });
    expect(retryAfterRejection({ tool: 1, domains: [] }, [])).toBeNull();
  });
});

describe("webResearch with a fake client", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const OPTS: WebResearchOptions = { system: "s", user: "u", maxSearches: 3, maxTokens: 2000, effort: "low", purpose: "research" };
  const DOMAINS = ["jrc.or.jp", "redcrossredcrescent.org", "ifrc.org", "icrc.org", "un.org", "unocha.org"];

  const answer = (text = "Notes.") => ({
    content: [{ type: "text", text, citations: null }],
    stop_reason: "end_turn",
    stop_details: null,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: { web_search_requests: 2 } },
  });
  const rejected = (message = "allowed_domains: invalid domain") =>
    new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message } }, message, new Headers());

  /** A client whose create() answers or throws in turn, as queued. */
  function fakeClient(queue: (object | Error)[]) {
    const create = vi.fn(async (body: { tools: { type: string; allowed_domains?: string[] }[] }) => {
      void body;
      const next = queue.shift();
      if (!next || next instanceof Error) throw next ?? new Error("nothing queued");
      return next;
    });
    /** The search tool each request carried. */
    const tools = () => create.mock.calls.map((c) => c[0].tools[0]);
    return { client: { messages: { create } } as unknown as Anthropic, create, tools };
  }

  it("limits the search to the allowed domains and records its usage", async () => {
    const { client, tools } = fakeClient([answer()]);
    const usage = vi.fn();
    const ai = createAiClient(() => {}, usage, client);
    const res = await ai?.webResearch({ ...OPTS, allowedDomains: DOMAINS });
    expect(res).toMatchObject({ text: "Notes.", searches: 2 });
    expect(tools()).toEqual([{ type: "web_search_20260209", name: "web_search", max_uses: 3, allowed_domains: DOMAINS }]);
    expect(usage).toHaveBeenCalledWith("research", expect.objectContaining({ webSearches: 2, inputTokens: 100 }));
  });

  it("retries once with the movement and UN domains when the API refuses the list, keeping the tool", async () => {
    const { client, tools } = fakeClient([rejected(), answer(), answer()]);
    const log = vi.fn();
    const ai = createAiClient(log, () => {}, client);
    expect(await ai?.webResearch({ ...OPTS, allowedDomains: DOMAINS })).toMatchObject({ text: "Notes." });
    expect(log.mock.calls[0][0]).toContain("allowed domains rejected");
    // The next call starts again from its own full list, on the same tool.
    await ai?.webResearch({ ...OPTS, allowedDomains: DOMAINS });
    expect(tools().map((t) => [t.type, t.allowed_domains])).toEqual([
      ["web_search_20260209", DOMAINS],
      ["web_search_20260209", ["ifrc.org", "icrc.org", "un.org", "unocha.org"]],
      ["web_search_20260209", DOMAINS],
    ]);
  });

  it("moves to the basic search tool with the full list when the narrower list is refused too, and keeps that tool", async () => {
    const { client, tools } = fakeClient([rejected(), rejected(), answer(), answer()]);
    const ai = createAiClient(() => {}, () => {}, client);
    expect(await ai?.webResearch({ ...OPTS, allowedDomains: DOMAINS })).not.toBeNull();
    expect(await ai?.webResearch({ ...OPTS, allowedDomains: DOMAINS })).not.toBeNull();
    expect(tools().map((t) => [t.type, t.allowed_domains?.length])).toEqual([
      ["web_search_20260209", DOMAINS.length],
      ["web_search_20260209", 4],
      ["web_search_20250305", DOMAINS.length],
      ["web_search_20250305", DOMAINS.length],
    ]);
  });

  it("falls back to the basic tool for a search without domains, as before", async () => {
    const { client, tools } = fakeClient([rejected("unknown tool type"), answer()]);
    const ai = createAiClient(() => {}, () => {}, client);
    expect(await ai?.webResearch(OPTS)).not.toBeNull();
    expect(tools()).toEqual([
      { type: "web_search_20260209", name: "web_search", max_uses: 3 },
      { type: "web_search_20250305", name: "web_search", max_uses: 3 },
    ]);
  });

  it("gives up with null after every variant is refused, and never retries another error", async () => {
    const refused = fakeClient([rejected(), rejected(), rejected(), rejected(), answer()]);
    const log = vi.fn();
    const ai = createAiClient(log, () => {}, refused.client);
    expect(await ai?.webResearch({ ...OPTS, allowedDomains: DOMAINS })).toBeNull();
    expect(refused.create).toHaveBeenCalledTimes(4);
    expect(log.mock.calls.at(-1)?.[0]).toContain("research call failed");

    const down = fakeClient([new Error("socket hang up"), answer()]);
    const ai2 = createAiClient(() => {}, () => {}, down.client);
    expect(await ai2?.webResearch({ ...OPTS, allowedDomains: DOMAINS })).toBeNull();
    expect(down.create).toHaveBeenCalledTimes(1);
  });

  it("is null without credentials or a client", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
    expect(createAiClient(() => {})).toBeNull();
  });
});
