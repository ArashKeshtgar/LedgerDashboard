// One-off copy of JobSearch/engine's CSV/YAML data into SQL Server, then a
// full read-back comparison. The CSV files are only read — they stay as the
// backup. Uses the same DB_* settings as the server (server/.env).
//
//   npm run migrate:sql              # into an empty database
//   npm run migrate:sql -- --replace # clear the SQL copy and copy again
//   npm run migrate:sql -- --verify  # compare only, change nothing
import "dotenv/config";
import path from "path";
import { loadConfig } from "../src/config.js";
import { createCsvStore } from "../src/stores/csvStore.js";
import { connectSqlPool, createSqlStore } from "../src/stores/sqlStore.js";
import { migrateCsvToSql, verifyMigration } from "../src/stores/migrate.js";

const args = new Set(process.argv.slice(2));
const cfg = loadConfig({ ...process.env, STORE: "sql" });
const engineDir = path.join(cfg.jobsearchDir, "engine");
const csvStore = createCsvStore(engineDir);
const pool = await connectSqlPool(cfg.db);
const sqlStore = createSqlStore(pool);

function list(title, items) {
  if (!items.length) return;
  console.log(`\n  ${title} (${items.length}):`);
  for (const item of items) console.log(`    - ${item}`);
}

let exitCode = 0;
try {
  console.log(`\n  source: ${engineDir}`);
  console.log(`  target: ${cfg.db.server}/${cfg.db.database}`);

  if (!args.has("--verify")) {
    const report = await migrateCsvToSql({ csvStore, pool, replace: args.has("--replace") });
    console.log("\n  Copied:");
    console.log(`    applications ${report.applications}`);
    console.log(`    events       ${report.events}`);
    console.log(`    stages       ${report.stages}`);
    console.log(`    recruiters   ${report.recruiters}`);
    list("Skipped events for applications no longer in the ledger", report.skippedOrphanEvents);
    list("Skipped events with a stage not in pipeline_stages.yml", report.skippedUnknownStageEvents);
    list("Repeated gap-tag slugs removed", report.dedupedGapTags);
    list("Skipped duplicate recruiters (same LinkedIn URL)", report.skippedDuplicateRecruiters);
  }

  const { counts, diffs } = await verifyMigration(csvStore, sqlStore);
  console.log("\n  Verification (CSV vs SQL, as the API serves them):");
  for (const [name, [a, b]] of Object.entries(counts)) console.log(`    ${name.padEnd(13)} ${a} vs ${b}`);
  if (diffs.length) {
    list("DIFFERENCES", diffs);
    exitCode = 1;
  } else {
    console.log("\n  OK: every field, event, stage, recruiter and pipeline view matches.\n");
  }
} catch (err) {
  console.error(`\n  Migration failed, nothing was changed: ${err.message}\n`);
  exitCode = 1;
} finally {
  await pool.close();
}
process.exit(exitCode);
