// Monthly spend ledger and budget guard for every Claude API call the
// pipeline makes (translation, grouping, news extraction, web research).
// Each response's usage is priced and added to cache/spend.json by month
// and by UTC day. The guard functions decide whether any model call may run
// this month and how much web research may still spend today, so the total
// stays under the monthly budget in pipeline/config/budget.json.
import fs from "node:fs";
import type { Purpose, Usage } from "./ai";
import { writeJson } from "./io";

/** USD per million tokens for one rate card. */
export interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  /** The 5-minute cache write rate; the pipeline never asks for 1-hour caching. */
  cacheWrite: number;
}

export interface ModelPrice {
  base: Rates;
  /** A second rate card for requests whose prompt is longer than overTokens. */
  long?: { overTokens: number; rates: Rates };
}

/**
 * Anthropic list prices from https://platform.claude.com/docs/en/about-claude/pricing
 * (checked October 2026). A request's prompt length for the Haiku 5.5 tier
 * counts input, cache read and cache write tokens.
 */
export const PRICES: Record<string, ModelPrice> = {
  "claude-haiku-5-5": {
    base: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
    long: { overTokens: 100_000, rates: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 } },
  },
  "claude-sonnet-5-5": { base: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 } },
  "claude-opus-5-5": { base: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } },
  // Other models the GLOBAL_VIEW_*MODEL variables might name, so they are not
  // mispriced as Opus 5.5 (Fable costs more than Opus).
  "claude-fable-5-1": { base: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 } },
  "claude-fable-5": { base: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 } },
  "claude-opus-5": { base: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
  "claude-opus-4-8": { base: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
  "claude-sonnet-5": { base: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } },
  "claude-sonnet-4-6": { base: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
  "claude-haiku-4-5": { base: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } },
};

/** Models missing from PRICES are charged at this model's rates. */
export const FALLBACK_MODEL = "claude-opus-5-5";

/** Web search costs $10 per 1,000 searches. */
export const WEB_SEARCH_USD = 0.01;

/** Default ledger location; GitHub Actions keeps the cache folder between runs. */
export const LEDGER_PATH = "cache/spend.json";
export const BUDGET_PATH = "pipeline/config/budget.json";

const MILLION = 1_000_000;
const DAY_MS = 86_400_000;

/** Every purpose, checked against the Purpose type so a new one is not missed. */
const PURPOSE_KEYS: Record<Purpose, true> = { translate: true, group: true, research: true, news: true };
export const PURPOSES = Object.keys(PURPOSE_KEYS) as Purpose[];

export interface DaySpend {
  usd: number;
  /** USD spent on web research that day. */
  research: number;
}

export interface MonthSpend {
  usd: number;
  /** API responses recorded (a research call that pauses and resumes counts each response). */
  calls: number;
  searches: number;
  /** Responses recorded with purpose "research" (search turns, continuations and parses). */
  researchCalls: number;
  /** Disasters researched (one search turn plus its parse), for averageResearchCost. */
  researches: number;
  byPurpose: Record<Purpose, number>;
  /** Keyed by UTC day, YYYY-MM-DD. */
  byDay: Record<string, DaySpend>;
}

export interface Ledger {
  /** Keyed by UTC month, YYYY-MM. */
  months: Record<string, MonthSpend>;
}

export interface Budget {
  /** The most the pipeline may spend on the Claude API in one calendar month (UTC). */
  monthlyUsd: number;
  /** Kept back from monthlyUsd for pricing drift and calls the ledger missed. */
  safetyUsd: number;
  /** Assumed daily spend on translation, grouping and news before a full day has been seen. */
  defaultDailyOtherUsd: number;
  /** Most web research calls one pipeline run may make. */
  maxResearchPerRun: number;
}

export const DEFAULT_BUDGET: Budget = { monthlyUsd: 50, safetyUsd: 3, defaultDailyOtherUsd: 0.6, maxResearchPerRun: 12 };

/** Logs an unknown model once per process, so a run does not repeat the warning per call. */
const warnedModels = new Set<string>();
function warnOnce(msg: string): void {
  if (warnedModels.has(msg)) return;
  warnedModels.add(msg);
  console.warn(msg);
}

/** Rounds to a millionth of a dollar so sums do not collect float noise. */
function roundUsd(usd: number): number {
  return Math.round(usd * MILLION) / MILLION;
}

