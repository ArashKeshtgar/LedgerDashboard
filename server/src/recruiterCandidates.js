// Which applications the nightly run should find a recruiter for: ones that
// are still "applied" and whose follow-up is due (no answer in 7+ days), so a
// LinkedIn connect to someone at that company is the next useful step.
// Each application is looked up once; the outcome is kept in daily/ (on the
// server, which release never overwrites) so a company with no findable
// recruiter doesn't come back every night.
import { readFileSync } from "fs";
import path from "path";

export const LOOKUPS_FILE = "recruiter_lookups.json";
export const CANDIDATES_PER_NIGHT = 5;
export const LOOKUP_RESULTS = new Set(["added", "not_found"]);

export function readLookups(dailyDir) {
  try {
    const data = JSON.parse(readFileSync(path.join(dailyDir, LOOKUPS_FILE), "utf-8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

// "Acme Corp." and "ACME Corporation" are the same employer.
export function companyKey(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(inc|incorporated|ltd|limited|corp|corporation|co|llc|llp|lp|group|canada)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// apps = ledger rows with pipeline state attached (withPipeline).
export function recruiterCandidates(apps, recruiters, lookups, limit = CANDIDATES_PER_NIGHT) {
  const known = new Set(recruiters.map((r) => companyKey(r.company)).filter(Boolean));
  const due = apps
    .filter((a) => a.stage === "applied" && a.needsFollowup && !lookups[a.folder])
    .filter((a) => companyKey(a.company) && !known.has(companyKey(a.company)))
    .sort((a, b) => (b.daysSinceAction ?? 0) - (a.daysSinceAction ?? 0) || a.folder.localeCompare(b.folder));

  // Two applications to one company need one recruiter, not two.
  const seen = new Set();
  const unique = due.filter((a) => {
    const key = companyKey(a.company);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    candidates: unique.slice(0, limit).map((a) => ({
      folder: a.folder,
      company: a.company,
      role: a.role,
      applied: a.date,
      days_since_action: a.daysSinceAction,
      posting_url: a.posting_url || "",
      poster_name: a.poster_name || "",
      poster_type: a.poster_type || "",
      contact_name: a.contact_name || "",
    })),
    remaining: Math.max(0, unique.length - limit),
  };
}
