// Routes for the Evaluation page: blind labeling of saved postings and the
// accuracy report of the model's scores against those labels.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import path from "path";
import { isSafeFolderName } from "./paths.js";
import { DEFAULT_THRESHOLD, LABELS, evaluate } from "./evaluation.js";

const LABEL_FILE = "eval_label.json";
const MAX_NOTE = 500;

export function registerEvalRoutes(app, { store, withPipeline, sendError, engineDir }) {
  const APPLICATIONS_DIR = path.join(engineDir, "applications");

  const readJson = (p) => {
    try {
      return JSON.parse(readFileSync(p, "utf-8"));
    } catch {
      return null;
    }
  };

  // Every application with a saved posting — the only ones that can be
  // labeled from their text.
  async function postings() {
    const rows = await withPipeline(await store.listApplications());
    return rows
      .map((row) => {
        const dir = path.join(APPLICATIONS_DIR, row.folder);
        const postingPath = path.join(dir, "posting.txt");
        if (!existsSync(postingPath)) return null;
        return { row, dir, postingPath, label: readJson(path.join(dir, LABEL_FILE)) };
      })
      .filter(Boolean);
  }

  // GET /api/eval/items - the labeling queue. Deliberately WITHOUT the
  // model's score, recommendation or gaps: seeing them first would anchor
  // the label and make the evaluation measure agreement with itself.
  app.get("/api/eval/items", async (req, res) => {
    try {
      const items = (await postings()).map(({ row, postingPath, label }) => ({
        folder: row.folder,
        company: row.company,
        role: row.role,
        location: row.location,
        date: row.date,
        track: row.track,
        posting: readFileSync(postingPath, "utf-8"),
        label: label?.label ?? null,
        note: label?.note ?? "",
        labeled_at: label?.labeled_at ?? null,
      }));
      res.json(items);
    } catch (err) {
      sendError(res, err);
    }
  });

  // PUT /api/eval/labels/:folder { label: "apply"|"skip"|null, note? }
  // null removes the label (back to unlabeled).
  app.put("/api/eval/labels/:folder", async (req, res) => {
    try {
      const { folder } = req.params;
      const { label, note } = req.body || {};
      if (!isSafeFolderName(folder)) return res.status(400).json({ error: "Invalid folder" });
      if (label !== null && !LABELS.includes(label)) {
        return res.status(400).json({ error: `label must be one of ${LABELS.join(", ")} or null` });
      }
      const dir = path.join(APPLICATIONS_DIR, folder);
      if (!existsSync(path.join(dir, "posting.txt"))) {
        return res.status(404).json({ error: "No saved posting for this application" });
      }
      const file = path.join(dir, LABEL_FILE);
      if (label === null) {
        if (existsSync(file)) unlinkSync(file);
        return res.json({ folder, label: null, note: "", labeled_at: null });
      }
      const record = {
        label,
        note: String(note ?? "").slice(0, MAX_NOTE),
        labeled_at: new Date().toISOString(),
      };
      writeFileSync(file, JSON.stringify(record, null, 2), "utf-8");
      res.json({ folder, ...record });
    } catch (err) {
      sendError(res, err);
    }
  });

  // GET /api/eval/report?threshold=70 - the model's scores against the labels.
  // The score is the one saved in analysis.json (source "engine" = scored by
  // the dashboard, "nightly-estimate" = by the nightly search); older rows
  // without one fall back to the ledger's match_score as "legacy".
  app.get("/api/eval/report", async (req, res) => {
    try {
      const t = Number(req.query.threshold);
      const threshold = Number.isFinite(t) && t >= 0 && t <= 100 ? t : DEFAULT_THRESHOLD;
      const items = (await postings()).map(({ row, dir, label }) => {
        const analysis = readJson(path.join(dir, "analysis.json"));
        const rowScore = Number(row.match_score);
        const hasAnalysis = Number.isFinite(Number(analysis?.match_score));
        return {
          folder: row.folder,
          company: row.company,
          role: row.role,
          track: row.track,
          label: label?.label ?? null,
          note: label?.note ?? "",
          score: hasAnalysis ? Number(analysis.match_score) : row.match_score !== "" && Number.isFinite(rowScore) ? rowScore : NaN,
          source: hasAnalysis ? analysis.source || "engine" : "legacy",
          recommendation: analysis?.recommendation ?? null,
          reasoning: analysis?.reasoning ?? null,
        };
      });
      res.json(evaluate(items, threshold));
    } catch (err) {
      sendError(res, err);
    }
  });
}
