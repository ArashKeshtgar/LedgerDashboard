// The dashboard's AI assistant: a daily briefing ("what should I do today?")
// and free questions about the ledger ("which companies never replied?"),
// in English or Persian. Claude only sees a compact, read-only snapshot of
// the ledger — no contact emails, no files — and answers in a fixed JSON
// shape, so every suggested action can link to the application it is about
// and a folder it made up is dropped before the answer leaves the server.

export const ASSISTANT_MODEL = "claude-sonnet-5-5";
export const ASSISTANT_USAGE_FOLDER = "_assistant"; // under applications/, never a real application (ids start alphanumeric)
const NOTES_MAX = 200;
const QUESTION_MAX = 2000;
const HISTORY_MAX = 6; // earlier turns kept for a follow-up question

const ANSWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["answer", "actions"],
  properties: {
    answer: {
      type: "string",
      description: "The reply itself: short paragraphs or '- ' bullet lines, plain text, no markdown headings.",
    },
    actions: {
      type: "array",
      description: "Concrete next steps, most urgent first. Empty when the question needs none.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "why", "folder", "priority"],
        properties: {
          title: { type: "string", description: "Imperative, under 80 characters." },
          why: { type: "string", description: "One sentence, citing the numbers from the snapshot." },
          folder: {
            type: ["string", "null"],
            description: "The application's folder exactly as in the snapshot, or null when the step is not about one application.",
          },
          priority: { type: "string", enum: ["high", "medium", "low"] },
        },
      },
    },
  },
};

const SYSTEM_PROMPT =
  "You are the assistant inside a job-search tracker. The user is the candidate. Below the " +
  "instructions you get a JSON snapshot of their application ledger, with the pipeline state " +
  "already computed per row (stage, days in stage, days until a booked stage such as an " +
  "interview, whether a follow-up is due, match score, gap tags).\n\n" +
  "Rules:\n" +
  "- Answer only from the snapshot. When it doesn't hold what a question needs, say so plainly " +
  "instead of guessing.\n" +
  "- Count and compute carefully; quote the numbers you used.\n" +
  "- Reply in the language the user wrote in (Persian or English). Keep company names, roles " +
  "and folder ids as written.\n" +
  "- Only use folder values that appear in the snapshot.\n" +
  "- Be brief and practical: the user reads this between applications.\n\n" +
  "For a daily briefing: lead with what is time-sensitive (interviews in the next few days, " +
  "follow-ups that are due, drafts waiting for approval), then patterns worth acting on (sources " +
  "or match ranges that do or don't get replies, gaps that keep appearing in rejections), and " +
  "keep it to at most 6 actions.";

// One line of the snapshot per application — the fields a question about
// progress or priorities could need, nothing that identifies a contact.
export function ledgerSnapshot(rows, now = new Date()) {
  const apps = rows.map((r) => {
    return {
      folder: r.folder,
      date: r.date,
      company: r.company,
      role: r.role,
      location: r.location || undefined,
      source: r.source || undefined,
      track: r.track,
      match: r.match_score === "" || r.match_score == null ? undefined : Number(r.match_score),
      stage: r.stage,
      days_in_stage: r.daysInStage ?? undefined,
      days_until_stage: r.daysUntilStage ?? undefined,
      days_since_action: r.daysSinceAction ?? undefined,
      followup_due: r.needsFollowup || undefined,
      followups: r.followupCount || undefined,
      next_action: r.next_action || undefined,
      outcome: r.outcome || undefined,
      gaps: r.gap_tags || undefined,
      notes: r.notes ? String(r.notes).slice(0, NOTES_MAX) : undefined,
    };
  });
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return { today: local.toISOString().slice(0, 10), applications: apps };
}

export function validateAssistantRequest(body) {
  const mode = body?.mode === "brief" ? "brief" : body?.mode === "ask" ? "ask" : null;
  if (!mode) return { error: 'mode must be "brief" or "ask"' };
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (mode === "ask" && !question) return { error: "question is required" };
  if (question.length > QUESTION_MAX) return { error: `question is longer than ${QUESTION_MAX} characters` };
  const history = (Array.isArray(body.history) ? body.history : [])
    .filter((t) => t && typeof t.question === "string" && typeof t.answer === "string")
    .slice(-HISTORY_MAX)
    .map((t) => ({ question: t.question.slice(0, QUESTION_MAX), answer: t.answer.slice(0, 4000) }));
  return { mode, question, history };
}

// Calls Claude and returns { answer, actions, message } — `message` for
// usage accounting. Throws when the reply can't be used.
export async function askAssistant(client, snapshot, { mode, question, history }) {
  const messages = [];
  for (const turn of history) {
    messages.push({ role: "user", content: turn.question });
    messages.push({ role: "assistant", content: turn.answer });
  }
  messages.push({
    role: "user",
    content:
      mode === "brief"
        ? "Give me today's briefing: what should I do today, and why?" + (question ? `\n\n${question}` : "")
        : question,
  });

  const message = await client.beta.messages.create({
    model: ASSISTANT_MODEL,
    max_tokens: 16000,
    // On a safety decline, the API retries on a fallback model it picks.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: { type: "json_schema", schema: ANSWER_SCHEMA } },
    system: [
      { type: "text", text: SYSTEM_PROMPT },
      // The snapshot changes only when the ledger does, so follow-up
      // questions read it from the cache.
      { type: "text", text: "LEDGER SNAPSHOT:\n" + JSON.stringify(snapshot), cache_control: { type: "ephemeral" } },
    ],
    messages,
  });

  if (message.stop_reason === "refusal") {
    const err = new Error("The assistant declined to answer this one. Try rephrasing the question.");
    err.status = 422;
    err.usageMessage = message;
    throw err;
  }
  if (message.stop_reason === "max_tokens") {
    const err = new Error("The answer was cut off. Try a narrower question.");
    err.status = 502;
    err.usageMessage = message;
    throw err;
  }
  const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const err = new Error("The assistant's reply couldn't be read. Please try again.");
    err.status = 502;
    err.usageMessage = message;
    throw err;
  }
  const known = new Set(snapshot.applications.map((a) => a.folder));
  const actions = (Array.isArray(parsed.actions) ? parsed.actions : []).map((a) => ({
    title: String(a.title || ""),
    why: String(a.why || ""),
    priority: ["high", "medium", "low"].includes(a.priority) ? a.priority : "medium",
    folder: a.folder && known.has(a.folder) ? a.folder : null,
  }));
  return { answer: String(parsed.answer || ""), actions, message };
}
