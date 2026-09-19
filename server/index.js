import express from "express";
import cors from "cors";
import { parse } from "csv-parse/sync";
import { load as loadYaml } from "js-yaml";
import { readFileSync, readdirSync, existsSync, appendFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JOBSEARCH_DIR = path.resolve(__dirname, "../../JobSearch");
const LEDGER_PATH = path.join(JOBSEARCH_DIR, "engine", "ledger.csv");
const APPLICATIONS_DIR = path.join(JOBSEARCH_DIR, "engine", "applications");
const GAP_TAGS_PATH = path.join(JOBSEARCH_DIR, "engine", "gap_tags.yml");
const CLIENT_DIST = path.resolve(__dirname, "../client/dist");
const MOTIVATION_PATH = path.resolve(__dirname, "../motivation.yml");
const PIPELINE_PATH = path.join(JOBSEARCH_DIR, "engine", "pipeline.csv");
const STAGES_PATH = path.join(JOBSEARCH_DIR, "engine", "pipeline_stages.yml");
const RECRUITERS_PATH = path.join(JOBSEARCH_DIR, "engine", "target_list.csv");

const app = express();
app.use(cors());
app.use(express.json());

function readCsv(file) {
  const raw = readFileSync(file, "utf-8")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  return parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
    record_delimiter: "\n",
  });
}

function loadLedger() {
  return readCsv(LEDGER_PATH).map((r, i) => ({ id: i, ...r }));
}

function loadStages() {
  if (!existsSync(STAGES_PATH)) return { stages: [], terminal: [] };
  const doc = loadYaml(readFileSync(STAGES_PATH, "utf-8")) || {};
  return { stages: doc.stages || [], terminal: doc.terminal || [] };
}

function loadPipelineEvents() {
  if (!existsSync(PIPELINE_PATH)) return [];
  return readCsv(PIPELINE_PATH).filter((e) => e.folder && e.stage);
}

