// A follow-up is logged as a pipeline.csv event too, but it never counts as
// a stage change — it only marks that action was taken and resets the
// "needs follow-up" clock computed in attachPipeline().
export const FOLLOWUP_KEY = "follow_up";

// Follow-up guidance (industry standard) is ~7-10 days of silence before a
// short check-in email is warranted.
export const FOLLOWUP_THRESHOLD_DAYS = 7;

// Attach stage + follow-up state to each ledger row. Pure: takes the rows,
// the pipeline.csv events, the stage definitions and "now", so it can be
// tested without touching any file. The CURRENT stage is the last
// STAGE-CHANGING event for that folder in file order (the file is
// append-only, so a later line always wins) — a "follow_up" event is logged
// the same append-only way but never counts as a stage change; it only
// resets the "needs follow-up" clock below.
export function attachPipeline(rows, events, { stages = [], terminal = [] }, now = new Date()) {
  const order = new Map(stages.map((s, i) => [s.key, i]));
  const terminalKeys = new Set(terminal.map((t) => t.key));
  // "Waiting on them" stages: you've acted, now the clock is on the
  // employer. Marked in pipeline_stages.yml (waiting: true) rather than
  // hardcoded here, so the two stay in sync.
  const waitingKeys = new Set(stages.filter((s) => s.waiting).map((s) => s.key));

  const byFolder = new Map();
  events.forEach((e) => {
    if (!e.folder) return;
    if (!byFolder.has(e.folder)) byFolder.set(e.folder, []);
    byFolder.get(e.folder).push({ stage: e.stage, date: e.date, note: e.note || "" });
  });

  // Whole calendar days between the event's date and today, both in local
  // time. `new Date("2026-09-10")` alone would be UTC midnight, which in
  // Toronto is the previous evening — enough to make "days in stage" or
  // "interview in N days" off by one depending on the time of day.
  // A date can be in the future (an interview already booked), so report
  // past and future separately instead of clamping both to zero.
  const today = startOfLocalDay(now);
  function daysSince(dateStr) {
    const d = parseLocalDate(dateStr);
    if (!d) return { days: null, until: null };
    const diff = Math.round((today - startOfLocalDay(d)) / 86400000);
    return diff >= 0 ? { days: diff, until: null } : { days: null, until: -diff };
  }

  return rows.map((r) => {
    const history = byFolder.get(r.folder) || [];
    const stageEvents = history.filter((h) => h.stage !== FOLLOWUP_KEY);
    const last = stageEvents.length ? stageEvents[stageEvents.length - 1] : null;
    const stage = last ? last.stage : r.status || "draft";

    const { days: daysInStage, until: daysUntilStage } = daysSince(last?.date);

    // Follow-ups logged since the card entered its current stage — one from
    // an earlier stage shouldn't keep resetting today's clock.
    const followupsInStage = history.filter(
      (h) => h.stage === FOLLOWUP_KEY && (!last || h.date >= last.date)
    );
    const lastFollowup = followupsInStage.length
      ? followupsInStage[followupsInStage.length - 1]
      : null;
    const lastFollowupDate = lastFollowup ? lastFollowup.date : null;

    // A follow-up is action taken, so "waiting on them" restarts from
    // whichever is more recent: entering the stage, or the last follow-up.
    const lastActionDate =
      lastFollowupDate && (!last || lastFollowupDate >= last.date)
        ? lastFollowupDate
        : last?.date || null;
    const { days: daysSinceAction } = daysSince(lastActionDate);

    const needsFollowup =
      waitingKeys.has(stage) &&
      daysSinceAction !== null &&
      daysSinceAction > FOLLOWUP_THRESHOLD_DAYS;

    return {
      ...r,
      // Which job family the row belongs to — derived from the résumé
      // variant it was built from, so there's one stored source of truth.
      track: r.variant === "itsupport" ? "it" : "dev",
      stage,
      stageIndex: order.has(stage) ? order.get(stage) : -1,
      isTerminal: terminalKeys.has(stage),
      stageHistory: history,
      daysInStage,
      daysUntilStage,
      needsFollowup,
      followupThresholdDays: FOLLOWUP_THRESHOLD_DAYS,
      followupCount: followupsInStage.length,
      lastFollowupDate,
      daysSinceAction,
    };
  });
}

// "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm[:ss]" read as LOCAL time (the ledger's
// dates are the user's own calendar dates, not UTC instants).
export function parseLocalDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(value || ""));
  if (!m) return null;
  const [, y, mo, d, h = 0, mi = 0, s = 0] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return isNaN(date) ? null : date;
}

function startOfLocalDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
