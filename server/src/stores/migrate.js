import sql from "mssql";
import { attachPipeline } from "../pipeline.js";
import { LEDGER_COLUMNS, RECRUITER_COLUMNS, splitGapTags } from "./shape.js";
import {
  APPLICATION_COLUMNS, RECRUITER_COLUMNS_SQL, bindColumn, splitEventDate, valueExpr,
} from "./sqlStore.js";

// One-off copy of the CSV/YAML data into SQL Server, in a single
// transaction: either everything lands or nothing does. The source files
// are only read, never changed — they stay as the backup.
//
// Refuses to run into a database that already has data unless `replace`
// is set, in which case the existing rows are cleared first (same
// transaction, so a failed re-run leaves the previous copy intact).
export async function migrateCsvToSql({ csvStore, pool, replace = false }) {
  const [apps, events, stages, recruiters] = await Promise.all([
    csvStore.listApplications(),
    csvStore.listEvents(),
    csvStore.loadStages(),
    csvStore.listRecruiters(),
  ]);

  const report = {
    applications: 0,
    events: 0,
    stages: 0,
    recruiters: 0,
    skippedOrphanEvents: [], // events whose folder is no longer in the ledger
    skippedUnknownStageEvents: [],
    dedupedGapTags: [], // folders whose gap_tags repeated a slug
    skippedDuplicateRecruiters: [],
  };

  const tx = new sql.Transaction(pool);
  await tx.begin();
  const request = () => new sql.Request(tx);
  try {
    const { recordset } = await request().query(`
      SELECT (SELECT COUNT(*) FROM dbo.Applications) + (SELECT COUNT(*) FROM dbo.Recruiters)
           + (SELECT COUNT(*) FROM dbo.Stages) AS n`);
    if (recordset[0].n > 0) {
      if (!replace) {
        throw new Error("The SQL database already has data. Re-run with --replace to clear it and copy again.");
      }
      await request().query(`
        DELETE FROM dbo.PipelineEvents; DELETE FROM dbo.ApplicationGapTags;
        DELETE FROM dbo.Applications;   DELETE FROM dbo.Recruiters; DELETE FROM dbo.Stages;`);
    }

    // Stages, terminal states and actions, in file order.
    const stageRows = [
      ...stages.stages.map((s) => ({ ...s, kind: "stage" })),
      ...stages.terminal.map((s) => ({ ...s, kind: "terminal" })),
      ...stages.actions.map((s) => ({ ...s, kind: "action" })),
    ];
    for (const [i, s] of stageRows.entries()) {
      await request()
        .input("key", sql.NVarChar(40), s.key)
        .input("kind", sql.NVarChar(10), s.kind)
        .input("sort", sql.Int, i)
        .input("label", sql.NVarChar(100), s.label || s.key)
        .input("labelFa", sql.NVarChar(200), s.label_fa || "")
        .input("icon", sql.NVarChar(16), s.icon || "")
        .input("waiting", sql.Bit, !!s.waiting)
        .query(`INSERT INTO dbo.Stages (StageKey, Kind, SortOrder, Label, LabelFa, Icon, IsWaiting)
                VALUES (@key, @kind, @sort, @label, @labelFa, @icon, @waiting)`);
    }
    report.stages = stageRows.length;
    const stageKeys = new Set(stageRows.map((s) => s.key));

    // Applications in ledger order (Id order = the old row order).
    const idByFolder = new Map();
    const fields = Object.entries(APPLICATION_COLUMNS);
    for (const row of apps) {
      const r = request().input("folder", sql.NVarChar(150), row.folder);
      fields.forEach(([field, { type }], i) => bindColumn(r, `p${i}`, row[field], type));
      const { recordset: inserted } = await r.query(`
        INSERT INTO dbo.Applications (Folder, ${fields.map(([, c]) => c.column).join(", ")})
        OUTPUT INSERTED.Id
        VALUES (@folder, ${fields.map(([, { type }], i) => valueExpr(`p${i}`, type)).join(", ")})`);
      const id = inserted[0].Id;
      idByFolder.set(row.folder, id);

      const raw = String(row.gap_tags || "").split(",").map((t) => t.trim()).filter(Boolean);
      const slugs = splitGapTags(row.gap_tags);
      if (slugs.length !== raw.length) report.dedupedGapTags.push(row.folder);
      for (const [pos, slug] of slugs.entries()) {
        await request()
          .input("id", sql.Int, id)
          .input("slug", sql.NVarChar(60), slug)
          .input("pos", sql.TinyInt, pos)
          .query("INSERT INTO dbo.ApplicationGapTags (ApplicationId, Slug, Position) VALUES (@id, @slug, @pos)");
      }
    }
    report.applications = apps.length;

    // Events in file order, so "last line wins" still picks the same stage.
    for (const e of events) {
      const id = idByFolder.get(e.folder);
      if (id === undefined) {
        report.skippedOrphanEvents.push(`${e.folder} (${e.stage}, ${e.date})`);
        continue;
      }
      if (!stageKeys.has(e.stage)) {
        report.skippedUnknownStageEvents.push(`${e.folder} (${e.stage}, ${e.date})`);
        continue;
      }
      const { date, time } = splitEventDate(e.date);
      await request()
        .input("id", sql.Int, id)
        .input("stage", sql.NVarChar(40), e.stage)
        .input("d", sql.NVarChar(10), date)
        .input("t", sql.NVarChar(8), time)
        .input("note", sql.NVarChar(1000), e.note || "")
        .query(`INSERT INTO dbo.PipelineEvents (ApplicationId, StageKey, EventDate, EventTime, Note)
                VALUES (@id, @stage, CAST(@d AS date), CAST(@t AS time(0)), @note)`);
      report.events += 1;
    }

    const recruiterFields = Object.entries(RECRUITER_COLUMNS_SQL);
    const seenUrls = new Set();
    for (const row of recruiters) {
      const url = (row.linkedin_url || "").trim().toLowerCase();
      if (url && seenUrls.has(url)) {
        report.skippedDuplicateRecruiters.push(row.linkedin_url);
        continue;
      }
      if (url) seenUrls.add(url);
      const r = request();
      recruiterFields.forEach(([field, { type }], i) => bindColumn(r, `p${i}`, row[field], type));
      await r.query(`
        INSERT INTO dbo.Recruiters (${recruiterFields.map(([, c]) => c.column).join(", ")})
        VALUES (${recruiterFields.map(([, { type }], i) => valueExpr(`p${i}`, type)).join(", ")})`);
      report.recruiters += 1;
    }

    await tx.commit();
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  }
  return report;
}

