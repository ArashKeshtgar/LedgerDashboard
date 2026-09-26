// Mirrors server/src/contact.js: where a hiring contact's email came from.
// The server enforces the rule (published, or "found" + verified); these
// labels just explain the choices in the form.
export const CONTACT_SOURCES = [
  { key: "posting", label: "Listed in the posting", published: true },
  { key: "ats_email", label: "Reply-to of the ATS confirmation email", published: true },
  { key: "recruiter_reply", label: "They emailed me", published: true },
  { key: "found", label: "Found it myself (company site, hiring team)", published: false },
];

export function sourceLabel(key) {
  return CONTACT_SOURCES.find((s) => s.key === key)?.label || key;
}

const SIGNATURE = "Arash Keshtgar";

// The date the application moved to "applied" (latest such event), for the
// email's "I applied on …" line.
export function appliedOn(app) {
  const applied = (app.stageHistory || []).filter((h) => h.stage === "applied");
  const date = applied.length ? applied[applied.length - 1].date : app.date;
  const d = date ? new Date(`${date.slice(0, 10)}T00:00:00`) : null;
  return d && !isNaN(d) ? d.toLocaleDateString("en-US", { month: "long", day: "numeric" }) : null;
}

// A short, polite follow-up as a mailto: link — it opens in the user's own
// mail app, where they can adjust it before sending. Nothing is sent from
// here.
export function followupMailto(app) {
  const firstName = (app.contact_name || "").trim().split(/\s+/)[0];
  const when = appliedOn(app);
  const subject = `Following up on my application: ${app.role}`;
  const body = [
    `Hi ${firstName || "there"},`,
    "",
    `I applied for the ${app.role} position at ${app.company}${when ? ` on ${when}` : ""} and wanted to follow up briefly. ` +
      "I'm still very interested in the role and would welcome the chance to talk about how my experience fits.",
    "",
    "Happy to share anything else that would help.",
    "",
    "Thank you for your time,",
    SIGNATURE,
  ].join("\r\n");
  return `mailto:${encodeURIComponent(app.contact_email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

// Days until the "no reply" clock reaches the follow-up threshold, or 0 if
// it already has.
export function daysUntilFollowup(app) {
  if (app.needsFollowup) return 0;
  if (app.daysSinceAction == null || app.followupThresholdDays == null) return null;
  return Math.max(0, app.followupThresholdDays + 1 - app.daysSinceAction);
}
