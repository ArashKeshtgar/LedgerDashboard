import path from "path";
import { createCsvStore } from "./csvStore.js";
import { connectSqlPool, createSqlStore } from "./sqlStore.js";

// STORE=csv (default) keeps using the files under JobSearch/engine;
// STORE=sql uses SQL Server (db/*.sql). Same interface either way.
export async function openStore(cfg) {
  if (cfg.store === "sql") {
    const pool = await connectSqlPool(cfg.db);
    return createSqlStore(pool);
  }
  return createCsvStore(path.join(cfg.jobsearchDir, "engine"));
}
