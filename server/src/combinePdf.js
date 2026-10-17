// After build.py: one more file for portals that take a single upload, the
// cover letter followed by the résumé in one PDF, next to the two PDFs it
// was made from (which stay as they are).
import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { PDFDocument } from "pdf-lib";

export const COMBINED_SUFFIX = "CoverLetter_and_Resume.pdf";
const RESUME_PDF_RE = /resume\.pdf$/i;
const COVER_PDF_RE = /cover[_ -]?letter\.pdf$/i;

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
