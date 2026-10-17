import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { askAssistant } from "../api.js";
import { usd } from "../costs.js";

// The AI assistant drawer, opened from the navbar's ✨ button (or the
// "assistant-open" window event) on any page. Two things it does:
//   ☀️ Today's briefing: what to do today, most urgent first
//   a free question about the ledger, in English or Persian
// Answers come with action cards that open the application they are about.
// The conversation lives as long as the tab does, so moving between pages
// doesn't lose it, and follow-up questions see the earlier turns.

const SUGGESTIONS = [
  "Which follow-ups are due, oldest first?",
  "کدام شرکت‌ها هنوز جواب نداده‌اند؟",
  "Which sources get me the most replies?",
  "Which gaps keep showing up in my rejections?",
  "این هفته چند درخواست فرستادم و با چه میانگین تطابقی؟",
];

const PRIORITY_CLASS = { high: "chip-danger", medium: "chip-warning", low: "chip-neutral" };

export default function AssistantPanel() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState([]); // { question, mode, answer?, actions?, usd?, error? }
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  const bodyRef = useRef(null);

  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener("assistant-open", show);
    return () => window.removeEventListener("assistant-open", show);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    inputRef.current?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Keep the newest turn in view.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [turns, busy]);

  async function send(mode, question) {
    if (busy) return;
    const q = (question || "").trim();
    if (mode === "ask" && !q) return;
    const history = turns
      .filter((t) => t.answer)
      .map((t) => ({ question: t.question, answer: t.answer }));
    const label = mode === "brief" ? "☀️ Today's briefing" : q;
    setTurns((ts) => [...ts, { question: label, mode }]);
    setDraft("");
    setBusy(true);
    try {
      const r = await askAssistant({ mode, question: mode === "brief" ? "" : q, history });
      setTurns((ts) => ts.map((t, i) => (i === ts.length - 1 ? { ...t, ...r } : t)));
    } catch (e) {
      setTurns((ts) => ts.map((t, i) => (i === ts.length - 1 ? { ...t, error: e.message } : t)));
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  function openApplication(folder) {
    setOpen(false);
    navigate(`/applications/${encodeURIComponent(folder)}`);
  }

  return (
    <>
      <div className={`assistant-backdrop ${open ? "show" : ""}`} onClick={() => setOpen(false)} aria-hidden="true" />
      <aside
        className={`assistant-drawer ${open ? "show" : ""}`}
        aria-label="AI assistant"
        aria-hidden={!open}
        inert={open ? undefined : ""}
      >
        <header className="assistant-head">
          <div>
            <div className="fw-semibold">✨ AI assistant</div>
            <div className="small text-muted">Reads your ledger, never changes it</div>
          </div>
          <div className="d-flex gap-1">
            {turns.length > 0 && (
              <button type="button" className="btn btn-sm btn-link text-muted" disabled={busy} onClick={() => setTurns([])}>
                Clear
              </button>
            )}
            <button type="button" className="btn-close" aria-label="Close" onClick={() => setOpen(false)} />
          </div>
        </header>

        <div className="assistant-body" ref={bodyRef}>
          {turns.length === 0 && (
            <div className="assistant-empty">
              <button type="button" className="btn btn-primary w-100 mb-3" disabled={busy} onClick={() => send("brief")}>
                ☀️ What should I do today?
              </button>
              <div className="small text-muted mb-2">Or ask about your applications:</div>
              <div className="d-flex flex-column gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    dir="auto"
                    className="assistant-suggestion"
                    disabled={busy}
                    onClick={() => send("ask", s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {turns.map((t, i) => (
            <div key={i} className="assistant-turn">
              <div className="assistant-q" dir="auto">{t.question}</div>
              {t.error && <div className="alert alert-danger py-2 small mb-0">{t.error}</div>}
              {t.answer !== undefined && (
                <div className="assistant-a">
                  <div className="assistant-a-text" dir="auto">{t.answer}</div>
                  {t.actions?.length > 0 && (
                    <div className="d-flex flex-column gap-2 mt-2">
                      {t.actions.map((a, j) => (
                        <div key={j} className="assistant-action" dir="auto">
                          <div className="d-flex align-items-start gap-2">
                            <span className={`chip ${PRIORITY_CLASS[a.priority] || "chip-neutral"}`}>{a.priority}</span>
                            <div className="flex-grow-1">
                              <div className="fw-semibold small">{a.title}</div>
                              <div className="small text-muted">{a.why}</div>
                            </div>
                            {a.folder && (
                              <button
                                type="button"
                                className="icon-btn"
                                title="Open this application"
                                aria-label="Open this application"
                                onClick={() => openApplication(a.folder)}
                              >
                                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M6 4l4 4-4 4" />
                                </svg>
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {t.usd != null && <div className="assistant-cost">{usd(t.usd)}</div>}
                </div>
              )}
            </div>
          ))}
          {busy && (
            <div className="assistant-thinking small text-muted">
              <span className="spinner-border spinner-border-sm me-2" aria-hidden="true" />
              Reading your ledger…
            </div>
          )}
        </div>

        <form
          className="assistant-input"
          onSubmit={(e) => {
            e.preventDefault();
            send("ask", draft);
          }}
        >
          {turns.length > 0 && (
            <button type="button" className="btn btn-sm btn-outline-secondary rounded-pill mb-2" disabled={busy} onClick={() => send("brief")}>
              ☀️ Today's briefing
            </button>
          )}
          <div className="d-flex gap-2 align-items-end">
            <textarea
              ref={inputRef}
              className="form-control"
              rows={2}
              dir="auto"
              placeholder="Ask about your applications… (Enter to send)"
              value={draft}
              maxLength={2000}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send("ask", draft);
                }
              }}
            />
            <button type="submit" className="btn btn-primary" disabled={busy || !draft.trim()}>
              Ask
            </button>
          </div>
        </form>
      </aside>
    </>
  );
}
