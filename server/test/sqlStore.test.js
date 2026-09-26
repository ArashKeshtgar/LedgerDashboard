import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { appendFileSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import sql from "mssql";
import { FOLDER_A, FOLDER_B, makeDataDir, startApp, testConfig } from "./fixture.js";
import { createCsvStore } from "../src/stores/csvStore.js";
import { createSqlStore } from "../src/stores/sqlStore.js";
import { migrateCsvToSql, verifyMigration } from "../src/stores/migrate.js";
import { createTestDatabase, sqlAvailable } from "./sqlTestDb.js";

describe.skipIf(!sqlAvailable)("SQL Server store", () => {
  let testDb;
  let data;
  let csvStore;
  let store;

  beforeAll(async () => {
    testDb = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await testDb?.drop();
  });

  beforeEach(() => {
    data = makeDataDir();
    csvStore = createCsvStore(data.engine);
    store = createSqlStore(testDb.pool);
  });
  afterEach(() => data.cleanup());

  const count = async (table) =>
    (await testDb.pool.request().query(`SELECT COUNT(*) AS n FROM dbo.${table}`)).recordset[0].n;

  describe("migration", () => {
    it("copies everything, reports what it skipped, and verifies clean", async () => {
      const engine = data.engine;
      appendFileSync(path.join(engine, "pipeline.csv"),
        `${FOLDER_A},Acme,applied,2026-09-03,sent\n` +
        "2026-01-01__Gone__Deleted,Gone,draft,2026-01-01,\n" + // orphan: not in the ledger
        `${FOLDER_B},Globex,applied,2026-10-01T14:30,booked\n`);
      const ledger = readFileSync(path.join(engine, "ledger.csv"), "utf-8");
      writeFileSync(path.join(engine, "ledger.csv"), ledger.replace(/,draft,,,,,\n$/, ',draft,,,,,"etl-ssis,power-bi,etl-ssis"\n'));

      const report = await migrateCsvToSql({ csvStore, pool: testDb.pool, replace: true });

      expect(report).toMatchObject({ applications: 2, events: 2, stages: 3, recruiters: 1 });
      expect(report.skippedOrphanEvents).toEqual(["2026-01-01__Gone__Deleted (draft, 2026-01-01)"]);
      expect(report.dedupedGapTags).toEqual([FOLDER_B]);
      const { diffs } = await verifyMigration(csvStore, store, new Date("2026-09-26T12:00:00"));
      expect(diffs).toEqual([]);

      const events = await store.listEvents();
      expect(events.at(-1)).toMatchObject({ folder: FOLDER_B, date: "2026-10-01T14:30", note: "booked" });
      expect((await store.getApplication(FOLDER_B)).gap_tags).toBe("etl-ssis,power-bi");
    });

    it("skips an event with an unknown stage and verification flags what that changes", async () => {
      // In the CSV that event would become the card's "current stage"; SQL
      // can't store it (foreign key), so the copy is NOT equivalent, and the
      // verification must say so rather than report OK.
      appendFileSync(path.join(data.engine, "pipeline.csv"), `${FOLDER_B},Globex,made_up_stage,2026-09-04,\n`);

      const report = await migrateCsvToSql({ csvStore, pool: testDb.pool, replace: true });
      expect(report.skippedUnknownStageEvents).toEqual([`${FOLDER_B} (made_up_stage, 2026-09-04)`]);

      const { diffs } = await verifyMigration(csvStore, store);
      expect(diffs).toContain(`pipeline view differs for ${FOLDER_B}`);
    });

    it("refuses to copy into a database that already has data unless replace is set", async () => {
      await migrateCsvToSql({ csvStore, pool: testDb.pool, replace: true });
      await expect(migrateCsvToSql({ csvStore, pool: testDb.pool })).rejects.toThrow(/--replace/);
      expect(await count("Applications")).toBe(2);
    });

    it("rolls back completely when a row can't be stored", async () => {
      await migrateCsvToSql({ csvStore, pool: testDb.pool, replace: true });
      const ledger = readFileSync(path.join(data.engine, "ledger.csv"), "utf-8");
      writeFileSync(path.join(data.engine, "ledger.csv"), ledger.replace(",70,dotnet_azure,2026-09-02", ",170,dotnet_azure,2026-09-02"));

      await expect(migrateCsvToSql({ csvStore, pool: testDb.pool, replace: true })).rejects.toThrow();
      // The previous copy is still there, untouched — the clear-out was rolled back too.
      expect(await count("Applications")).toBe(2);
      expect(await count("Stages")).toBe(3);
    });

    it("verification catches a value that differs", async () => {
      await migrateCsvToSql({ csvStore, pool: testDb.pool, replace: true });
      await testDb.pool.request().query(`UPDATE dbo.Applications SET Company = N'Tampered' WHERE Folder = N'${FOLDER_A}'`);

      const { diffs } = await verifyMigration(csvStore, store);
      expect(diffs.some((d) => d.includes(`${FOLDER_A}.company`))).toBe(true);
    });
  });

  describe("integrity the CSV files could not give", () => {
    beforeEach(async () => {
      await migrateCsvToSql({ csvStore, pool: testDb.pool, replace: true });
    });

    it("creates a row, its tags and its draft event together or not at all", async () => {
      const row = {
        folder: "2026-09-26__Initech__Dev", date: "2026-09-26", company: "Initech", role: "Dev",
        match_score: "150", gap_tags: "etl-ssis", status: "draft",
      };
      await expect(store.createApplication(row)).rejects.toThrow();
      expect(await store.getApplication(row.folder)).toBeNull();
      expect((await store.listEvents()).some((e) => e.folder === row.folder)).toBe(false);
    });

    it("deletes an application's events and tags with it", async () => {
      await store.appendEvent({ folder: FOLDER_A, stage: "applied", date: "2026-09-05" });
      await store.updateApplication(FOLDER_A, { gap_tags: "etl-ssis" });
      await store.deleteApplication(FOLDER_A);
      const leftovers = await testDb.pool.request().query(`
        SELECT (SELECT COUNT(*) FROM dbo.PipelineEvents e LEFT JOIN dbo.Applications a ON a.Id = e.ApplicationId WHERE a.Id IS NULL)
             + (SELECT COUNT(*) FROM dbo.ApplicationGapTags) AS n`);
      expect(leftovers.recordset[0].n).toBe(0);
    });

    it("refuses an event for an unknown stage", async () => {
      await expect(store.appendEvent({ folder: FOLDER_A, stage: "made_up" })).rejects.toThrow();
    });

    it("answers 400 when a free-text sentence is sent as gap tags", async () => {
      const server = await startApp(testConfig(data.root), { store });
      try {
        const res = await server.call("PATCH", `/api/applications/${FOLDER_A}`, {
          body: { gap_tags: "Needs more Azure experience, and SSIS" },
        });
        expect(res.status).toBe(400);
        expect((await store.getApplication(FOLDER_A)).gap_tags).toBe("");
      } finally {
        await server.close();
      }
    });

    it("keeps one row per LinkedIn profile, case-insensitively", async () => {
      const { added, skipped } = await store.addRecruiters([
        { name: "Jane Doe", linkedin_url: "HTTPS://LINKEDIN.COM/in/jane" },
        { name: "New Person", linkedin_url: "https://linkedin.com/in/new" },
      ]);
      expect(added.map((r) => r.name)).toEqual(["New Person"]);
      expect(skipped).toHaveLength(1);
      await expect(
        testDb.pool.request()
          .input("u", sql.NVarChar, "https://linkedin.com/in/new")
          .query("INSERT INTO dbo.Recruiters (Name, LinkedInUrl) VALUES (N'Dup', @u)")
      ).rejects.toThrow(/duplicate/i);
    });
  });
});
