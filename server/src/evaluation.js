// Evaluation of the scoring model against Arash's own judgment. He labels
// each saved posting "apply" or "skip" WITHOUT seeing the model's score (so
// the label isn't anchored on it); this module turns those labels and the
// scores the model gave into accuracy numbers.
//
// The label lives in the application's own folder (eval_label.json), next to
// analysis.json: applications/ is never overwritten by a release, so labels
// made on the server survive deploys.

export const LABELS = ["apply", "skip"];
export const DEFAULT_THRESHOLD = 70;

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);

// Confusion matrix of "score >= threshold means apply" against the labels.
export function confusion(items, threshold) {
  const m = { tp: 0, fp: 0, fn: 0, tn: 0 };
  for (const it of items) {
    const predicted = it.score >= threshold;
    const actual = it.label === "apply";
    if (predicted && actual) m.tp++;
    else if (predicted) m.fp++;
    else if (actual) m.fn++;
    else m.tn++;
  }
  const n = m.tp + m.fp + m.fn + m.tn;
  return {
    threshold,
    n,
    ...m,
    accuracy: pct(m.tp + m.tn, n),
    // Of the postings the model said to apply to, how many were worth it.
    precision: pct(m.tp, m.tp + m.fp),
    // Of the postings worth applying to, how many the model caught.
    recall: pct(m.tp, m.tp + m.fn),
  };
}

// Mean score per label: a model that separates well gives "apply" postings
// clearly higher scores than "skip" ones.
function meanScore(items, label) {
  const s = items.filter((i) => i.label === label).map((i) => i.score);
  return s.length ? Math.round((s.reduce((a, b) => a + b, 0) / s.length) * 10) / 10 : null;
}

function summarize(items, threshold) {
  const sweep = [];
  for (let t = 40; t <= 90; t += 5) sweep.push(confusion(items, t));
  // Best accuracy; ties go to the threshold nearest the one in use.
  const best = sweep
    .filter((s) => s.n)
    .sort((a, b) => b.accuracy - a.accuracy || Math.abs(a.threshold - threshold) - Math.abs(b.threshold - threshold))[0];
  return {
    ...confusion(items, threshold),
    meanApply: meanScore(items, "apply"),
    meanSkip: meanScore(items, "skip"),
    sweep,
    best: best ? { threshold: best.threshold, accuracy: best.accuracy } : null,
  };
}

// items: [{ folder, company, role, label, score, source, recommendation }]
// Only labeled items with a score count; unlabeled ones are reported as such.
export function evaluate(items, threshold = DEFAULT_THRESHOLD) {
  const labeled = items.filter((i) => LABELS.includes(i.label));
  const scored = labeled.filter((i) => Number.isFinite(i.score));
  const sources = [...new Set(scored.map((i) => i.source))].sort();

  // The model's own recommendation field (only full engine analyses have
  // one): "apply" and "apply_with_caveats" both count as apply.
  const withRec = labeled.filter((i) => i.recommendation);
  const recAgree = withRec.filter((i) => (i.recommendation === "skip" ? "skip" : "apply") === i.label).length;

  // The model's mistakes at the threshold in use, biggest miss first —
  // where to look for the cause.
  const mistakes = scored
    .filter((i) => i.score >= threshold !== (i.label === "apply"))
    .map((i) => ({ ...i, kind: i.label === "apply" ? "missed" : "false_alarm", distance: Math.abs(i.score - threshold) }))
    .sort((a, b) => b.distance - a.distance);

  return {
    threshold,
    total: items.length,
    labeled: labeled.length,
    unlabeled: items.length - labeled.length,
    apply: labeled.filter((i) => i.label === "apply").length,
    skip: labeled.filter((i) => i.label === "skip").length,
    noScore: labeled.length - scored.length,
    overall: summarize(scored, threshold),
    bySource: Object.fromEntries(sources.map((s) => [s, summarize(scored.filter((i) => i.source === s), threshold)])),
    recommendation: withRec.length ? { n: withRec.length, agree: recAgree, accuracy: pct(recAgree, withRec.length) } : null,
    mistakes,
  };
}
