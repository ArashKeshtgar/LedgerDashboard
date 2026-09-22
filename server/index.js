import "dotenv/config";
import express from "express";
import cors from "cors";
import { parse } from "csv-parse/sync";
import { load as loadYaml } from "js-yaml";
import {
  readFileSync, readdirSync, existsSync, appendFileSync, writeFileSync, mkdirSync, unlinkSync,
  rmSync,
} from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JOBSEARCH_DIR = path.resolve(__dirname, "../../JobSearch");
const ENGINE_DIR = path.join(JOBSEARCH_DIR, "engine");
const LEDGER_PATH = path.join(JOBSEARCH_DIR, "engine", "ledger.csv");
const APPLICATIONS_DIR = path.join(JOBSEARCH_DIR, "engine", "applications");
const GAP_TAGS_PATH = path.join(JOBSEARCH_DIR, "engine", "gap_tags.yml");
const CLIENT_DIST = path.resolve(__dirname, "../client/dist");
const MOTIVATION_PATH = path.resolve(__dirname, "../motivation.yml");
const PIPELINE_PATH = path.join(JOBSEARCH_DIR, "engine", "pipeline.csv");
const STAGES_PATH = path.join(JOBSEARCH_DIR, "engine", "pipeline_stages.yml");
const RECRUITERS_PATH = path.join(JOBSEARCH_DIR, "engine", "target_list.csv");
const FACTS_DIR = path.join(ENGINE_DIR, "facts");
const COMPANIES_PATH = path.join(ENGINE_DIR, "companies.yml");

// Windows Python launcher: the interpreter isn't always on PATH for an
// already-running shell right after install, so try the known install
// location first (see JobSearch/engine/requirements.txt).
const PYTHON_CANDIDATES = [
  "C:\\Users\\akesh\\AppData\\Local\\Programs\\Python\\Python312\\python.exe",
  "python",
];
function findPython() {
  for (const candidate of PYTHON_CANDIDATES) {
    if (candidate === "python" || existsSync(candidate)) return candidate;
  }
  throw new Error("Python not found");
}

function loadFactBank() {
  const facts = {};
  for (const file of readdirSync(FACTS_DIR)) {
    if (!file.endsWith(".yml")) continue;
    const entries = loadYaml(readFileSync(path.join(FACTS_DIR, file), "utf-8")) || [];
    for (const entry of entries) facts[entry.id] = entry;
  }
  return facts;
}

// A follow-up is logged as a pipeline.csv event too, but it never counts as
// a stage change — it only marks that action was taken and resets the
// "needs follow-up" clock computed in withPipeline().
const FOLLOWUP_KEY = "follow_up";

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

const LEDGER_COLUMNS = [
  "date", "company", "role", "branch", "source", "source_detail", "poster_type",
  "poster_name", "end_client", "applied_via", "posting_url", "date_posted",
  "date_seen", "location", "match_score", "variant", "folder", "status",
  "last_contact", "next_action", "outcome", "notes", "gap_tags",
];

function loadLedger() {
  return readCsv(LEDGER_PATH).map((r, i) => ({ id: i, ...r }));
}

// Rewrites ledger.csv wholesale — safe here (small file, not append-only like
// pipeline.csv) and needed for edits/new rows, unlike stage moves which only
// ever append.
function writeLedger(rows) {
  const header = LEDGER_COLUMNS.join(",");
  const lines = rows.map((r) => LEDGER_COLUMNS.map((c) => csvField(r[c] ?? "")).join(","));
  writeFileSync(LEDGER_PATH, [header, ...lines].join("\n") + "\n", "utf-8");
}

