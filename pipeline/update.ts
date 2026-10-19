// Fetches each enabled country's top stories, translates new headlines,
// finds stories shared across countries, and writes the JSON the website
// reads. A country whose feed fails keeps its previous file; the run only
// fails outright if every feed fails, so stale data is never replaced
// with nothing. Without API credentials, or with --no-ai, the feeds are
// still published and the translation steps are skipped.
//
//   npm run pipeline:update
//   npm run pipeline:update -- --countries TH,GB --max 20
//   npm run pipeline:update -- --no-ai
import fs from "node:fs";
import { createAiClient } from "./lib/ai";
import { parseUpdateArgs } from "./lib/args";
import { buildAboutFiles, buildAttention } from "./lib/attention";
import { dedupeArticles } from "./lib/clean";
import { fetchBingFeed } from "./lib/bingnews";
import {
  loadCountryConfig,
  loadGlobeCodes,
  loadGlobeFeatures,
  loadLanguages,
  loadWorldQueries,
  selectCountries,
  worldCountries,
  type CountryConfig,
} from "./lib/countries";
import { buildSearchUrl, fetchFeed, fetchFeedUrl, type Article } from "./lib/googlenews";
import { sleep, writeJson } from "./lib/io";
import { mergeIndex, readIndex, type CountryFile, type IndexEntry } from "./lib/publish";
import { collectCandidates, findSharedStories, reconcileStories, type SharedFile } from "./lib/shared";
import { addDay, buildSnapshot, dayOf, readBaselines, type HistoryIndex } from "./lib/history";
import { buildResolver, fetchAlerts } from "./lib/alerts";
import { detectCrises, inboundEditions, loadCrisisTerms, type CrisesFile } from "./lib/crises";
import { refreshHelp, type HelpFile } from "./lib/help";
import { refreshNeeds, type NeedsFile } from "./lib/needs";
import { applyCache, pruneCache, readCache, translateNew, type EnrichedArticle } from "./lib/translate";

/** Most model calls one run may make; a guard against runaway cost. */
const MAX_AI_CALLS = 250;
/** World coverage lists are capped lower: they are a fallback, not a ranking. */
const MAX_WORLD_ARTICLES = 20;
/** Countries translated at the same time. Keeps the first run well under the job timeout. */
const TRANSLATE_CONCURRENCY = 4;
const CACHE_PATH = "cache/headlines.json";

interface Fetched {
  country: CountryConfig;
  feedUrl: string;
  articles: Article[];
}

/**
 * World coverage: what the country's own outlets publish, from Bing News
 * in the press language, followed by Google News search results in
 * English. Either source may fail; both failing keeps the previous data.
 */
async function fetchWorld(country: CountryConfig, delayMs: number, deps: typeof fetchDeps): Promise<{ url: string; articles: Article[] } | null> {
  const local = country.local ?? { lang: "en", name: country.name };
  const bing = await fetchBingFeed(local.name, country.code.slice(0, 2), local.lang, delayMs, deps);
  await deps.sleep(delayMs);
  const google = await fetchFeedUrl(buildSearchUrl(country.query ?? `"${country.name}"`), country.code, delayMs, deps);
  if (!bing && !google) return null;
  return { url: bing?.url ?? google!.url, articles: [...(bing?.articles ?? []), ...(google?.articles ?? [])] };
}
const fetchDeps = { fetch, sleep, log: console.log };

