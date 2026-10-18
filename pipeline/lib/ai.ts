// Thin wrapper around the Claude API: one method that returns parsed,
// schema-checked JSON or null. Everything else in the pipeline depends on
// this interface, so tests can pass a fake instead of a real client.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";

/** Headlines are short and the tasks are routine, so the small model is used. */
export const MODEL = process.env.GLOBAL_VIEW_MODEL ?? "claude-haiku-5-5";

export type Effort = "low" | "medium" | "high";

export interface AiClient {
  /** Resolves to the parsed object, or null when the call or parse failed. */
  parse<T>(opts: { schema: z.ZodType<T>; system: string; user: string; maxTokens: number; effort: Effort }): Promise<T | null>;
  /** Calls made so far, for the per-run cap and the log. */
  readonly calls: number;
}

/** Returns null when no credentials are configured, so the run continues without AI. */
export function createAiClient(log: (msg: string) => void): AiClient | null {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) return null;
  const client = new Anthropic();
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async parse({ schema, system, user, maxTokens, effort }) {
      calls++;
      try {
        const res = await client.messages.parse({
          model: MODEL,
          max_tokens: maxTokens,
          system,
          messages: [{ role: "user", content: user }],
          output_config: { format: zodOutputFormat(schema), effort },
        });
        if (res.stop_reason === "refusal") {
          log(`  model declined (${res.stop_details?.category ?? "unknown"})`);
          return null;
        }
        if (res.stop_reason === "max_tokens") log("  model output was cut off by max_tokens");
        return res.parsed_output ?? null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`  model call failed: ${msg}`);
        return null;
      }
    },
  };
}
