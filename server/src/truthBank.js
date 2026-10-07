// The truth bank (engine/facts/*.yml) and the gap dictionary (engine/gap_tags.yml)
// as data the dashboard can read and edit.
//
// Edits are surgical: only the edited fact's own lines (or the gap's one line)
// are replaced, so the files' comments and every other entry stay byte-for-byte
// as they were — a full YAML re-dump reformatted ~1,500 lines per file. Every
// rendered fact is parsed back and compared with what was asked for before the
// file is written, so a formatting slip can't silently change a claim.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import path from "path";
import { dump as dumpYaml, load as loadYaml } from "js-yaml";

export const STRENGTHS = ["strong", "medium", "soft"];
export const FACT_ID_RE =
  /^(?:(?:proj|exp)\.[a-z0-9_]+\.[a-z0-9_]+|(?:skill|identity|edu)\.[a-z0-9_]+)$/;
// Same pattern Context/engine/registry.py uses to find fact references in a
// gap label — the two tools must agree on what a label "points at".
const FACT_REF_RE =
  /\b(?:(?:proj|exp)\.[a-z0-9_]+\.[a-z0-9_]+|(?:skill|edu|identity)\.[a-z0-9_]+)\b/g;
export const GAP_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const FILE_FOR_PREFIX = {
  proj: "projects.yml",
  exp: "experience.yml",
  skill: "skills.yml",
  identity: "identity.yml",
  edu: "education.yml",
};

export class TruthBankError extends Error {
  constructor(message, status = 400, details = undefined) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// "proj.rebiomed.offers" -> "proj.rebiomed"; "skill.languages" -> "skill"
export function sectionOf(id) {
  const parts = id.split(".");
  return parts[0] === "proj" || parts[0] === "exp" ? parts.slice(0, 2).join(".") : parts[0];
}

export function fileForId(id) {
  return FILE_FOR_PREFIX[id.split(".")[0]] || null;
}

export function factRefs(text) {
  return [...new Set(String(text || "").match(FACT_REF_RE) || [])];
}

// Status read from the label's own wording, exactly like registry.py's
// gap_status(): the dictionary text is the single source of a gap's status.
export function gapStatus(label) {
  const t = label || "";
  if (t.includes("کامل بسته شد")) return "closed";
  if (t.includes("بسته شد")) return /همچنان|باقی|هنوز/.test(t) ? "partial" : "closed";
  return "open";
}

// --- facts -------------------------------------------------------------------

export function factFiles(factsDir) {
  return readdirSync(factsDir).filter((f) => f.endsWith(".yml")).sort();
}

// Every fact with the file it lives in. Duplicate ids are reported, not
// merged: the server's and build.py's loaders both keep only the last one, so
// a duplicate silently hides a fact.
export function readFacts(factsDir) {
  const facts = [];
  const seen = new Map();
  const duplicates = [];
  for (const file of factFiles(factsDir)) {
    const entries = loadYaml(readFileSync(path.join(factsDir, file), "utf-8")) || [];
    entries.forEach((entry, index) => {
      const fact = { ...normalizeFact(entry), file, index };
      if (seen.has(fact.id)) duplicates.push({ id: fact.id, files: [seen.get(fact.id), file] });
      seen.set(fact.id, file);
      facts.push(fact);
    });
  }
  return { facts, duplicates };
}

const squash = (s) => String(s ?? "").trim().replace(/\s+/g, " ");
const list = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);

export function normalizeFact(f) {
  return {
    id: String(f?.id ?? "").trim(),
    claim: squash(f?.claim),
    evidence: squash(f?.evidence),
    tags: list(f?.tags),
    allowed_numbers: list(f?.allowed_numbers),
    forbidden: list(f?.forbidden),
    strength: String(f?.strength ?? "").trim(),
  };
}

export function validateFact(fact) {
  const errors = [];
  if (!FACT_ID_RE.test(fact.id)) {
    errors.push(
      "id must look like proj.<project>.<name>, exp.<role>.<name>, skill.<name>, identity.<name> or edu.<name> (lowercase, digits, _)"
    );
  }
  if (!fact.claim) errors.push("claim is required");
  if (!fact.evidence) errors.push("evidence is required — a fact without evidence doesn't belong in the truth bank");
  if (!STRENGTHS.includes(fact.strength)) errors.push(`strength must be one of ${STRENGTHS.join(", ")}`);
  for (const t of fact.tags) if (/[\s,[\]]/.test(t)) errors.push(`tag "${t}" can't contain spaces, commas or brackets`);
  return errors;
}

const PLAIN_RE = /^[A-Za-z_][A-Za-z0-9_.+-]*$/;
const RESERVED = new Set(["true", "false", "yes", "no", "on", "off", "null", "~"]);
const flowItem = (s) => (PLAIN_RE.test(s) && !RESERVED.has(s.toLowerCase()) ? s : JSON.stringify(s));

