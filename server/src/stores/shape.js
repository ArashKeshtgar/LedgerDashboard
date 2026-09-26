import { createHash } from "crypto";

// The API's row shapes — the same field names ledger.csv and
// target_list.csv always had. Both stores return exactly these, so the
// client never knows which one is behind the API.
export const LEDGER_COLUMNS = [
  "date", "company", "role", "branch", "source", "source_detail", "poster_type",
  "poster_name", "end_client", "applied_via", "posting_url", "date_posted",
  "date_seen", "location", "match_score", "variant", "folder", "status",
  "last_contact", "next_action", "outcome", "notes", "gap_tags",
];

export const RECRUITER_COLUMNS = [
  "name", "title", "company", "linkedin_url", "source", "date_added",
  "connect_note", "connect_sent", "connect_accepted",
  "followup_note", "followup_sent", "replied", "notes",
];

export const RECRUITER_DATE_FIELDS = new Set(["connect_sent", "connect_accepted", "followup_sent", "replied"]);

// Stable id from the LinkedIn URL (unique per person), falling back to
// name+company — never the row's position.
export function recruiterId(r) {
  const key = r.linkedin_url || `${r.name}|${r.company}`;
  return createHash("sha1").update(key).digest("hex").slice(0, 12);
}

// gap_tags is a comma-joined list of slugs in the API; storage may keep it
// as a list. Order kept, blanks and repeats dropped.
export function splitGapTags(value) {
  const seen = new Set();
  return String(value || "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t && !seen.has(t) && seen.add(t));
}
