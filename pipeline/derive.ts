// Recomputes the derived files (attention counts, "about" files, today's
// history snapshot and the disaster map) from the data already on disk,
// without the model. Useful after a change to a derived format.
//
// The disaster map is rebuilt from the cached feed reports, research,
// geocoding and donation checks. With --fetch the disaster feeds,
// geocoder and donation checks run live as well (still no model calls).
//
//   npx tsx pipeline/derive.ts [--out public/data] [--fetch]
import fs from "node:fs";
import { buildAboutFiles, buildAttention } from "./lib/attention";
import { loadCountryConfig, loadGlobeCodes, loadGlobeFeatures } from "./lib/countries";
import { updateDisasters } from "./lib/disasters/build";
import { loadCountryShapes } from "./lib/disasters/geo";
import type { NewsArticle } from "./lib/disasters/news";
import { addDay, buildSnapshot, dayOf, type HistoryIndex } from "./lib/history";
import { sleep, writeJson } from "./lib/io";
import type { CountryFile, IndexFile } from "./lib/publish";
import { buildResolver } from "./lib/resolve";
import type { SharedFile } from "./lib/shared";
import { loadBudget, readLedger } from "./lib/spend";
import type { EnrichedArticle } from "./lib/translate";

async function main() {
  const outDir = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : "public/data";
  const live = process.argv.includes("--fetch");
  const index = JSON.parse(fs.readFileSync(`${outDir}/index.json`, "utf8")) as IndexFile;
  const shared = fs.existsSync(`${outDir}/shared.json`) ? (JSON.parse(fs.readFileSync(`${outDir}/shared.json`, "utf8")) as SharedFile) : null;
  const now = new Date().toISOString();
  const read = (code: string) => (JSON.parse(fs.readFileSync(`${outDir}/countries/${code}.json`, "utf8")) as CountryFile).articles as EnrichedArticle[];

  // Attention, "about" files and today's snapshot use local editions only.
  const all = Object.entries(index.countries)
    .filter(([, e]) => (e.kind ?? "local") === "local")
    .map(([code]) => ({ code, articles: read(code) }));
  writeJson(`${outDir}/attention.json`, buildAttention(all, now));
  const aboutDir = `${outDir}/about`;
  const abouts = buildAboutFiles(all, now);
  fs.mkdirSync(aboutDir, { recursive: true });
  for (const name of fs.readdirSync(aboutDir)) if (!(name.replace(/\.json$/, "") in abouts)) fs.unlinkSync(`${aboutDir}/${name}`);
  for (const [code, file] of Object.entries(abouts)) writeJson(`${aboutDir}/${code}.json`, file);
  console.log(`Wrote attention.json and ${Object.keys(abouts).length} about files`);
  const snapshot = buildSnapshot(now, all, shared?.stories ?? []);
  const indexFile = `${outDir}/history/index.json`;
  const historyIndex: HistoryIndex | null = fs.existsSync(indexFile) ? (JSON.parse(fs.readFileSync(indexFile, "utf8")) as HistoryIndex) : null;
  writeJson(`${outDir}/history/${snapshot.date}.json`, snapshot);
  writeJson(indexFile, addDay(historyIndex, dayOf(now)));
  console.log(`Wrote ${outDir}/history/${snapshot.date}.json: ${Object.keys(snapshot.countries).length} countries, ${snapshot.stories.length} stories`);

  // The disaster map, from every published article (local and world coverage).
  const articles: NewsArticle[] = Object.keys(index.countries)
    .filter((code) => fs.existsSync(`${outDir}/countries/${code}.json`))
    .flatMap((code) => read(code).map((a) => ({ country: code, title: a.title, en: a.en, outlet: a.outlet, url: a.url, published: a.published, about: a.about })));
  const features = loadGlobeFeatures();
  await updateDisasters({
    outDir,
    now,
    deps: { fetch, sleep, log: console.log },
    ai: null,
    ledger: readLedger(),
    budget: loadBudget(),
    articles,
    resolve: buildResolver(features, loadCountryConfig()),
    shapes: loadCountryShapes(),
    globeCodes: loadGlobeCodes(),
    countryNames: Object.fromEntries(features.map((f) => [f.code, f.admin])),
    offline: !live,
    log: console.log,
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
