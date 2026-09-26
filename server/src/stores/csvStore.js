import { existsSync, readFileSync } from "fs";
import { load as loadYaml } from "js-yaml";
import path from "path";
import { appendLine, csvField, readCsv, toCsv, writeFileAtomic } from "../csv.js";
import { todayISO, ISO_DATE_RE } from "../text.js";
import { LEDGER_COLUMNS, RECRUITER_COLUMNS, RECRUITER_DATE_FIELDS, recruiterId } from "./shape.js";

// The original storage: ledger.csv, pipeline.csv, target_list.csv and
// pipeline_stages.yml under JobSearch/engine. Every method is async so this
// and sqlStore.js are interchangeable behind the same interface.
//
// Every read-modify-write here is synchronous inside the method, so two
// requests in this process can't interleave between the read and the write.
export function createCsvStore(engineDir) {
  const LEDGER_PATH = path.join(engineDir, "ledger.csv");
  const PIPELINE_PATH = path.join(engineDir, "pipeline.csv");
  const STAGES_PATH = path.join(engineDir, "pipeline_stages.yml");
  const RECRUITERS_PATH = path.join(engineDir, "target_list.csv");

  // A row's id is its folder — stable across edits, deletes and hand edits
  // of ledger.csv, unlike an array index.
  // Columns added later (the contact fields) are "" on rows written before
  // they existed, the same as SQL's defaults.
  const EMPTY_ROW = Object.fromEntries(LEDGER_COLUMNS.map((c) => [c, ""]));
  function readLedger() {
    return readCsv(LEDGER_PATH).map((r) => ({ id: r.folder, ...EMPTY_ROW, ...r }));
  }

  // Rewrites ledger.csv wholesale (small file) — atomically, via a temp
  // file and rename.
  function writeLedger(rows) {
    writeFileAtomic(LEDGER_PATH, toCsv(LEDGER_COLUMNS, rows.map(({ id, ...r }) => r)));
  }

  // pipeline.csv is append-only — the last line for a folder is its
  // current stage — so recording an event is just a new line.
  function appendEventLine({ folder, company, stage, date, note }) {
    const raw = existsSync(PIPELINE_PATH) ? readFileSync(PIPELINE_PATH, "utf-8") : "";
    const needsNewline = raw.length > 0 && !raw.endsWith("\n");
    const eventDate = date && ISO_DATE_RE.test(date) ? date : todayISO();
    const line = [folder, company, stage, eventDate, note || ""].map(csvField).join(",");
    appendLine(PIPELINE_PATH, (needsNewline ? "\n" : "") + line + "\n");
  }

  function readRecruiters() {
    if (!existsSync(RECRUITERS_PATH)) return [];
    return readCsv(RECRUITERS_PATH).map((r) => ({ id: recruiterId(r), ...r }));
  }

  function writeRecruiters(rows) {
    writeFileAtomic(RECRUITERS_PATH, toCsv(RECRUITER_COLUMNS, rows));
  }

  return {
    kind: "csv",

    async listApplications() {
      return readLedger();
    },

    async getApplication(folder) {
      return readLedger().find((r) => r.folder === folder) || null;
    },

    // New row + its initial "draft" event.
    async createApplication(row) {
      writeLedger([...readLedger(), row]);
      appendEventLine({ folder: row.folder, company: row.company, stage: "draft", note: "" });
    },

    async updateApplication(folder, fields) {
      const rows = readLedger();
      const idx = rows.findIndex((r) => r.folder === folder);
      if (idx === -1) return false;
      rows[idx] = { ...rows[idx], ...fields };
      writeLedger(rows);
      return true;
    },

    // pipeline.csv is left alone (append-only everywhere); an orphaned event
    // for a deleted folder is harmless since nothing looks it up once the
    // row is gone.
    async deleteApplication(folder) {
      writeLedger(readLedger().filter((r) => r.folder !== folder));
    },

    async listEvents() {
      if (!existsSync(PIPELINE_PATH)) return [];
      return readCsv(PIPELINE_PATH).filter((e) => e.folder && e.stage);
    },

    async appendEvent({ folder, stage, date, note }) {
      const row = readLedger().find((r) => r.folder === folder);
      appendEventLine({ folder, company: row?.company || "", stage, date, note });
    },

    async loadStages() {
      if (!existsSync(STAGES_PATH)) return { stages: [], terminal: [], actions: [] };
      const doc = loadYaml(readFileSync(STAGES_PATH, "utf-8")) || {};
      return { stages: doc.stages || [], terminal: doc.terminal || [], actions: doc.actions || [] };
    },

    async listRecruiters() {
      return readRecruiters();
    },

    // Adds recruiters not already present (matched by LinkedIn URL,
    // case-insensitive). Returns { added, skipped } rows.
    async addRecruiters(newRows) {
      const rows = readRecruiters();
      const known = new Set(rows.map((r) => (r.linkedin_url || "").trim().toLowerCase()));
      const added = [];
      const skipped = [];
      for (const r of newRows) {
        const key = (r.linkedin_url || "").trim().toLowerCase();
        if (key && known.has(key)) {
          skipped.push(r);
          continue;
        }
        if (key) known.add(key);
        added.push(r);
      }
      if (added.length) writeRecruiters([...rows, ...added]);
      return { added, skipped };
    },

    // Sets one of the dated stage fields to `date` (or clears it with null).
    async setRecruiterDate(id, field, date) {
      if (!RECRUITER_DATE_FIELDS.has(field)) throw new Error(`Unknown field: ${field}`);
      const rows = readRecruiters();
      const idx = rows.findIndex((r) => r.id === id);
      if (idx === -1) return null;
      rows[idx][field] = date || "";
      writeRecruiters(rows);
      return rows[idx];
    },

    async close() {},
  };
}
