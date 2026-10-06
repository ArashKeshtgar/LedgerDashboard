import express from "express";
import cookieSession from "cookie-session";
import { load as loadYaml } from "js-yaml";
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, unlinkSync, rmSync } from "fs";
import { randomUUID } from "crypto";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";
import { FileLockedError, writeFileAtomic } from "./csv.js";
import { monthUsage, readUsage, recordUsage, summarize, usageCalls, usageRecord } from "./aiUsage.js";
import { readPostings, similarTo } from "./similar.js";
import { buildFunnel } from "./funnel.js";
import {
  groupRejections, isReviewed, postingKey, readRejections, readReviewed, REVIEWED_FILE, weeklyTrend,
} from "./rejections.js";
import { isSafeFolderName, resolveApplicationFolder, UnsafeFolderError } from "./paths.js";
import { attachPipeline, FOLLOWUP_KEY } from "./pipeline.js";
import { passwordMatches, createLoginLimiter, originGuard } from "./security.js";
import { runProcess, findPython } from "./process.js";
import { slugify, todayISO, weekStartISO, ISO_DATE_RE } from "./text.js";
import { RECRUITER_DATE_FIELDS } from "./stores/shape.js";
import { CONTACT_FIELDS, ContactValidationError, resolveContact } from "./contact.js";
import { isStoreValidationError } from "./stores/sqlStore.js";
import { registerTruthRoutes } from "./truthRoutes.js";
import { bankFingerprint, gapStatus, readFacts } from "./truthBank.js";

const VALIDATE_TIMEOUT_MS = 30_000;
// LibreOffice's docx -> pdf conversion is the slow part of a build.
const BUILD_TIMEOUT_MS = 180_000;

