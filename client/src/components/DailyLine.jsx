import { useEffect, useState } from "react";
import { fetchApplications, fetchMotivation } from "../api.js";

// One line a day, chosen by date on the server so it doesn't reshuffle
// on every page load. ‹ › browse the other lines without changing
// tomorrow's; a small strip under it turns the day's to-dos into numbers.
// Persian text, so the block is explicitly RTL.

const PERSIAN_DATE = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
  weekday: "long", day: "numeric", month: "long",
});
const faNum = (n) => n.toLocaleString("fa-IR");

// Collapsing hides the card for the rest of today only.
const HIDDEN_KEY = "dailyLineHiddenOn";
const todayKey = () => new Date().toDateString();
function readHidden() {
  try { return localStorage.getItem(HIDDEN_KEY) === todayKey(); } catch { return false; }
}
function writeHidden(hidden) {
  try {
    if (hidden) localStorage.setItem(HIDDEN_KEY, todayKey());
    else localStorage.removeItem(HIDDEN_KEY);
  } catch { /* storage blocked — just don't remember */ }
}

function todayCounts(rows) {
  const open = rows.filter((r) => !r.isTerminal);
  return {
    awaiting: open.filter((r) => r.stage === "draft" && /منتظر تأیید/.test(r.next_action || "")).length,
    ready: open.filter((r) => r.stage === "draft" && /آماده/.test(r.next_action || "")).length,
    followups: open.filter((r) => r.needsFollowup).length,
  };
}

export default function DailyLine() {
  const [quote, setQuote] = useState(null);
  const [shift, setShift] = useState(0);
  const [counts, setCounts] = useState(null);
  const [hidden, setHidden] = useState(readHidden);

  useEffect(() => {
    fetchMotivation(shift).then(setQuote).catch(() => {});
  }, [shift]);

  useEffect(() => {
    fetchApplications()
      .then((rows) => setCounts(todayCounts(Array.isArray(rows) ? rows : rows.rows || [])))
      .catch(() => {});
  }, []);

  if (!quote || !quote.text) return null;

  const toggle = () => {
    writeHidden(!hidden);
    setHidden(!hidden);
  };

  if (hidden) {
    return (
      <div className="daily-line-collapsed" dir="rtl" lang="fa">
        <button type="button" onClick={toggle}>✨ جمله‌ی امروز</button>
      </div>
    );
  }

  const chips = counts
    ? [
        counts.awaiting > 0 && `⏳ ${faNum(counts.awaiting)} بسته منتظر تأیید تو`,
        counts.ready > 0 && `📤 ${faNum(counts.ready)} بسته آماده‌ی ارسال`,
        counts.followups > 0 && `🔁 ${faNum(counts.followups)} پیگیری سررسیده`,
      ].filter(Boolean)
    : [];

  return (
    <section className="daily-line" dir="rtl" lang="fa" aria-label="جمله‌ی امروز">
      <header className="daily-line-head">
        <span className="daily-line-title">✨ جمله‌ی امروز</span>
        <span className="daily-line-date">{PERSIAN_DATE.format(new Date())}</span>
        <span className="daily-line-tools">
          <button type="button" title="جمله‌ی قبلی" onClick={() => setShift((s) => s - 1)}>›</button>
          <span className="daily-line-count">
            {faNum(quote.index + 1)} / {faNum(quote.total)}
          </span>
          <button type="button" title="جمله‌ی بعدی" onClick={() => setShift((s) => s + 1)}>‹</button>
          {shift !== 0 && (
            <button type="button" className="daily-line-today" onClick={() => setShift(0)}>امروز</button>
          )}
          <button type="button" title="تا فردا جمعش کن" onClick={toggle}>✕</button>
        </span>
      </header>

      <blockquote className="daily-line-text">{quote.text}</blockquote>
      {quote.mine && <div className="daily-line-by">— حرف خودت</div>}

      {counts && (
        <footer className="daily-line-chips">
          {chips.length > 0
            ? chips.map((c) => <span key={c} className="daily-line-chip">{c}</span>)
            : <span className="daily-line-chip daily-line-chip-calm">✅ امروز کار عقب‌افتاده‌ای نداری</span>}
        </footer>
      )}
    </section>
  );
}