/** A token count from usage, treating missing, negative or non-numeric values as zero. */
function count(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

/** Strips platform prefixes and date or context suffixes: "anthropic.claude-haiku-5-5-20261001" -> "claude-haiku-5-5". */
export function normaliseModel(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/^(?:[a-z]+\.)*(?=claude-)/, "")
    .replace(/\[[^\]]*\]$/, "")
    .replace(/(?:@|-)\d{8}$/, "")
    .replace(/-v\d+(?::\d+)?$/, "");
}

/** The price card for a model, or null when the model is not in PRICES. */
export function priceFor(model: string): ModelPrice | null {
  return PRICES[normaliseModel(model)] ?? null;
}

/** USD cost of one API response: tokens at the model's rates plus web searches. */
export function costOf(usage: Usage, log: (msg: string) => void = warnOnce): number {
  let price = priceFor(usage.model);
  if (!price) {
    log(`spend: unknown model "${usage.model}", priced as ${FALLBACK_MODEL}`);
    price = PRICES[FALLBACK_MODEL];
  }
  const input = count(usage.inputTokens);
  const cacheRead = count(usage.cacheReadTokens);
  const cacheWrite = count(usage.cacheWriteTokens);
  const prompt = input + cacheRead + cacheWrite;
  const rates = price.long && prompt > price.long.overTokens ? price.long.rates : price.base;
  const tokensUsd =
    (input * rates.input + count(usage.outputTokens) * rates.output + cacheRead * rates.cacheRead + cacheWrite * rates.cacheWrite) / MILLION;
  return roundUsd(tokensUsd + count(usage.webSearches) * WEB_SEARCH_USD);
}

/** The UTC month of an ISO time, YYYY-MM. */
export function monthKey(now: string): string {
  return new Date(now).toISOString().slice(0, 7);
}

/** The UTC day of an ISO time, YYYY-MM-DD. */
export function dayKey(now: string): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Days left in the UTC month, counting today. */
export function daysLeftInMonth(now: string): number {
  const d = new Date(now);
  const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  return daysInMonth - d.getUTCDate() + 1;
}

export function emptyLedger(): Ledger {
  return { months: {} };
}

function emptyMonth(): MonthSpend {
  const byPurpose = Object.fromEntries(PURPOSES.map((p) => [p, 0])) as Record<Purpose, number>;
  return { usd: 0, calls: 0, searches: 0, researchCalls: 0, researches: 0, byPurpose, byDay: {} };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Rebuilds one month from parsed JSON, zeroing bad numbers and dropping bad days. */
function sanitizeMonth(raw: unknown): MonthSpend | null {
  if (!isObject(raw)) return null;
  const month = emptyMonth();
  month.usd = count(raw.usd);
  month.calls = count(raw.calls);
  month.searches = count(raw.searches);
  month.researchCalls = count(raw.researchCalls);
  month.researches = count(raw.researches);
  const byPurpose = isObject(raw.byPurpose) ? raw.byPurpose : {};
  for (const p of PURPOSES) month.byPurpose[p] = count(byPurpose[p]);
  const byDay = isObject(raw.byDay) ? raw.byDay : {};
  for (const [day, spend] of Object.entries(byDay)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !isObject(spend)) continue;
    month.byDay[day] = { usd: count(spend.usd), research: count(spend.research) };
  }
  return month;
}

/** Reads the ledger; an empty one when the file is missing or not valid JSON. Bad months are dropped. */
export function readLedger(path: string = LEDGER_PATH): Ledger {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return emptyLedger();
  }
  const ledger = emptyLedger();
  if (!isObject(parsed) || !isObject(parsed.months)) return ledger;
  for (const [key, raw] of Object.entries(parsed.months)) {
    const month = /^\d{4}-\d{2}$/.test(key) ? sanitizeMonth(raw) : null;
    if (month) ledger.months[key] = month;
  }
  return ledger;
}

export function writeLedger(ledger: Ledger, path: string = LEDGER_PATH): void {
  writeJson(path, ledger);
}

/** Adds one response's cost to the ledger under now's month and day; returns the cost. */
export function record(ledger: Ledger, purpose: Purpose, usage: Usage, now: string, log?: (msg: string) => void): number {
  const cost = costOf(usage, log);
  const key = monthKey(now);
  const month = (ledger.months[key] ??= emptyMonth());
  const day = (month.byDay[dayKey(now)] ??= { usd: 0, research: 0 });
  month.usd = roundUsd(month.usd + cost);
  month.calls += 1;
  month.searches += count(usage.webSearches);
  month.byPurpose[purpose] = roundUsd((month.byPurpose[purpose] ?? 0) + cost);
  day.usd = roundUsd(day.usd + cost);
  if (purpose === "research") {
    month.researchCalls += 1;
    day.research = roundUsd(day.research + cost);
  }
  return cost;
}