// Builds the Express app from an already-validated config (see config.js).
// `deps.store` is the data store (stores/index.js — CSV files or SQL Server,
// same interface); application folders, the fact bank and the engine
// scripts are always files under cfg.jobsearchDir. `deps.anthropic` lets
// tests swap the Claude client for a fake.
export function createApp(cfg, deps = {}) {
  const store = deps.store;
  if (!store) throw new Error("createApp needs deps.store (see stores/index.js)");
  const JOBSEARCH_DIR = cfg.jobsearchDir;
  const ENGINE_DIR = path.join(JOBSEARCH_DIR, "engine");
  const APPLICATIONS_DIR = path.join(ENGINE_DIR, "applications");
  const GAP_TAGS_PATH = path.join(ENGINE_DIR, "gap_tags.yml");
  const FACTS_DIR = path.join(ENGINE_DIR, "facts");
  const COMPANIES_PATH = path.join(ENGINE_DIR, "companies.yml");

  // Folders currently being built — a second build of the same folder while
  // the first is still rendering would race on the same output files.
  const buildsInFlight = new Set();

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", originGuard(cfg.allowedOrigins));

  // Maps known error types to status codes; everything else is a 500. In
  // production the raw message (which can include server file paths) is
  // logged, not sent.
  function sendError(res, err) {
    if (err instanceof FileLockedError) return res.status(423).json({ error: err.message });
    if (err instanceof UnsafeFolderError) return res.status(400).json({ error: err.message });
    if (err instanceof ContactValidationError) return res.status(400).json({ error: err.message });
    // A value the database refused (bad date, too long, duplicate, constraint).
    if (isStoreValidationError(err)) return res.status(400).json({ error: `Invalid value: ${err.message}` });
    console.error(err);
    res.status(500).json({ error: cfg.production ? "Internal server error" : err.message });
  }

  // Password gate — only active when DASHBOARD_PASSWORD is set (i.e. in a
  // deployed environment). Local use with no password has no login at all,
  // which is why config.js only lets it bind to 127.0.0.1.
  if (cfg.password) {
    app.set("trust proxy", 1); // Render/Railway sit behind a proxy — needed for secure cookies
    // Signed cookie session: nothing kept in server memory, so sessions
    // survive restarts and redeploys; rotating SESSION_SECRET logs every
    // device out.
    app.use(
      cookieSession({
        name: "ld_session",
        keys: [cfg.sessionSecret],
        maxAge: 30 * 24 * 60 * 60 * 1000,
        sameSite: "lax",
        httpOnly: true,
        secure: cfg.secureCookies ?? cfg.production,
      })
    );

    const limiter = createLoginLimiter();

    app.post("/api/login", (req, res) => {
      const ip = req.ip;
      const wait = limiter.retryAfterSeconds(ip);
      if (wait > 0) {
        res.set("Retry-After", String(wait));
        return res
          .status(429)
          .json({ error: `Too many wrong passwords — try again in ${Math.ceil(wait / 60)} min.` });
      }
      const { password } = req.body || {};
      if (!passwordMatches(password, cfg.password)) {
        limiter.recordFailure(ip);
        return res.status(401).json({ error: "Wrong password" });
      }
      limiter.recordSuccess(ip);
      req.session.authed = true;
      res.json({ authed: true });
    });

    app.post("/api/logout", (req, res) => {
      req.session = null;
      res.json({ authed: false });
    });

    // A script's bearer token counts as a logged-in session. Browsers never
    // send this header on their own, so it adds no cross-site exposure.
    const hasApiToken = (req) => {
      if (!cfg.apiToken) return false;
      const m = /^Bearer (.+)$/.exec(req.get("authorization") || "");
      return !!m && passwordMatches(m[1], cfg.apiToken);
    };

    app.get("/api/session", (req, res) => {
      res.json({ authed: !!req.session?.authed || hasApiToken(req), passwordRequired: true });
    });

    app.use("/api", (req, res, next) => {
      if (req.path === "/login" || req.path === "/session") return next();
      if (req.session?.authed || hasApiToken(req)) return next();
      res.status(401).json({ error: "Login required" });
    });
  } else {
    app.get("/api/session", (req, res) => res.json({ authed: true, passwordRequired: false }));
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

  async function findLedgerRow(folder) {
    if (!isSafeFolderName(folder)) return null;
    return store.getApplication(folder);
  }

  async function withPipeline(rows) {
    const [events, stages] = await Promise.all([store.listEvents(), store.loadStages()]);
    return attachPipeline(rows, events, stages);
  }

  async function withPipelineFor(folder) {
    const row = await store.getApplication(folder);
    return row ? (await withPipeline([row]))[0] : null;
  }

  // GET /api/motivation - one line, picked by the date so it holds for the
  // whole day and changes at midnight (not random on every refresh).
  // ?shift=n steps n quotes away from today's (the card's ‹ › buttons).
  app.get("/api/motivation", (req, res) => {
    try {
      if (!existsSync(cfg.motivationPath)) return res.json(null);
      const doc = loadYaml(readFileSync(cfg.motivationPath, "utf-8")) || {};
      const quotes = doc.quotes || [];
      if (quotes.length === 0) return res.json(null);
      const now = new Date();
      // Anchored to the day the list was written, so quotes[0] shows on day one.
      const EPOCH = Date.UTC(2026, 8, 13);
      const dayNumber = Math.floor(
        (Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - EPOCH) / 86400000
      );
      const shift = Number.parseInt(req.query.shift, 10) || 0;
      const index = (((dayNumber + shift) % quotes.length) + quotes.length) % quotes.length;
      res.json({ ...quotes[index], index, total: quotes.length, shift });
    } catch (err) {
      sendError(res, err);
    }
  });

  // GET /api/pipeline-stages - the stage definitions (ordered) + terminal states
  app.get("/api/pipeline-stages", async (req, res) => {
    try {
      res.json(await store.loadStages());
    } catch (err) {
      sendError(res, err);
    }
  });

  // POST /api/pipeline-events - move an application to a new stage (drag & drop
  // on the Pipeline board). Body: { folder, stage, note?, date? }
  app.post("/api/pipeline-events", async (req, res) => {
    try {
      const { folder, stage, note, date } = req.body || {};
      if (!folder || !stage) {
        return res.status(400).json({ error: "folder and stage are required" });
      }
      if (date && !ISO_DATE_RE.test(date)) {
        return res.status(400).json({ error: "date must be YYYY-MM-DD, optionally with THH:mm" });
      }

      const { stages, terminal } = await store.loadStages();
      const validKeys = new Set([...stages, ...terminal].map((s) => s.key));
      if (!validKeys.has(stage)) {
        return res.status(400).json({ error: `Unknown stage: ${stage}` });
      }

      const ledgerRow = await findLedgerRow(folder);
      if (!ledgerRow) return res.status(404).json({ error: `Unknown folder: ${folder}` });

      await store.appendEvent({ folder, stage, note, date });
      res.json(await withPipelineFor(folder));
    } catch (err) {
      sendError(res, err);
    }
  });

  // POST /api/pipeline-events/followup - log that a follow-up was sent, without
  // moving the card to a new stage. Body: { folder, note? }
  app.post("/api/pipeline-events/followup", async (req, res) => {
    try {
      const { folder, note } = req.body || {};
      if (!folder) return res.status(400).json({ error: "folder is required" });

      const ledgerRow = await findLedgerRow(folder);
      if (!ledgerRow) return res.status(404).json({ error: `Unknown folder: ${folder}` });

      await store.appendEvent({ folder, stage: FOLLOWUP_KEY, note: note || "Follow-up sent" });
      res.json(await withPipelineFor(folder));
    } catch (err) {
      sendError(res, err);
    }
  });

  // POST /api/pipeline-events/undo - take back a stage marked by mistake.
  // Body: { folder, all? } — removes the latest event, or with all:true every
  // event after the initial draft (back to where the row started). The
  // contact captured on "Approve & Apply" is left alone.
  app.post("/api/pipeline-events/undo", async (req, res) => {
    try {
      const { folder, all } = req.body || {};
      if (!folder) return res.status(400).json({ error: "folder is required" });

      const ledgerRow = await findLedgerRow(folder);
      if (!ledgerRow) return res.status(404).json({ error: `Unknown folder: ${folder}` });

      const removed = await store.removeEvents(folder, { all: all === true });
      if (removed.length === 0) {
        return res.status(409).json({ error: "Nothing to undo — this application is at its first stage" });
      }
      res.json({ ...(await withPipelineFor(folder)), removed });
    } catch (err) {
      sendError(res, err);
    }
  });

  // Shared by POST /api/applications (manual entry) and POST /api/packages/analyze
  // (engine-built entry) — both start life in "draft" and create the same
  // folder/ledger-row/pipeline-event shape.
  async function createApplicationRow({
    company, role, location, branch, source, posting_url, match_score, notes, variant, gap_tags,
  }) {
    const rows = await store.listApplications();
    const date = todayISO();
    const base = `${date}__${slugify(company) || "Company"}__${slugify(role) || "Role"}`;
    const existingFolders = new Set(rows.map((r) => r.folder));
    let folder = base;
    let n = 2;
    while (existingFolders.has(folder) || existsSync(path.join(APPLICATIONS_DIR, folder))) {
      folder = `${base}-${n++}`;
    }
    const folderPath = resolveApplicationFolder(APPLICATIONS_DIR, folder);

    const newRow = {
      date, company, role, branch: branch || "", source: source || "",
      source_detail: "", poster_type: "", poster_name: "", end_client: "",
      applied_via: "", posting_url: posting_url || "", date_posted: "",
      date_seen: date, location: location || "", match_score: match_score ?? "",
      variant: variant || "", folder, status: "draft", last_contact: "", next_action: "",
      outcome: "", notes: notes || "", gap_tags: gap_tags || "",
    };

    await store.createApplication(newRow);
    mkdirSync(folderPath, { recursive: true });

    return folder;
  }

  // Updates ledger fields on an already-existing row, found by folder.
  async function updateApplicationRowByFolder(folder, fields) {
    if (!(await store.updateApplication(folder, fields))) throw new Error(`Unknown folder: ${folder}`);
  }

  // POST /api/applications - add a new application (starts life in "draft",
  // same as one built by hand) so a new posting can be tracked without
  // touching ledger.csv directly. Body: { company, role, location?, branch?,
  // source?, posting_url?, match_score?, notes?, postingText? }
  // postingText is saved as posting.txt, so the draft can be analyzed later
  // from its page — how the nightly search saves postings without spending
  // API credit on them. The nightly search scores postings itself (its own
  // session, not API credit) and sends that estimate along: variant, gap_tags,
  // and optionally gaps + reasoning, kept in analysis.json marked as an
  // estimate. A click on Analyze in the app replaces it with the engine's score.
  app.post("/api/applications", async (req, res) => {
    try {
      const {
        company, role, location, branch, source, posting_url, match_score, notes, postingText,
        variant, gap_tags, gaps, reasoning,
      } = req.body || {};
      if (!company || !role) {
        return res.status(400).json({ error: "company and role are required" });
      }
      const variants = ANALYZE_TOOL.input_schema.properties.base_variant.enum;
      if (variant && !variants.includes(variant)) {
        return res.status(400).json({ error: `variant must be one of ${variants.join(", ")}` });
      }
      const { kept: tags, dropped: droppedClosedGaps } = withoutClosedGaps(toGapTagList(gap_tags));

      const folder = await createApplicationRow({
        company, role, location, branch, source, posting_url, match_score, notes,
        variant, gap_tags: tags.join(","),
      });
      if (postingText) {
        writeFileSync(path.join(APPLICATIONS_DIR, folder, "posting.txt"), postingText, "utf-8");
      }
      if (variant && postingText) {
        const score = Math.round(Number(match_score));
        saveAnalysis(folder, {
          source: "nightly-estimate",
          match_score: Number.isFinite(score) ? Math.min(100, Math.max(0, score)) : null,
          base_variant: variant,
          recommendation: null,
          reasoning: reasoning || "",
          gaps: Array.isArray(gaps) ? gaps.map(String) : [],
          gap_tags: tags,
          ...(droppedClosedGaps.length ? { dropped_closed_gaps: droppedClosedGaps } : {}),
        });
      }
      res.status(201).json({ ...(await withPipelineFor(folder)), droppedClosedGaps });
    } catch (err) {
      sendError(res, err);
    }
  });

  // PATCH /api/applications/:id - edit the free-text tracking fields (not
  // pipeline stage — that's POST /api/pipeline-events — and not the posting
  // facts, which come from how the package was built). :id is the folder.
  const EDITABLE_LEDGER_FIELDS = new Set([
    "notes", "next_action", "last_contact", "outcome", "gap_tags", ...CONTACT_FIELDS,
  ]);
  app.patch("/api/applications/:id", async (req, res) => {
    try {
      const folder = req.params.id;
      const current = await findLedgerRow(folder);
      if (!current) return res.status(404).json({ error: "Not found" });

      const updates = {};
      for (const [k, v] of Object.entries(req.body || {})) {
        if (EDITABLE_LEDGER_FIELDS.has(k)) updates[k] = v;
      }
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "No editable fields in request body" });
      }
      // The contact is checked as a whole (see contact.js): an email needs a
      // source, and a self-found one must be marked verified.
      if (CONTACT_FIELDS.some((f) => f in updates)) {
        Object.assign(updates, resolveContact(current, updates));
      }

      await store.updateApplication(folder, updates);
      res.json(await withPipelineFor(folder));
    } catch (err) {
      sendError(res, err);
    }
  });

  // DELETE /api/applications/:id - remove a row and its folder entirely.
  // Meant for undoing a draft the user never wanted (e.g. "Skip" on the
  // analyze→build gate) — not a general archive feature. The folder path is
  // resolved strictly inside applications/ (an empty or odd folder value is
  // refused, never turned into "delete applications/ itself"). What happens
  // to its pipeline events is up to the store: CSV leaves them in the
  // append-only file (harmless, nothing looks them up), SQL deletes them
  // with the row.
  app.delete("/api/applications/:id", async (req, res) => {
    try {
      const folder = req.params.id;
      const row = await findLedgerRow(folder);
      if (!row) return res.status(404).json({ error: "Not found" });
      if (buildsInFlight.has(folder)) {
        return res.status(409).json({ error: "A build is running for this application" });
      }

      const folderPath = resolveApplicationFolder(APPLICATIONS_DIR, row.folder);
      await store.deleteApplication(folder);
      if (existsSync(folderPath)) rmSync(folderPath, { recursive: true, force: true });

      res.json({ deleted: true, folder });
    } catch (err) {
      sendError(res, err);
    }
  });

  // GET /api/applications - full ledger table
  app.get("/api/applications", async (req, res) => {
    try {
      res.json(await withPipeline(await store.listApplications()));
    } catch (err) {
      sendError(res, err);
    }
  });

  // GET /api/applications/:id - one row + any files found in its folder
  app.get("/api/applications/:id", async (req, res) => {
    try {
      const folder = req.params.id;
      const row = (await findLedgerRow(folder)) && (await withPipelineFor(folder));
      if (!row) return res.status(404).json({ error: "Not found" });

      let files = [];
      let matchReport = null;
      let interviewQuestions = null;
      let postingText = null;
      let analysis = null;
      const folderPath = resolveApplicationFolder(APPLICATIONS_DIR, row.folder);
      if (existsSync(folderPath)) {
        files = readdirSync(folderPath);
        const read = (name) => {
          const p = path.join(folderPath, name);
          return existsSync(p) ? readFileSync(p, "utf-8") : null;
        };
        matchReport = read("Match_Report.md");
        interviewQuestions = read("Interview_Questions.md");
        postingText = read("posting.txt");
        try {
          analysis = JSON.parse(read("analysis.json") || "null");
        } catch {
          analysis = null; // a hand-edited, broken file just means no analysis shown
        }
      }

      const calls = existsSync(folderPath) ? readUsage(folderPath) : [];
      const usage = { ...summarize(calls), list: calls };
      res.json({ ...row, files, matchReport, interviewQuestions, postingText, analysis, usage });
    } catch (err) {
      sendError(res, err);
    }
  });

  // GET /api/usage?month=YYYY-MM - what Claude calls cost this month (UTC),
  // in total and per package, against the monthly budget.
  app.get("/api/usage", async (req, res) => {
    try {
      const month = /^\d{4}-\d{2}$/.test(req.query.month || "")
        ? req.query.month
        : new Date().toISOString().slice(0, 7);
      const usage = monthUsage(APPLICATIONS_DIR, month);
      const rows = await store.listApplications();
      const byFolder = new Map(rows.map((r) => [r.folder, r]));
      usage.packages = usage.packages.map((p) => ({
        ...p, company: byFolder.get(p.folder)?.company || "", role: byFolder.get(p.folder)?.role || "",
      }));
      res.json({ ...usage, budget: cfg.aiMonthlyBudget });
    } catch (err) {
      sendError(res, err);
    }
  });

  // GET /api/usage/calls?since=YYYY-MM-DD - every Claude call since then
  // (default: 120 days back), for the per-day cost on the day cards.
  app.get("/api/usage/calls", (req, res) => {
    try {
      const since = /^\d{4}-\d{2}-\d{2}$/.test(req.query.since || "")
        ? req.query.since
        : new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10);
      res.json({ since, calls: usageCalls(APPLICATIONS_DIR, since) });
    } catch (err) {
      sendError(res, err);
    }
  });

  // GET /api/funnel - applied -> reply -> interview -> offer from live data,
  // plus the 6-month offer forecast. Local, no model call.
  app.get("/api/funnel", async (req, res) => {
    try {
      res.json(buildFunnel(await withPipeline(await store.listApplications())));
    } catch (err) {
      sendError(res, err);
    }
  });

  // GET /api/rejections - postings the nightly run turned down (last 90
  // reports), one entry per posting however many nights it was seen, each
  // marked reviewed or not and whether it was added to the ledger anyway;
  // plus the weekly trend of reasons. ?summary=1 returns only the count of
  // unreviewed postings (for the navbar badge).
  const DAILY_DIR = path.join(ENGINE_DIR, "daily");
  const rejectionGroups = () => groupRejections(readRejections(DAILY_DIR, { days: 90 }));

  app.get("/api/rejections", async (req, res) => {
    try {
      const reviewed = readReviewed(DAILY_DIR);
      const groups = rejectionGroups().map((g) => ({ ...g, reviewed: isReviewed(g, reviewed) }));
      const unreviewed = groups.filter((g) => !g.reviewed).length;
      if (req.query.summary) return res.json({ unreviewed });
      const tracked = new Map((await store.listApplications()).map((r) => [postingKey(r.company, r.role), r.folder]));
      res.json({
        unreviewed,
        groups: groups.map((g) => ({ ...g, trackedFolder: tracked.get(g.key) || null })),
        trend: weeklyTrend(groups),
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  // POST /api/rejections/review { keys: [...], reviewed: true|false }
  app.post("/api/rejections/review", (req, res) => {
    try {
      const { keys, reviewed = true } = req.body || {};
      if (!Array.isArray(keys) || !keys.length || keys.some((k) => typeof k !== "string")) {
        return res.status(400).json({ error: "keys must be a non-empty list of posting keys" });
      }
      const lastSeen = new Map(rejectionGroups().map((g) => [g.key, g.lastSeen]));
      const marks = readReviewed(DAILY_DIR);
      for (const key of keys) {
        if (!reviewed) delete marks[key];
        else if (lastSeen.has(key)) marks[key] = lastSeen.get(key);
      }
      mkdirSync(DAILY_DIR, { recursive: true });
      writeFileAtomic(path.join(DAILY_DIR, REVIEWED_FILE), JSON.stringify(marks, null, 2) + "\n");
      res.json({ ok: true, unreviewed: rejectionGroups().filter((g) => !isReviewed(g, marks)).length });
    } catch (err) {
      sendError(res, err);
    }
  });

  // GET /api/applications/:id/similar - the other saved postings most like this one
  // (by stack, role and industry) and how each went. Local, no model call.
  app.get("/api/applications/:id/similar", async (req, res) => {
    try {
      const folder = req.params.id;
      if (!(await findLedgerRow(folder))) return res.status(404).json({ error: "Not found" });
      const matches = similarTo(folder, readPostings(APPLICATIONS_DIR), { limit: 5, min: 0.4 });
      const rows = new Map((await withPipeline(await store.listApplications())).map((r) => [r.folder, r]));
      res.json(
        matches
          .filter((m) => rows.has(m.folder)) // a folder whose row was deleted
          .map((m) => {
            const r = rows.get(m.folder);
            return {
              ...m, company: r.company, role: r.role, date: r.date, stage: r.stage,
              isTerminal: r.isTerminal, match_score: r.match_score,
            };
          })
      );
    } catch (err) {
      sendError(res, err);
    }
  });

  // GET /api/applications/:id/files/:name - one file from the folder, as a
  // download. Builds run on the server, so this is how a package reaches the
  // PC. Only names actually listed in the folder are served (no paths).
  app.get("/api/applications/:id/files/:name", async (req, res) => {
    try {
      const { id: folder, name } = req.params;
      if (!(await findLedgerRow(folder))) return res.status(404).json({ error: "Not found" });
      const folderPath = resolveApplicationFolder(APPLICATIONS_DIR, folder);
      const listed = existsSync(folderPath) ? readdirSync(folderPath) : [];
      if (!listed.includes(name)) return res.status(404).json({ error: "No such file" });
      res.download(path.join(folderPath, name), name);
    } catch (err) {
      sendError(res, err);
    }
  });

  // GET /api/gap-tags - the standard gap-tag dictionary (key -> description)
  app.get("/api/gap-tags", (req, res) => {
    try {
      if (!existsSync(GAP_TAGS_PATH)) return res.json({});
      const doc = loadYaml(readFileSync(GAP_TAGS_PATH, "utf-8"));
      res.json(doc || {});
    } catch (err) {
      sendError(res, err);
    }
  });

  function anthropicClient() {
    if (deps.anthropic) return deps.anthropic;
    if (!cfg.anthropicApiKey) {
      throw new Error("ANTHROPIC_API_KEY is not set on the server (see server/.env.example)");
    }
    return new Anthropic({ apiKey: cfg.anthropicApiKey });
  }

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
  // A fact tagged only.<variant> belongs to a section that exists in that
  // variant's template alone (e.g. the Shiraz IT role in resume_itsupport),
  // so offering it to another variant would only produce a build.py error.
  function selectableFactIds(facts, variant) {
    return Object.values(facts)
      .filter((f) => BULLET_FACT_PREFIXES.has(f.id.split(".")[0]))
      .filter((f) => !(f.tags || []).some((t) => BULLET_FACT_TAGS_EXCLUDE.has(t)))
      .filter((f) => (f.tags || []).every((t) => !t.startsWith("only.") || t === `only.${variant}`))
      .map((f) => f.id);
  }

  // Every employment role (a role_header fact under exp.*) that this
  // variant's template shows, as its section prefix ("exp.dena", ...).
  function requiredRolePrefixes(facts, variant) {
    return Object.values(facts)
      .filter((f) => f.id.startsWith("exp.") && (f.tags || []).includes("role_header"))
      .filter((f) => (f.tags || []).every((t) => !t.startsWith("only.") || t === `only.${variant}`))
      .map((f) => f.id.split(".").slice(0, 2).join("."));
  }

  // Skill facts eligible for this build's TECHNICAL SKILLS section: shared
  // lines, lines tagged for the chosen base_variant, and "pool" lines
  // (conditional on an exp.tarashe bullet also being selected — validate.py
  // warns, doesn't block, if one's picked without its matching bullet).
  // "excluded" facts (dropped Perl/C) are never offered — the model can't
  // select what isn't in the enum, same structural guarantee as bullets.
  function selectableSkillIds(facts, variant) {
    const variantTag = `variant.${variant}`;
    return Object.values(facts)
      .filter((f) => f.id.split(".")[0] === "skill")
      .filter((f) => !(f.tags || []).includes("excluded"))
      .filter((f) => {
        const tags = f.tags || [];
        return tags.includes("shared") || tags.includes(variantTag) || tags.includes("pool");
      })
      .map((f) => f.id);
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

  // strict: the API then guarantees the input matches this schema. Without it
  // the model sometimes dropped gap_tags, or put the gap_tags array inside
  // the `gaps` string, so the row was saved with no tags. Strict mode doesn't
  // allow minimum/maximum, so normalizeAnalysis clamps match_score instead.
  const ANALYZE_TOOL = {
    name: "submit_analysis",
    description: "Submit the match analysis for this job posting against the candidate's fact bank.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        base_variant: {
          type: "string",
          enum: ["dotnet_azure", "powerplatform", "itsupport"],
          description:
            "Which base resume template fits this posting better. Use itsupport for IT support, " +
            "help desk, service desk, desktop support and IT technician roles (score those against " +
            "the exp.dena.it_* and skill.it_* facts, not against developer skills).",
        },
        match_score: { type: "integer", description: "0-100." },
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

  // Accepts an array or a comma-joined string and returns clean kebab-case
  // slugs. The build endpoint gets gap_tags from the client in either shape.
  function toGapTagList(value) {
    const items = Array.isArray(value) ? value : String(value || "").split(",");
    const slug = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return [...new Set(items.map(slug).filter(Boolean))];
  }

  // A closed gap is closed whoever scored the posting. Both the analyze
  // prompt and the nightly search are told never to use a [CLOSED] slug, and
  // both have done it anyway (TCS, 2026-10-03), so the dictionary is
  // enforced here rather than trusted to the prompt.
  function withoutClosedGaps(tags) {
    const dict = loadGapTagsDict();
    const isClosed = (t) => dict[t] != null && gapStatus(String(dict[t])) === "closed";
    return { kept: tags.filter((t) => !isClosed(t)), dropped: tags.filter(isClosed) };
  }

  // Last check even under strict mode: a truncated or refused response can
  // still come back incomplete, and it should fail loudly instead of saving
  // a draft row with no gap tags.
  function normalizeAnalysis(message) {
    if (message.stop_reason === "max_tokens") {
      throw new Error("Analysis was cut off (max_tokens) — nothing was saved, try again");
    }
    const toolUse = message.content.find((b) => b.type === "tool_use");
    if (!toolUse) throw new Error("Model did not return a structured analysis");
    const a = toolUse.input;
    const gaps = Array.isArray(a.gaps) ? a.gaps : [];
    const allTags = toGapTagList(a.gap_tags);
    if (gaps.length > 0 && allTags.length === 0) {
      throw new Error("Analysis listed gaps but no gap_tags — nothing was saved, try again");
    }
    const { kept: gap_tags, dropped } = withoutClosedGaps(allTags);
    const score = Math.round(Number(a.match_score));
    return {
      ...a,
      match_score: Number.isFinite(score) ? Math.min(100, Math.max(0, score)) : 0,
      gaps,
      gap_tags,
      ...(dropped.length ? { dropped_closed_gaps: dropped } : {}),
    };
  }

  // The analysis as it was scored, next to the posting: the full gap
  // sentences (the row only keeps slugs) and a fingerprint of the truth bank
  // it was scored against, so Health can tell exactly when it went stale.
  function saveAnalysis(folder, analysis) {
    const record = {
      // "engine" = scored here by Claude; "nightly-estimate" = sent by the
      // nightly search, which scored it in its own session.
      source: analysis.source || "engine",
      analyzed_at: new Date().toISOString(),
      bank_fingerprint: bankFingerprint(FACTS_DIR, GAP_TAGS_PATH),
      match_score: analysis.match_score,
      base_variant: analysis.base_variant,
      recommendation: analysis.recommendation,
      reasoning: analysis.reasoning,
      gaps: analysis.gaps,
      gap_tags: analysis.gap_tags,
      ...(analysis.dropped_closed_gaps ? { dropped_closed_gaps: analysis.dropped_closed_gaps } : {}),
    };
    writeFileSync(
      path.join(resolveApplicationFolder(APPLICATIONS_DIR, folder), "analysis.json"),
      JSON.stringify(record, null, 2),
      "utf-8"
    );
  }

  // The fact bank is ~35k tokens and identical across calls, so the system
  // prompt (and the tools before it) is marked for prompt caching: a second
  // analyze/build within a few minutes reads it at ~10% of the price. `tail`
  // is the per-request part, kept after the breakpoint so it doesn't split
  // the cache.
  // One line per Claude call in the server log, so where the credit goes
  // (and whether the cache is hit) can be read back later.
  function logUsage(kind, message) {
    const u = message?.usage;
    if (!u) return;
    console.log(
      `[claude] ${kind} in=${u.input_tokens} cache_read=${u.cache_read_input_tokens ?? 0} ` +
        `cache_write=${u.cache_creation_input_tokens ?? 0} out=${u.output_tokens}`
    );
  }

  function cachedSystem(text, tail = "") {
    const blocks = [{ type: "text", text, cache_control: { type: "ephemeral" } }];
    if (tail) blocks.push({ type: "text", text: tail });
    return blocks;
  }

  // One scoring call against the fact bank and gap dictionary as they are
  // right now. Shared by /analyze (a new posting) and /reanalyze (a posting
  // scored before newer evidence landed — a row's gap_tags are a snapshot).
  // folder: the draft being re-analyzed, so its cost is filed with it right
  // away; a new posting has no folder yet, so the caller files `usage` once
  // it exists.
  async function analyzePosting(company, role, postingText, folder = null) {
    const facts = loadFactBank();
    const factSummary = Object.values(facts)
      .filter((f) => !(f.tags || []).includes("excluded"))
      .map((f) => `- ${f.id} [${f.strength}]: ${f.claim.trim().replace(/\s+/g, " ")}`)
      .join("\n");
    const gapTagsDict = loadGapTagsDict();
    // Each slug carries its status (read from the label, as everywhere else):
    // without it the model reused a closed slug (frontend-modern) for a
    // narrower gap that's still real (legacy AngularJS, team-production React).
    const gapTagsSummary = Object.entries(gapTagsDict)
      .map(([slug, desc]) => `- ${slug} [${gapStatus(String(desc ?? "")).toUpperCase()}]: ${desc}`)
      .join("\n");

    // A dictionary description can go stale when a gap is closed (mongodb-nosql
    // said "all relational" after ReBiomed added MongoDB facts, and the model
    // trusted the description over the facts) — so the facts are ranked first.
    const client = anthropicClient();
    const message = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 4096,
      system: cachedSystem(
        "You are scoring how well a job posting matches a candidate, using ONLY the facts " +
        "listed below — never invent experience, numbers or skills not in this list. " +
        "Call submit_analysis with your result. The fact bank is the source of truth: if a " +
        "dictionary description below says the candidate lacks something a fact shows, the " +
        "fact wins.\n\nCANDIDATE FACT BANK:\n" + factSummary +
        "\n\nEXISTING GAP-TAG DICTIONARY (reuse these slugs when a gap matches one; only " +
        "coin a new short kebab-case slug when it doesn't). Never put a [CLOSED] slug in " +
        "gap_tags: the candidate has that evidence. If a narrower part of it is still missing " +
        "for this posting (e.g. legacy AngularJS when modern Angular is closed), coin a more " +
        "specific slug for exactly that part instead:\n" + gapTagsSummary
      ),
      messages: [
        { role: "user", content: `Job posting for ${role} at ${company}:\n\n${postingText}` },
      ],
      tools: [ANALYZE_TOOL],
      tool_choice: { type: "tool", name: "submit_analysis" },
    });
    logUsage("analyze", message);
    const usage = usageRecord(folder ? "reanalyze" : "analyze", message, "claude-sonnet-5");
    // Filed before normalizeAnalysis, which can still throw: a failed call
    // was paid for all the same.
    if (folder) recordUsage(resolveApplicationFolder(APPLICATIONS_DIR, folder), usage);
    return { ...normalizeAnalysis(message), usage };
  }

  // Every Claude call spends API credit, so it has to start from a click in
  // the dashboard: the client marks those three requests with X-AI-Request:
  // app. A script (the nightly search, a curl) doesn't, and is refused unless
  // AI_SCRIPT_CALLS opens it up. This is a spending brake, not security —
  // anyone already past the login could send the header.
  const AI_ROUTES = {
    "/api/packages/analyze": "analyze",
    "/api/packages/reanalyze": "analyze",
    "/api/packages/build": "build",
  };
  app.post(Object.keys(AI_ROUTES), (req, res, next) => {
    if (req.get("x-ai-request") === "app") return next();
    const allowed = cfg.aiScriptCalls === "all" || (cfg.aiScriptCalls === "analyze" && AI_ROUTES[req.path] === "analyze");
    if (allowed) return next();
    res.status(403).json({
      error:
        "Claude calls only start from a button in the dashboard (they spend API credit). " +
        "Save the posting as a draft with POST /api/applications { postingText } and analyze it from its page.",
      code: "ai_manual_only",
    });
  });

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
      const analysis = await analyzePosting(company, role, postingText);

      const folder = await createApplicationRow({
        company, role, location, source, posting_url,
        match_score: analysis.match_score,
        variant: analysis.base_variant,
        gap_tags: analysis.gap_tags.join(","),
      });
      writeFileSync(path.join(APPLICATIONS_DIR, folder, "posting.txt"), postingText, "utf-8");
      recordUsage(resolveApplicationFolder(APPLICATIONS_DIR, folder), analysis.usage);
      saveAnalysis(folder, analysis);
      const createdRow = await withPipelineFor(folder);

      res.json({
        ...analysis,
        id: createdRow.id,
        folder,
        duplicate: duplicate
          ? { display: duplicate.display, applications: duplicate.applications || [] }
          : null,
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  // POST /api/packages/reanalyze - re-score an existing draft's saved
  // posting.txt against today's fact bank, and overwrite its match_score and
  // gap_tags. Drafts only: once a package is sent, its gap_tags record what
  // was missing when it went out, which is what Stats correlates with
  // rejections. A variant already set is left alone (the build may rely on
  // it); a draft saved unscored gets its first one here.
  // Body: { folder }
  app.post("/api/packages/reanalyze", async (req, res) => {
    try {
      const { folder } = req.body || {};
      if (!(await findLedgerRow(folder))) {
        return res.status(404).json({ error: `Unknown folder: ${folder}` });
      }
      // The stage comes from pipeline events; the ledger's status column
      // stays "draft" after a package is sent.
      const row = await withPipelineFor(folder);
      if (row.stage !== "draft") {
        return res.status(409).json({ error: "Only drafts can be re-analyzed — this one was already sent" });
      }
      const postingPath = path.join(resolveApplicationFolder(APPLICATIONS_DIR, folder), "posting.txt");
      if (!existsSync(postingPath)) {
        return res.status(422).json({ error: "This application has no saved posting.txt to re-analyze" });
      }

      const analysis = await analyzePosting(row.company, row.role, readFileSync(postingPath, "utf-8"), folder);
      await updateApplicationRowByFolder(folder, {
        match_score: analysis.match_score,
        gap_tags: analysis.gap_tags.join(","),
        // A draft saved without analysis has no variant yet; build needs one.
        ...(row.variant ? {} : { variant: analysis.base_variant }),
      });
      saveAnalysis(folder, analysis);
      res.json({
        ...analysis,
        previous: { match_score: row.match_score, gap_tags: row.gap_tags },
        application: await withPipelineFor(folder),
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  // fact_id is a real enum of the fact bank's bullet-eligible facts, so the
  // model is structurally unable to invent an id the guardian would reject.
  function buildPlanTool(facts, variant) {
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
                fact_id: { type: "string", enum: selectableFactIds(facts, variant) },
                text: { type: "string" },
              },
              required: ["fact_id", "text"],
            },
            minItems: 8,
          },
          skill_ids: {
            type: "array",
            items: { type: "string", enum: selectableSkillIds(facts, variant) },
            description:
              "Which TECHNICAL SKILLS lines to include, in display order. Text is pulled " +
              "verbatim from the fact bank, never rewritten, so pick lines rather than word " +
              "them. Default to including every core line (skill.languages plus this " +
              "variant's own Azure/Databases/Web/Practices/Tools lines) — dropping one just " +
              "because a single posting didn't mention it throws away a fully-verified skill " +
              "for no reason. Only add skill.his_extras, skill.db_change_management or " +
              "skill.office_interop_automation when a matching exp.tarashe.* bullet is also " +
              "selected below — they're the Skills-section half of that bullet, not standalone.",
            minItems: 1,
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
          "summary", "bullets", "skill_ids", "match_report_markdown",
          "interview_questions_markdown", "cover_letter_markdown",
        ],
      },
    };
  }

  // POST /api/packages/build - stage 2 (heavy), only reached after the human
  // approval gate. `folder` must already exist (created by /analyze) — this
  // endpoint fills it in, it never creates a new row. Body: { folder,
  // company, role, postingText, base_variant, match_score?, gaps?, caveats? }
  async function buildPackage(req, res) {
    try {
      const { folder, company, role, postingText, base_variant, match_score, gap_tags, caveats } =
        req.body || {};
      if (!folder || !company || !role || !postingText || !base_variant) {
        return res
          .status(400)
          .json({ error: "folder, company, role, postingText and base_variant are required" });
      }

      const folderPath = resolveApplicationFolder(APPLICATIONS_DIR, folder);
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
      const request = {
        model: "claude-sonnet-5",
        max_tokens: 8192,
        system: cachedSystem(
          "You are building a tailored job application package using ONLY the fact bank below. " +
          "Rules: every bullet must cite a real fact_id from the bank; any number you write in a " +
          "bullet must be exactly one of that fact's allowed_numbers (or omit numbers entirely); " +
          "never use any of that fact's forbidden words/phrases; never use any form of the verbs " +
          "lock, prevent, guarantee or ensure anywhere — not in the summary, bullets, cover letter, " +
          "match report or interview questions (so no locks/locking/prevents/preventing/ensures/" +
          "ensuring/guaranteed etc.; say e.g. 'helps', 'reduces', 'checks' instead). Rewrite each bullet's wording (not its " +
          "underlying facts) to use the posting's own vocabulary. Also pick which TECHNICAL " +
          "SKILLS lines to include via skill_ids — that text is used exactly as written in the " +
          "fact bank, never rewritten, so just choose and order the lines. Pick 3-5 bullets per relevant " +
          "project/role section — do not use every fact, and omit a project/role entirely if it " +
          "has no relevant facts for this posting. EXCEPTION: always include exp.ctdi.description " +
          "(the Material Handler bridge role) regardless of relevance — it explains an otherwise " +
          "unexplained employment gap on the timeline, which matters more than topical fit here. " +
          "The same holds for EVERY employment role (exp.nmb, exp.dena, exp.tarashe, exp.eram, " +
          "exp.sepid): never omit a role, because a missing role reads as a hole in the timeline. " +
          "Give each at least one bullet (3-5 for the ones relevant to this posting; exactly one " +
          "each for exp.nmb, exp.eram and exp.sepid). Only project sections may be omitted.\n\n" +
          (base_variant === "itsupport"
            ? "This is an IT SUPPORT resume: lead with the exp.dena.it_* bullets (4-6 of them) and " +
              "the skill.it_* lines, and include the exp.shiraz role (2007-2011 IT support at a " +
              "Sepid System reseller) with 2-3 of its bullets. Total hands-on IT support " +
              "experience is about 5 years (2007-2011 plus 2022-2023): say at most '5+ years' of IT " +
              "support, never more. Frame development work as a plus (scripting, SQL, knowing how " +
              "applications fail), include at most 1-2 short project sections, and never claim a " +
              "certification — the candidate has none.\n\n"
            : "") +
          "FACT BANK (JSON lines):\n" + factDetail,
          caveats
            ? "The candidate has real gaps for this posting — address them honestly in the " +
              "cover letter rather than hiding them."
            : ""
        ),
        messages: [
          {
            role: "user",
            content:
              `Build the package for ${role} at ${company} (base template: ${base_variant}).\n\n` +
              `Job posting:\n${postingText}`,
          },
        ],
        tools: [buildPlanTool(facts, base_variant)],
        tool_choice: { type: "tool", name: "submit_package" },
      };

      // Guardian check BEFORE anything is written to disk. A rejected package
      // gets ONE repair turn: the model sees validate.py's exact errors and
      // resubmits. Most rejections are a single blacklisted word ("ensuring",
      // or "locking" used as a SQL term) that a fresh generation would just as
      // likely repeat somewhere else.
      const python = findPython(cfg.python);
      const planPath = path.join(ENGINE_DIR, `.tmp-plan-${randomUUID()}.json`);
      let generated;
      let validation;
      for (let attempt = 0; attempt < 2; attempt++) {
        const message = await client.messages.create(request);
        logUsage("build", message);
        recordUsage(folderPath, usageRecord(attempt ? "build-repair" : "build", message, request.model));
        const toolUse = message.content.find((b) => b.type === "tool_use");
        if (!toolUse) throw new Error("Model did not return a structured package");
        generated = toolUse.input;

        const plan = {
          base_variant,
          target_role: role,
          summary: generated.summary,
          bullets: generated.bullets,
          skill_ids: generated.skill_ids,
          match_report_markdown: generated.match_report_markdown,
          cover_letter_markdown: generated.cover_letter_markdown,
          interview_questions_markdown: generated.interview_questions_markdown,
        };
        writeFileSync(planPath, JSON.stringify(plan, null, 2), "utf-8");
        // The prompt asks for every employment role, but the model has still
        // dropped a whole role (a 4-year hole in the timeline) — so it's
        // checked here and fed to the same repair turn as a guardian error.
        const missingRoles = requiredRolePrefixes(facts, base_variant).filter(
          (prefix) => !(generated.bullets || []).some((b) => (b.fact_id || "").startsWith(`${prefix}.`))
        );
        validation = missingRoles.length
          ? {
              status: 1,
              stdout:
                `ERROR: employment role(s) missing from the résumé: ${missingRoles.join(", ")} — ` +
                "every role needs at least one bullet, or the timeline shows a gap\n",
            }
          : await runProcess(python, [path.join(ENGINE_DIR, "validate.py"), planPath], {
              timeoutMs: cfg.validateTimeoutMs ?? VALIDATE_TIMEOUT_MS,
            });

        if (validation.timedOut) {
          unlinkSync(planPath);
          return res.status(504).json({ error: "validate.py timed out" });
        }
        if (validation.status === 0) break;

        request.messages = [
          ...request.messages,
          { role: "assistant", content: message.content },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: toolUse.id,
                is_error: true,
                content:
                  "The guardian rejected this package:\n" +
                  (validation.stdout || validation.stderr || "") +
                  "\nCall submit_package again with the SAME content, changing only what these " +
                  "errors point at (reword a blacklisted verb, e.g. 'row locking' -> 'row-level " +
                  "concurrency', 'ensure' -> 'confirm'; drop a disallowed number or term).",
              },
            ],
          },
        ];
      }

      // Every rejection is kept in the folder and the log: the 422 used to
      // reach only the browser, so a paid build could fail with no trace of why.
      const buildErrorPath = path.join(folderPath, "build_error.json");
      const saveBuildError = (stage, details) => {
        writeFileSync(
          buildErrorPath,
          JSON.stringify({ at: new Date().toISOString(), stage, details }, null, 2),
          "utf-8"
        );
        console.log(`[build] ${folder} ${stage}:\n  ${details.join("\n  ")}`);
      };

      // Still rejected after the repair turn: both calls are already paid
      // for, so the package is built anyway and the guardian's errors become
      // warnings to review (build_error.json + plan.json) before sending.
      let guardianWarnings = [];
      if (validation.status !== 0) {
        guardianWarnings = (validation.stdout || validation.stderr || "").split("\n").filter(Boolean);
        saveBuildError("guardian-warning", guardianWarnings);
      } else if (existsSync(buildErrorPath)) {
        unlinkSync(buildErrorPath);
      }

      // Render into the folder /analyze already created.
      const build = await runProcess(python, [path.join(ENGINE_DIR, "build.py"), planPath, folderPath], {
        timeoutMs: cfg.buildTimeoutMs ?? BUILD_TIMEOUT_MS,
      });

      if (build.status !== 0) {
        unlinkSync(planPath);
        saveBuildError(build.timedOut ? "build-timeout" : "build-failed", [
          ...guardianWarnings,
          ...(build.stdout || build.stderr || "").split("\n").filter(Boolean),
        ]);
        return res.status(build.timedOut ? 504 : 500).json({
          error: build.timedOut ? "build.py timed out" : "build.py failed",
          folder,
          details: (build.stdout || build.stderr || "").split("\n").filter(Boolean),
        });
      }

      // Which fact every bullet and skills line came from, and what each
      // fact said at build time — the Résumé view links bullets back to the
      // truth bank, and Health flags a draft whose facts changed since.
      const plan = JSON.parse(readFileSync(planPath, "utf-8"));
      const usedIds = [...new Set([...(plan.bullets || []).map((b) => b.fact_id), ...(plan.skill_ids || [])])];
      const current = new Map(readFacts(FACTS_DIR).facts.map((f) => [f.id, f.claim]));
      writeFileSync(
        path.join(folderPath, "plan.json"),
        JSON.stringify(
          {
            built_at: new Date().toISOString(),
            ...plan,
            ...(guardianWarnings.length ? { guardian_warnings: guardianWarnings } : {}),
            facts_used: Object.fromEntries(usedIds.map((id) => [id, current.get(id) ?? null])),
          },
          null,
          2
        ),
        "utf-8"
      );
      unlinkSync(planPath);

      writeFileSync(path.join(folderPath, "Match_Report.md"), generated.match_report_markdown, "utf-8");
      writeFileSync(
        path.join(folderPath, "Interview_Questions.md"),
        generated.interview_questions_markdown,
        "utf-8"
      );
      writeFileSync(path.join(folderPath, "CoverLetter.md"), generated.cover_letter_markdown, "utf-8");

      // Refresh the row with the heavier call's numbers (analyze's were an
      // early estimate) — folder/status/etc. are untouched. Only fields the
      // caller actually sent are overwritten: a build started from the
      // detail page used to omit gap_tags, and "missing" was written as
      // "empty", wiping the tags /analyze had saved.
      const refreshedFields = { variant: base_variant };
      if (match_score !== undefined && match_score !== null && match_score !== "") {
        refreshedFields.match_score = match_score;
      }
      // The page sends the tags it loaded, which can predate a fix made
      // elsewhere — so closed slugs are filtered here too.
      if (gap_tags !== undefined && gap_tags !== null) {
        refreshedFields.gap_tags = withoutClosedGaps(toGapTagList(gap_tags)).kept.join(",");
      }
      await updateApplicationRowByFolder(folder, refreshedFields);

      const updated = await withPipelineFor(folder);
      res.status(201).json(guardianWarnings.length ? { ...updated, guardian_warnings: guardianWarnings } : updated);
    } catch (err) {
      sendError(res, err);
    }
  }

  // POST /api/packages/build - route wrapper around buildPackage(): the
  // folder must be a safe name, belong to a real ledger row, and not already
  // be building. The in-flight set is released however the build ends.
  app.post("/api/packages/build", async (req, res) => {
    const { folder } = req.body || {};
    if (!isSafeFolderName(folder) || !(await findLedgerRow(folder))) {
      return res.status(404).json({
        error: `Unknown folder: ${folder} — call /api/packages/analyze first, it creates this`,
      });
    }
    if (buildsInFlight.has(folder)) {
      return res.status(409).json({ error: "This application is already being built" });
    }
    buildsInFlight.add(folder);
    try {
      await buildPackage(req, res);
    } finally {
      buildsInFlight.delete(folder);
    }
  });

  // --- Recruiter Search Engine ---------------------------------------------

  function recruiterStage(r) {
    if (r.replied) return "replied";
    if (r.followup_sent) return "followup_sent";
    if (r.connect_accepted) return "connect_accepted";
    if (r.connect_sent) return "connect_sent";
    return "added";
  }

  function withRecruiterMeta(rows) {
    return rows.map((r) => ({ ...r, stage: recruiterStage(r) }));
  }

  function sendCounts(rows) {
    const today = todayISO();
    const weekStart = weekStartISO(new Date());
    const sentDates = rows.map((r) => r.connect_sent).filter(Boolean);
    return {
      today,
      weekStart,
      sentToday: sentDates.filter((d) => d === today).length,
      sentThisWeek: sentDates.filter((d) => d >= weekStart).length,
    };
  }

  // GET /api/recruiters - target list + funnel counts + daily/weekly send rate
  app.get("/api/recruiters", async (req, res) => {
    try {
      const rows = withRecruiterMeta(await store.listRecruiters());
      const { sentToday, sentThisWeek, weekStart } = sendCounts(rows);

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
      sendError(res, err);
    }
  });

  // POST /api/recruiters - add a batch of recruiters (used by
  // JobSearch/engine/recruiter_batch.py). Rows whose LinkedIn URL is already
  // on the list are skipped, not duplicated. Body: { rows: [{ name, title,
  // company, linkedin_url, source?, connect_note?, followup_note?, notes? }] }
  app.post("/api/recruiters", async (req, res) => {
    try {
      const input = Array.isArray(req.body?.rows) ? req.body.rows : null;
      if (!input || input.length === 0) return res.status(400).json({ error: "rows[] is required" });
      if (input.some((r) => !r || !String(r.name || "").trim())) {
        return res.status(400).json({ error: "every row needs a name" });
      }

      const today = todayISO();
      const rows = input.map((r) => ({
        name: String(r.name).trim(),
        title: String(r.title || "").trim(),
        company: String(r.company || "").trim(),
        linkedin_url: String(r.linkedin_url || "").trim(),
        source: String(r.source || "batch").trim(),
        date_added: today,
        connect_note: String(r.connect_note || ""),
        connect_sent: "",
        connect_accepted: "",
        followup_note: String(r.followup_note || ""),
        followup_sent: "",
        replied: "",
        notes: String(r.notes || ""),
      }));

      const { added, skipped } = await store.addRecruiters(rows);
      res.status(201).json({ added: added.length, skipped: skipped.map((r) => r.linkedin_url || r.name) });
    } catch (err) {
      sendError(res, err);
    }
  });

  // POST /api/recruiters/:id - mark a stage field with today's date, or clear it
  // Body: { field: "connect_sent"|"connect_accepted"|"followup_sent"|"replied", value?: boolean }
  app.post("/api/recruiters/:id", async (req, res) => {
    try {
      const { field, value = true } = req.body || {};
      if (!RECRUITER_DATE_FIELDS.has(field)) {
        return res.status(400).json({ error: `Unknown field: ${field}` });
      }

      // A day-5 guardrail: warn (not block) if this send would blow past the
      // self-imposed daily/weekly rhythm.
      let warning = null;
      if (field === "connect_sent" && value) {
        const { sentToday, sentThisWeek } = sendCounts(await store.listRecruiters());
        if (sentToday >= 5) warning = `Already ${sentToday} sent today — daily target is 5.`;
        else if (sentThisWeek >= 25) warning = `Already ${sentThisWeek} sent this week — weekly target is 25.`;
      }

      const updated = await store.setRecruiterDate(req.params.id, field, value ? todayISO() : null);
      if (!updated) return res.status(404).json({ error: "Not found" });

      res.json({ ...withRecruiterMeta([updated])[0], warning });
    } catch (err) {
      sendError(res, err);
    }
  });

  registerTruthRoutes(app, { cfg, store, withPipeline, sendError, engineDir: ENGINE_DIR, git: deps.engineGit });

  // Serve the built React app (so no dev server / Vite is needed to use this)
  if (existsSync(cfg.clientDist)) {
    app.use(express.static(cfg.clientDist));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api/")) return next();
      res.sendFile(path.join(cfg.clientDist, "index.html"));
    });
  }

  return app;
}