// A long string as a folded block (the files' own style); a short one inline.
function scalarLines(name, text) {
  const inline = `  ${name}: ${JSON.stringify(text)}`;
  if (inline.length <= 80) return [inline];
  const lines = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && line.length + 1 + word.length > 72) {
      lines.push(`    ${line}`);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(`    ${line}`);
  return [`  ${name}: >`, ...lines];
}

export function renderFact(fact) {
  return [
    `- id: ${fact.id}`,
    ...scalarLines("claim", fact.claim),
    ...scalarLines("evidence", fact.evidence),
    `  tags: [${fact.tags.map(flowItem).join(", ")}]`,
    `  allowed_numbers: [${fact.allowed_numbers.map((s) => JSON.stringify(s)).join(", ")}]`,
    `  forbidden: [${fact.forbidden.map((s) => JSON.stringify(s)).join(", ")}]`,
    `  strength: ${fact.strength}`,
  ].join("\n");
}

function sameFact(a, b) {
  return JSON.stringify(normalizeFact(a)) === JSON.stringify(normalizeFact(b));
}

// Line spans of every top-level "- id:" item: from its first line to its last
// non-blank line before the next column-0 line (next item or a section comment).
function itemSpans(lines) {
  const spans = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^- id:\s*(\S+)\s*$/.exec(lines[i]);
    if (!m) continue;
    let end = i;
    for (let j = i + 1; j < lines.length && !/^\S/.test(lines[j]); j++) {
      if (lines[j].trim()) end = j;
    }
    spans.push({ id: m[1], start: i, end });
  }
  return spans;
}

// Files are edited as LF lines; a file that used CRLF is written back as CRLF
// throughout, instead of ending up with the spliced lines LF and the rest CRLF.
const toLines = (src) => src.replace(/\r\n/g, "\n").split("\n");

function writeChecked(filePath, text, check, src = "") {
  if (src.includes("\r\n")) text = text.replace(/\n/g, "\r\n");
  const parsed = loadYaml(text) || [];
  check(parsed);
  writeFileSync(filePath, text, "utf-8");
}

// fields: the full new fact. Returns { file }.
export function saveFact(factsDir, { id, fact: input, create }) {
  const fact = normalizeFact(input);
  const errors = validateFact(fact);
  if (errors.length) throw new TruthBankError("The fact isn't valid", 400, errors);

  const { facts } = readFacts(factsDir);
  const existing = facts.find((f) => f.id === (create ? fact.id : id));
  if (create && existing) throw new TruthBankError(`${fact.id} already exists (${existing.file})`, 409);
  if (!create && !existing) throw new TruthBankError(`Unknown fact: ${id}`, 404);
  if (!create && fact.id !== id) {
    throw new TruthBankError("A fact's id can't be renamed — gaps and built résumés refer to it", 400);
  }

  const file = create ? fileForId(fact.id) : existing.file;
  const filePath = path.join(factsDir, file);
  const src = existsSync(filePath) ? readFileSync(filePath, "utf-8") : "";
  const lines = toLines(src);
  const spans = itemSpans(lines);
  const rendered = renderFact(fact).split("\n");

  if (create) {
    // After the last fact of the same section, so a project's facts stay together.
    const section = sectionOf(fact.id);
    const sameSection = spans.filter((s) => sectionOf(s.id) === section);
    const after = sameSection.length ? sameSection[sameSection.length - 1] : spans[spans.length - 1];
    if (after) lines.splice(after.end + 1, 0, "", ...rendered);
    else lines.push(...(src.trim() ? [""] : []), ...rendered, "");
  } else {
    const span = spans.find((s) => s.id === id);
    lines.splice(span.start, span.end - span.start + 1, ...rendered);
  }

  writeChecked(filePath, lines.join("\n"), (parsed) => {
    const back = parsed.find((f) => f?.id === fact.id);
    if (!back || !sameFact(back, fact)) throw new Error(`Rendered YAML for ${fact.id} didn't read back the same — nothing was written`);
    const before = loadYaml(src) || [];
    if (parsed.length !== before.length + (create ? 1 : 0)) {
      throw new Error(`Saving ${fact.id} would have changed other facts in ${file} — nothing was written`);
    }
  }, src);
  return { file, fact };
}

export function deleteFact(factsDir, id) {
  const { facts } = readFacts(factsDir);
  const existing = facts.find((f) => f.id === id);
  if (!existing) throw new TruthBankError(`Unknown fact: ${id}`, 404);
  const filePath = path.join(factsDir, existing.file);
  const src = readFileSync(filePath, "utf-8");
  const lines = toLines(src);
  const span = itemSpans(lines).find((s) => s.id === id);
  // Take one surrounding blank line with it, so no double gap is left behind.
  let { start, end } = span;
  if (lines[end + 1] === "") end += 1;
  else if (start > 0 && lines[start - 1] === "") start -= 1;
  lines.splice(start, end - start + 1);
  writeChecked(filePath, lines.join("\n"), (parsed) => {
    if (parsed.some((f) => f?.id === id) || parsed.length !== (loadYaml(src) || []).length - 1) {
      throw new Error(`Deleting ${id} would have changed other facts — nothing was written`);
    }
  }, src);
  return { file: existing.file };
}

