import sql from "mssql";
import { readFileSync } from "fs";

// Runs a db/*.sql file the way sqlcmd would: $(VAR) substitution, then one
// batch per GO. All batches share one transaction (and so one connection),
// which keeps session SET options in force and makes a failed script leave
// nothing half-applied. Used by the tests to build a throwaway database.
export async function runSqlScript(pool, file, vars = {}) {
  const text = readFileSync(file, "utf-8")
    .replace(/^﻿/, "")
    .replace(/\$\((\w+)\)/g, (m, name) => (name in vars ? vars[name] : m));
  const batches = text
    .split(/^\s*GO\s*$/im)
    .map((b) => b.trim())
    .filter((b) => b.split("\n").some((line) => line.trim() && !line.trim().startsWith("--")));

  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    for (const batch of batches) await new sql.Request(tx).batch(batch);
    await tx.commit();
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  }
}
