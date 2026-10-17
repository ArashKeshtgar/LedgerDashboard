// Shared formatting for the Claude-cost views.
export const usd = (n) => `$${(n || 0).toFixed(n >= 1 ? 2 : 3)}`;

export const KIND_LABELS = {
  analyze: "🤖 Analyze",
  reanalyze: "🔄 Re-analyze",
  build: "✅ Build",
  "build-repair": "🛠 Build repair turn",
  assistant: "✨ Assistant",
};

// Where the assistant's calls are filed (server/src/assistant.js) — not an
// application, so it has no page to link to.
export const ASSISTANT_USAGE_FOLDER = "_assistant";
