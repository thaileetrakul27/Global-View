import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Purpose, Usage } from "./ai";
import {
  DEFAULT_BUDGET,
  PRICES,
  WEB_SEARCH_USD,
  averageResearchCost,
  canSpend,
  costOf,
  dailyOtherSpend,
  dayKey,
  daysLeftInMonth,
  emptyLedger,
  loadBudget,
  monthKey,
  monthSpent,
  noteResearch,
  normaliseModel,
  priceFor,
  pruneLedger,
  readLedger,
  record,
  researchAllowance,
  writeLedger,
  type Ledger,
  type MonthSpend,
} from "./spend";

/** A usage block with zero tokens, overridden per test. */
function usage(over: Partial<Usage> = {}): Usage {
  return { model: "claude-haiku-5-5", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0, ...over };
}

/** A month record with the given totals, for budget tests. */
function month(over: Partial<MonthSpend> = {}): MonthSpend {
  return {
    usd: 0,
    calls: 0,
    searches: 0,
    researchCalls: 0,
    researches: 0,
    byPurpose: { translate: 0, group: 0, research: 0, news: 0 },
    byDay: {},
    ...over,
  };
}

const BUDGET = { ...DEFAULT_BUDGET };
const CAP = BUDGET.monthlyUsd - BUDGET.safetyUsd; // 47

/**
 * Rows of the real model pricing table at
 * https://platform.claude.com/docs/en/about-claude/pricing (fetched 2026-10-19),
 * trimmed to the models the pipeline uses. Columns: base input, 5m cache
 * writes, 1h cache writes, cache hits, output.
 */
const PRICING_ROWS = `
| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok<sup>2</sup> | $20 / MTok |
| Claude Sonnet 5.5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.10 / MTok<sup>2</sup> | $10 / MTok |
| Claude Haiku 5.5 (for prompts up to 100,000 tokens) | $0.10 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 / MTok | $0.50 / MTok |
| Claude Haiku 5.5 (for prompts over 100,000 tokens) | $0.50 / MTok | $0.625 / MTok | $1 / MTok | $0.05 / MTok | $2.50 / MTok |
| Claude Fable 5.1 | $10 / MTok | $12.50 / MTok | $20 / MTok | $0.25 / MTok<sup>1</sup> | $50 / MTok |
`;

describe("PRICES", () => {
  it("matches the published pricing table", () => {
    const rows = PRICING_ROWS.trim().split("\n").map((line) => {
      const cells = line.split("|").slice(1, -1).map((c) => c.trim());
      const dollars = cells.slice(1).map((c) => Number(c.match(/\$([\d.]+)/)![1]));
      return { name: cells[0], input: dollars[0], cacheWrite: dollars[1], cacheRead: dollars[3], output: dollars[4] };
    });
    const card = (name: string) => {
      const { input, output, cacheRead, cacheWrite } = rows.find((r) => r.name === name)!;
      return { input, output, cacheRead, cacheWrite };
    };
    expect(PRICES["claude-opus-5-5"].base).toEqual(card("Claude Opus 5.5"));
    expect(PRICES["claude-sonnet-5-5"].base).toEqual(card("Claude Sonnet 5.5"));
    expect(PRICES["claude-haiku-5-5"].base).toEqual(card("Claude Haiku 5.5 (for prompts up to 100,000 tokens)"));
    expect(PRICES["claude-haiku-5-5"].long).toEqual({ overTokens: 100_000, rates: card("Claude Haiku 5.5 (for prompts over 100,000 tokens)") });
    expect(PRICES["claude-fable-5-1"].base).toEqual(card("Claude Fable 5.1"));
    expect(WEB_SEARCH_USD).toBe(0.01);
  });
});