// --- gap dictionary ------------------------------------------------------------

export function readGaps(gapTagsPath) {
  if (!existsSync(gapTagsPath)) return {};
  return loadYaml(readFileSync(gapTagsPath, "utf-8")) || {};
}

// Short hash of everything an analysis reads (facts + gap labels). Saved with
// each analysis, so "was this scored against today's truth bank?" is exact
// instead of a guess from file dates.
export function bankFingerprint(factsDir, gapTagsPath) {
  const { facts } = readFacts(factsDir);
  return createHash("sha1")
    .update(JSON.stringify(facts.map(({ index, file, ...f }) => f)))
    .update(JSON.stringify(readGaps(gapTagsPath)))
    .digest("hex")
    .slice(0, 12);
}

export function saveGap(gapTagsPath, { slug, label, create }) {
  if (!GAP_SLUG_RE.test(slug || "")) throw new TruthBankError("slug must be lowercase kebab-case, e.g. azure-devops");
  const text = squash(label);
  if (!text) throw new TruthBankError("label is required");
  const src = existsSync(gapTagsPath) ? readFileSync(gapTagsPath, "utf-8") : "";
  const before = loadYaml(src) || {};
  const exists = Object.prototype.hasOwnProperty.call(before, slug);
  if (create && exists) throw new TruthBankError(`${slug} already exists`, 409);
  if (!create && !exists) throw new TruthBankError(`Unknown gap: ${slug}`, 404);

  const line = `${slug}: ${JSON.stringify(text)}`;
  const lines = toLines(src);
  if (create) {
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    lines.push(line, "");
  } else {
    const i = lines.findIndex((l) => l.startsWith(`${slug}:`));
    if (i < 0 || !/^[a-z0-9-]+: ".*"$/.test(lines[i])) {
      throw new TruthBankError(`${slug} isn't a one-line entry in gap_tags.yml — edit it by hand`, 409);
    }
    lines[i] = line;
  }
  writeChecked(gapTagsPath, lines.join("\n"), (parsed) => {
    if (parsed[slug] !== text) throw new Error(`Rendered YAML for ${slug} didn't read back the same — nothing was written`);
    const others = Object.keys(before).filter((k) => k !== slug);
    if (others.some((k) => parsed[k] !== before[k])) throw new Error("Saving would have changed other gaps — nothing was written");
  }, src);
  return { slug, label: text };
}

// --- gap aliases (merged gaps) -------------------------------------------------
// gap_aliases.yml maps a merged slug to the gap it now counts as. The
// dictionary keeps only the surviving slug; any analysis that still coins
// the old one is mapped on save.

export function readGapAliases(aliasesPath) {
  if (!existsSync(aliasesPath)) return {};
  return loadYaml(readFileSync(aliasesPath, "utf-8")) || {};
}

export function resolveGapAliases(tags, aliases) {
  return [...new Set(tags.map((t) => aliases[t] || t))];
}

// Removes `slug` from the dictionary and records slug -> into. Aliases that
// pointed at `slug` are pointed at `into`, so chains never form.
export function mergeGap(gapTagsPath, aliasesPath, { slug, into }) {
  if (!GAP_SLUG_RE.test(slug || "") || !GAP_SLUG_RE.test(into || "")) {
    throw new TruthBankError("slug and into must be lowercase kebab-case");
  }
  if (slug === into) throw new TruthBankError("A gap can't be merged into itself");
  const src = existsSync(gapTagsPath) ? readFileSync(gapTagsPath, "utf-8") : "";
  const before = loadYaml(src) || {};
  if (!Object.prototype.hasOwnProperty.call(before, into)) throw new TruthBankError(`Unknown gap: ${into}`, 404);

  if (Object.prototype.hasOwnProperty.call(before, slug)) {
    const lines = toLines(src);
    const i = lines.findIndex((l) => l.startsWith(`${slug}:`));
    if (i < 0 || !/^[a-z0-9-]+: ".*"$/.test(lines[i])) {
      throw new TruthBankError(`${slug} isn't a one-line entry in gap_tags.yml — edit it by hand`, 409);
    }
    lines.splice(i, 1);
    writeChecked(gapTagsPath, lines.join("\n"), (parsed) => {
      if (Object.prototype.hasOwnProperty.call(parsed, slug)) throw new Error(`${slug} is still in gap_tags.yml — nothing was written`);
      const others = Object.keys(before).filter((k) => k !== slug);
      if (others.some((k) => parsed[k] !== before[k])) throw new Error("Merging would have changed other gaps — nothing was written");
    }, src);
  }

  const aliases = readGapAliases(aliasesPath);
  for (const [from, to] of Object.entries(aliases)) if (to === slug) aliases[from] = into;
  aliases[slug] = into;
  const header =
    "# Merged gaps: old slug -> the gap it now counts as. Written by the Gaps\n" +
    "# page's Merge; analyses that still use an old slug are mapped on save.\n";
  writeFileSync(aliasesPath, header + dumpYaml(aliases, { sortKeys: true }), "utf-8");
  return { slug, into };
}