function csvField(value) {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function todayISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Appends one event line to pipeline.csv. The file is append-only — the last
// line for a folder is its current stage — so moving a card is just a new line.
function appendPipelineEvent({ folder, company, stage, note }) {
  const raw = existsSync(PIPELINE_PATH) ? readFileSync(PIPELINE_PATH, "utf-8") : "";
  const needsNewline = raw.length > 0 && !raw.endsWith("\n");
  const line = [folder, company, stage, todayISO(), note || ""].map(csvField).join(",");
  appendFileSync(PIPELINE_PATH, (needsNewline ? "\n" : "") + line + "\n", "utf-8");
}

// Attach stage + history to each ledger row. The CURRENT stage is the last
// event for that folder in file order (the file is append-only), so a later
// line always wins over an earlier one.
function withPipeline(rows) {
  const events = loadPipelineEvents();
  const { stages, terminal } = loadStages();
  const order = new Map(stages.map((s, i) => [s.key, i]));
  const terminalKeys = new Set(terminal.map((t) => t.key));

  const byFolder = new Map();
  events.forEach((e) => {
    if (!e.folder) return;
    if (!byFolder.has(e.folder)) byFolder.set(e.folder, []);
    byFolder.get(e.folder).push({ stage: e.stage, date: e.date, note: e.note || "" });
  });

  const today = new Date();
  return rows.map((r) => {
    const history = byFolder.get(r.folder) || [];
    const last = history.length ? history[history.length - 1] : null;
    const stage = last ? last.stage : r.status || "draft";
    // A stage date can be in the future (an interview already booked), so
    // report past and future separately instead of clamping both to zero.
    let daysInStage = null;
    let daysUntilStage = null;
    if (last && last.date) {
      const d = new Date(last.date);
      if (!isNaN(d)) {
        const diff = Math.round((today - d) / 86400000);
        if (diff >= 0) daysInStage = diff;
        else daysUntilStage = -diff;
      }
    }
    // "Waiting on them" stages: you've acted, now the clock is on the
    // employer. Follow-up guidance (industry standard) is ~7-10 days of
    // silence before a short check-in email is warranted.
    const WAITING_STAGES = new Set([
      "applied",
      "recruiter_screen",
      "technical_interview",
      "final_round",
    ]);
    const FOLLOWUP_THRESHOLD_DAYS = 7;
    const needsFollowup =
      WAITING_STAGES.has(stage) &&
      daysInStage !== null &&
      daysInStage > FOLLOWUP_THRESHOLD_DAYS;

    return {
      ...r,
      stage,
      stageIndex: order.has(stage) ? order.get(stage) : -1,
      isTerminal: terminalKeys.has(stage),
      stageHistory: history,
      daysInStage,
      daysUntilStage,
      needsFollowup,
      followupThresholdDays: FOLLOWUP_THRESHOLD_DAYS,
    };
  });
}

// GET /api/motivation - one line, picked by the date so it holds for the
// whole day and changes at midnight (not random on every refresh).
app.get("/api/motivation", (req, res) => {
  try {
    if (!existsSync(MOTIVATION_PATH)) return res.json(null);
    const doc = loadYaml(readFileSync(MOTIVATION_PATH, "utf-8")) || {};
    const quotes = doc.quotes || [];
    if (quotes.length === 0) return res.json(null);
    const now = new Date();
    // Anchored to the day the list was written, so quotes[0] shows on day one.
    const EPOCH = Date.UTC(2026, 8, 13);
    const dayNumber = Math.floor(
      (Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - EPOCH) / 86400000
    );
    const index = ((dayNumber % quotes.length) + quotes.length) % quotes.length;
    res.json({ ...quotes[index], index, total: quotes.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pipeline-stages - the stage definitions (ordered) + terminal states
app.get("/api/pipeline-stages", (req, res) => {
  try {
    res.json(loadStages());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/pipeline-events - move an application to a new stage (drag & drop
// on the Pipeline board). Body: { folder, stage, note? }
app.post("/api/pipeline-events", (req, res) => {
  try {
    const { folder, stage, note } = req.body || {};
    if (!folder || !stage) {
      return res.status(400).json({ error: "folder and stage are required" });
    }

    const { stages, terminal } = loadStages();
    const validKeys = new Set([...stages, ...terminal].map((s) => s.key));
    if (!validKeys.has(stage)) {
      return res.status(400).json({ error: `Unknown stage: ${stage}` });
    }

    const ledgerRow = loadLedger().find((r) => r.folder === folder);
    if (!ledgerRow) return res.status(404).json({ error: `Unknown folder: ${folder}` });

    appendPipelineEvent({ folder, company: ledgerRow.company, stage, note });

    const updated = withPipeline(loadLedger()).find((r) => r.folder === folder);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/applications - full ledger table
app.get("/api/applications", (req, res) => {
  try {
    res.json(withPipeline(loadLedger()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/applications/:id - one row + any files found in its folder
app.get("/api/applications/:id", (req, res) => {
  try {
    const rows = withPipeline(loadLedger());
    const row = rows[Number(req.params.id)];
    if (!row) return res.status(404).json({ error: "Not found" });

    let files = [];
    let matchReport = null;
    let interviewQuestions = null;
    if (row.folder) {
      const folderPath = path.join(APPLICATIONS_DIR, row.folder);
      if (existsSync(folderPath)) {
        files = readdirSync(folderPath);
        const mrPath = path.join(folderPath, "Match_Report.md");
        const iqPath = path.join(folderPath, "Interview_Questions.md");
        if (existsSync(mrPath)) matchReport = readFileSync(mrPath, "utf-8");
        if (existsSync(iqPath)) interviewQuestions = readFileSync(iqPath, "utf-8");
      }
    }

    res.json({ ...row, files, matchReport, interviewQuestions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/gap-tags - the standard gap-tag dictionary (key -> description)
app.get("/api/gap-tags", (req, res) => {
  try {
    if (!existsSync(GAP_TAGS_PATH)) return res.json({});
    const doc = loadYaml(readFileSync(GAP_TAGS_PATH, "utf-8"));
    res.json(doc || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// --- Recruiter Search Engine (target_list.csv) ---------------------------

const RECRUITER_COLUMNS = [
  "name", "title", "company", "linkedin_url", "source", "date_added",
  "connect_note", "connect_sent", "connect_accepted",
  "followup_note", "followup_sent", "replied", "notes",
];

function loadRecruiters() {
  if (!existsSync(RECRUITERS_PATH)) return [];
  return readCsv(RECRUITERS_PATH).map((r, i) => ({ id: i, ...r }));
}

function writeRecruiters(rows) {
  const header = RECRUITER_COLUMNS.join(",");
  const lines = rows.map((r) =>
    RECRUITER_COLUMNS.map((c) => csvField(r[c] ?? "")).join(",")
  );
  writeFileSync(RECRUITERS_PATH, [header, ...lines].join("\n") + "\n", "utf-8");
}

function recruiterStage(r) {
  if (r.replied) return "replied";
  if (r.followup_sent) return "followup_sent";
  if (r.connect_accepted) return "connect_accepted";
  if (r.connect_sent) return "connect_sent";
  return "added";
}

// Monday-start week, matching the "25/week" rule as he stated it.
function weekStartISO(d) {
  const day = d.getDay(); // 0=Sun..6=Sat
  const diffToMonday = day === 0 ? 6 : day - 1;
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - diffToMonday);
  const pad = (n) => String(n).padStart(2, "0");
  return `${monday.getFullYear()}-${pad(monday.getMonth() + 1)}-${pad(monday.getDate())}`;
}

function withRecruiterMeta(rows) {
  return rows.map((r) => ({ ...r, stage: recruiterStage(r) }));
}

// GET /api/recruiters - target list + funnel counts + daily/weekly send rate
app.get("/api/recruiters", (req, res) => {
  try {
    const rows = withRecruiterMeta(loadRecruiters());
    const today = todayISO();
    const weekStart = weekStartISO(new Date());

    const sentDates = rows.map((r) => r.connect_sent).filter(Boolean);
    const sentToday = sentDates.filter((d) => d === today).length;
    const sentThisWeek = sentDates.filter((d) => d >= weekStart).length;

    const funnel = {
      added: rows.length,
      connect_sent: rows.filter((r) => r.connect_sent).length,
      connect_accepted: rows.filter((r) => r.connect_accepted).length,
      followup_sent: rows.filter((r) => r.followup_sent).length,
      replied: rows.filter((r) => r.replied).length,
    };

    res.json({
      rows,
      funnel,
      daily: { sent: sentToday, cap: 5 },
      weekly: { sent: sentThisWeek, cap: 25, hardCap: 100, weekStart },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/recruiters/:id - mark a stage field with today's date, or clear it
// Body: { field: "connect_sent"|"connect_accepted"|"followup_sent"|"replied", value?: boolean }
app.post("/api/recruiters/:id", (req, res) => {
  try {
    const { field, value = true } = req.body || {};
    const allowed = new Set(["connect_sent", "connect_accepted", "followup_sent", "replied"]);
    if (!allowed.has(field)) {
      return res.status(400).json({ error: `Unknown field: ${field}` });
    }
    const rows = loadRecruiters();
    const idx = Number(req.params.id);
    if (!rows[idx]) return res.status(404).json({ error: "Not found" });

    // A day-5 guardrail: warn (not block) if this send would blow past the
    // self-imposed daily/weekly rhythm.
    let warning = null;
    if (field === "connect_sent" && value) {
      const today = todayISO();
      const weekStart = weekStartISO(new Date());
      const sentDates = rows.map((r) => r.connect_sent).filter(Boolean);
      const sentToday = sentDates.filter((d) => d === today).length;
      const sentThisWeek = sentDates.filter((d) => d >= weekStart).length;
      if (sentToday >= 5) warning = `Already ${sentToday} sent today — daily target is 5.`;
      else if (sentThisWeek >= 25) warning = `Already ${sentThisWeek} sent this week — weekly target is 25.`;
    }

    rows[idx][field] = value ? todayISO() : "";
    writeRecruiters(rows);

    const updated = withRecruiterMeta(rows).find((r) => r.id === idx);
    res.json({ ...updated, warning });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve the built React app (so no dev server / Vite is needed to use this)
if (existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(CLIENT_DIST, "index.html"));
  });
}

const PORT = 4310;
app.listen(PORT, () => {
  console.log("");
  console.log(`  Ledger Dashboard is running:  http://localhost:${PORT}`);
  console.log("");
  console.log(`  ledger: ${LEDGER_PATH}`);
  console.log(`  client: ${existsSync(CLIENT_DIST) ? "serving built app" : "NOT BUILT (run: cd client && npm run build)"}`);
  console.log("");
});
