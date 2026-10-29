// The stage after `current` in pipeline_stages.yml order, or null when there
// is none (the last stage, a closed one, or a draft — a draft moves on
// through "Approve & Apply", not a plain next step).
export function nextStage(stages, current) {
  const i = (stages || []).findIndex((s) => s.key === current);
  if (i < 1 || i >= stages.length - 1) return null;
  return stages[i + 1];
}