describe("normaliseModel / priceFor", () => {
  it("strips platform prefixes and date or version suffixes", () => {
    expect(normaliseModel("claude-haiku-5-5")).toBe("claude-haiku-5-5");
    expect(normaliseModel("anthropic.claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
    expect(normaliseModel("us.anthropic.claude-opus-5-5-v1:0")).toBe("claude-opus-5-5");
    expect(normaliseModel("claude-haiku-5-5-20261001")).toBe("claude-haiku-5-5");
    expect(normaliseModel("claude-opus-5-5@20261001")).toBe("claude-opus-5-5");
    expect(normaliseModel(" Claude-Opus-5-5[1m] ")).toBe("claude-opus-5-5");
  });

  it("does not confuse a model with a shorter name inside it", () => {
    expect(priceFor("claude-opus-5-5")).toBe(PRICES["claude-opus-5-5"]);
    expect(priceFor("claude-opus-5")).toBe(PRICES["claude-opus-5"]);
    expect(priceFor("claude-opus-9-9")).toBeNull();
  });
});

describe("costOf", () => {
  it("prices Haiku 5.5 on the short-prompt rate card", () => {
    // Prompt = 50,000 + 20,000 + 10,000 = 80,000 tokens.
    const cost = costOf(usage({ inputTokens: 50_000, outputTokens: 10_000, cacheReadTokens: 20_000, cacheWriteTokens: 10_000 }));
    expect(cost).toBeCloseTo(0.005 + 0.005 + 0.0002 + 0.00125, 9);
  });

  it("keeps a prompt of exactly 100,000 tokens on the short card", () => {
    expect(costOf(usage({ inputTokens: 100_000, outputTokens: 1_000 }))).toBeCloseTo(0.01 + 0.0005, 9);
  });

  it("moves to the long-prompt card when input plus cache tokens pass 100,000", () => {
    // 90,000 input + 10,001 cache read = 100,001 tokens of prompt.
    const cost = costOf(usage({ inputTokens: 90_000, cacheReadTokens: 10_001, outputTokens: 1_000 }));
    expect(cost).toBeCloseTo(90_000 * 0.5e-6 + 10_001 * 0.05e-6 + 1_000 * 2.5e-6, 6);
    // Cache writes count toward the prompt length too.
    const writes = costOf(usage({ inputTokens: 1_000, cacheWriteTokens: 100_000 }));
    expect(writes).toBeCloseTo(1_000 * 0.5e-6 + 100_000 * 0.625e-6, 6);
  });

  it("adds a cent per web search", () => {
    expect(costOf(usage({ webSearches: 3 }))).toBeCloseTo(0.03, 9);
    expect(costOf(usage({ inputTokens: 10_000, outputTokens: 2_000, webSearches: 5 }))).toBeCloseTo(0.001 + 0.001 + 0.05, 9);
  });

  it("prices Sonnet 5.5 and Opus 5.5 with one rate card at any length", () => {
    const sonnet = usage({ model: "claude-sonnet-5-5", inputTokens: 200_000, outputTokens: 1_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 4_000 });
    expect(costOf(sonnet)).toBeCloseTo(0.4 + 0.01 + 0.1 + 0.01, 6);
    const opus = usage({ model: "claude-opus-5-5", inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 });
    expect(costOf(opus)).toBeCloseTo(4 + 2 + 0.2 + 5, 6);
  });

  it("prices an unknown model as Opus 5.5 and logs it", () => {
    const log = vi.fn();
    const tokens = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    expect(costOf(usage({ model: "claude-mystery-1", ...tokens }), log)).toBe(costOf(usage({ model: "claude-opus-5-5", ...tokens }), log));
    expect(costOf(usage({ model: "claude-mystery-1", ...tokens }), log)).toBeCloseTo(24, 9);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0][0]).toContain("claude-mystery-1");
  });

  it("treats missing or negative counts as zero", () => {
    const odd = { ...usage(), inputTokens: -5, outputTokens: Number.NaN, webSearches: undefined } as unknown as Usage;
    expect(costOf(odd)).toBe(0);
  });
});

describe("keys and calendar", () => {
  it("uses UTC months and days", () => {
    expect(monthKey("2026-11-01T03:00:00+07:00")).toBe("2026-10");
    expect(dayKey("2026-11-01T03:00:00+07:00")).toBe("2026-10-31");
  });

  it("counts days left including today", () => {
    expect(daysLeftInMonth("2026-10-01T00:00:00Z")).toBe(31);
    expect(daysLeftInMonth("2026-10-31T23:59:00Z")).toBe(1);
    expect(daysLeftInMonth("2028-02-15T12:00:00Z")).toBe(15); // leap year, 29 days
  });
});