// Turns "Sr. Power Platform Developer (Remote)" into "Sr-Power-Platform-Developer"
// for folder names — drops parentheticals, caps word count so names stay sane.
function slugify(s) {
  return String(s || "")
    .replace(/\(.*?\)/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .join("-");
}

function loadStages() {
  if (!existsSync(STAGES_PATH)) return { stages: [], terminal: [], actions: [] };
  const doc = loadYaml(readFileSync(STAGES_PATH, "utf-8")) || {};
  return { stages: doc.stages || [], terminal: doc.terminal || [], actions: doc.actions || [] };
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

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Appends one event line to pipeline.csv. The file is append-only — the last
// line for a folder is its current stage — so moving a card is just a new line.
// `date` defaults to today but can be overridden (e.g. logging a stage change
// that actually happened a few days ago, or a future booked interview date).
function appendPipelineEvent({ folder, company, stage, note, date }) {
  const raw = existsSync(PIPELINE_PATH) ? readFileSync(PIPELINE_PATH, "utf-8") : "";
  const needsNewline = raw.length > 0 && !raw.endsWith("\n");
  const eventDate = date && ISO_DATE_RE.test(date) ? date : todayISO();
  const line = [folder, company, stage, eventDate, note || ""].map(csvField).join(",");
  appendFileSync(PIPELINE_PATH, (needsNewline ? "\n" : "") + line + "\n", "utf-8");
}

// Attach stage + follow-up state to each ledger row. The CURRENT stage is
// the last STAGE-CHANGING event for that folder in file order (the file is
// append-only, so a later line always wins) — a "follow_up" event is logged
// the same append-only way but never counts as a stage change; it only
// resets the "needs follow-up" clock below.
function withPipeline(rows) {
  const events = loadPipelineEvents();
  const { stages, terminal } = loadStages();
  const order = new Map(stages.map((s, i) => [s.key, i]));
  const terminalKeys = new Set(terminal.map((t) => t.key));
  // "Waiting on them" stages: you've acted, now the clock is on the
  // employer. Marked in pipeline_stages.yml (waiting: true) rather than
  // hardcoded here, so the two stay in sync.
  const waitingKeys = new Set(stages.filter((s) => s.waiting).map((s) => s.key));
  // Follow-up guidance (industry standard) is ~7-10 days of silence before a
  // short check-in email is warranted.
  const FOLLOWUP_THRESHOLD_DAYS = 7;

  const byFolder = new Map();
  events.forEach((e) => {
    if (!e.folder) return;
    if (!byFolder.has(e.folder)) byFolder.set(e.folder, []);
    byFolder.get(e.folder).push({ stage: e.stage, date: e.date, note: e.note || "" });
  });

  const today = new Date();
  // A date can be in the future (an interview already booked), so report
  // past and future separately instead of clamping both to zero.
  function daysSince(dateStr) {
    if (!dateStr) return { days: null, until: null };
    const d = new Date(dateStr);
    if (isNaN(d)) return { days: null, until: null };
    const diff = Math.round((today - d) / 86400000);
    return diff >= 0 ? { days: diff, until: null } : { days: null, until: -diff };
  }

  return rows.map((r) => {
    const history = byFolder.get(r.folder) || [];
    const stageEvents = history.filter((h) => h.stage !== FOLLOWUP_KEY);
    const last = stageEvents.length ? stageEvents[stageEvents.length - 1] : null;
    const stage = last ? last.stage : r.status || "draft";

    const { days: daysInStage, until: daysUntilStage } = daysSince(last?.date);

    // Follow-ups logged since the card entered its current stage — one from
    // an earlier stage shouldn't keep resetting today's clock.
    const followupsInStage = history.filter(
      (h) => h.stage === FOLLOWUP_KEY && (!last || h.date >= last.date)
    );
    const lastFollowup = followupsInStage.length
      ? followupsInStage[followupsInStage.length - 1]
      : null;
    const followupCount = followupsInStage.length;
    const lastFollowupDate = lastFollowup ? lastFollowup.date : null;

    // A follow-up is action taken, so "waiting on them" restarts from
    // whichever is more recent: entering the stage, or the last follow-up.
    const lastActionDate =
      lastFollowupDate && (!last || lastFollowupDate >= last.date)
        ? lastFollowupDate
        : last?.date || null;
    const { days: daysSinceAction } = daysSince(lastActionDate);

    const needsFollowup =
      waitingKeys.has(stage) &&
      daysSinceAction !== null &&
      daysSinceAction > FOLLOWUP_THRESHOLD_DAYS;

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
      followupCount,
      lastFollowupDate,
      daysSinceAction,
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
    const { folder, stage, note, date } = req.body || {};
    if (!folder || !stage) {
      return res.status(400).json({ error: "folder and stage are required" });
    }
    if (date && !ISO_DATE_RE.test(date)) {
      return res.status(400).json({ error: "date must be YYYY-MM-DD" });
    }

    const { stages, terminal } = loadStages();
    const validKeys = new Set([...stages, ...terminal].map((s) => s.key));
    if (!validKeys.has(stage)) {
      return res.status(400).json({ error: `Unknown stage: ${stage}` });
    }

    const ledgerRow = loadLedger().find((r) => r.folder === folder);
    if (!ledgerRow) return res.status(404).json({ error: `Unknown folder: ${folder}` });

    appendPipelineEvent({ folder, company: ledgerRow.company, stage, note, date });

    const updated = withPipeline(loadLedger()).find((r) => r.folder === folder);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/pipeline-events/followup - log that a follow-up was sent, without
// moving the card to a new stage. Body: { folder, note? }
app.post("/api/pipeline-events/followup", (req, res) => {
  try {
    const { folder, note } = req.body || {};
    if (!folder) return res.status(400).json({ error: "folder is required" });

    const ledgerRow = loadLedger().find((r) => r.folder === folder);
    if (!ledgerRow) return res.status(404).json({ error: `Unknown folder: ${folder}` });

    appendPipelineEvent({
      folder,
      company: ledgerRow.company,
      stage: FOLLOWUP_KEY,
      note: note || "Follow-up sent",
    });

    const updated = withPipeline(loadLedger()).find((r) => r.folder === folder);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Shared by POST /api/applications (manual entry) and POST /api/packages/build
// (engine-built entry) — both start life in "draft" and create the same
// folder/ledger-row/pipeline-event shape.
function createApplicationRow({
  company, role, location, branch, source, posting_url, match_score, notes, variant, gap_tags,
}) {
  const rows = loadLedger();
  const date = todayISO();
  const base = `${date}__${slugify(company)}__${slugify(role)}`;
  const existingFolders = new Set(rows.map((r) => r.folder));
  let folder = base;
  let n = 2;
  while (existingFolders.has(folder) || existsSync(path.join(APPLICATIONS_DIR, folder))) {
    folder = `${base}-${n++}`;
  }

  const newRow = {
    date, company, role, branch: branch || "", source: source || "",
    source_detail: "", poster_type: "", poster_name: "", end_client: "",
    applied_via: "", posting_url: posting_url || "", date_posted: "",
    date_seen: date, location: location || "", match_score: match_score ?? "",
    variant: variant || "", folder, status: "draft", last_contact: "", next_action: "",
    outcome: "", notes: notes || "", gap_tags: gap_tags || "",
  };

  writeLedger([...rows.map(({ id, ...r }) => r), newRow]);
  mkdirSync(path.join(APPLICATIONS_DIR, folder), { recursive: true });
  appendPipelineEvent({ folder, company, stage: "draft", note: "" });

  return folder;
}

// Updates ledger fields on an already-existing row, found by folder rather
// than array index — used by the build step to fill in what analyze
// estimated (variant, score, gaps) once the heavier call has real numbers.
function updateApplicationRowByFolder(folder, fields) {
  const rows = loadLedger();
  const idx = rows.findIndex((r) => r.folder === folder);
  if (idx === -1) throw new Error(`Unknown folder: ${folder}`);
  rows[idx] = { ...rows[idx], ...fields };
  writeLedger(rows.map(({ id, ...r }) => r));
}

// POST /api/applications - add a new application (starts life in "draft",
// same as one built by hand) so a new posting can be tracked without
// touching ledger.csv directly. Body: { company, role, location?, branch?,
// source?, posting_url?, match_score?, notes? }
app.post("/api/applications", (req, res) => {
  try {
    const { company, role, location, branch, source, posting_url, match_score, notes } =
      req.body || {};
    if (!company || !role) {
      return res.status(400).json({ error: "company and role are required" });
    }

    const folder = createApplicationRow({
      company, role, location, branch, source, posting_url, match_score, notes,
    });

    const updated = withPipeline(loadLedger()).find((r) => r.folder === folder);
    res.status(201).json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/applications/:id - edit the free-text tracking fields (not
// pipeline stage — that's POST /api/pipeline-events — and not the posting
// facts, which come from how the package was built).
const EDITABLE_LEDGER_FIELDS = new Set(["notes", "next_action", "last_contact", "outcome", "gap_tags"]);
app.patch("/api/applications/:id", (req, res) => {
  try {
    const rows = loadLedger();
    const idx = Number(req.params.id);
    if (!rows[idx]) return res.status(404).json({ error: "Not found" });

    const updates = {};
    for (const [k, v] of Object.entries(req.body || {})) {
      if (EDITABLE_LEDGER_FIELDS.has(k)) updates[k] = v;
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No editable fields in request body" });
    }

    rows[idx] = { ...rows[idx], ...updates };
    writeLedger(rows.map(({ id, ...r }) => r));

    const updated = withPipeline(loadLedger())[idx];
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/applications/:id - remove a row and its folder entirely.
// Meant for undoing a draft the user never wanted (e.g. "Skip" on the
// analyze→build gate) — not a general archive feature. pipeline.csv is left
// alone (it's append-only everywhere else in this codebase); an orphaned
// event for a deleted folder is harmless since nothing ever looks it up
// once the folder is gone from ledger.csv.
app.delete("/api/applications/:id", (req, res) => {
  try {
    const rows = loadLedger();
    const idx = Number(req.params.id);
    const row = rows[idx];
    if (!row) return res.status(404).json({ error: "Not found" });

    writeLedger(rows.filter((_, i) => i !== idx).map(({ id, ...r }) => r));

    const folderPath = path.join(APPLICATIONS_DIR, row.folder);
    if (existsSync(folderPath)) rmSync(folderPath, { recursive: true, force: true });

    res.json({ deleted: true, folder: row.folder });
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
    let postingText = null;
    if (row.folder) {
      const folderPath = path.join(APPLICATIONS_DIR, row.folder);
      if (existsSync(folderPath)) {
        files = readdirSync(folderPath);
        const mrPath = path.join(folderPath, "Match_Report.md");
        const iqPath = path.join(folderPath, "Interview_Questions.md");
        const postingPath = path.join(folderPath, "posting.txt");
        if (existsSync(mrPath)) matchReport = readFileSync(mrPath, "utf-8");
        if (existsSync(iqPath)) interviewQuestions = readFileSync(iqPath, "utf-8");
        if (existsSync(postingPath)) postingText = readFileSync(postingPath, "utf-8");
      }
    }

    res.json({ ...row, files, matchReport, interviewQuestions, postingText });
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


// --- Resume Engine (Claude judgment + build.py/validate.py rendering) ----
// See JobSearch/Resume_Engine_Plan.md. Deliberately two-stage: /analyze is
// a light, cheap call that only scores the posting, so nothing is spent
// generating a full package for one the human then rejects; /build is the
// heavier call, only reached after that approval gate.

const BULLET_FACT_TAGS_EXCLUDE = new Set(["project_header", "role_header"]);
const BULLET_FACT_PREFIXES = new Set(["proj", "exp"]);

// Only project/experience bullet facts (not headers, not identity/skills/
// education) are ever selected as a resume bullet — see build.py's
// SECTION_ANCHORS, which is the other half of this contract.
function selectableFactIds(facts) {
  return Object.values(facts)
    .filter((f) => BULLET_FACT_PREFIXES.has(f.id.split(".")[0]))
    .filter((f) => !(f.tags || []).some((t) => BULLET_FACT_TAGS_EXCLUDE.has(t)))
    .map((f) => f.id);
}

function anthropicClient() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set on the server (see server/.env.example)");
  return new Anthropic({ apiKey: key });
}

// The gap_tags.yml dictionary — short kebab-case slug -> description. This
// is what ledger.csv's own gap_tags column is supposed to hold (comma-
// joined slugs), NOT free-text sentences — sentences have commas in them
// and shred into garbage fragments the moment Stats splits on ",".
function loadGapTagsDict() {
  if (!existsSync(GAP_TAGS_PATH)) return {};
  return loadYaml(readFileSync(GAP_TAGS_PATH, "utf-8")) || {};
}

// Duplicate-company check (Resume_Engine_Plan.md step 2) — three-layer
// match (exact key, then aliases, then display name) run BEFORE any API
// call, so a repeat posting doesn't cost tokens to discover.
function findCompanyHistory(companyName) {
  if (!existsSync(COMPANIES_PATH)) return null;
  const companies = loadYaml(readFileSync(COMPANIES_PATH, "utf-8")) || [];
  const lower = companyName.trim().toLowerCase();
  return (
    companies.find((c) => {
      if ((c.display || "").toLowerCase() === lower) return true;
      if ((c.key || "") === lower.replace(/\s+/g, "-")) return true;
      return (c.aliases || []).some((a) => a.toLowerCase() === lower);
    }) || null
  );
}

const ANALYZE_TOOL = {
  name: "submit_analysis",
  description: "Submit the match analysis for this job posting against the candidate's fact bank.",
  input_schema: {
    type: "object",
    properties: {
      base_variant: {
        type: "string",
        enum: ["dotnet_azure", "powerplatform"],
        description: "Which base resume template fits this posting better.",
      },
      match_score: { type: "integer", minimum: 0, maximum: 100 },
      recommendation: { type: "string", enum: ["apply", "apply_with_caveats", "skip"] },
      reasoning: {
        type: "string",
        description: "2-4 sentences: why this score, the strongest fit points, the biggest gaps.",
      },
      gaps: {
        type: "array",
        items: { type: "string" },
        description: "Human-readable gap explanations, one full sentence each, for display.",
      },
      gap_tags: {
        type: "array",
        items: { type: "string" },
        description:
          "The SAME gaps as short kebab-case slugs (e.g. 'etl-ssis', 'power-bi'), for storage " +
          "and stats aggregation — never a sentence, never containing a comma. Reuse an existing " +
          "slug from the dictionary below if this gap matches one; only coin a new short slug " +
          "when it's genuinely not covered yet.",
      },
    },
    required: ["base_variant", "match_score", "recommendation", "reasoning", "gaps", "gap_tags"],
  },
};

// POST /api/packages/analyze - stage 1 (light). This is the ONLY place a
// draft row/folder gets created for the AI-package flow — build fills that
// same folder in rather than making a new one, so analyzing a posting twice
// (or analyzing one already added by hand) can't silently fork into two
// folders for the same job. Body: { company, role, postingText, location?,
// source?, posting_url? }
app.post("/api/packages/analyze", async (req, res) => {
  try {
    const { company, role, postingText, location, source, posting_url } = req.body || {};
    if (!company || !role || !postingText) {
      return res.status(400).json({ error: "company, role and postingText are required" });
    }

    const duplicate = findCompanyHistory(company);
    const facts = loadFactBank();
    const factSummary = Object.values(facts)
      .filter((f) => !(f.tags || []).includes("excluded"))
      .map((f) => `- ${f.id} [${f.strength}]: ${f.claim.trim().replace(/\s+/g, " ")}`)
      .join("\n");
    const gapTagsDict = loadGapTagsDict();
    const gapTagsSummary = Object.entries(gapTagsDict)
      .map(([slug, desc]) => `- ${slug}: ${desc}`)
      .join("\n");

    const client = anthropicClient();
    const message = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 1024,
      system:
        "You are scoring how well a job posting matches a candidate, using ONLY the facts " +
        "listed below — never invent experience, numbers or skills not in this list. " +
        "Call submit_analysis with your result.\n\nCANDIDATE FACT BANK:\n" + factSummary +
        "\n\nEXISTING GAP-TAG DICTIONARY (reuse these slugs when a gap matches one; only " +
        "coin a new short kebab-case slug when it doesn't):\n" + gapTagsSummary,
      messages: [
        { role: "user", content: `Job posting for ${role} at ${company}:\n\n${postingText}` },
      ],
      tools: [ANALYZE_TOOL],
      tool_choice: { type: "tool", name: "submit_analysis" },
    });

    const toolUse = message.content.find((b) => b.type === "tool_use");
    if (!toolUse) throw new Error("Model did not return a structured analysis");
    const analysis = toolUse.input;

    const folder = createApplicationRow({
      company, role, location, source, posting_url,
      match_score: analysis.match_score,
      variant: analysis.base_variant,
      gap_tags: (analysis.gap_tags || []).join(","),
    });
    writeFileSync(path.join(APPLICATIONS_DIR, folder, "posting.txt"), postingText, "utf-8");
    const createdRow = withPipeline(loadLedger()).find((r) => r.folder === folder);

    res.json({
      ...analysis,
      id: createdRow.id,
      folder,
      duplicate: duplicate
        ? { display: duplicate.display, applications: duplicate.applications || [] }
        : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// fact_id is a real enum of the fact bank's bullet-eligible facts, so the
// model is structurally unable to invent an id the guardian would reject.
function buildPlanTool(facts) {
  return {
    name: "submit_package",
    description: "Submit the full application package content.",
    input_schema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "Rewritten Professional Summary paragraph, using the posting's own vocabulary.",
        },
        bullets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              fact_id: { type: "string", enum: selectableFactIds(facts) },
              text: { type: "string" },
            },
            required: ["fact_id", "text"],
          },
          minItems: 8,
        },
        match_report_markdown: { type: "string" },
        interview_questions_markdown: { type: "string" },
        cover_letter_markdown: {
          type: "string",
          description:
            "BODY PARAGRAPHS ONLY, separated by blank lines (\\n\\n). Do not include " +
            "'Dear Hiring Manager,' or any greeting, and do not include 'Sincerely,' or a " +
            "sign-off — the cover letter template already has the header, greeting and " +
            "sign-off, this field is only what goes between them.",
        },
      },
      required: [
        "summary", "bullets", "match_report_markdown",
        "interview_questions_markdown", "cover_letter_markdown",
      ],
    },
  };
}

// POST /api/packages/build - stage 2 (heavy), only reached after the human
// approval gate. `folder` must already exist (created by /analyze) — this
// endpoint fills it in, it never creates a new row. Body: { folder,
// company, role, postingText, base_variant, match_score?, gaps?, caveats? }
app.post("/api/packages/build", async (req, res) => {
  try {
    const { folder, company, role, postingText, base_variant, match_score, gap_tags, caveats } =
      req.body || {};
    if (!folder || !company || !role || !postingText || !base_variant) {
      return res
        .status(400)
        .json({ error: "folder, company, role, postingText and base_variant are required" });
    }

    const folderPath = path.join(APPLICATIONS_DIR, folder);
    if (!existsSync(folderPath)) {
      return res.status(404).json({
        error: `Unknown folder: ${folder} — call /api/packages/analyze first, it creates this`,
      });
    }

    const facts = loadFactBank();
    const factDetail = Object.values(facts)
      .filter((f) => !(f.tags || []).includes("excluded"))
      .map((f) =>
        JSON.stringify({
          id: f.id,
          claim: f.claim.trim().replace(/\s+/g, " "),
          strength: f.strength,
          allowed_numbers: f.allowed_numbers,
          forbidden: f.forbidden,
        })
      )
      .join("\n");

    const client = anthropicClient();
    const message = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 8192,
      system:
        "You are building a tailored job application package using ONLY the fact bank below. " +
        "Rules: every bullet must cite a real fact_id from the bank; any number you write in a " +
        "bullet must be exactly one of that fact's allowed_numbers (or omit numbers entirely); " +
        "never use any of that fact's forbidden words/phrases; never use the words locks, " +
        "prevents, guarantees or ensures anywhere. Rewrite each bullet's wording (not its " +
        "underlying facts) to use the posting's own vocabulary. Pick 3-5 bullets per relevant " +
        "project/role section — do not use every fact, and omit a project/role entirely if it " +
        "has no relevant facts for this posting. EXCEPTION: always include exp.ctdi.description " +
        "(the Material Handler bridge role) regardless of relevance — it explains an otherwise " +
        "unexplained employment gap on the timeline, which matters more than topical fit here.\n\n" +
        (caveats
          ? "The candidate has real gaps for this posting — address them honestly in the " +
            "cover letter rather than hiding them.\n\n"
          : "") +
        "FACT BANK (JSON lines):\n" + factDetail,
      messages: [
        {
          role: "user",
          content:
            `Build the package for ${role} at ${company} (base template: ${base_variant}).\n\n` +
            `Job posting:\n${postingText}`,
        },
      ],
      tools: [buildPlanTool(facts)],
      tool_choice: { type: "tool", name: "submit_package" },
    });

    const toolUse = message.content.find((b) => b.type === "tool_use");
    if (!toolUse) throw new Error("Model did not return a structured package");
    const generated = toolUse.input;

    const plan = {
      base_variant,
      target_role: role,
      summary: generated.summary,
      bullets: generated.bullets,
      match_report_markdown: generated.match_report_markdown,
      cover_letter_markdown: generated.cover_letter_markdown,
      interview_questions_markdown: generated.interview_questions_markdown,
    };

    // Guardian check BEFORE anything is written to disk.
    const planPath = path.join(ENGINE_DIR, `.tmp-plan-${Date.now()}.json`);
    writeFileSync(planPath, JSON.stringify(plan, null, 2), "utf-8");
    const python = findPython();
    const validation = spawnSync(python, [path.join(ENGINE_DIR, "validate.py"), planPath], {
      encoding: "utf-8",
    });

    if (validation.status !== 0) {
      unlinkSync(planPath);
      return res.status(422).json({
        error: "The generated package failed guardian validation",
        details: (validation.stdout || validation.stderr || "").split("\n").filter(Boolean),
      });
    }

    // Guardian passed — render into the folder /analyze already created.
    const build = spawnSync(python, [path.join(ENGINE_DIR, "build.py"), planPath, folderPath], {
      encoding: "utf-8",
    });
    unlinkSync(planPath);

    if (build.status !== 0) {
      return res.status(500).json({
        error: "build.py failed",
        folder,
        details: (build.stdout || build.stderr || "").split("\n").filter(Boolean),
      });
    }

    writeFileSync(path.join(folderPath, "Match_Report.md"), generated.match_report_markdown, "utf-8");
    writeFileSync(
      path.join(folderPath, "Interview_Questions.md"),
      generated.interview_questions_markdown,
      "utf-8"
    );
    writeFileSync(path.join(folderPath, "CoverLetter.md"), generated.cover_letter_markdown, "utf-8");

    // Refresh the row with the heavier call's numbers (analyze's were an
    // early estimate) — folder/status/etc. are untouched.
    updateApplicationRowByFolder(folder, {
      variant: base_variant,
      match_score: match_score ?? "",
      gap_tags: (gap_tags || []).join(","),
    });

    const updated = withPipeline(loadLedger()).find((r) => r.folder === folder);
    res.status(201).json(updated);
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
