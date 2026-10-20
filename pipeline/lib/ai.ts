// Thin wrapper around the Claude API. Two methods: parse() returns
// schema-checked JSON, and webResearch() lets the model search the web and
// returns its cited text. Both return null on failure so the run carries
// on. Everything else in the pipeline depends on this interface, so tests
// pass a fake instead of a real client. Every call reports its token and
// search usage through onUsage, which feeds the monthly spend ledger.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";

/** Headlines are short and the tasks are routine, so the small model is used. */
export const MODEL = process.env.GLOBAL_VIEW_MODEL ?? "claude-haiku-5-5";
/** The model that researches disasters with web search. */
export const RESEARCH_MODEL = process.env.GLOBAL_VIEW_RESEARCH_MODEL ?? "claude-haiku-5-5";

export type Effort = "low" | "medium" | "high";

/** What a call was for, so the spend ledger can show where the money goes. */
export type Purpose = "translate" | "group" | "research" | "news";

export interface Usage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearches: number;
}

export interface ResearchCitation {
  url: string;
  title: string;
  citedText: string;
}

export interface ResearchResult {
  /** The model's final answer, all text blocks joined. */
  text: string;
  /** Sources the answer cites, deduplicated by URL. */
  citations: ResearchCitation[];
  /** Every search result the model saw, deduplicated by URL. */
  results: { url: string; title: string; pageAge?: string }[];
  searches: number;
}

export interface AiClient {
  /** Resolves to the parsed object, or null when the call or parse failed. */
  parse<T>(opts: { schema: z.ZodType<T>; system: string; user: string; maxTokens: number; effort: Effort; purpose: Purpose }): Promise<T | null>;
  /** Lets the model search the web; null when the call failed or was declined. */
  webResearch(opts: { system: string; user: string; maxSearches: number; maxTokens: number; effort: Effort; purpose: Purpose }): Promise<ResearchResult | null>;
  /** Calls made so far, for the per-run cap and the log. */
  readonly calls: number;
}

export type UsageHook = (purpose: Purpose, usage: Usage) => void;

/** Reads the token and search counts off a response's usage block. */
export function readUsage(model: string, usage: Anthropic.Usage | undefined): Usage {
  return {
    model,
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
    webSearches: usage?.server_tool_use?.web_search_requests ?? 0,
  };
}

/** Pulls the answer text, citations and search results out of a finished research turn. */
export function collectResearch(content: Anthropic.ContentBlock[]): Omit<ResearchResult, "searches"> {
  const texts: string[] = [];
  const citations = new Map<string, ResearchCitation>();
  const results = new Map<string, { url: string; title: string; pageAge?: string }>();
  for (const block of content) {
    if (block.type === "text") {
      texts.push(block.text);
      for (const c of block.citations ?? []) {
        if (c.type === "web_search_result_location" && !citations.has(c.url)) {
          citations.set(c.url, { url: c.url, title: c.title ?? c.url, citedText: c.cited_text });
        }
      }
    } else if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const r of block.content) {
        if (r.type === "web_search_result" && !results.has(r.url)) {
          results.set(r.url, { url: r.url, title: r.title, pageAge: r.page_age ?? undefined });
        }
      }
    }
  }
  return { text: texts.join("").trim(), citations: [...citations.values()], results: [...results.values()] };
}

/** Web search with dynamic filtering first; the basic version for models that reject it. */
const SEARCH_TOOLS = ["web_search_20260209", "web_search_20250305"] as const;
/** The server pauses long search turns; this many continuations are allowed. */
const MAX_CONTINUATIONS = 3;

/** Returns null when no credentials are configured, so the run continues without AI. */
export function createAiClient(log: (msg: string) => void, onUsage: UsageHook = () => {}): AiClient | null {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) return null;
  const client = new Anthropic();
  let calls = 0;
  let searchTool = 0;
  return {
    get calls() {
      return calls;
    },

    async parse({ schema, system, user, maxTokens, effort, purpose }) {
      calls++;
      // create() rather than parse(): the SDK's parse() throws on a cut-off or
      // invalid answer before its usage can be read, and that spend would
      // then be missing from the ledger.
      const format = zodOutputFormat(schema);
      try {
        const res = await client.messages.create({
          model: MODEL,
          max_tokens: maxTokens,
          system,
          messages: [{ role: "user", content: user }],
          output_config: { format, effort },
        });
        onUsage(purpose, readUsage(MODEL, res.usage));
        if (res.stop_reason === "refusal") {
          log(`  model declined (${res.stop_details?.category ?? "unknown"})`);
          return null;
        }
        if (res.stop_reason === "max_tokens") log("  model output was cut off by max_tokens");
        const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
        return format.parse(text);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`  model call failed: ${msg.slice(0, 300)}`);
        return null;
      }
    },

    async webResearch({ system, user, maxSearches, maxTokens, effort, purpose }) {
      calls++;
      const messages: Anthropic.MessageParam[] = [{ role: "user", content: user }];
      const content: Anthropic.ContentBlock[] = [];
      let searches = 0;
      try {
        for (let turn = 0; turn <= MAX_CONTINUATIONS; turn++) {
          let res: Anthropic.Message;
          try {
            res = await client.messages.create({
              model: RESEARCH_MODEL,
              max_tokens: maxTokens,
              system,
              messages,
              tools: [{ type: SEARCH_TOOLS[searchTool], name: "web_search", max_uses: maxSearches }],
              output_config: { effort },
            } as Anthropic.MessageCreateParamsNonStreaming);
          } catch (err) {
            // A model without dynamic filtering rejects the newer tool; fall back once.
            if (err instanceof Anthropic.BadRequestError && searchTool < SEARCH_TOOLS.length - 1 && turn === 0) {
              log(`  ${SEARCH_TOOLS[searchTool]} rejected (${err.message.slice(0, 120)}); using ${SEARCH_TOOLS[searchTool + 1]}`);
              searchTool++;
              turn--;
              continue;
            }
            throw err;
          }
          const usage = readUsage(RESEARCH_MODEL, res.usage);
          searches += usage.webSearches;
          onUsage(purpose, usage);
          content.push(...res.content);
          if (res.stop_reason === "refusal") {
            log(`  research declined (${res.stop_details?.category ?? "unknown"})`);
            return null;
          }
          if (res.stop_reason !== "pause_turn") break;
          // Send the paused turn back unchanged; the server resumes where it stopped.
          messages.push({ role: "assistant", content: res.content });
        }
        return { ...collectResearch(content), searches };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`  research call failed: ${msg}`);
        return null;
      }
    },
  };
}
