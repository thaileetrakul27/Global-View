// Thin wrapper around the Claude API. Two methods: parse() returns
// schema-checked JSON, and webResearch() lets the model search the web and
// returns its cited text. Both return null on failure so the run carries
// on. Everything else in the pipeline depends on this interface, so tests
// pass a fake instead of a real client. Every call reports its token and
// search usage through onUsage, which feeds the monthly spend ledger.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { MOVEMENT_DOMAINS, UN_DOMAINS } from "./disasters/donate";

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

export interface WebResearchOptions {
  system: string;
  user: string;
  maxSearches: number;
  maxTokens: number;
  effort: Effort;
  purpose: Purpose;
  /**
   * Limits the search to these sites (the web search tool's allowed_domains):
   * plain hostnames, each covering its subdomains, or a host with a folder.
   * Left out, the whole web is searched. Never pass a registry suffix such
   * as gov.ph or co.uk: the API refuses it.
   */
  allowedDomains?: readonly string[];
}

export interface AiClient {
  /** Resolves to the parsed object, or null when the call or parse failed. */
  parse<T>(opts: { schema: z.ZodType<T>; system: string; user: string; maxTokens: number; effort: Effort; purpose: Purpose }): Promise<T | null>;
  /** Lets the model search the web; null when the call failed or was declined. */
  webResearch(opts: WebResearchOptions): Promise<ResearchResult | null>;
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
export const SEARCH_TOOLS = ["web_search_20260209", "web_search_20250305"] as const;
export type SearchToolType = (typeof SEARCH_TOOLS)[number];
/** The server pauses long search turns; this many continuations are allowed. */
const MAX_CONTINUATIONS = 3;
/** The web search tool takes at most this many allowed domains. */
export const MAX_ALLOWED_DOMAINS = 64;
/**
 * What a restricted search falls back to when the API refuses its domain
 * list: the Red Cross and Red Crescent movement's international bodies and
 * the UN's own sites, plain domains the API accepts.
 */
export const FALLBACK_SEARCH_DOMAINS: readonly string[] = [...MOVEMENT_DOMAINS, ...UN_DOMAINS];

/** Allowed domains as the API takes them: trimmed, lower case, each once, at most 64; empty when none is usable. */
export function cleanAllowedDomains(domains: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of domains ?? []) {
    const d = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (d && !out.includes(d) && out.length < MAX_ALLOWED_DOMAINS) out.push(d);
  }
  return out;
}

/**
 * The narrower list to retry with when the API refuses a domain list: the
 * fallback domains the caller allowed, so a retry never searches a site the
 * caller left out. Empty when there is nothing narrower to try.
 */
export function fallbackDomains(domains: readonly string[]): string[] {
  const narrower = FALLBACK_SEARCH_DOMAINS.filter((d) => domains.includes(d));
  return narrower.length > 0 && narrower.length < domains.length ? narrower : [];
}

/** The web search tool definition, restricted to allowedDomains when any are given. */
export function searchToolDefinition(
  type: SearchToolType,
  maxUses: number,
  allowedDomains?: readonly string[],
): Anthropic.WebSearchTool20250305 | Anthropic.WebSearchTool20260209 {
  const domains = cleanAllowedDomains(allowedDomains);
  return { type, name: "web_search", max_uses: maxUses, ...(domains.length ? { allowed_domains: domains } : {}) };
}

/**
 * What to send after the API refused a search's first request (a 400), or
 * null to give up: a narrower domain list on the same tool first, once, so
 * a refused site never downgrades the tool for the rest of the run; then
 * the basic search tool with the call's full list again.
 */
export function retryAfterRejection(
  attempt: { tool: number; domains: string[] },
  fullDomains: string[],
): { tool: number; domains: string[]; reason: "domains" | "tool" } | null {
  const narrower = fallbackDomains(attempt.domains);
  if (narrower.length > 0) return { tool: attempt.tool, domains: narrower, reason: "domains" };
  if (attempt.tool < SEARCH_TOOLS.length - 1) return { tool: attempt.tool + 1, domains: fullDomains, reason: "tool" };
  return null;
}

/**
 * Returns null when no credentials are configured, so the run continues
 * without AI. Tests pass their own client; the run makes a real one.
 */
export function createAiClient(log: (msg: string) => void, onUsage: UsageHook = () => {}, injected?: Anthropic): AiClient | null {
  if (!injected && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) return null;
  const client = injected ?? new Anthropic();
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

    async webResearch({ system, user, maxSearches, maxTokens, effort, purpose, allowedDomains }) {
      calls++;
      const messages: Anthropic.MessageParam[] = [{ role: "user", content: user }];
      const content: Anthropic.ContentBlock[] = [];
      const fullDomains = cleanAllowedDomains(allowedDomains);
      // The domains this call searches; narrowed if the API refuses the list.
      let domains = fullDomains;
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
              tools: [searchToolDefinition(SEARCH_TOOLS[searchTool], maxSearches, domains)],
              output_config: { effort },
            } as Anthropic.MessageCreateParamsNonStreaming);
          } catch (err) {
            // A refused first request is tried again: with a narrower domain
            // list, or, for a model without dynamic filtering, the basic tool.
            const next = err instanceof Anthropic.BadRequestError && turn === 0 ? retryAfterRejection({ tool: searchTool, domains }, fullDomains) : null;
            if (!next) throw err;
            const why = (err as Error).message.slice(0, 120);
            if (next.reason === "domains") log(`  search with ${domains.length} allowed domains rejected (${why}); retrying with ${next.domains.join(", ")}`);
            else log(`  ${SEARCH_TOOLS[searchTool]} rejected (${why}); using ${SEARCH_TOOLS[next.tool]}`);
            searchTool = next.tool;
            domains = next.domains;
            turn--;
            continue;
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