async function main() {
  const args = parseUpdateArgs(process.argv.slice(2));
  const local = loadCountryConfig();
  const world = worldCountries(local, loadGlobeFeatures(), loadWorldQueries(), loadLanguages());
  const countries = selectCountries([...local, ...world], args.countries);
  const indexPath = `${args.outDir}/index.json`;
  const previous = readIndex(indexPath);
  const log = console.log;
  const deps = { fetch, sleep, log };

  // 1. Feeds
  const localCount = countries.filter((c) => c.kind === "local").length;
  log(`Updating ${countries.length} countries: ${localCount} local editions, ${countries.length - localCount} world coverage`);
  const fetched: Fetched[] = [];
  const failed: string[] = [];
  for (const [i, country] of countries.entries()) {
    if (i > 0) await sleep(args.delayMs);
    const result = country.kind === "local" && country.edition ? await fetchFeed(country.edition, args.delayMs, deps) : await fetchWorld(country, args.delayMs, deps);
    if (!result) {
      failed.push(country.code);
      log(`  ${country.code}: kept previous data`);
      continue;
    }
    const max = country.kind === "local" ? args.maxArticles : Math.min(args.maxArticles, MAX_WORLD_ARTICLES);
    const articles = dedupeArticles(result.articles).slice(0, max);
    // A feed that is all junk today should not wipe yesterday's real list.
    if (articles.length === 0 && (previous?.countries[country.code]?.articles ?? 0) > 0) {
      failed.push(country.code);
      log(`  ${country.code}: nothing usable in feed, kept previous data`);
      continue;
    }
    fetched.push({ country, feedUrl: result.url, articles });
    log(`  ${country.code}${country.kind === "world" ? " (world)" : ""}: ${result.articles.length} in feed, ${articles.length} kept`);
  }
  if (failed.length === countries.length) throw new Error("Every country failed; nothing was written");

  // 2. Translation, from cache plus the model for anything new
  const now = new Date().toISOString();
  const ai = args.noAi ? null : createAiClient(log);
  if (!ai) log(args.noAi ? "AI disabled by --no-ai" : "No ANTHROPIC_API_KEY; publishing without new translations");
  const cache = readCache(CACHE_PATH);
  const globeCodes = loadGlobeCodes();
  let translated = 0;
  if (ai) {
    // A small pool of workers pulls countries off a shared queue.
    const queue = [...fetched];
    let capped = false;
    const worker = async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        if (ai.calls >= MAX_AI_CALLS) {
          capped = true;
          return;
        }
        const n = await translateNew(ai, f.country, f.articles, cache, globeCodes, now);
        translated += n;
        if (n) log(`  ${f.country.code}: ${n} headlines translated`);
      }
    };
    await Promise.all(Array.from({ length: TRANSLATE_CONCURRENCY }, worker));
    if (capped) log(`  reached the cap of ${MAX_AI_CALLS} model calls; remaining headlines wait for the next run`);
  }
  const enriched = fetched.map((f) => ({ ...f, articles: applyCache(f.articles, cache, now) }));
  const pruned = pruneCache(cache, now);
  writeJson(CACHE_PATH, pruned);
  log(`Translations: ${translated} new, ${Object.keys(pruned).length} cached`);

  // 3. Country files and index
  const fresh: Record<string, IndexEntry> = {};
  for (const f of enriched) {
    const file: CountryFile = {
      code: f.country.code,
      name: f.country.name,
      kind: f.country.kind,
      updated: now,
      source: {
        name: f.country.kind === "local" ? "Google News" : "Bing News and Google News",
        edition: f.country.kind === "local" ? (f.country.edition?.ceid ?? "") : "search",
        url: f.feedUrl,
      },
      articles: f.articles,
    };
    writeJson(`${args.outDir}/countries/${f.country.code}.json`, file);
    fresh[f.country.code] = { name: f.country.name, kind: f.country.kind, articles: f.articles.length, updated: now };
  }
  const untouched = Object.keys(previous?.countries ?? {}).filter(
    (code) => !(code in fresh) && !failed.includes(code) && !countries.some((c) => c.code === code),
  );
  const index = mergeIndex(previous, fresh, [...failed, ...untouched], now);
  writeJson(indexPath, index);
  log(`Wrote ${indexPath}: ${Object.keys(index.countries).length} countries${failed.length ? `, ${failed.length} kept from before (${failed.join(", ")})` : ""}`);

  // 4. Attention and shared stories use every published local country,
  //    including the ones kept from before. World coverage is left out: it
  //    is what others write about a country, not what that country reads.
  const all: { code: string; articles: EnrichedArticle[] }[] = enriched
    .filter((f) => f.country.kind === "local")
    .map((f) => ({ code: f.country.code, articles: f.articles }));
  for (const [code, entry] of Object.entries(index.countries)) {
    if ((entry.kind ?? "local") !== "local" || all.some((c) => c.code === code)) continue;
    const path = `${args.outDir}/countries/${code}.json`;
    if (fs.existsSync(path)) all.push({ code, articles: (JSON.parse(fs.readFileSync(path, "utf8")) as CountryFile).articles });
  }
  const attention = buildAttention(all, now);
  writeJson(`${args.outDir}/attention.json`, attention);
  log(`Attention: ${Object.keys(attention.mentions).length} countries mention another`);
  // The foreign articles behind those counts, one file per country written about.
  const aboutDir = `${args.outDir}/about`;
  const abouts = buildAboutFiles(all, now);
  fs.mkdirSync(aboutDir, { recursive: true });
  for (const name of fs.readdirSync(aboutDir)) {
    if (!(name.replace(/\.json$/, "") in abouts)) fs.unlinkSync(`${aboutDir}/${name}`);
  }
  for (const [code, file] of Object.entries(abouts)) writeJson(`${aboutDir}/${code}.json`, file);
  log(`About: ${Object.keys(abouts).length} countries are written about elsewhere`);

  const sharedPath = `${args.outDir}/shared.json`;
  let shared: SharedFile | null = fs.existsSync(sharedPath) ? (JSON.parse(fs.readFileSync(sharedPath, "utf8")) as SharedFile) : null;
  if (ai && ai.calls < MAX_AI_CALLS) {
    const candidates = collectCandidates(all);
    log(`Shared stories: grouping ${candidates.length} cross-border headlines`);
    const fresh = await findSharedStories(ai, candidates);
    if (fresh) {
      const stories = reconcileStories(fresh, shared?.stories, now);
      const carried = stories.filter((st) => st.since !== now).length;
      shared = { updated: now, stories };
      writeJson(sharedPath, shared);
      log(`Shared stories: ${stories.length} across ${candidates.length} headlines, ${carried} carried over from the previous run`);
    } else {
      log("Shared stories: grouping failed; previous file kept");
    }
  }
  if (ai) log(`Model calls this run: ${ai.calls}`);

  // 5. Daily snapshot for the time machine.
  const historyDir = `${args.outDir}/history`;
  const indexFile = `${historyDir}/index.json`;
  const historyIndex: HistoryIndex | null = fs.existsSync(indexFile) ? (JSON.parse(fs.readFileSync(indexFile, "utf8")) as HistoryIndex) : null;
  const watched = inboundEditions(attention);
  const snapshot = buildSnapshot(now, all, shared?.stories ?? [], watched);
  writeJson(`${historyDir}/${snapshot.date}.json`, snapshot);
  writeJson(indexFile, addDay(historyIndex, dayOf(now)));
  log(`History: snapshot for ${snapshot.date} with ${Object.keys(snapshot.countries).length} countries`);

  // 6. Humanitarian signals: verified GDACS alerts, sudden world attention,
  // and emergencies nobody is watching. A failed alert fetch keeps the
  // alerts from the previous run.
  const crisesPath = `${args.outDir}/crises.json`;
  const previousCrises: CrisesFile | null = fs.existsSync(crisesPath) ? (JSON.parse(fs.readFileSync(crisesPath, "utf8")) as CrisesFile) : null;
  const resolver = buildResolver(loadGlobeFeatures(), local);
  const alerts = (await fetchAlerts(resolver, now, deps)) ?? previousCrises?.alerts ?? [];
  const crises = detectCrises({
    attention,
    abouts,
    locals: all,
    baselines: readBaselines(historyDir, dayOf(now)),
    terms: loadCrisisTerms(),
    alerts,
    now,
  });
  writeJson(crisesPath, crises);
  log(`Crises: ${crises.alerts.length} alerts, ${crises.quiet.length} quiet, ${crises.watching.length} watched, ${crises.unwatched.length} unwatched`);

  // 7. Where help is needed and where to send it: national Red Cross and
  // Red Crescent societies, IFRC appeals and UN response plans. Each
  // source that fails keeps the previous run's data.
  const helpPath = `${args.outDir}/help.json`;
  const previousHelp: HelpFile | null = fs.existsSync(helpPath) ? (JSON.parse(fs.readFileSync(helpPath, "utf8")) as HelpFile) : null;
  const help = await refreshHelp(previousHelp, resolver, now, deps);
  writeJson(helpPath, help);
  log(`Help: ${Object.keys(help.societies).length} societies, ${help.appeals.length} appeals, ${Object.keys(help.events).length} emergencies, ${help.plans.length} plans, ${Object.keys(help.uncr).length} UN donation pages`);

  // 8. Long-term needs: water, sanitation, electricity, hunger, poverty,
  // schooling, literacy and child mortality from the World Bank's open data.
  const needsPath = `${args.outDir}/needs.json`;
  const previousNeeds: NeedsFile | null = fs.existsSync(needsPath) ? (JSON.parse(fs.readFileSync(needsPath, "utf8")) as NeedsFile) : null;
  const needs = await refreshNeeds(previousNeeds, resolver, now, deps);
  writeJson(needsPath, needs);
  log(`Needs: ${Object.keys(needs.countries).length} countries with a listed need, ${Object.values(needs.fetched).filter(Boolean).length} of 8 indicators fetched`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
