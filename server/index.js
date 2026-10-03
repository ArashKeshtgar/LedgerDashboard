import "dotenv/config";
import { loadConfig } from "./src/config.js";
import { createApp } from "./src/app.js";
import { existsSync } from "fs";
import { openStore } from "./src/stores/index.js";

// loadConfig() throws on an unsafe setup (no password on a public HOST,
// missing/short SESSION_SECRET) — better to stop here than to run exposed.
let cfg;
let store;
try {
  cfg = loadConfig();
  store = await openStore(cfg);
} catch (err) {
  console.error(`\n  Ledger Dashboard did not start: ${err.message}\n`);
  process.exit(1);
}

const app = createApp(cfg, { store });

app.listen(cfg.port, cfg.host, () => {
  console.log("");
  console.log(`  Ledger Dashboard is running:  http://${cfg.host === "0.0.0.0" ? "localhost" : cfg.host}:${cfg.port}`);
  console.log(`  ${cfg.password ? "password login is ON" : "local mode — no login, reachable from this machine only"}`);
  console.log("");
  console.log(`  store:  ${cfg.store === "sql" ? `SQL Server ${cfg.db.server}/${cfg.db.database}` : "CSV files"}`);
  console.log(`  data:   ${cfg.jobsearchDir}`);
  console.log(`  client: ${cfg.clientDist}`);
  if (!existsSync(cfg.motivationPath)) {
    console.warn(`  WARNING: ${cfg.motivationPath} is missing — the daily line will not show.`);
  }
  console.log("");
});
