// Phase 4: fetch recent articles for each enabled country from GDELT and
// save the cleaned raw lists to pipeline/out/raw/<CODE>.json.
//
//   npm run pipeline:fetch -- --countries TH
//   npm run pipeline:fetch -- --timespan 6h --max 50
import { parseFetchArgs } from "./lib/args";
import { cleanArticles, loadNonNewsDomains } from "./lib/clean";
import { loadCountryConfig, loadGdeltCodes, selectCountries, unknownGdeltCodes } from "./lib/countries";
import { fetchGdelt } from "./lib/gdelt";
import { sleep, writeJson } from "./lib/io";

async function main() {
  const args = parseFetchArgs(process.argv.slice(2));
  const countries = selectCountries(loadCountryConfig(), args.countries);
  const blocked = loadNonNewsDomains();

  const unknown = unknownGdeltCodes(countries, loadGdeltCodes());
  if (unknown.length) {
    throw new Error(
      `GDELT does not know these codes: ${unknown.map((c) => `${c.code} -> ${c.gdelt}`).join(", ")}. ` +
        "Check the gdelt field in data/countries.json against pipeline/data/gdelt-countries.txt.",
    );
  }

  console.log(`Fetching ${countries.length} countr${countries.length === 1 ? "y" : "ies"}, timespan ${args.timespan}, up to ${args.maxRecords} records each`);
  const deps = { fetch, sleep, log: console.log };
  let failures = 0;

  for (const [i, country] of countries.entries()) {
    if (i > 0) await sleep(args.delayMs); // GDELT asks for one request per 5 seconds
    const result = await fetchGdelt(
      { gdeltCode: country.gdelt, timespan: args.timespan, maxRecords: args.maxRecords },
      args.delayMs,
      deps,
    );
    if (!result) {
      failures++;
      console.log(`  ${country.code}: skipped after two failed attempts`);
      continue;
    }
    const { kept, dropped } = cleanArticles(result.articles, blocked);
    writeJson(`${args.outDir}/${country.code}.json`, {
      code: country.code,
      gdelt: country.gdelt,
      name: country.name,
      fetchedAt: new Date().toISOString(),
      timespan: args.timespan,
      request: result.url,
      received: result.articles.length,
      kept: kept.length,
      dropped,
      articles: kept,
    });
    console.log(
      `  ${country.code}: ${result.articles.length} received, ${kept.length} kept ` +
        `(${dropped.duplicates} duplicates, ${dropped.nonNews} non-news, ${dropped.empty} empty)`,
    );
  }

  if (failures === countries.length) {
    throw new Error("Every country failed; nothing was written");
  }
  if (failures) console.log(`${failures} countr${failures === 1 ? "y" : "ies"} skipped`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
