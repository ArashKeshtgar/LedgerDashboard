import sql from "mssql";
import { todayISO } from "../text.js";
import { RECRUITER_DATE_FIELDS, recruiterId, splitGapTags } from "./shape.js";

// SQL Server storage (db/03-schema.sql). Same interface and the same row
// shapes as csvStore.js: dates come back as "YYYY-MM-DD" strings (formatted
// by SQL Server itself, so no JavaScript time-zone conversion is involved)
// and empty text is "", exactly as the CSV had it.

// API field -> column, for every ledger field except folder and gap_tags
// (which have their own handling). Also the whitelist for dynamic UPDATEs.
export const APPLICATION_COLUMNS = {
  date: { column: "AppliedDate", type: "date" },
  company: { column: "Company" },
  role: { column: "Role" },
  branch: { column: "Branch" },
  source: { column: "Source" },
  source_detail: { column: "SourceDetail" },
  poster_type: { column: "PosterType" },
  poster_name: { column: "PosterName" },
  end_client: { column: "EndClient" },
  applied_via: { column: "AppliedVia" },
  posting_url: { column: "PostingUrl" },
  date_posted: { column: "DatePosted", type: "date" },
  date_seen: { column: "DateSeen", type: "date" },
  location: { column: "Location" },
  match_score: { column: "MatchScore", type: "score" },
  variant: { column: "Variant" },
  status: { column: "Status" },
  last_contact: { column: "LastContact" },
  next_action: { column: "NextAction" },
  outcome: { column: "Outcome" },
  notes: { column: "Notes" },
};

export const RECRUITER_COLUMNS_SQL = {
  name: { column: "Name" },
  title: { column: "Title" },
  company: { column: "Company" },
  linkedin_url: { column: "LinkedInUrl" },
  source: { column: "Source" },
  date_added: { column: "DateAdded", type: "date" },
  connect_note: { column: "ConnectNote" },
  connect_sent: { column: "ConnectSentOn", type: "date" },
  connect_accepted: { column: "ConnectAcceptedOn", type: "date" },
  followup_note: { column: "FollowupNote" },
  followup_sent: { column: "FollowupSentOn", type: "date" },
  replied: { column: "RepliedOn", type: "date" },
  notes: { column: "Notes" },
};

// SELECT list that turns columns back into API fields. Dates are formatted
// by SQL Server (style 23 = yyyy-mm-dd), NULL becomes "".
function selectList(columns, alias) {
  return Object.entries(columns)
    .map(([field, { column, type }]) => {
      const ref = `${alias}.${column}`;
      // varchar, not char: ISNULL takes the first argument's type, and a
      // char(10) would turn the "" fallback into ten spaces (truthy).
      if (type === "date") return `ISNULL(CONVERT(varchar(10), ${ref}, 23), '') AS [${field}]`;
      if (type === "score") return `ISNULL(CAST(${ref} AS nvarchar(3)), '') AS [${field}]`;
      return `${ref} AS [${field}]`;
    })
    .join(",\n      ");
}

const APPLICATION_SELECT = `
  SELECT a.Folder AS folder,
      ${selectList(APPLICATION_COLUMNS, "a")},
      ISNULL((SELECT STRING_AGG(t.Slug, ',') WITHIN GROUP (ORDER BY t.Position)
              FROM dbo.ApplicationGapTags t WHERE t.ApplicationId = a.Id), '') AS gap_tags
  FROM dbo.Applications a`;

const RECRUITER_SELECT = `
  SELECT r.Id AS dbId, ${selectList(RECRUITER_COLUMNS_SQL, "r")}
  FROM dbo.Recruiters r`;

// Converts an API value to what the column takes: "" -> NULL for dates and
// the score, text stays text (NOT NULL columns get "" rather than NULL).
function toDbValue(value, type) {
  const s = value === null || value === undefined ? "" : String(value).trim();
  if (type === "date" || type === "score") return s === "" ? null : s;
  return value === null || value === undefined ? "" : String(value);
}

// The placeholder expression for a bound value, cast to the column type.
export function valueExpr(param, type) {
  if (type === "date") return `CAST(@${param} AS date)`;
  if (type === "score") return `CAST(@${param} AS tinyint)`;
  return `@${param}`;
}

export function bindColumn(request, name, value, type) {
  if (type === "date") request.input(name, sql.NVarChar(10), toDbValue(value, type));
  else if (type === "score") request.input(name, sql.NVarChar(10), toDbValue(value, type));
  else request.input(name, sql.NVarChar(sql.MAX), toDbValue(value, type));
}

