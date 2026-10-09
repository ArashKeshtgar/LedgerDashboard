// What to do next with each recruiter, and when — derived only from the
// stage dates already stored, so no schema change. Templates are the
// #R tags in Context/engine/data/recruit.py (same wording, truth-bank checked).

export const CONNECT_DAILY_CAP = 5;
export const FIRST_MESSAGE_AFTER_DAYS = 1;  // after the connect is accepted
export const FOLLOWUP_AFTER_DAYS = 7;       // no reply to the message
export const STALE_CONNECT_DAYS = 14;       // connect never accepted
export const CHECKIN_AFTER_DAYS = 28;       // monthly check-in once they replied

export const STEPS = {
  connect: { label: "Send LinkedIn connect", fa: "دعوت لینکدین بفرست", tag: "#R:msg.connect", field: "connect_sent" },
  wait_accept: { label: "Waiting for accept", fa: "منتظر قبول دعوت", tag: "", field: "" },
  stale: { label: "Connect not accepted — email or apply to their posting", fa: "دعوت را قبول نکرد — به آگهی‌شان اپلای کن یا ایمیل بزن", tag: "#R:rules.target", field: "" },
  first_message: { label: "Send first message", fa: "پیام اول را بفرست", tag: "#R:msg.cold", field: "followup_sent" },
  followup: { label: "Follow up (no reply in 7 days)", fa: "پیگیری — ۷ روز جواب نداده", tag: "#R:msg.followup", field: "followup_sent" },
  checkin: { label: "Monthly check-in", fa: "سر زدن ماهانه", tag: "#R:msg.checkin", field: "followup_sent" },
};

export function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromIso, toIso) {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86400000);
}

// One recruiter → { step, due } (due = yyyy-mm-dd, or "" while only waiting).
// A repeat follow-up or a check-in is logged by stamping followup_sent again.
export function nextStep(r, today) {
  if (r.replied) {
    const last = r.followup_sent > r.replied ? r.followup_sent : r.replied;
    return { step: "checkin", due: addDays(last, CHECKIN_AFTER_DAYS) };
  }
  if (r.followup_sent) return { step: "followup", due: addDays(r.followup_sent, FOLLOWUP_AFTER_DAYS) };
  if (r.connect_accepted) return { step: "first_message", due: addDays(r.connect_accepted, FIRST_MESSAGE_AFTER_DAYS) };
  if (r.connect_sent) {
    const staleOn = addDays(r.connect_sent, STALE_CONNECT_DAYS);
    return staleOn <= today ? { step: "stale", due: staleOn } : { step: "wait_accept", due: "" };
  }
  return { step: "connect", due: r.date_added || today };
}

// The "today" list: everything due on or before today, oldest first, with
// new connects limited to what is left of the daily cap.
export function planToday(rows, today, sentToday) {
  const withNext = rows.map((r) => {
    const n = nextStep(r, today);
    const overdueDays = n.due ? Math.max(0, daysBetween(n.due, today)) : 0;
    return { ...r, next: { ...n, ...STEPS[n.step], overdueDays } };
  });

  const due = withNext
    .filter((r) => r.next.due && r.next.due <= today && r.next.step !== "connect")
    .sort((a, b) => a.next.due.localeCompare(b.next.due) || a.name.localeCompare(b.name));

  const connectRoom = Math.max(0, CONNECT_DAILY_CAP - sentToday);
  const connects = withNext
    .filter((r) => r.next.step === "connect")
    .sort((a, b) => (a.date_added || "").localeCompare(b.date_added || "") || a.name.localeCompare(b.name));

  return {
    rows: withNext,
    today: [...due, ...connects.slice(0, connectRoom)].map((r) => r.id),
    queuedConnects: Math.max(0, connects.length - connectRoom),
  };
}
