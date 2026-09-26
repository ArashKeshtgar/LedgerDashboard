import { parse } from "csv-parse/sync";
import { appendFileSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";

export function readCsv(file) {
  const raw = readFileSync(file, "utf-8")
    .replace(/^﻿/, "")
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

export function csvField(value) {
  const s = String(value ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns, rows) {
  const header = columns.join(",");
  const lines = rows.map((r) => columns.map((c) => csvField(r[c] ?? "")).join(","));
  return [header, ...lines].join("\n") + "\n";
}

// Thrown when Windows refuses the write because another program (usually
// Excel) has the file open. Callers turn it into a 423 the user can act on.
export class FileLockedError extends Error {
  constructor(file) {
    super(`${file} is open in another program (close it in Excel and try again).`);
    this.name = "FileLockedError";
    this.file = file;
  }
}

const LOCK_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);

// Writes to a temp file next to the target and renames it over the original,
// so a crash mid-write leaves either the old file or the new one — never a
// half-written ledger. The rename is atomic on the same volume.
export function writeFileAtomic(file, content) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, "utf-8");
  try {
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    if (LOCK_CODES.has(err.code)) throw new FileLockedError(file);
    throw err;
  }
}

export function appendLine(file, line) {
  try {
    appendFileSync(file, line, "utf-8");
  } catch (err) {
    if (LOCK_CODES.has(err.code)) throw new FileLockedError(file);
    throw err;
  }
}
