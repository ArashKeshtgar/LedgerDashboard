// When the SQL tests fail with "CREATE DATABASE failed. Some file names
// listed could not be created": shows the free space where SQL Server puts
// new database files, and the LedgerTest_* databases left behind by test
// runs that were stopped before they could drop theirs. Uses the same
// server/.env.test as the tests.
//
//   npm run sql:doctor             look only
//   npm run sql:doctor -- --drop   also drop the leftover LedgerTest_* databases
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { connectSqlPool } from "../src/stores/sqlStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env.test"), quiet: true });

if (!process.env.TEST_SQL_SERVER) {
  console.log("No TEST_SQL_SERVER in server/.env.test, so the SQL tests don't run here.");
  process.exit(0);
}

const pool = await connectSqlPool({
  server: process.env.TEST_SQL_SERVER,
  port: Number(process.env.TEST_SQL_PORT) || 1433,
  database: "master",
  user: process.env.TEST_SQL_USER,
  password: process.env.TEST_SQL_PASSWORD,
});

try {
  const where = await pool.request().query(
    "SELECT CAST(SERVERPROPERTY('InstanceDefaultDataPath') AS nvarchar(400)) AS data_path"
  );
  console.log(`New database files go to: ${where.recordset[0].data_path || "(unknown)"}`);

  try {
    const space = await pool.request().query(`
      SELECT DISTINCT vs.volume_mount_point AS drive,
             CAST(vs.available_bytes / 1048576 AS bigint) AS free_mb,
             CAST(vs.total_bytes / 1048576 AS bigint) AS total_mb
      FROM sys.master_files mf
      CROSS APPLY sys.dm_os_volume_stats(mf.database_id, mf.file_id) vs`);
    for (const d of space.recordset) {
      console.log(`Drive ${d.drive}: ${d.free_mb.toLocaleString()} MB free of ${d.total_mb.toLocaleString()} MB`);
    }
  } catch {
    console.log("(Free space needs the VIEW SERVER STATE permission; check the drive above in Explorer.)");
  }

  const left = await pool.request().query(
    "SELECT name, create_date FROM sys.databases WHERE name LIKE 'LedgerTest[_]%' ORDER BY create_date"
  );
  console.log(`Leftover test databases: ${left.recordset.length}`);
  for (const db of left.recordset) console.log(`  ${db.name}  (created ${db.create_date.toISOString()})`);

  if (process.argv.includes("--drop")) {
    for (const { name } of left.recordset) {
      // Names come from sys.databases and match LedgerTest_<hex>; QUOTENAME guards anyway.
      await pool.request().input("name", name).query(`
        DECLARE @q nvarchar(300) = QUOTENAME(@name);
        EXEC('ALTER DATABASE ' + @q + ' SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ' + @q + ';');`);
      console.log(`  dropped ${name}`);
    }
  } else if (left.recordset.length) {
    console.log("Run again with -- --drop to remove them.");
  }
} finally {
  await pool.close();
}
