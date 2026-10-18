// Pure helpers for the "who is reading about whom" view.
import type { AttentionFile } from "./data";

export interface Mention {
  code: string;
  count: number;
}

/** Countries that `code`'s top stories are about, most first. */
export function outbound(att: AttentionFile | null, code: string, limit = 8): Mention[] {
  const row = att?.mentions[code] ?? {};
  return sortMentions(Object.entries(row).map(([c, count]) => ({ code: c, count }))).slice(0, limit);
}

/** Countries whose top stories are about `code`, most first. */
export function inbound(att: AttentionFile | null, code: string, limit = 8): Mention[] {
  const out: Mention[] = [];
  for (const [from, row] of Object.entries(att?.mentions ?? {})) {
    if (row[code]) out.push({ code: from, count: row[code] });
  }
  return sortMentions(out).slice(0, limit);
}

function sortMentions(m: Mention[]): Mention[] {
  return m.sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

/** Scales counts to 0..1 for tinting the globe, the largest count being 1. */
export function tintMap(mentions: Mention[]): Map<string, number> {
  const max = Math.max(1, ...mentions.map((m) => m.count));
  return new Map(mentions.map((m) => [m.code, m.count / max]));
}
