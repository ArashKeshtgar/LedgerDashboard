// Routes for the Interviews page: past interviews and the practice question
// bank, read from engine/interviews/question_bank.json (the source; the .md
// next to it is rendered from it by render_bank.py). Read-only: the bank is
// edited as a file, like the Python engine's other inputs.
import { existsSync, readFileSync } from "fs";
import path from "path";

const BANK_FILE = "question_bank.json";
// Records are named like application folders, plus .md.
const RECORD_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

export class InterviewBankError extends Error {
  constructor(message) {
    super(message);
    this.name = "InterviewBankError";
  }
}

// Parses and checks the bank's shape, so a hand-edit mistake is reported by
// name instead of breaking the page somewhere later.
export function parseBank(text) {
  let bank;
  try {
    bank = JSON.parse(text);
  } catch (err) {
    throw new InterviewBankError(`${BANK_FILE} is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(bank?.interviews) || !Array.isArray(bank?.questions)) {
    throw new InterviewBankError(`${BANK_FILE} needs "interviews" and "questions" lists`);
  }
  const interviewIds = new Set(bank.interviews.map((i) => i.id));
  const questionIds = new Set();
  for (const q of bank.questions) {
    if (!q?.id || !q.question) throw new InterviewBankError(`${BANK_FILE}: every question needs an id and a question`);
    if (questionIds.has(q.id)) throw new InterviewBankError(`${BANK_FILE}: question id "${q.id}" is used twice`);
    questionIds.add(q.id);
    const unknown = (q.asked_in || []).find((id) => !interviewIds.has(id));
    if (unknown) throw new InterviewBankError(`${BANK_FILE}: question "${q.id}" is asked_in unknown interview "${unknown}"`);
  }
  return bank;
}

export function registerInterviewRoutes(app, { store, sendError, engineDir }) {
  const INTERVIEWS_DIR = path.join(engineDir, "interviews");

  const readRecord = (name) => {
    if (typeof name !== "string" || !RECORD_RE.test(name) || name.includes("..")) return null;
    const p = path.join(INTERVIEWS_DIR, name);
    return existsSync(p) ? readFileSync(p, "utf-8") : null;
  };

  // GET /api/interviews - every interview (with its record's text and
  // whether its application is in the ledger, so the page only links to
  // pages that exist) and every question. No bank yet is an empty bank.
  app.get("/api/interviews", async (req, res) => {
    try {
      const bankPath = path.join(INTERVIEWS_DIR, BANK_FILE);
      if (!existsSync(bankPath)) return res.json({ updated: null, interviews: [], questions: [] });
      const bank = parseBank(readFileSync(bankPath, "utf-8"));
      const tracked = new Set((await store.listApplications()).map((r) => r.folder));
      res.json({
        updated: bank.updated ?? null,
        interviews: bank.interviews.map((i) => ({
          ...i,
          tracked: tracked.has(i.application_folder),
          recordText: readRecord(i.record),
        })),
        questions: bank.questions,
      });
    } catch (err) {
      // The message names the field to fix and holds no server path.
      if (err instanceof InterviewBankError) return res.status(500).json({ error: err.message });
      sendError(res, err);
    }
  });
}