// Reads everything back through both stores and compares what the API
// would serve: every ledger field, every event, the stage definitions,
// every recruiter, and the computed pipeline view (current stage, days in
// stage, follow-up flags). Returns a list of differences — empty means the
// SQL copy is indistinguishable from the CSV files for the dashboard.
// Known, intended differences (orphan events, repeated gap-tag slugs) are
// normalized away here and listed in the migration report instead.
export async function verifyMigration(csvStore, sqlStore, now = new Date()) {
  const diffs = [];
  const [csvApps, sqlApps, csvEvents, sqlEvents, csvStages, sqlStages, csvRec, sqlRec] = await Promise.all([
    csvStore.listApplications(), sqlStore.listApplications(),
    csvStore.listEvents(), sqlStore.listEvents(),
    csvStore.loadStages(), sqlStore.loadStages(),
    csvStore.listRecruiters(), sqlStore.listRecruiters(),
  ]);

  const counts = {
    applications: [csvApps.length, sqlApps.length],
    events: [csvEvents.length, sqlEvents.length],
    recruiters: [csvRec.length, sqlRec.length],
  };

  const normalizeApp = (r) =>
    Object.fromEntries(LEDGER_COLUMNS.map((c) => [c, c === "gap_tags" ? splitGapTags(r[c]).join(",") : r[c] ?? ""]));

  const sqlByFolder = new Map(sqlApps.map((r) => [r.folder, r]));
  csvApps.forEach((csvRow, i) => {
    const sqlRow = sqlByFolder.get(csvRow.folder);
    if (!sqlRow) return diffs.push(`application missing in SQL: ${csvRow.folder}`);
    if (sqlApps[i]?.folder !== csvRow.folder) diffs.push(`application order differs at row ${i + 1}`);
    const a = normalizeApp(csvRow);
    const b = normalizeApp(sqlRow);
    for (const c of LEDGER_COLUMNS) {
      if (a[c] !== b[c]) diffs.push(`${csvRow.folder}.${c}: CSV ${JSON.stringify(a[c])} vs SQL ${JSON.stringify(b[c])}`);
    }
  });
  if (sqlApps.length !== csvApps.length) diffs.push(`application count: CSV ${csvApps.length} vs SQL ${sqlApps.length}`);

  const folders = new Set(csvApps.map((r) => r.folder));
  const keptCsvEvents = csvEvents.filter((e) => folders.has(e.folder));
  const eventKey = (e) => JSON.stringify([e.folder, e.company, e.stage, e.date, e.note || ""]);
  if (keptCsvEvents.length !== sqlEvents.length) {
    diffs.push(`event count (excluding orphans): CSV ${keptCsvEvents.length} vs SQL ${sqlEvents.length}`);
  }
  keptCsvEvents.forEach((e, i) => {
    if (!sqlEvents[i] || eventKey(e) !== eventKey(sqlEvents[i])) {
      diffs.push(`event ${i + 1}: CSV ${eventKey(e)} vs SQL ${sqlEvents[i] ? eventKey(sqlEvents[i]) : "(missing)"}`);
    }
  });

  if (JSON.stringify(normalizeStages(csvStages)) !== JSON.stringify(normalizeStages(sqlStages))) {
    diffs.push("stage definitions differ");
  }

  const recKey = (r) => JSON.stringify([r.id, ...RECRUITER_COLUMNS.map((c) => r[c] ?? "")]);
  if (csvRec.length !== sqlRec.length) diffs.push(`recruiter count: CSV ${csvRec.length} vs SQL ${sqlRec.length}`);
  csvRec.forEach((r, i) => {
    if (!sqlRec[i] || recKey(r) !== recKey(sqlRec[i])) diffs.push(`recruiter ${i + 1} (${r.name}) differs`);
  });

  // What the Applications/Pipeline pages actually show.
  const view = (apps, events, stages) =>
    new Map(attachPipeline(apps, events, stages, now).map((r) => [r.folder, JSON.stringify([
      r.stage, r.stageIndex, r.isTerminal, r.daysInStage, r.daysUntilStage, r.needsFollowup,
      r.followupCount, r.lastFollowupDate, r.daysSinceAction, r.stageHistory,
    ])]));
  const csvView = view(csvApps, csvEvents, csvStages);
  const sqlView = view(sqlApps, sqlEvents, sqlStages);
  for (const [folder, v] of csvView) {
    if (sqlView.get(folder) !== v) diffs.push(`pipeline view differs for ${folder}`);
  }

  return { counts, diffs };
}

// YAML may carry extra keys or `waiting: false`; compare what the app uses.
function normalizeStages({ stages, terminal, actions }) {
  const pick = (s) => ({ key: s.key, label: s.label || s.key, label_fa: s.label_fa || "", icon: s.icon || "", waiting: !!s.waiting });
  return { stages: stages.map(pick), terminal: terminal.map(pick), actions: actions.map(pick) };
}
