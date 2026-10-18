// Recomputes the derived files (attention counts, "about" files and today's
// history snapshot) from the data already in public/data, without fetching
// anything. Useful after a change to a derived format. With --fetch it
// also refreshes the GDACS alerts and the help sources (IFRC, OCHA);
// otherwise the stored ones stay.
//
//   npx tsx pipeline/derive.ts [--out public/data] [--fetch]
import fs from "node:fs";
import { buildResolver, fetchAlerts } from "./lib/alerts";
import { buildAboutFiles, buildAttention } from "./lib/attention";
import { addDay, buildSnapshot, dayOf, readBaselines, type HistoryIndex } from "./lib/history";
import { loadCountryConfig, loadGlobeFeatures } from "./lib/countries";
import { detectCrises, inboundEditions, loadCrisisTerms, type CrisesFile } from "./lib/crises";
import { buildHelp, refreshHelp, type HelpFile } from "./lib/help";
import { buildNeeds, refreshNeeds, type NeedsFile } from "./lib/needs";
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
  const refresh = process.argv.includes("--fetch");
  const deps = { fetch, sleep, log: console.log };
  const resolver = buildResolver(loadGlobeFeatures(), loadCountryConfig());
  const fetched = refresh ? await fetchAlerts(resolver, now, deps) : null;
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
  const helpPath = `${outDir}/help.json`;
  const previousHelp: HelpFile | null = fs.existsSync(helpPath) ? (JSON.parse(fs.readFileSync(helpPath, "utf8")) as HelpFile) : null;
  const help = refresh
    ? await refreshHelp(previousHelp, resolver, now, deps)
    : buildHelp(previousHelp, { societies: null, appeals: null, plans: null, events: null, uncr: null }, now);
  writeJson(helpPath, help);
  console.log(
    `Wrote help.json: ${Object.keys(help.societies).length} societies, ${help.appeals.length} appeals, ${Object.keys(help.events).length} emergencies, ${help.plans.length} plans, ${Object.keys(help.uncr).length} UN donation pages`,
  );
  const needsPath = `${outDir}/needs.json`;
  const previousNeeds: NeedsFile | null = fs.existsSync(needsPath) ? (JSON.parse(fs.readFileSync(needsPath, "utf8")) as NeedsFile) : null;
  const needs = refresh ? await refreshNeeds(previousNeeds, resolver, now, deps) : buildNeeds(previousNeeds, {}, now);
  writeJson(needsPath, needs);
  console.log(`Wrote needs.json: ${Object.keys(needs.countries).length} countries with a listed need`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
