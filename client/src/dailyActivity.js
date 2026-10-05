// Per-day activity for the Applications page's "forecast" panel: how many
// applications were sent, found (drafts saved) and rejected on each day.
// Pure, so it can be reasoned about apart from the chart.

const NOT_SENT = new Set(["draft", "follow_up", "rejected", "no_response"]);

export function isoDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function parseDay(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(s, n) {
  const d = parseDay(s);
  d.setDate(d.getDate() + n);
  return isoDay(d);
}

// The day a row was sent: its first stage past draft (applied, screen…).
// A card dragged straight from draft to Rejected was still sent that day.
export function sentDay(row) {
  const h = row.stageHistory || [];
  const sent = h.find((e) => !NOT_SENT.has(e.stage)) || (row.isTerminal ? h.find((e) => e.stage === row.stage) : null);
  return sent?.date ? String(sent.date).slice(0, 10) : null;
}

export function rejectedDay(row) {
  const e = (row.stageHistory || []).find((h) => h.stage === "rejected");
  return e?.date ? String(e.date).slice(0, 10) : null;
}

// Every day from the first activity to today, zeros included.
export function dailyActivity(rows, today = isoDay(new Date())) {
  const days = new Map();
  const at = (day) => {
    if (!days.has(day)) days.set(day, { day, sent: 0, found: 0, rejected: 0, scores: [] });
    return days.get(day);
  };
  for (const r of rows) {
    const found = String(r.date || "").slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(found)) at(found).found++;
    const sent = sentDay(r);
    if (sent) {
      const d = at(sent);
      d.sent++;
      const score = Number(r.match_score);
      if (r.match_score !== "" && r.match_score != null && !isNaN(score)) d.scores.push(score);
    }
    const rej = rejectedDay(r);
    if (rej) at(rej).rejected++;
  }
  if (!days.size) return [];
  const first = [...days.keys()].sort()[0];
  const out = [];
  for (let day = first < today ? first : today; day <= today; day = addDays(day, 1)) {
    const d = days.get(day) || { day, sent: 0, found: 0, rejected: 0, scores: [] };
    out.push({
      ...d,
      score: d.scores.length ? Math.round(d.scores.reduce((s, n) => s + n, 0) / d.scores.length) : null,
    });
  }
  return out;
}

// Claude API cost per local day, from /api/usage/calls. Cost tracking began
// on COST_TRACKED_FROM; earlier days have no record, not a zero bill.
export const COST_TRACKED_FROM = "2026-10-03";

export const COST_KIND_LABEL = {
  analyze: "Analyze",
  reanalyze: "Re-analyze",
  build: "Build package",
  "build-repair": "Build repair",
};

export function dailyCost(calls) {
  const days = new Map();
  for (const c of calls || []) {
    const at = new Date(c.at);
    if (isNaN(at)) continue;
    const day = isoDay(at);
    if (!days.has(day)) days.set(day, { usd: 0, calls: 0, byKind: {} });
    const d = days.get(day);
    d.usd += c.usd || 0;
    d.calls++;
    d.byKind[c.kind] = (d.byKind[c.kind] || 0) + (c.usd || 0);
  }
  return days;
}

export function formatUsd(usd) {
  if (usd == null) return "—";
  if (usd === 0) return "$0";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}
