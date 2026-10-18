// Writes today's history snapshot from the data already in public/data,
// without fetching anything. Useful after a change to the archive format.
//
//   npx tsx pipeline/snapshot.ts [--out public/data]
import fs from "node:fs";
import { addDay, buildSnapshot, dayOf, type HistoryIndex } from "./lib/history";
import { writeJson } from "./lib/io";
import type { CountryFile, IndexFile } from "./lib/publish";
import type { SharedFile } from "./lib/shared";

const outDir = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : "public/data";
const index = JSON.parse(fs.readFileSync(`${outDir}/index.json`, "utf8")) as IndexFile;
const shared = fs.existsSync(`${outDir}/shared.json`) ? (JSON.parse(fs.readFileSync(`${outDir}/shared.json`, "utf8")) as SharedFile) : null;
const now = new Date().toISOString();
const all = Object.entries(index.countries)
  .filter(([, e]) => (e.kind ?? "local") === "local")
  .map(([code]) => ({ code, articles: (JSON.parse(fs.readFileSync(`${outDir}/countries/${code}.json`, "utf8")) as CountryFile).articles }));
const snapshot = buildSnapshot(now, all, shared?.stories ?? []);
const indexFile = `${outDir}/history/index.json`;
const historyIndex: HistoryIndex | null = fs.existsSync(indexFile) ? (JSON.parse(fs.readFileSync(indexFile, "utf8")) as HistoryIndex) : null;
writeJson(`${outDir}/history/${snapshot.date}.json`, snapshot);
writeJson(indexFile, addDay(historyIndex, dayOf(now)));
console.log(`Wrote ${outDir}/history/${snapshot.date}.json: ${Object.keys(snapshot.countries).length} countries, ${snapshot.stories.length} stories`);
