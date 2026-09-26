import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { randomBytes } from "crypto";
import { connectSqlPool } from "../src/stores/sqlStore.js";
import { runSqlScript } from "../src/stores/sqlScripts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env.test"), quiet: true });

// SQL tests run only when a server is configured (server/.env.test locally,
// a service container in CI). The login needs to be able to create a
// database; each test run gets its own and drops it afterwards.
export const sqlAvailable = !!process.env.TEST_SQL_SERVER;

function connection(database) {
  return {
    server: process.env.TEST_SQL_SERVER,
    port: Number(process.env.TEST_SQL_PORT) || 1433,
    database,
    user: process.env.TEST_SQL_USER,
    password: process.env.TEST_SQL_PASSWORD,
  };
}

export async function createTestDatabase() {
  const name = `LedgerTest_${randomBytes(4).toString("hex")}`;
  const admin = await connectSqlPool(connection("master"));
  await admin.request().batch(`CREATE DATABASE [${name}]`);
  const pool = await connectSqlPool(connection(name));
  await runSqlScript(pool, path.join(__dirname, "..", "..", "db", "03-schema.sql"));

  return {
    name,
    pool,
    async drop() {
      await pool.close();
      await admin.request().batch(`ALTER DATABASE [${name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${name}];`);
      await admin.close();
    },
  };
}