describe("record", () => {
  it("adds cost to the month, purpose and UTC day, and returns it", () => {
    const ledger = emptyLedger();
    const now = "2026-10-19T09:00:00Z";
    const a = record(ledger, "translate", usage({ inputTokens: 10_000, outputTokens: 2_000 }), now);
    const b = record(ledger, "research", usage({ inputTokens: 20_000, outputTokens: 4_000, webSearches: 4 }), now);
    record(ledger, "research", usage({ inputTokens: 20_000, outputTokens: 4_000, webSearches: 2 }), "2026-10-20T01:00:00Z");
    expect(a).toBeCloseTo(0.002, 9);
    expect(b).toBeCloseTo(0.004 + 0.04, 9);
    const m = ledger.months["2026-10"];
    expect(m.usd).toBeCloseTo(0.002 + 0.044 + 0.024, 9);
    expect(m.calls).toBe(3);
    expect(m.searches).toBe(6);
    expect(m.researchCalls).toBe(2);
    // Researched disasters are counted by noteResearch, not by record.
    expect(m.researches).toBe(0);
    expect(m.byPurpose).toEqual({ translate: 0.002, group: 0, research: 0.068, news: 0 });
    expect(m.byDay["2026-10-19"]).toEqual({ usd: 0.046, research: 0.044 });
    expect(m.byDay["2026-10-20"]).toEqual({ usd: 0.024, research: 0.024 });
  });

  it("files a call made just after midnight UTC under the new month", () => {
    const ledger = emptyLedger();
    record(ledger, "news", usage({ outputTokens: 1_000_000 }), "2026-10-31T23:59:59Z");
    record(ledger, "news", usage({ outputTokens: 1_000_000 }), "2026-11-01T00:00:01Z");
    expect(Object.keys(ledger.months).sort()).toEqual(["2026-10", "2026-11"]);
    expect(ledger.months["2026-11"].usd).toBe(0.5);
  });

  it("passes unknown-model warnings to the given log", () => {
    const log = vi.fn();
    record(emptyLedger(), "group", usage({ model: "gpt-x" }), "2026-10-19T00:00:00Z", log);
    expect(log).toHaveBeenCalledOnce();
  });
});

describe("readLedger / writeLedger", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "spend-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a ledger, creating folders as needed", () => {
    const ledger = emptyLedger();
    record(ledger, "research", usage({ inputTokens: 5_000, webSearches: 1 }), "2026-10-19T09:00:00Z");
    record(ledger, "translate", usage({ outputTokens: 3_000 }), "2026-09-02T09:00:00Z");
    const file = path.join(dir, "nested", "spend.json");
    writeLedger(ledger, file);
    expect(readLedger(file)).toEqual(ledger);
  });

  it("returns an empty ledger when the file is missing or corrupt", () => {
    expect(readLedger(path.join(dir, "none.json"))).toEqual({ months: {} });
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, "{ not json");
    expect(readLedger(bad)).toEqual({ months: {} });
    fs.writeFileSync(bad, JSON.stringify([1, 2, 3]));
    expect(readLedger(bad)).toEqual({ months: {} });
    fs.writeFileSync(bad, JSON.stringify({ months: "x" }));
    expect(readLedger(bad)).toEqual({ months: {} });
  });

  it("keeps good months, zeroes bad numbers and fills fields older files lack", () => {
    const file = path.join(dir, "partial.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        months: {
          "2026-10": { usd: 12.5, calls: 40, searches: -3, byPurpose: { translate: 2, research: "x" }, byDay: { "2026-10-01": { usd: 1, research: 0.5 }, nope: { usd: 1 } } },
          "October": { usd: 1 },
          "2026-09": null,
        },
      }),
    );
    expect(readLedger(file)).toEqual({
      months: {
        "2026-10": month({ usd: 12.5, calls: 40, byPurpose: { translate: 2, group: 0, research: 0, news: 0 }, byDay: { "2026-10-01": { usd: 1, research: 0.5 } } }),
      },
    });
  });
});

