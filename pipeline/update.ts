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
import { buildAttention } from "./lib/attention";
import { dedupeArticles } from "./lib/clean";
import { loadCountryConfig, loadGlobeCodes, selectCountries, type CountryConfig } from "./lib/countries";
import { fetchFeed, type Article } from "./lib/googlenews";
import { sleep, writeJson } from "./lib/io";
import { mergeIndex, readIndex, type CountryFile, type IndexEntry } from "./lib/publish";
import { collectCandidates, findSharedStories, type SharedFile } from "./lib/shared";
import { applyCache, pruneCache, readCache, translateNew, type EnrichedArticle } from "./lib/translate";

/** Most model calls one run may make; a guard against runaway cost. */
const MAX_AI_CALLS = 120;
/** Countries translated at the same time. Keeps the first run well under the job timeout. */
const TRANSLATE_CONCURRENCY = 4;
const CACHE_PATH = "cache/headlines.json";

interface Fetched {
  country: CountryConfig;
  feedUrl: string;
  articles: Article[];
}

async function main() {
  const args = parseUpdateArgs(process.argv.slice(2));
  const countries = selectCountries(loadCountryConfig(), args.countries);
  const indexPath = `${args.outDir}/index.json`;
  const previous = readIndex(indexPath);
  const log = console.log;
  const deps = { fetch, sleep, log };

  // 1. Feeds
  log(`Updating ${countries.length} countr${countries.length === 1 ? "y" : "ies"}, up to ${args.maxArticles} articles each`);
  const fetched: Fetched[] = [];
  const failed: string[] = [];
  for (const [i, country] of countries.entries()) {
    if (i > 0) await sleep(args.delayMs);
    const result = await fetchFeed(country.edition, args.delayMs, deps);
    if (!result) {
      failed.push(country.code);
      log(`  ${country.code}: kept previous data`);
      continue;
    }
    const articles = dedupeArticles(result.articles).slice(0, args.maxArticles);
    fetched.push({ country, feedUrl: result.url, articles });
    log(`  ${country.code}: ${result.articles.length} in feed, ${articles.length} kept`);
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
      updated: now,
      source: { name: "Google News", edition: f.country.edition.ceid, url: f.feedUrl },
      articles: f.articles,
    };
    writeJson(`${args.outDir}/countries/${f.country.code}.json`, file);
    fresh[f.country.code] = { name: f.country.name, articles: f.articles.length, updated: now };
  }
  const untouched = Object.keys(previous?.countries ?? {}).filter(
    (code) => !(code in fresh) && !failed.includes(code) && !countries.some((c) => c.code === code),
  );
  const index = mergeIndex(previous, fresh, [...failed, ...untouched], now);
  writeJson(indexPath, index);
  log(`Wrote ${indexPath}: ${Object.keys(index.countries).length} countries${failed.length ? `, ${failed.length} kept from before (${failed.join(", ")})` : ""}`);

  // 4. Attention and shared stories use every published country, including
  //    the ones kept from before.
  const all: { code: string; articles: EnrichedArticle[] }[] = enriched.map((f) => ({ code: f.country.code, articles: f.articles }));
  for (const code of Object.keys(index.countries)) {
    if (all.some((c) => c.code === code)) continue;
    const path = `${args.outDir}/countries/${code}.json`;
    if (fs.existsSync(path)) all.push({ code, articles: (JSON.parse(fs.readFileSync(path, "utf8")) as CountryFile).articles });
  }
  const attention = buildAttention(all, now);
  writeJson(`${args.outDir}/attention.json`, attention);
  log(`Attention: ${Object.keys(attention.mentions).length} countries mention another`);

  if (ai && ai.calls < MAX_AI_CALLS) {
    const candidates = collectCandidates(all);
    log(`Shared stories: grouping ${candidates.length} cross-border headlines`);
    const stories = await findSharedStories(ai, candidates);
    if (stories) {
      const shared: SharedFile = { updated: now, stories };
      writeJson(`${args.outDir}/shared.json`, shared);
      log(`Shared stories: ${stories.length} across ${candidates.length} headlines`);
    } else {
      log("Shared stories: grouping failed; previous file kept");
    }
  }
  if (ai) log(`Model calls this run: ${ai.calls}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
