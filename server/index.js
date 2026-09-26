import "dotenv/config";
import { loadConfig } from "./src/config.js";
import { createApp } from "./src/app.js";

// loadConfig() throws on an unsafe setup (no password on a public HOST,
// missing/short SESSION_SECRET) — better to stop here than to run exposed.
let cfg;
try {
  cfg = loadConfig();
} catch (err) {
  console.error(`\n  Ledger Dashboard did not start: ${err.message}\n`);
  process.exit(1);
}

const app = createApp(cfg);

app.listen(cfg.port, cfg.host, () => {
  console.log("");
  console.log(`  Ledger Dashboard is running:  http://${cfg.host === "0.0.0.0" ? "localhost" : cfg.host}:${cfg.port}`);
  console.log(`  ${cfg.password ? "password login is ON" : "local mode — no login, reachable from this machine only"}`);
  console.log("");
  console.log(`  data:   ${cfg.jobsearchDir}`);
  console.log(`  client: ${cfg.clientDist}`);
  console.log("");
});