/** Counts one researched disaster under now's month, whatever number of responses it took. */
export function noteResearch(ledger: Ledger, now: string): void {
  const month = (ledger.months[monthKey(now)] ??= emptyMonth());
  month.researches += 1;
}

/** Keeps the current UTC month and the keepMonths - 1 before it (and any later ones); returns the ledger. */
export function pruneLedger(ledger: Ledger, now: string, keepMonths = 3): Ledger {
  const d = new Date(now);
  const oldest = monthKey(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - (keepMonths - 1), 1)).toISOString());
  for (const key of Object.keys(ledger.months)) {
    if (key < oldest) delete ledger.months[key];
  }
  return ledger;
}

/** A budget value from config, or the default when it is missing or not a sensible number. */
function budgetValue(raw: Record<string, unknown>, key: keyof Budget): number {
  const v = raw[key];
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : DEFAULT_BUDGET[key];
}

/** Reads the budget config, falling back to DEFAULT_BUDGET for a missing file or bad fields. */
export function loadBudget(path: string = BUDGET_PATH): Budget {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return { ...DEFAULT_BUDGET };
  }
  const obj = isObject(raw) ? raw : {};
  return {
    monthlyUsd: budgetValue(obj, "monthlyUsd"),
    safetyUsd: budgetValue(obj, "safetyUsd"),
    defaultDailyOtherUsd: budgetValue(obj, "defaultDailyOtherUsd"),
    maxResearchPerRun: Math.floor(budgetValue(obj, "maxResearchPerRun")),
  };
}

/** USD spent so far in now's UTC month. */
export function monthSpent(ledger: Ledger, now: string): number {
  return ledger.months[monthKey(now)]?.usd ?? 0;
}

/** False once this month's spend reaches monthlyUsd - safetyUsd; then no model call should run until next month. */
export function canSpend(ledger: Ledger, budget: Budget, now: string): boolean {
  return monthSpent(ledger, now) < budget.monthlyUsd - budget.safetyUsd;
}

/**
 * Average daily spend on everything but research this month, measured from
 * the first day with data (the ledger may have started mid-month). Before one
 * full day of data it is the budget's defaultDailyOtherUsd.
 */
export function dailyOtherSpend(ledger: Ledger, budget: Budget, now: string): number {
  const month = ledger.months[monthKey(now)];
  if (!month) return budget.defaultDailyOtherUsd;
  const firstDay = Object.keys(month.byDay).sort()[0] ?? `${monthKey(now)}-01`;
  const elapsedDays = (Date.parse(now) - Date.parse(`${firstDay}T00:00:00Z`)) / DAY_MS;
  if (!(elapsedDays >= 1)) return budget.defaultDailyOtherUsd;
  return Math.max(0, month.usd - (month.byPurpose.research ?? 0)) / elapsedDays;
}

/**
 * USD that web research may still spend today (UTC). What was left of the
 * month's budget when today began, less the projected spend on everything
 * else for the rest of the month (today included), is shared evenly over
 * the days left including today; today's research spend so far comes off
 * today's share. Never more than what is left of the month's budget now.
 */
export function researchAllowance(ledger: Ledger, budget: Budget, now: string): number {
  const remaining = budget.monthlyUsd - budget.safetyUsd - monthSpent(ledger, now);
  if (remaining <= 0) return 0;
  const today = ledger.months[monthKey(now)]?.byDay[dayKey(now)] ?? { usd: 0, research: 0 };
  const daysLeft = daysLeftInMonth(now);
  // Today's spend so far is added back, so it is counted once: in the
  // projection for other spend, and as today's research below.
  const pool = remaining + today.usd - dailyOtherSpend(ledger, budget, now) * daysLeft;
  return roundUsd(Math.max(0, Math.min(remaining, pool / daysLeft - today.research)));
}

/** Mean USD of researching one disaster this month (search turns plus parses), or fallback before the first one. */
export function averageResearchCost(ledger: Ledger, now: string, fallback = 0.06): number {
  const month = ledger.months[monthKey(now)];
  if (!month || month.researches === 0) return fallback;
  return roundUsd((month.byPurpose.research ?? 0) / month.researches);
}