// SQL Server refused the value (bad date, too long, constraint, duplicate):
// the caller's input was wrong, so the API answers 400 rather than 500.
const VALIDATION_ERROR_NUMBERS = new Set([220, 241, 242, 245, 547, 2601, 2627, 2628, 8114, 8115, 8152]);
export function isStoreValidationError(err) {
  return !!err && typeof err.number === "number" && VALIDATION_ERROR_NUMBERS.has(err.number);
}

// "2026-09-25" or "2026-09-25T14:30[:ss]" -> { date, time|null }.
export function splitEventDate(value) {
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}(?::\d{2})?))?$/.exec(String(value || ""));
  if (!m) return { date: todayISO(), time: null };
  return { date: m[1], time: m[2] || null };
}

export async function connectSqlPool({ server, port, database, user, password, trustServerCertificate = true }) {
  return new sql.ConnectionPool({
    server,
    port,
    database,
    user,
    password,
    options: { encrypt: true, trustServerCertificate, enableArithAbort: true },
    pool: { max: 10 },
  }).connect();
}

export function createSqlStore(pool) {
  async function inTransaction(work) {
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      const result = await work(() => new sql.Request(tx));
      await tx.commit();
      return result;
    } catch (err) {
      await tx.rollback().catch(() => {});
      throw err;
    }
  }

  async function replaceGapTags(request, applicationId, gapTags) {
    await request().input("id", sql.Int, applicationId)
      .query("DELETE FROM dbo.ApplicationGapTags WHERE ApplicationId = @id");
    const slugs = splitGapTags(gapTags);
    for (const [i, slug] of slugs.entries()) {
      await request()
        .input("id", sql.Int, applicationId)
        .input("slug", sql.NVarChar(60), slug)
        .input("pos", sql.TinyInt, i)
        .query("INSERT INTO dbo.ApplicationGapTags (ApplicationId, Slug, Position) VALUES (@id, @slug, @pos)");
    }
  }

  async function insertEvent(request, { applicationId, folder, stage, date, note }) {
    const { date: d, time } = splitEventDate(date);
    const r = request()
      .input("stage", sql.NVarChar(40), stage)
      .input("d", sql.NVarChar(10), d)
      .input("t", sql.NVarChar(8), time)
      .input("note", sql.NVarChar(1000), note || "");
    let target;
    if (applicationId !== undefined) {
      r.input("appId", sql.Int, applicationId);
      target = "@appId";
    } else {
      r.input("folder", sql.NVarChar(150), folder);
      target = "(SELECT Id FROM dbo.Applications WHERE Folder = @folder)";
    }
    const result = await r.query(`
      INSERT INTO dbo.PipelineEvents (ApplicationId, StageKey, EventDate, EventTime, Note)
      SELECT ${target}, @stage, CAST(@d AS date), CAST(@t AS time(0)), @note
      WHERE ${target} IS NOT NULL`);
    if (result.rowsAffected[0] !== 1) throw new Error(`Unknown folder: ${folder}`);
  }

  function withRecruiterIds(rows) {
    return rows.map(({ dbId, ...r }) => ({ id: recruiterId(r), ...r }));
  }

  return {
    kind: "sql",
    pool,

    async listApplications() {
      const { recordset } = await pool.request().query(`${APPLICATION_SELECT} ORDER BY a.Id`);
      return recordset.map((r) => ({ id: r.folder, ...r }));
    },

    async getApplication(folder) {
      const { recordset } = await pool
        .request()
        .input("folder", sql.NVarChar(150), folder)
        .query(`${APPLICATION_SELECT} WHERE a.Folder = @folder`);
      return recordset[0] ? { id: recordset[0].folder, ...recordset[0] } : null;
    },

    // Row, gap tags and the initial "draft" event in one transaction —
    // either all of it exists afterwards or none of it does.
    async createApplication(row) {
      await inTransaction(async (request) => {
        const r = request().input("folder", sql.NVarChar(150), row.folder);
        const fields = Object.entries(APPLICATION_COLUMNS);
        fields.forEach(([field, { type }], i) => bindColumn(r, `p${i}`, row[field], type));
        const { recordset } = await r.query(`
          INSERT INTO dbo.Applications (Folder, ${fields.map(([, c]) => c.column).join(", ")})
          OUTPUT INSERTED.Id
          VALUES (@folder, ${fields.map(([, { type }], i) => valueExpr(`p${i}`, type)).join(", ")})`);
        const applicationId = recordset[0].Id;
        await replaceGapTags(request, applicationId, row.gap_tags);
        await insertEvent(request, { applicationId, stage: "draft", date: todayISO(), note: "" });
      });
    },

    async updateApplication(folder, fields) {
      return inTransaction(async (request) => {
        const { recordset } = await request()
          .input("folder", sql.NVarChar(150), folder)
          .query("SELECT Id FROM dbo.Applications WITH (UPDLOCK) WHERE Folder = @folder");
        if (!recordset[0]) return false;
        const applicationId = recordset[0].Id;

        const updates = Object.entries(fields).filter(([f]) => APPLICATION_COLUMNS[f]);
        if (updates.length) {
          const r = request().input("id", sql.Int, applicationId);
          const sets = updates.map(([field, value], i) => {
            const { column, type } = APPLICATION_COLUMNS[field];
            bindColumn(r, `p${i}`, value, type);
            return `${column} = ${valueExpr(`p${i}`, type)}`;
          });
          await r.query(`UPDATE dbo.Applications SET ${sets.join(", ")} WHERE Id = @id`);
        }
        if (Object.prototype.hasOwnProperty.call(fields, "gap_tags")) {
          await replaceGapTags(request, applicationId, fields.gap_tags);
        }
        return true;
      });
    },

    // Gap tags and pipeline events go with the row (ON DELETE CASCADE).
    async deleteApplication(folder) {
      await pool.request().input("folder", sql.NVarChar(150), folder)
        .query("DELETE FROM dbo.Applications WHERE Folder = @folder");
    },

    async listEvents() {
      const { recordset } = await pool.request().query(`
        SELECT a.Folder AS folder, a.Company AS company, e.StageKey AS stage,
               CONVERT(char(10), e.EventDate, 23)
                 + CASE WHEN e.EventTime IS NULL THEN ''
                        WHEN DATEPART(second, e.EventTime) = 0 THEN 'T' + CONVERT(char(5), e.EventTime, 108)
                        ELSE 'T' + CONVERT(char(8), e.EventTime, 108) END AS [date],
               e.Note AS note
        FROM dbo.PipelineEvents e
        JOIN dbo.Applications a ON a.Id = e.ApplicationId
        ORDER BY e.Id`);
      return recordset;
    },

    async appendEvent({ folder, stage, date, note }) {
      await insertEvent(() => pool.request(), { folder, stage, date, note });
    },

    // Same shape as pipeline_stages.yml: `waiting` only present when true.
    async loadStages() {
      const { recordset } = await pool.request().query(`
        SELECT StageKey, Kind, Label, LabelFa, Icon, IsWaiting
        FROM dbo.Stages ORDER BY SortOrder`);
      const out = { stages: [], terminal: [], actions: [] };
      const bucket = { stage: out.stages, terminal: out.terminal, action: out.actions };
      for (const s of recordset) {
        const item = { key: s.StageKey, label: s.Label, label_fa: s.LabelFa, icon: s.Icon };
        if (s.IsWaiting) item.waiting = true;
        bucket[s.Kind].push(item);
      }
      return out;
    },

    async listRecruiters() {
      const { recordset } = await pool.request().query(`${RECRUITER_SELECT} ORDER BY r.Id`);
      return withRecruiterIds(recordset);
    },

    // Skips rows whose LinkedIn URL is already on the list (case-insensitive).
    async addRecruiters(newRows) {
      return inTransaction(async (request) => {
        const { recordset } = await request().query(
          "SELECT LOWER(LinkedInUrl) AS url FROM dbo.Recruiters WITH (UPDLOCK, HOLDLOCK) WHERE LinkedInUrl <> ''");
        const known = new Set(recordset.map((r) => r.url));
        const added = [];
        const skipped = [];
        for (const row of newRows) {
          const key = (row.linkedin_url || "").trim().toLowerCase();
          if (key && known.has(key)) {
            skipped.push(row);
            continue;
          }
          if (key) known.add(key);
          const r = request();
          const fields = Object.entries(RECRUITER_COLUMNS_SQL);
          fields.forEach(([field, { type }], i) => bindColumn(r, `p${i}`, row[field], type));
          await r.query(`
            INSERT INTO dbo.Recruiters (${fields.map(([, c]) => c.column).join(", ")})
            VALUES (${fields.map(([, { type }], i) => valueExpr(`p${i}`, type)).join(", ")})`);
          added.push(row);
        }
        return { added, skipped };
      });
    },

    async setRecruiterDate(id, field, date) {
      if (!RECRUITER_DATE_FIELDS.has(field)) throw new Error(`Unknown field: ${field}`);
      const { recordset } = await pool.request().query(`${RECRUITER_SELECT} ORDER BY r.Id`);
      const match = recordset.find(({ dbId, ...r }) => recruiterId(r) === id);
      if (!match) return null;
      const { column } = RECRUITER_COLUMNS_SQL[field];
      await pool
        .request()
        .input("dbId", sql.Int, match.dbId)
        .input("d", sql.NVarChar(10), date || null)
        .query(`UPDATE dbo.Recruiters SET ${column} = CAST(@d AS date) WHERE Id = @dbId`);
      const { dbId, ...rest } = match;
      return { id, ...rest, [field]: date || "" };
    },

    async close() {
      await pool.close();
    },
  };
}
