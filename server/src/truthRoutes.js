// Routes for the Truth Bank, Gaps, Résumé and Health pages. The truth bank
// (facts/*.yml), the gap dictionary and the templates stay files — the engine
// scripts read them directly — and this is the one place the dashboard edits
// them, each save committed to the engine's local git history.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import path from "path";
import { dump as dumpYaml, load as loadYaml } from "js-yaml";
import { runProcess, findPython } from "./process.js";
import { isSafeFolderName } from "./paths.js";
import { createEngineGit } from "./engineGit.js";
import { computeHealth } from "./health.js";
import {
  TruthBankError, bankFingerprint, deleteFact, factRefs, gapStatus, mergeGap, readFacts, readGaps,
  saveFact, saveGap, sectionOf,
} from "./truthBank.js";

const INSPECT_TIMEOUT_MS = 60_000;
const RESUME_RE = /Resume\.docx$/i;

export function registerTruthRoutes(app, { cfg, store, withPipeline, sendError, engineDir, git: gitOverride }) {
  const FACTS_DIR = path.join(engineDir, "facts");
  const GAP_TAGS_PATH = path.join(engineDir, "gap_tags.yml");
  const GAP_ALIASES_PATH = path.join(engineDir, "gap_aliases.yml");
  const APPLICATIONS_DIR = path.join(engineDir, "applications");
  const TEMPLATES_DIR = path.join(engineDir, "templates");
  const DISMISSED_PATH = path.join(engineDir, "health_dismissed.yml");
  const git = gitOverride || createEngineGit(engineDir);

  const fail = (res, err) =>
    err instanceof TruthBankError
      ? res.status(err.status).json({ error: err.message, details: err.details })
      : sendError(res, err);

  const readJson = (p) => {
    try {
      return JSON.parse(readFileSync(p, "utf-8"));
    } catch {
      return null;
    }
  };
  const mtime = (p) => (existsSync(p) ? statSync(p).mtime.toISOString() : null);

  // Everything per application the pages and health checks need: the saved
  // analysis, the saved build plan (which fact each bullet came from) and
  // when each happened.
  async function applicationsInfo() {
    const rows = await withPipeline(await store.listApplications());
    const fingerprint = bankFingerprint(FACTS_DIR, GAP_TAGS_PATH);
    return rows.map((row) => {
      const dir = path.join(APPLICATIONS_DIR, row.folder);
      const files = existsSync(dir) ? readdirSync(dir) : [];
      const resume = files.find((f) => RESUME_RE.test(f));
      const analysis = readJson(path.join(dir, "analysis.json"));
      const plan = readJson(path.join(dir, "plan.json"));
      const analyzedAt = analysis?.analyzed_at || mtime(path.join(dir, "posting.txt"));
      return {
        folder: row.folder,
        company: row.company,
        role: row.role,
        stage: row.stage,
        variant: row.variant,
        gapTags: String(row.gap_tags || "").split(",").map((s) => s.trim()).filter(Boolean),
        hasPosting: files.includes("posting.txt"),
        analysis,
        plan,
        analyzedAt,
        // Old drafts have no saved fingerprint: if they have a posting at
        // all, they were analyzed before tracking began, so treat as stale.
        analysisStale: files.includes("posting.txt") && analysis?.bank_fingerprint !== fingerprint,
        built: !!resume,
        builtAt: plan?.built_at || (resume ? mtime(path.join(dir, resume)) : null),
        resumeFile: resume || null,
      };
    });
  }

  // Template inspection runs build.py's own section logic through Python;
  // cached until a template or build.py changes.
  let templateCache = { key: null, value: null, error: null };
  async function templatesInfo() {
    const files = existsSync(TEMPLATES_DIR) ? readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith(".docx")) : [];
    const key = [...files.map((f) => `${f}:${statSync(path.join(TEMPLATES_DIR, f)).mtimeMs}`), mtime(path.join(engineDir, "build.py"))].join("|");
    if (templateCache.key === key) return templateCache;
    const script = path.join(engineDir, "inspect_resume.py");
    let value = null;
    let error = null;
    if (!existsSync(script)) {
      error = "inspect_resume.py is missing from the engine folder";
    } else {
      const res = await runProcess(findPython(cfg.python), [script, "templates"], { cwd: engineDir, timeoutMs: INSPECT_TIMEOUT_MS });
      try {
        if (res.status !== 0) throw new Error(res.stderr || res.stdout || "inspect_resume.py failed");
        value = JSON.parse(res.stdout);
      } catch (e) {
        error = String(e.message || e).slice(0, 500);
      }
    }
    templateCache = { key, value, error };
    return templateCache;
  }

  const readDismissed = () => (existsSync(DISMISSED_PATH) ? loadYaml(readFileSync(DISMISSED_PATH, "utf-8")) || [] : []);

  // --- truth bank ---

  app.get("/api/truth-bank", async (req, res) => {
    try {
      const { facts, duplicates } = readFacts(FACTS_DIR);
      const gaps = readGaps(GAP_TAGS_PATH);
      const apps = await applicationsInfo();
      const usage = new Map();
      for (const a of apps) {
        const ids = new Set([...(a.plan?.bullets || []).map((b) => b.fact_id), ...(a.plan?.skill_ids || [])]);
        for (const id of ids) {
          usage.set(id, [...(usage.get(id) || []), { folder: a.folder, company: a.company, role: a.role, stage: a.stage }]);
        }
      }
      const gapRefs = new Map();
      for (const [slug, label] of Object.entries(gaps)) {
        for (const id of factRefs(label)) gapRefs.set(id, [...(gapRefs.get(id) || []), { slug, status: gapStatus(label) }]);
      }
      const { value: templates } = await templatesInfo();
      const anchors = new Map((templates?.anchors || []).map((a) => [a.prefix, a.in_variants]));
      res.json({
        facts: facts.map((f) => ({
          ...f,
          section: sectionOf(f.id),
          usedIn: usage.get(f.id) || [],
          gaps: gapRefs.get(f.id) || [],
        })),
        duplicates,
        sectionVariants: Object.fromEntries(anchors),
        trackedBuilds: apps.filter((a) => a.plan).length,
        history: git.enabled(),
      });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/truth-bank/facts", async (req, res) => {
    try {
      const { fact, note } = req.body || {};
      const saved = saveFact(FACTS_DIR, { fact, create: true });
      const commit = await git.commit([`facts/${saved.file}`], `Add ${saved.fact.id}${note ? `: ${note}` : ""}`);
      res.status(201).json({ ...saved, commit });
    } catch (err) {
      fail(res, err);
    }
  });

  app.put("/api/truth-bank/facts/:id", async (req, res) => {
    try {
      const { fact, note } = req.body || {};
      const saved = saveFact(FACTS_DIR, { id: req.params.id, fact });
      const commit = await git.commit([`facts/${saved.file}`], `Edit ${saved.fact.id}${note ? `: ${note}` : ""}`);
      res.json({ ...saved, commit });
    } catch (err) {
      fail(res, err);
    }
  });

  app.delete("/api/truth-bank/facts/:id", async (req, res) => {
    try {
      const id = req.params.id;
      const citing = Object.entries(readGaps(GAP_TAGS_PATH)).filter(([, label]) => factRefs(label).includes(id));
      if (citing.length) {
        throw new TruthBankError(
          `${id} is cited as evidence by gap(s) ${citing.map(([s]) => s).join(", ")} — update those labels first`,
          409
        );
      }
      const { file } = deleteFact(FACTS_DIR, id);
      const commit = await git.commit([`facts/${file}`], `Remove ${id}`);
      res.json({ id, file, commit });
    } catch (err) {
      fail(res, err);
    }
  });

  app.get("/api/truth-bank/history", async (req, res) => {
    try {
      const q = typeof req.query.q === "string" && req.query.q ? req.query.q : undefined;
      res.json({ enabled: git.enabled(), commits: await git.log({ grep: q }) });
    } catch (err) {
      fail(res, err);
    }
  });

  app.get("/api/truth-bank/history/:hash", async (req, res) => {
    try {
      const commit = await git.show(req.params.hash);
      if (!commit) return res.status(404).json({ error: "Unknown commit" });
      res.json(commit);
    } catch (err) {
      fail(res, err);
    }
  });

  // Commits edits made outside the dashboard (by hand, or by a chat session).
  app.post("/api/truth-bank/commit", async (req, res) => {
    try {
      const changed = await git.uncommitted();
      if (!changed.length) return res.json({ commit: null, files: [] });
      const message = (req.body?.message || "").trim() || `Edits outside the dashboard: ${changed.join(", ")}`;
      res.json({ commit: await git.commit(changed, message), files: changed });
    } catch (err) {
      fail(res, err);
    }
  });

  // --- gaps ---

  app.get("/api/gaps", async (req, res) => {
    try {
      const gaps = readGaps(GAP_TAGS_PATH);
      const { facts } = readFacts(FACTS_DIR);
      const ids = new Set(facts.map((f) => f.id));
      const apps = await applicationsInfo();
      const slugs = new Set([...Object.keys(gaps), ...apps.flatMap((a) => a.gapTags)]);
      const out = [...slugs].map((slug) => {
        const label = gaps[slug] ?? null;
        const refs = factRefs(label);
        const using = apps.filter((a) => a.gapTags.includes(slug));
        return {
          slug,
          label,
          defined: label !== null,
          status: label === null ? "undefined" : gapStatus(label),
          refs: refs.filter((r) => ids.has(r)),
          danglingRefs: refs.filter((r) => !ids.has(r)),
          counts: {
            total: using.length,
            draft: using.filter((a) => a.stage === "draft").length,
            sent: using.filter((a) => a.stage !== "draft").length,
            rejected: using.filter((a) => a.stage === "rejected").length,
          },
          applications: using.map((a) => ({ folder: a.folder, company: a.company, role: a.role, stage: a.stage })),
        };
      });
      res.json(out);
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/gaps", async (req, res) => {
    try {
      const saved = saveGap(GAP_TAGS_PATH, { ...req.body, create: true });
      const commit = await git.commit(["gap_tags.yml"], `Add gap ${saved.slug}`);
      res.status(201).json({ ...saved, commit });
    } catch (err) {
      fail(res, err);
    }
  });

  app.put("/api/gaps/:slug", async (req, res) => {
    try {
      const saved = saveGap(GAP_TAGS_PATH, { slug: req.params.slug, label: req.body?.label });
      const note = (req.body?.note || "").trim();
      const commit = await git.commit(["gap_tags.yml"], `Edit gap ${saved.slug}${note ? `: ${note}` : ""}`);
      res.json({ ...saved, commit });
    } catch (err) {
      fail(res, err);
    }
  });

  // POST /api/gaps/:slug/merge { into } - two slugs for one gap (cs-degree,
  // bachelor-degree-cs, degree-requirement) split its count three ways.
  // Every application tagged with the old slug gets `into` instead (row and
  // its saved analysis), the old slug leaves the dictionary, and an alias
  // maps any later analysis that still coins it.
  app.post("/api/gaps/:slug/merge", async (req, res) => {
    try {
      const { slug } = req.params;
      const into = req.body?.into;
      mergeGap(GAP_TAGS_PATH, GAP_ALIASES_PATH, { slug, into });
      const swap = (tags) => [...new Set(tags.map((t) => (t === slug ? into : t)))];
      let updated = 0;
      for (const a of await applicationsInfo()) {
        if (!a.gapTags.includes(slug)) continue;
        await store.updateApplication(a.folder, { gap_tags: swap(a.gapTags).join(",") });
        updated++;
        const analysisPath = path.join(APPLICATIONS_DIR, a.folder, "analysis.json");
        const analysis = readJson(analysisPath);
        if (Array.isArray(analysis?.gap_tags) && analysis.gap_tags.includes(slug)) {
          writeFileSync(analysisPath, JSON.stringify({ ...analysis, gap_tags: swap(analysis.gap_tags) }, null, 2), "utf-8");
        }
      }
      const commit = await git.commit(["gap_tags.yml", "gap_aliases.yml"], `Merge gap ${slug} into ${into}`);
      res.json({ slug, into, updated, commit });
    } catch (err) {
      fail(res, err);
    }
  });

  // --- résumé ---

  app.get("/api/resume/templates", async (req, res) => {
    try {
      const { value, error } = await templatesInfo();
      if (!value) return res.status(503).json({ error: `Couldn't read the templates: ${error}` });
      res.json(value);
    } catch (err) {
      fail(res, err);
    }
  });

  // Every application with a built résumé, newest first.
  app.get("/api/resume/builds", async (req, res) => {
    try {
      const apps = (await applicationsInfo()).filter((a) => a.built);
      apps.sort((a, b) => String(b.builtAt).localeCompare(String(a.builtAt)));
      res.json(
        apps.map((a) => ({
          folder: a.folder, company: a.company, role: a.role, stage: a.stage, variant: a.plan?.base_variant || a.variant,
          builtAt: a.builtAt, tracked: !!a.plan, bullets: a.plan?.bullets?.length ?? null,
        }))
      );
    } catch (err) {
      fail(res, err);
    }
  });

  // A built résumé, paragraph by paragraph, with each bullet joined to the
  // fact it was written from (plan.json's bullets are written verbatim).
  app.get("/api/applications/:id/resume", async (req, res) => {
    try {
      const folder = req.params.id;
      if (!isSafeFolderName(folder) || !(await store.getApplication(folder))) {
        return res.status(404).json({ error: "Not found" });
      }
      const dir = path.join(APPLICATIONS_DIR, folder);
      const resume = existsSync(dir) ? readdirSync(dir).find((f) => RESUME_RE.test(f)) : null;
      if (!resume) return res.status(404).json({ error: "No résumé has been built for this application yet" });
      const plan = readJson(path.join(dir, "plan.json"));
      const result = await runProcess(
        findPython(cfg.python),
        [path.join(engineDir, "inspect_resume.py"), "file", path.join(dir, resume)],
        { cwd: engineDir, timeoutMs: INSPECT_TIMEOUT_MS }
      );
      if (result.status !== 0) return res.status(503).json({ error: `Couldn't read the résumé: ${(result.stderr || "").slice(0, 300)}` });
      const document = JSON.parse(result.stdout);
      const factByText = new Map((plan?.bullets || []).map((b) => [b.text.trim(), b.fact_id]));
      const { facts } = readFacts(FACTS_DIR);
      const byId = new Map(facts.map((f) => [f.id, f]));
      const skillByText = new Map(
        (plan?.skill_ids || []).map((id) => [String(byId.get(id)?.claim || "").replace(/\s+/g, " ").trim(), id])
      );
      for (const p of document.paragraphs) {
        const id = p.kind === "bullet" ? factByText.get(p.text) : p.kind === "skill" ? skillByText.get(p.text) : undefined;
        if (!id) continue;
        p.fact_id = id;
        const now = byId.get(id);
        const then = plan.facts_used?.[id];
        p.fact_changed = !now || (then !== undefined && then.replace(/\s+/g, " ").trim() !== now.claim);
        p.fact_claim = now?.claim ?? null;
      }
      res.json({ folder, file: resume, plan, document, builtAt: plan?.built_at || mtime(path.join(dir, resume)) });
    } catch (err) {
      fail(res, err);
    }
  });

  // --- health ---

  app.get("/api/health", async (req, res) => {
    try {
      const { facts, duplicates } = readFacts(FACTS_DIR);
      const [applications, templates, uncommitted] = await Promise.all([
        applicationsInfo(),
        templatesInfo(),
        git.uncommitted(),
      ]);
      const health = computeHealth({
        facts,
        duplicates,
        gaps: readGaps(GAP_TAGS_PATH),
        applications,
        templates: templates.value,
        uncommitted,
        dismissed: readDismissed(),
      });
      res.json({ ...health, templatesError: templates.error, history: git.enabled() });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/health/dismiss", async (req, res) => {
    try {
      const key = String(req.body?.key || "");
      if (!key) return res.status(400).json({ error: "key is required" });
      const keys = [...new Set([...readDismissed(), key])].sort();
      writeFileSync(DISMISSED_PATH, dumpYaml(keys), "utf-8");
      await git.commit(["health_dismissed.yml"], `Dismiss health check ${key}`);
      res.json({ dismissed: keys });
    } catch (err) {
      fail(res, err);
    }
  });

  app.delete("/api/health/dismiss", async (req, res) => {
    try {
      writeFileSync(DISMISSED_PATH, dumpYaml([]), "utf-8");
      await git.commit(["health_dismissed.yml"], "Restore all dismissed health checks");
      res.json({ dismissed: [] });
    } catch (err) {
      fail(res, err);
    }
  });
}
