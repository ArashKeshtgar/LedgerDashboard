// Consistency checks across the truth bank, the gap dictionary, the résumé
// templates and the drafts built from them. Each rule exists because the
// mismatch it describes actually happened and had to be found by hand:
//   - a fact tagged mongodb whose claim never said "MongoDB" (the build model
//     only reads claim text, so the posting was told there was no MongoDB);
//   - a gap label still saying "all relational" after MongoDB facts landed;
//   - drafts scored before newer evidence was added (gap_tags are a snapshot).
// Pure: everything it needs is passed in, so it's tested without files.
import { factRefs, gapStatus, sectionOf, validateFact } from "./truthBank.js";

export const SEVERITY_ORDER = { error: 0, warn: 1, info: 2 };

const STRUCTURAL_TAG_RE =
  /^(?:proj|exp|variant|only|conditional)|^(?:shared|pool|header|role_header|project_header|excluded|locked|contact|skill)$/;
// Category words that legitimately describe a fact without being said in it.
const GENERIC_TAGS = new Set(
  ("security testing deployment healthcare workflow support documentation training performance " +
    "migration schema reporting analytics frontend backend containers messaging tooling legacy " +
    "education windows devops integrations accounting marketplace payments crud authentication " +
    "sql dotnet azure hardware networking").split(" ")
);

// Gap slugs often use the category word where facts carry the technology
// tag ("nosql-experience" vs facts tagged mongodb).
const SLUG_TOKEN_ALIASES = { nosql: ["mongodb"], cicd: ["github_actions"], k8s: ["kubernetes"] };

// The tag's last word is also tried without its inflection, so a claim
// saying "stored procedure", "Azure Function" or "Reverse-engineered"
// counts as naming stored_procedures / azure_functions / reverse_engineering.
const stemLast = (tag) => tag.replace(/([a-z]{4,}?)(?:ing|es|ed|s)$/, "$1");
const spellings = (tag) =>
  [tag, stemLast(tag)].flatMap((t) => [
    t.replace(/_/g, " "),
    t.replace(/_/g, ""),
    t.replace(/_/g, "-"),
    t.replace(/_/g, "."),
  ]);
export const mentions = (tag, text) => {
  const t = String(text || "").toLowerCase();
  return spellings(tag.toLowerCase()).some((s) => t.includes(s));
};

// Technology tags: ones named somewhere in a skills line or a project's
// stack header — so "mongodb" counts (the ReBiomed header says MongoDB),
// "security" doesn't.
export function techVocabulary(facts) {
  const stackText = facts
    .filter((f) => f.id.startsWith("skill.") || f.tags.includes("project_header"))
    .map((f) => f.claim)
    .join(" ");
  const tags = new Set(facts.flatMap((f) => f.tags));
  return new Set(
    [...tags].filter((t) => !STRUCTURAL_TAG_RE.test(t) && !GENERIC_TAGS.has(t) && mentions(t, stackText))
  );
}

const NUMBER_RE = /\d[\d,]*(?:\+|%)?/g;
// Mirrors validate.py's KNOWN_PRODUCT_VERSION_RE plus years/dates, which a
// bullet never has to restate.
const NOT_A_CLAIM_RE =
  /\b(?:Microsoft|Office)\s+365\b|\bWindows\s+(?:10|11)\b|\bSQL\s+Server\s+20\d{2}\b|\.NET(?:\s+Core)?\s+(?:[5-9]|10)\b|\bAZ-\d{3}\b|\b(?:19|20)\d{2}(?:-\d{2}(?:-\d{2})?)?\b|\b[0-9a-f]{7,40}\b/gi;

const isBullet = (f) =>
  (f.id.startsWith("proj.") || f.id.startsWith("exp.")) &&
  !f.tags.includes("role_header") &&
  !f.tags.includes("project_header");

const squash = (s) => String(s || "").replace(/[\s·]+/g, " ").trim().toLowerCase();

