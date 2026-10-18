// Recomputes the derived files (attention counts, "about" files and today's
// history snapshot) from the data already in public/data, without fetching
// anything. Useful after a change to a derived format. With --alerts it
// also refreshes the GDACS disaster alerts; otherwise the stored ones stay.
//
//   npx tsx pipeline/derive.ts [--out public/data] [--alerts]
import fs from "node:fs";
import { buildResolver, fetchAlerts } from "./lib/alerts";
import { buildAboutFiles, buildAttention } from "./lib/attention";
import { addDay, buildSnapshot, dayOf, readBaselines, type HistoryIndex } from "./lib/history";
import { loadCountryConfig, loadGlobeFeatures } from "./lib/countries";
import { detectCrises, inboundEditions, loadCrisisTerms, type CrisesFile } from "./lib/crises";
import { sleep } from "./lib/io";
import { writeJson } from "./lib/io";
import type { CountryFile, IndexFile } from "./lib/publish";
import type { SharedFile } from "./lib/shared";

async function main() {
  const outDir = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : "public/data";
  const index = JSON.parse(fs.readFileSync(`${outDir}/index.json`, "utf8")) as IndexFile;
  const shared = fs.existsSync(`${outDir}/shared.json`) ? (JSON.parse(fs.readFileSync(`${outDir}/shared.json`, "utf8")) as SharedFile) : null;
  const now = new Date().toISOString();
  const all = Object.entries(index.countries)
    .filter(([, e]) => (e.kind ?? "local") === "local")
    .map(([code]) => ({
      code,
      articles: (JSON.parse(fs.readFileSync(`${outDir}/countries/${code}.json`, "utf8")) as CountryFile).articles,
    }));
  const attention = buildAttention(all, now);
  writeJson(`${outDir}/attention.json`, attention);
  const aboutDir = `${outDir}/about`;
  const abouts = buildAboutFiles(all, now);
  fs.mkdirSync(aboutDir, { recursive: true });
  for (const name of fs.readdirSync(aboutDir)) if (!(name.replace(/\.json$/, "") in abouts)) fs.unlinkSync(`${aboutDir}/${name}`);
  for (const [code, file] of Object.entries(abouts)) writeJson(`${aboutDir}/${code}.json`, file);
  console.log(`Wrote attention.json and ${Object.keys(abouts).length} about files`);
  const snapshot = buildSnapshot(now, all, shared?.stories ?? [], inboundEditions(attention));
  const indexFile = `${outDir}/history/index.json`;
  const historyIndex: HistoryIndex | null = fs.existsSync(indexFile) ? (JSON.parse(fs.readFileSync(indexFile, "utf8")) as HistoryIndex) : null;
  writeJson(`${outDir}/history/${snapshot.date}.json`, snapshot);
  writeJson(indexFile, addDay(historyIndex, dayOf(now)));
  console.log(`Wrote ${outDir}/history/${snapshot.date}.json: ${Object.keys(snapshot.countries).length} countries, ${snapshot.stories.length} stories`);
  const crisesPath = `${outDir}/crises.json`;
  const previousCrises: CrisesFile | null = fs.existsSync(crisesPath) ? (JSON.parse(fs.readFileSync(crisesPath, "utf8")) as CrisesFile) : null;
  const fetched = process.argv.includes("--alerts")
    ? await fetchAlerts(buildResolver(loadGlobeFeatures(), loadCountryConfig()), now, { fetch, sleep, log: console.log })
    : null;
  const alerts = fetched ?? previousCrises?.alerts ?? [];
  const crises = detectCrises({
    attention,
    abouts,
    locals: all,
    baselines: readBaselines(`${outDir}/history`, dayOf(now)),
    terms: loadCrisisTerms(),
    alerts,
    now,
  });
  writeJson(crisesPath, crises);
  console.log(
    `Wrote crises.json: ${crises.alerts.length} alerts, ${crises.quiet.length} quiet, ${crises.watching.length} watched, ${crises.unwatched.length} unwatched`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
