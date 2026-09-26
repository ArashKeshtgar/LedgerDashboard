import express from "express";
import cookieSession from "cookie-session";
import { load as loadYaml } from "js-yaml";
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, unlinkSync, rmSync } from "fs";
import { randomUUID } from "crypto";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";
import { FileLockedError } from "./csv.js";
import { isSafeFolderName, resolveApplicationFolder, UnsafeFolderError } from "./paths.js";
import { attachPipeline, FOLLOWUP_KEY } from "./pipeline.js";
import { passwordMatches, createLoginLimiter, originGuard } from "./security.js";
import { runProcess, findPython } from "./process.js";
import { slugify, todayISO, weekStartISO, ISO_DATE_RE } from "./text.js";
import { RECRUITER_DATE_FIELDS } from "./stores/shape.js";
import { isStoreValidationError } from "./stores/sqlStore.js";

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
        secure: cfg.production,
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

    app.get("/api/session", (req, res) => {
      res.json({ authed: !!req.session?.authed, passwordRequired: true });
    });

    app.use("/api", (req, res, next) => {
      if (req.path === "/login" || req.path === "/session") return next();
      if (req.session?.authed) return next();
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
      const index = ((dayNumber % quotes.length) + quotes.length) % quotes.length;
      res.json({ ...quotes[index], index, total: quotes.length });
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
  // source?, posting_url?, match_score?, notes? }
  app.post("/api/applications", async (req, res) => {
    try {
      const { company, role, location, branch, source, posting_url, match_score, notes } =
        req.body || {};
      if (!company || !role) {
        return res.status(400).json({ error: "company and role are required" });
      }

      const folder = await createApplicationRow({
        company, role, location, branch, source, posting_url, match_score, notes,
      });
      res.status(201).json(await withPipelineFor(folder));
    } catch (err) {
      sendError(res, err);
    }
  });

  // PATCH /api/applications/:id - edit the free-text tracking fields (not
  // pipeline stage — that's POST /api/pipeline-events — and not the posting
  // facts, which come from how the package was built). :id is the folder.
  const EDITABLE_LEDGER_FIELDS = new Set(["notes", "next_action", "last_contact", "outcome", "gap_tags"]);
  app.patch("/api/applications/:id", async (req, res) => {
    try {
      const folder = req.params.id;
      if (!(await findLedgerRow(folder))) return res.status(404).json({ error: "Not found" });

      const updates = {};
      for (const [k, v] of Object.entries(req.body || {})) {
        if (EDITABLE_LEDGER_FIELDS.has(k)) updates[k] = v;
      }
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "No editable fields in request body" });
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
      }

      res.json({ ...row, files, matchReport, interviewQuestions, postingText });
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
  function selectableFactIds(facts) {
    return Object.values(facts)
      .filter((f) => BULLET_FACT_PREFIXES.has(f.id.split(".")[0]))
      .filter((f) => !(f.tags || []).some((t) => BULLET_FACT_TAGS_EXCLUDE.has(t)))
      .map((f) => f.id);
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
          enum: ["dotnet_azure", "powerplatform"],
          description: "Which base resume template fits this posting better.",
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
    const gap_tags = toGapTagList(a.gap_tags);
    if (gaps.length > 0 && gap_tags.length === 0) {
      throw new Error("Analysis listed gaps but no gap_tags — nothing was saved, try again");
    }
    const score = Math.round(Number(a.match_score));
    return {
      ...a,
      match_score: Number.isFinite(score) ? Math.min(100, Math.max(0, score)) : 0,
      gaps,
      gap_tags,
    };
  }

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
        max_tokens: 4096,
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

      const analysis = normalizeAnalysis(message);

      const folder = await createApplicationRow({
        company, role, location, source, posting_url,
        match_score: analysis.match_score,
        variant: analysis.base_variant,
        gap_tags: analysis.gap_tags.join(","),
      });
      writeFileSync(path.join(APPLICATIONS_DIR, folder, "posting.txt"), postingText, "utf-8");
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
                fact_id: { type: "string", enum: selectableFactIds(facts) },
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
      const message = await client.messages.create({
        model: "claude-sonnet-5",
        max_tokens: 8192,
        system:
          "You are building a tailored job application package using ONLY the fact bank below. " +
          "Rules: every bullet must cite a real fact_id from the bank; any number you write in a " +
          "bullet must be exactly one of that fact's allowed_numbers (or omit numbers entirely); " +
          "never use any of that fact's forbidden words/phrases; never use the words locks, " +
          "prevents, guarantees or ensures anywhere. Rewrite each bullet's wording (not its " +
          "underlying facts) to use the posting's own vocabulary. Also pick which TECHNICAL " +
          "SKILLS lines to include via skill_ids — that text is used exactly as written in the " +
          "fact bank, never rewritten, so just choose and order the lines. Pick 3-5 bullets per relevant " +
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
        tools: [buildPlanTool(facts, base_variant)],
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
        skill_ids: generated.skill_ids,
        match_report_markdown: generated.match_report_markdown,
        cover_letter_markdown: generated.cover_letter_markdown,
        interview_questions_markdown: generated.interview_questions_markdown,
      };

      // Guardian check BEFORE anything is written to disk.
      const planPath = path.join(ENGINE_DIR, `.tmp-plan-${randomUUID()}.json`);
      writeFileSync(planPath, JSON.stringify(plan, null, 2), "utf-8");
      const python = findPython(cfg.python);
      const validation = await runProcess(python, [path.join(ENGINE_DIR, "validate.py"), planPath], {
        timeoutMs: cfg.validateTimeoutMs ?? VALIDATE_TIMEOUT_MS,
      });

      if (validation.timedOut) {
        unlinkSync(planPath);
        return res.status(504).json({ error: "validate.py timed out" });
      }
      if (validation.status !== 0) {
        unlinkSync(planPath);
        return res.status(422).json({
          error: "The generated package failed guardian validation",
          details: (validation.stdout || validation.stderr || "").split("\n").filter(Boolean),
        });
      }

      // Guardian passed — render into the folder /analyze already created.
      const build = await runProcess(python, [path.join(ENGINE_DIR, "build.py"), planPath, folderPath], {
        timeoutMs: cfg.buildTimeoutMs ?? BUILD_TIMEOUT_MS,
      });
      unlinkSync(planPath);

      if (build.status !== 0) {
        return res.status(build.timedOut ? 504 : 500).json({
          error: build.timedOut ? "build.py timed out" : "build.py failed",
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
      await updateApplicationRowByFolder(folder, {
        variant: base_variant,
        match_score: match_score ?? "",
        gap_tags: toGapTagList(gap_tags).join(","),
      });

      const updated = await withPipelineFor(folder);
      res.status(201).json(updated);
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
