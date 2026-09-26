// Writes the current data (from whichever STORE the server uses) out as
// ledger.csv / pipeline.csv / target_list.csv, for opening in Excel or as a
// plain-text backup. Never overwrites the originals in JobSearch/engine:
// the default target is a new timestamped folder under engine/sql-export/.
//
//   npm run export:csv
//   npm run export:csv -- C:\some\folder
import "dotenv/config";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { loadConfig } from "../src/config.js";
import { openStore } from "../src/stores/index.js";
import { toCsv } from "../src/csv.js";
import { LEDGER_COLUMNS, RECRUITER_COLUMNS } from "../src/stores/shape.js";

const cfg = loadConfig();
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
const outDir = process.argv[2] || path.join(cfg.jobsearchDir, "engine", "sql-export", stamp);
const store = await openStore(cfg);

try {
  const [apps, events, recruiters] = await Promise.all([
    store.listApplications(),
    store.listEvents(),
    store.listRecruiters(),
  ]);
  mkdirSync(outDir, { recursive: true });
  // BOM so Excel opens the UTF-8 (Persian notes) correctly.
  const write = (name, text) => writeFileSync(path.join(outDir, name), "\uFEFF" + text, "utf-8");
  write("ledger.csv", toCsv(LEDGER_COLUMNS, apps));
  write("pipeline.csv", toCsv(["folder", "company", "stage", "date", "note"], events));
  write("target_list.csv", toCsv(RECRUITER_COLUMNS, recruiters));
  console.log(`\n  Exported from ${store.kind.toUpperCase()} to ${outDir}`);
  console.log(`    ${apps.length} applications, ${events.length} events, ${recruiters.length} recruiters\n`);
} finally {
  await store.close();
}
