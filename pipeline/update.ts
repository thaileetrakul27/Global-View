// Fetches each enabled country's top stories and writes the JSON the website
// reads. A country whose feed fails keeps its previous file; the run only
// fails outright if every country fails, so stale data is never replaced
// with nothing.
//
//   npm run pipeline:update
//   npm run pipeline:update -- --countries TH,GB --max 20
import { parseUpdateArgs } from "./lib/args";
import { dedupeArticles } from "./lib/clean";
import { loadCountryConfig, selectCountries } from "./lib/countries";
import { fetchFeed } from "./lib/googlenews";
import { sleep, writeJson } from "./lib/io";
import { mergeIndex, readIndex, type CountryFile, type IndexEntry } from "./lib/publish";

async function main() {
  const args = parseUpdateArgs(process.argv.slice(2));
  const countries = selectCountries(loadCountryConfig(), args.countries);
  const indexPath = `${args.outDir}/index.json`;
  const previous = readIndex(indexPath);
  const deps = { fetch, sleep, log: console.log };

  console.log(`Updating ${countries.length} countr${countries.length === 1 ? "y" : "ies"}, up to ${args.maxArticles} articles each`);
  const fresh: Record<string, IndexEntry> = {};
  const failed: string[] = [];

  for (const [i, country] of countries.entries()) {
    if (i > 0) await sleep(args.delayMs);
    const result = await fetchFeed(country.edition, args.delayMs, deps);
    if (!result) {
      failed.push(country.code);
      console.log(`  ${country.code}: kept previous data`);
      continue;
    }
    const articles = dedupeArticles(result.articles).slice(0, args.maxArticles);
    const now = new Date().toISOString();
    const file: CountryFile = {
      code: country.code,
      name: country.name,
      updated: now,
      source: { name: "Google News", edition: country.edition.ceid, url: result.url },
      articles,
    };
    writeJson(`${args.outDir}/countries/${country.code}.json`, file);
    fresh[country.code] = { name: country.name, articles: articles.length, updated: now };
    console.log(`  ${country.code}: ${result.articles.length} in feed, ${articles.length} kept`);
  }

  if (failed.length === countries.length) {
    throw new Error("Every country failed; nothing was written");
  }

  // When only some countries were requested, keep every other country's entry.
  const untouched = Object.keys(previous?.countries ?? {}).filter(
    (code) => !(code in fresh) && !failed.includes(code) && !countries.some((c) => c.code === code),
  );
  const index = mergeIndex(previous, fresh, [...failed, ...untouched], new Date().toISOString());
  writeJson(indexPath, index);
  console.log(`Wrote ${indexPath}: ${Object.keys(index.countries).length} countries${failed.length ? `, ${failed.length} kept from before (${failed.join(", ")})` : ""}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