describe("pruneLedger", () => {
  it("keeps the current month and the two before it", () => {
    const ledger: Ledger = { months: Object.fromEntries(["2026-06", "2026-07", "2026-08", "2026-09", "2026-10"].map((k) => [k, month({ usd: 1 })])) };
    pruneLedger(ledger, "2026-10-19T00:00:00Z");
    expect(Object.keys(ledger.months).sort()).toEqual(["2026-08", "2026-09", "2026-10"]);
  });

  it("works across a year boundary and with a custom window", () => {
    const keys = ["2026-10", "2026-11", "2026-12", "2027-01"];
    const ledger: Ledger = { months: Object.fromEntries(keys.map((k) => [k, month()])) };
    expect(Object.keys(pruneLedger(ledger, "2027-01-05T00:00:00Z").months).sort()).toEqual(["2026-11", "2026-12", "2027-01"]);
    expect(Object.keys(pruneLedger(ledger, "2027-01-05T00:00:00Z", 1).months)).toEqual(["2027-01"]);
  });
});

describe("loadBudget", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads the checked-in config", () => {
    expect(loadBudget()).toEqual({ monthlyUsd: 50, safetyUsd: 3, defaultDailyOtherUsd: 0.6, maxResearchPerRun: 12 });
  });

  it("falls back to defaults for a missing file or bad fields", () => {
    expect(loadBudget(path.join(dir, "none.json"))).toEqual(DEFAULT_BUDGET);
    const file = path.join(dir, "b.json");
    fs.writeFileSync(file, JSON.stringify({ monthlyUsd: 80, safetyUsd: -1, defaultDailyOtherUsd: "1", maxResearchPerRun: 7.9 }));
    expect(loadBudget(file)).toEqual({ monthlyUsd: 80, safetyUsd: 3, defaultDailyOtherUsd: 0.6, maxResearchPerRun: 7 });
  });
});

describe("monthSpent / canSpend", () => {
  const now = "2026-10-19T12:00:00Z";
  const at = (usd: number): Ledger => ({ months: { "2026-10": month({ usd }), "2026-09": month({ usd: 49 }) } });

  it("reads only the current month", () => {
    expect(monthSpent(emptyLedger(), now)).toBe(0);
    expect(monthSpent(at(12.34), now)).toBe(12.34);
  });

  it("stops at monthlyUsd - safetyUsd", () => {
    expect(canSpend(emptyLedger(), BUDGET, now)).toBe(true);
    expect(canSpend(at(CAP - 0.000001), BUDGET, now)).toBe(true);
    expect(canSpend(at(CAP), BUDGET, now)).toBe(false);
    expect(canSpend(at(CAP + 0.5), BUDGET, now)).toBe(false);
  });

  it("opens again in a new month", () => {
    expect(canSpend(at(CAP + 2), BUDGET, "2026-11-01T00:00:00Z")).toBe(true);
  });
});

describe("dailyOtherSpend", () => {
  it("uses the default before a full day of data", () => {
    expect(dailyOtherSpend(emptyLedger(), BUDGET, "2026-10-01T05:00:00Z")).toBe(0.6);
    const ledger: Ledger = { months: { "2026-10": month({ usd: 3, byDay: { "2026-10-10": { usd: 3, research: 0 } } }) } };
    expect(dailyOtherSpend(ledger, BUDGET, "2026-10-10T23:00:00Z")).toBe(0.6);
  });

  it("averages non-research spend from the first day with data", () => {
    const byPurpose = { translate: 3, group: 1, research: 5, news: 2 };
    const ledger: Ledger = { months: { "2026-10": month({ usd: 11, byPurpose, byDay: { "2026-10-12": { usd: 2, research: 1 }, "2026-10-10": { usd: 9, research: 4 } } }) } };
    // 6 USD of non-research spend over 2.5 days since 10 October.
    expect(dailyOtherSpend(ledger, BUDGET, "2026-10-12T12:00:00Z")).toBeCloseTo(6 / 2.5, 9);
  });
});

