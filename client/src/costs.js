// Shared formatting for the Claude-cost views.
export const usd = (n) => `$${(n || 0).toFixed(n >= 1 ? 2 : 3)}`;

export const KIND_LABELS = {
  analyze: "🤖 Analyze",
  reanalyze: "🔄 Re-analyze",
  build: "✅ Build",
  "build-repair": "🛠 Build repair turn",
};