export function computeHealth({
  facts,
  duplicates = [],
  gaps = {},
  applications = [],
  templates = null,
  uncommitted = [],
  dismissed = [],
}) {
  const issues = [];
  const add = (issue) => issues.push({ ...issue, key: `${issue.kind}:${issue.target.id}` });
  const byId = new Map(facts.map((f) => [f.id, f]));
  const vocab = techVocabulary(facts);

  // --- facts ---
  for (const d of duplicates) {
    add({
      severity: "error", kind: "duplicate-id", target: { type: "fact", id: d.id },
      title: `${d.id} is defined twice`,
      detail: `In ${d.files.join(" and ")}. Every loader keeps only the last one, so the other is silently ignored.`,
    });
  }
  for (const f of facts) {
    const errors = validateFact(f);
    if (errors.length) {
      add({ severity: "error", kind: "invalid-fact", target: { type: "fact", id: f.id }, title: `${f.id} is incomplete`, detail: errors.join("; ") });
    }
    if (!f.id.startsWith("skill.")) {
      const unsaid = f.tags.filter((t) => vocab.has(t) && !mentions(t, f.claim));
      if (unsaid.length) {
        add({
          severity: "warn", kind: "tag-not-in-claim", target: { type: "fact", id: f.id },
          title: `${f.id} is tagged ${unsaid.join(", ")} but its claim never says so`,
          detail: "Analyze and Build only read the claim text, not tags — a posting asking for this will be told it's missing. Name it in the claim, or drop the tag.",
        });
      }
    }
    if (isBullet(f) && !f.tags.includes("excluded")) {
      const allowed = new Set(f.allowed_numbers);
      const numbers = [...new Set(f.claim.replace(NOT_A_CLAIM_RE, " ").match(NUMBER_RE) || [])];
      const missing = numbers.filter((n) => !allowed.has(n));
      if (missing.length) {
        add({
          severity: "info", kind: "number-not-allowed", target: { type: "fact", id: f.id },
          title: `${f.id} states ${missing.join(", ")} but allowed_numbers doesn't list it`,
          detail: "The guardian blocks any number not in allowed_numbers, so a bullet built from this fact can't use it.",
        });
      }
    }
  }

  // --- templates (only when the Python inspection ran) ---
  if (templates) {
    const anchored = new Set(templates.anchors.filter((a) => a.in_variants.length).map((a) => a.prefix));
    const sections = new Set(facts.filter(isBullet).map((f) => sectionOf(f.id)));
    for (const s of sections) {
      if (!anchored.has(s)) {
        add({
          severity: "error", kind: "section-no-template", target: { type: "section", id: s },
          title: `${s} has facts but no section in any résumé template`,
          detail: "build.py fails on any bullet from this section. Add the project block to the templates and an entry to SECTION_ANCHORS in build.py.",
        });
      }
    }
    const skillClaims = new Set(facts.filter((f) => f.id.startsWith("skill.")).map((f) => squash(f.claim)));
    const identity = facts.filter((f) => f.id.startsWith("identity.") && f.tags.includes("header"));
    for (const [variant, doc] of Object.entries(templates.variants)) {
      const stale = doc.paragraphs.filter((p) => p.kind === "skill" && !skillClaims.has(squash(p.text)));
      if (stale.length) {
        add({
          severity: "info", kind: "template-skill-drift", target: { type: "template", id: variant },
          title: `resume_${variant}.docx has ${stale.length} skills line(s) that no longer match the truth bank`,
          detail: "Builds replace these from the truth bank, but the base template file itself shows the old text: " +
            stale.map((p) => `“${p.text.slice(0, 60)}…”`).join(" "),
        });
      }
      const header = squash(doc.paragraphs.slice(0, 6).map((p) => p.text).join(" "));
      for (const f of identity) {
        // A variant-tagged line (the job title) belongs to that template only.
        const forVariants = f.tags.filter((t) => t.startsWith("variant.")).map((t) => t.slice("variant.".length));
        if (forVariants.length && !forVariants.includes(variant)) continue;
        if (!header.includes(squash(f.claim))) {
          add({
            severity: "warn", kind: "template-identity-drift", target: { type: "template", id: `${variant}:${f.id}` },
            title: `resume_${variant}.docx header doesn't match ${f.id}`,
            detail: `Expected “${f.claim}” in the header — every built résumé copies the template's header as-is.`,
          });
        }
      }
    }
  }

  // --- gap dictionary ---
  const gapList = Object.entries(gaps).map(([slug, label]) => ({
    slug, label: String(label ?? ""), status: gapStatus(String(label ?? "")), refs: factRefs(label),
  }));
  for (const g of gapList) {
    const dangling = g.refs.filter((r) => !byId.has(r));
    if (dangling.length) {
      add({
        severity: "error", kind: "gap-dangling-ref", target: { type: "gap", id: g.slug },
        title: `${g.slug} points at ${dangling.join(", ")}, which isn't in the truth bank`,
        detail: "The fact was renamed or removed — fix the label so its evidence is real.",
      });
    }
    if (g.status !== "closed" && g.refs.length === 0) {
      const tokens = [
        ...new Set(g.slug.split("-").flatMap((t) => [t, ...(SLUG_TOKEN_ALIASES[t] || [])]).filter((t) => vocab.has(t))),
      ];
      const candidates = facts.filter((f) => tokens.some((t) => f.tags.includes(t))).map((f) => f.id);
      if (candidates.length) {
        add({
          severity: "warn", kind: "gap-possible-evidence", target: { type: "gap", id: g.slug },
          title: `${g.slug} is ${g.status}, but ${candidates.length} fact(s) are tagged ${tokens.join(", ")}`,
          detail: `Its label cites no fact — check whether ${candidates.slice(0, 4).join(", ")}${candidates.length > 4 ? "…" : ""} close or narrow it, and say so in the label.`,
        });
      }
    }
  }
  const gapStatusBySlug = new Map(gapList.map((g) => [g.slug, g.status]));
  const undefinedGaps = new Map();
  for (const a of applications) {
    for (const t of a.gapTags) {
      if (!gapStatusBySlug.has(t)) undefinedGaps.set(t, [...(undefinedGaps.get(t) || []), a.folder]);
    }
  }
  for (const [slug, folders] of undefinedGaps) {
    add({
      severity: "info", kind: "gap-undefined", target: { type: "gap", id: slug },
      title: `${slug} is used by ${folders.length} application(s) but isn't in the gap dictionary`,
      detail: "Stats shows the raw slug, and Analyze can't reuse it consistently. Add a label for it.",
    });
  }

  // --- drafts (sent applications are history, not something to fix) ---
  for (const a of applications.filter((x) => x.stage === "draft")) {
    const target = { type: "application", id: a.folder };
    const name = `${a.company} — ${a.role}`;
    if (a.analysisStale) {
      add({
        severity: "info", kind: "draft-stale-analysis", target,
        title: `${name} was analyzed before the truth bank last changed`,
        detail: `Its gap tags (${a.gapTags.join(", ") || "none"}) may no longer be right.`,
        action: { type: "reanalyze", folder: a.folder },
      });
    }
    const closed = a.gapTags.filter((t) => gapStatusBySlug.get(t) === "closed");
    if (closed.length) {
      add({
        severity: "warn", kind: "draft-closed-gap", target,
        title: `${name} is still tagged with closed gap(s): ${closed.join(", ")}`,
        detail: "The dictionary says these are closed — re-analyze so the package stops apologizing for them.",
        action: { type: "reanalyze", folder: a.folder },
      });
    }
    if (a.built) {
      if (!a.plan) {
        add({
          severity: "info", kind: "draft-built-untracked", target,
          title: `${name} was built before résumés were linked to facts`,
          detail: "Rebuild it to see which fact each bullet came from and to be warned when one of them changes.",
          action: { type: "open", folder: a.folder },
        });
      } else {
        const changed = Object.entries(a.plan.facts_used || {})
          .filter(([id, claim]) => !byId.has(id) || squash(byId.get(id).claim) !== squash(claim))
          .map(([id]) => id);
        if (changed.length) {
          add({
            severity: "warn", kind: "draft-plan-stale", target,
            title: `${name}'s résumé uses ${changed.length} fact(s) that changed since it was built`,
            detail: changed.join(", "),
            action: { type: "open", folder: a.folder },
          });
        }
      }
      if (a.analyzedAt && a.builtAt && a.analyzedAt > a.builtAt) {
        add({
          severity: "info", kind: "draft-built-before-analysis", target,
          title: `${name} was re-analyzed after its package was built`,
          detail: "The cover letter and match report still reflect the old gaps — rebuild it.",
          action: { type: "open", folder: a.folder },
        });
      }
    }
  }

  // --- history ---
  if (uncommitted.length) {
    add({
      severity: "info", kind: "uncommitted", target: { type: "engine", id: "git" },
      title: `${uncommitted.length} truth-bank file(s) changed outside the dashboard`,
      detail: `${uncommitted.join(", ")} — commit them so the change has a dated entry in the history.`,
      action: { type: "commit" },
    });
  }

  const hidden = new Set(dismissed);
  const visible = issues.filter((i) => !hidden.has(i.key));
  visible.sort((x, y) => SEVERITY_ORDER[x.severity] - SEVERITY_ORDER[y.severity]);
  const counts = { error: 0, warn: 0, info: 0 };
  for (const i of visible) counts[i.severity] += 1;
  return { issues: visible, counts, dismissedCount: issues.length - visible.length };
}