describe("researchAllowance", () => {
  it("shares the month evenly on day 1 with no data", () => {
    // 47 left, 31 days, 0.60 a day projected for other work.
    const expected = (CAP - 0.6 * 31) / 31;
    expect(researchAllowance(emptyLedger(), BUDGET, "2026-10-01T00:30:00Z")).toBeCloseTo(expected, 6);
    expect(expected).toBeCloseTo(0.916129, 6);
  });

  it("uses the observed daily spend mid-month and subtracts today's research", () => {
    const byPurpose: Record<Purpose, number> = { translate: 7, group: 3, research: 8, news: 2 };
    const byDay = { "2026-10-01": { usd: 1, research: 0.4 }, "2026-10-16": { usd: 0.5, research: 0.3 } };
    const ledger: Ledger = { months: { "2026-10": month({ usd: 20, byPurpose, byDay, researchCalls: 100 }) } };
    const now = "2026-10-16T12:00:00Z";
    const daysLeft = 16;
    const avgOther = 12 / 15.5;
    // The 0.50 spent today is added back: it is covered by today's projection.
    const expected = (CAP - 20 + 0.5 - avgOther * daysLeft) / daysLeft - 0.3;
    expect(researchAllowance(ledger, BUDGET, now)).toBeCloseTo(expected, 6);
    expect(expected).toBeGreaterThan(0.5);
  });

  it("is zero once today's share is used", () => {
    const byPurpose: Record<Purpose, number> = { translate: 7, group: 3, research: 8, news: 2 };
    const byDay = { "2026-10-01": { usd: 1, research: 0.4 }, "2026-10-16": { usd: 2, research: 1.5 } };
    const ledger: Ledger = { months: { "2026-10": month({ usd: 20, byPurpose, byDay }) } };
    expect(researchAllowance(ledger, BUDGET, "2026-10-16T12:00:00Z")).toBe(0);
  });

  it("is zero after overspending, even when the month is not yet at the cap", () => {
    // 40 spent by the 10th, 20 of it on other work over 9 days: the 7 left
    // cannot cover 22 more days of other work at about 2.22 a day.
    const byPurpose: Record<Purpose, number> = { translate: 10, group: 5, research: 20, news: 5 };
    const ledger: Ledger = { months: { "2026-10": month({ usd: 40, byPurpose, byDay: { "2026-10-01": { usd: 2, research: 1 } } }) } };
    expect(researchAllowance(ledger, BUDGET, "2026-10-10T00:00:00Z")).toBe(0);
    const capped: Ledger = { months: { "2026-10": month({ usd: CAP + 1 }) } };
    expect(researchAllowance(capped, BUDGET, "2026-10-30T00:00:00Z")).toBe(0);
  });

  it("starts fresh when the month rolls over", () => {
    const byPurpose: Record<Purpose, number> = { translate: 10, group: 5, research: 30, news: 1 };
    const ledger: Ledger = { months: { "2026-10": month({ usd: 46, byPurpose, byDay: { "2026-10-31": { usd: 2, research: 1.8 } } }) } };
    // 3 were left when the 31st began; 0.60 is projected for other work, and
    // 1.80 of research is already spent today.
    expect(researchAllowance(ledger, BUDGET, "2026-10-31T22:00:00Z")).toBeCloseTo(3 - 0.6 - 1.8, 6);
    // November has 30 days.
    expect(researchAllowance(ledger, BUDGET, "2026-11-01T00:10:00Z")).toBeCloseTo((CAP - 0.6 * 30) / 30, 6);
  });

  it("takes each dollar of research today off today's allowance once", () => {
    // 40 spent by the end of the 30th, then the check on the 31st.
    const byPurpose: Record<Purpose, number> = { translate: 10, group: 0, research: 30, news: 0 };
    const before: Ledger = { months: { "2026-10": month({ usd: 40, byPurpose, byDay: { "2026-10-01": { usd: 1, research: 0.5 } } }) } };
    const now = "2026-10-31T09:00:00Z";
    const start = researchAllowance(before, BUDGET, now);
    expect(start).toBeCloseTo(CAP - 40 - 10 / 30.375, 6);
    record(before, "research", usage({ webSearches: 100 }), now);
    expect(researchAllowance(before, BUDGET, now)).toBeCloseTo(start - 1, 6);
  });

  it("never allows more than what is left of the month", () => {
    // Heavy other spend earlier today pushes today's share above what is left.
    const byPurpose: Record<Purpose, number> = { translate: 5, group: 0, research: 0, news: 0 };
    const ledger: Ledger = { months: { "2026-10": month({ usd: 45, byPurpose: { ...byPurpose, translate: 45 }, byDay: { "2026-10-01": { usd: 1, research: 0 }, "2026-10-31": { usd: 5, research: 0 } } }) } };
    const allowance = researchAllowance(ledger, BUDGET, "2026-10-31T09:00:00Z");
    expect(allowance).toBeLessThanOrEqual(CAP - 45);
  });

  it("stays within the month's remaining budget on the last day", () => {
    const ledger: Ledger = { months: { "2026-10": month({ usd: 30, byPurpose: { translate: 15, group: 0, research: 15, news: 0 }, byDay: { "2026-10-01": { usd: 1, research: 0 } } }) } };
    const allowance = researchAllowance(ledger, BUDGET, "2026-10-31T06:00:00Z");
    expect(allowance).toBeGreaterThan(0);
    expect(allowance).toBeLessThanOrEqual(CAP - 30);
  });
});

