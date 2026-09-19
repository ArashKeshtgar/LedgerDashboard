import { useEffect, useState } from "react";
import { fetchMotivation } from "../api.js";

// One line a day, chosen by date on the server so it doesn't reshuffle
// on every page load. Persian text, so the block is explicitly RTL.
export default function DailyLine() {
  const [quote, setQuote] = useState(null);

  useEffect(() => {
    fetchMotivation()
      .then(setQuote)
      .catch(() => {});
  }, []);

  if (!quote || !quote.text) return null;

  return (
    <div className="daily-line" dir="rtl" lang="fa">
      <span className="daily-line-mark">”</span>
      <div className="daily-line-body">
        <div className="daily-line-text">{quote.text}</div>
        {quote.mine && <div className="daily-line-by">— حرف خودت</div>}
      </div>
    </div>
  );
}
