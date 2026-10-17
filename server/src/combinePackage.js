// After build.py: the cover letter followed by the résumé in one file, as
// PDF and as Word, for portals that take a single upload. The separate files
// they're made from stay as they are.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PDFDocument } from "pdf-lib";
import { runProcess } from "./process.js";

export const COMBINED_SUFFIX = "CoverLetter_and_Resume.pdf";
export const COMBINED_DOCX_SUFFIX = "CoverLetter_and_Resume.docx";
const RESUME_PDF_RE = /resume\.pdf$/i;
const COVER_PDF_RE = /cover[_ -]?letter\.pdf$/i; // build.py writes CoverLetter.pdf
const RESUME_DOCX_RE = /resume\.docx$/i;
const COVER_DOCX_RE = /cover[_ -]?letter\.docx$/i;
const COMBINE_DOCX_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "combine_docx.py");
const COMBINE_DOCX_TIMEOUT_MS = 30_000;

// Returns { file } when the combined PDF was written, or { skipped: reason }
// when the folder lacks one of the two PDFs (e.g. LibreOffice missing, so
// build.py only wrote the .docx files). Throws if a PDF can't be read.
export async function combineCoverLetterAndResume(folderPath) {
  const files = existsSync(folderPath) ? readdirSync(folderPath) : [];
  const isOurs = (f) => f.endsWith(COMBINED_SUFFIX);
  const resume = files.find((f) => RESUME_PDF_RE.test(f) && !isOurs(f));
  const cover = files.find((f) => COVER_PDF_RE.test(f) && !isOurs(f));
  if (!resume || !cover) {
    return { skipped: `no ${!resume ? "résumé" : "cover letter"} PDF to combine` };
  }

  const out = await PDFDocument.create();
  for (const name of [cover, resume]) {
    const src = await PDFDocument.load(readFileSync(path.join(folderPath, name)));
    for (const page of await out.copyPages(src, src.getPageIndices())) out.addPage(page);
  }
  out.setTitle("Cover letter and résumé");

  // Same name stem as the résumé: "Arash_Keshtgar_Resume.pdf" ->
  // "Arash_Keshtgar_CoverLetter_and_Resume.pdf".
  const file = resume.replace(RESUME_PDF_RE, COMBINED_SUFFIX);
  writeFileSync(path.join(folderPath, file), await out.save());
  return { file };
}

// The Word version, by scripts/combine_docx.py (python-docx, which the
// résumé engine already needs). Same results as the PDF one: { file } or
// { skipped }; a failed script throws with its message.
export async function combineCoverLetterAndResumeDocx(folderPath, python) {
  const files = existsSync(folderPath) ? readdirSync(folderPath) : [];
  const isOurs = (f) => f.endsWith(COMBINED_DOCX_SUFFIX);
  const resume = files.find((f) => RESUME_DOCX_RE.test(f) && !isOurs(f));
  const cover = files.find((f) => COVER_DOCX_RE.test(f) && !isOurs(f));
  if (!resume || !cover) {
    return { skipped: `no ${!resume ? "résumé" : "cover letter"} .docx to combine` };
  }
  const file = resume.replace(RESUME_DOCX_RE, COMBINED_DOCX_SUFFIX);
  const run = await runProcess(
    python,
    [COMBINE_DOCX_SCRIPT, path.join(folderPath, cover), path.join(folderPath, resume), path.join(folderPath, file)],
    { timeoutMs: COMBINE_DOCX_TIMEOUT_MS }
  );
  if (run.status !== 0) {
    throw new Error((run.stderr || run.stdout || "").trim().split("\n").pop() || `combine_docx.py exited with ${run.status}`);
  }
  return { file };
}