describe("averageResearchCost", () => {
  it("falls back before any research this month", () => {
    expect(averageResearchCost(emptyLedger(), "2026-10-19T00:00:00Z")).toBe(0.06);
    expect(averageResearchCost(emptyLedger(), "2026-10-19T00:00:00Z", 0.1)).toBe(0.1);
  });

  it("averages this month's research per researched disaster, not per response", () => {
    const ledger = emptyLedger();
    // September does not count.
    record(ledger, "research", usage({ webSearches: 4 }), "2026-09-30T23:00:00Z");
    noteResearch(ledger, "2026-09-30T23:00:00Z");
    // One disaster: a search turn and its parse.
    record(ledger, "research", usage({ webSearches: 4 }), "2026-10-02T00:00:00Z");
    record(ledger, "research", usage({ outputTokens: 2_000 }), "2026-10-02T00:00:00Z");
    noteResearch(ledger, "2026-10-02T00:00:00Z");
    // Another: a search turn that paused and resumed, then its parse.
    record(ledger, "research", usage({ webSearches: 3 }), "2026-10-03T00:00:00Z");
    record(ledger, "research", usage({ webSearches: 2 }), "2026-10-03T00:00:00Z");
    record(ledger, "research", usage({ outputTokens: 2_000 }), "2026-10-03T00:00:00Z");
    noteResearch(ledger, "2026-10-03T00:00:00Z");
    record(ledger, "translate", usage({ outputTokens: 1_000_000 }), "2026-10-03T00:00:00Z");
    expect(ledger.months["2026-10"].researchCalls).toBe(5);
    expect(averageResearchCost(ledger, "2026-10-19T00:00:00Z")).toBeCloseTo((0.04 + 0.001 + 0.03 + 0.02 + 0.001) / 2, 9);
  });

  it("falls back while responses are recorded but no research has finished", () => {
    const ledger = emptyLedger();
    record(ledger, "research", usage({ webSearches: 4 }), "2026-10-02T00:00:00Z");
    expect(averageResearchCost(ledger, "2026-10-19T00:00:00Z")).toBe(0.06);
  });
});

describe("noteResearch", () => {
  it("counts one researched disaster under now's month and survives a save", () => {
    const ledger = emptyLedger();
    noteResearch(ledger, "2026-10-31T23:59:00Z");
    noteResearch(ledger, "2026-11-01T00:01:00Z");
    noteResearch(ledger, "2026-11-01T00:02:00Z");
    expect(ledger.months["2026-10"].researches).toBe(1);
    expect(ledger.months["2026-11"].researches).toBe(2);
    expect(ledger.months["2026-11"].usd).toBe(0);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gv-spend-")), "spend.json");
    writeLedger(ledger, file);
    expect(readLedger(file).months["2026-11"].researches).toBe(2);
  });
});
