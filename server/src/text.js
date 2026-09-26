// Turns "Sr. Power Platform Developer (Remote)" into "Sr-Power-Platform-Developer"
// for folder names — drops parentheticals, caps word count so names stay sane.
export function slugify(s) {
  return String(s || "")
    .replace(/\(.*?\)/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .join("-");
}

export function toISODate(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayISO() {
  return toISODate(new Date());
}

// Monday-start week, matching the "25/week" recruiter rule.
export function weekStartISO(d) {
  const day = d.getDay(); // 0=Sun..6=Sat
  const diffToMonday = day === 0 ? 6 : day - 1;
  return toISODate(new Date(d.getFullYear(), d.getMonth(), d.getDate() - diffToMonday));
}

// Plain date (YYYY-MM-DD) or, since the "Record a stage update" form also
// takes an optional time, a date+time ("YYYY-MM-DDTHH:mm", seconds optional).
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/;
