// In a production build the app is served by the API server itself, so use a
// relative base. In `vite dev` the app runs on another port, so point at 4310.
const API_BASE = import.meta.env.DEV ? "http://localhost:4310" : "";

export async function checkSession() {
  const res = await fetch(`${API_BASE}/api/session`);
  if (!res.ok) throw new Error(`Failed to check session (${res.status})`);
  return res.json();
}

export async function login(password) {
  const res = await fetch(`${API_BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) {
    // 401 wrong password, 429 locked out after too many tries — show the
    // server's own message so the lockout wait is visible.
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Wrong password");
  }
  return res.json();
}

export async function logout() {
  const res = await fetch(`${API_BASE}/api/logout`, { method: "POST" });
  if (!res.ok) throw new Error(`Failed to log out (${res.status})`);
  return res.json();
}

export async function fetchApplications() {
  const res = await fetch(`${API_BASE}/api/applications`);
  if (!res.ok) throw new Error(`Failed to load applications (${res.status})`);
  return res.json();
}

export async function fetchApplication(id) {
  const res = await fetch(`${API_BASE}/api/applications/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`Failed to load application ${id} (${res.status})`);
  return res.json();
}

export async function fetchGapTags() {
  const res = await fetch(`${API_BASE}/api/gap-tags`);
  if (!res.ok) throw new Error(`Failed to load gap tags (${res.status})`);
  return res.json();
}

export async function fetchPipelineStages() {
  const res = await fetch(`${API_BASE}/api/pipeline-stages`);
  if (!res.ok) throw new Error(`Failed to load pipeline stages (${res.status})`);
  return res.json();
}

export async function fetchMotivation(shift = 0) {
  const res = await fetch(`${API_BASE}/api/motivation${shift ? `?shift=${shift}` : ""}`);
  if (!res.ok) throw new Error(`Failed to load motivation (${res.status})`);
  return res.json();
}

export async function fetchRecruiters() {
  const res = await fetch(`${API_BASE}/api/recruiters`);
  if (!res.ok) throw new Error(`Failed to load recruiters (${res.status})`);
  return res.json();
}

export async function updateRecruiterStatus(id, field, value) {
  const res = await fetch(`${API_BASE}/api/recruiters/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ field, value }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to update recruiter (${res.status})`);
  }
  return res.json();
}

export async function moveApplicationStage(folder, stage, note = "", date = "") {
  const res = await fetch(`${API_BASE}/api/pipeline-events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folder, stage, note, date: date || undefined }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to move application (${res.status})`);
  }
  return res.json();
}

export async function createApplication(fields) {
  const res = await fetch(`${API_BASE}/api/applications`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to create application (${res.status})`);
  }
  return res.json();
}

export async function updateApplication(id, fields) {
  const res = await fetch(`${API_BASE}/api/applications/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to update application (${res.status})`);
  }
  return res.json();
}

// The server only runs a Claude call (it spends API credit) when the
// request says it came from a click here, not from a script.
const AI_HEADERS = { "Content-Type": "application/json", "X-AI-Request": "app" };

export async function analyzePosting({ company, role, postingText, location, source, posting_url }) {
  const res = await fetch(`${API_BASE}/api/packages/analyze`, {
    method: "POST",
    headers: AI_HEADERS,
    body: JSON.stringify({ company, role, postingText, location, source, posting_url }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Analysis failed (${res.status})`);
  return body;
}

// One file of an application folder, served as a download.
export function fileUrl(folder, name) {
  return `${API_BASE}/api/applications/${encodeURIComponent(folder)}/files/${encodeURIComponent(name)}`;
}

export async function deleteApplication(id) {
  const res = await fetch(`${API_BASE}/api/applications/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to delete application (${res.status})`);
  }
  return res.json();
}

export async function buildPackage(fields) {
  const res = await fetch(`${API_BASE}/api/packages/build`, {
    method: "POST",
    headers: AI_HEADERS,
    body: JSON.stringify(fields),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `Build failed (${res.status})`);
    err.details = body.details;
    throw err;
  }
  // Built even though the guardian still objected after its repair turn —
  // the text needs a human look before it is sent anywhere.
  if (body.guardian_warnings?.length) {
    window.alert(
      "Built WITH guardian warnings — check the résumé before sending:\n\n" +
        body.guardian_warnings.join("\n")
    );
  }
  return body;
}

// Re-score a draft's saved posting against today's fact bank — its gap
// tags were a snapshot from when it was first analyzed.
export async function reanalyzePackage(folder) {
  const res = await fetch(`${API_BASE}/api/packages/reanalyze`, {
    method: "POST",
    headers: AI_HEADERS,
    body: JSON.stringify({ folder }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Re-analyze failed (${res.status})`);
  return body;
}

export async function logFollowup(folder, note = "") {
  const res = await fetch(`${API_BASE}/api/pipeline-events/followup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folder, note }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to log follow-up (${res.status})`);
  }
  return res.json();
}

// Takes back a stage marked by mistake: the latest one, or with all=true
// everything after the initial draft.
export async function undoApplicationStage(folder, all = false) {
  const res = await fetch(`${API_BASE}/api/pipeline-events/undo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folder, all }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to undo (${res.status})`);
  }
  return res.json();
}

// --- Truth Bank / Gaps / Résumé / Health -----------------------------------

// Throws the server's message, with its validation details attached.
async function request(method, url, body) {
  const res = await fetch(`${API_BASE}${url}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `${method} ${url} failed (${res.status})`);
    err.details = data.details;
    throw err;
  }
  return data;
}

export const fetchTruthBank = () => request("GET", "/api/truth-bank");
export const createFact = (fact, note) => request("POST", "/api/truth-bank/facts", { fact, note });
export const updateFact = (id, fact, note) =>
  request("PUT", `/api/truth-bank/facts/${encodeURIComponent(id)}`, { fact, note });
export const deleteFact = (id) => request("DELETE", `/api/truth-bank/facts/${encodeURIComponent(id)}`);
export const fetchHistory = (q) =>
  request("GET", `/api/truth-bank/history${q ? `?q=${encodeURIComponent(q)}` : ""}`);
export const fetchCommit = (hash) => request("GET", `/api/truth-bank/history/${encodeURIComponent(hash)}`);
export const commitOutsideEdits = (message) => request("POST", "/api/truth-bank/commit", { message });

export const fetchGaps = () => request("GET", "/api/gaps");
export const createGap = (slug, label) => request("POST", "/api/gaps", { slug, label });
export const mergeGap = (slug, into) => request("POST", `/api/gaps/${encodeURIComponent(slug)}/merge`, { into });
export const updateGap = (slug, label, note) =>
  request("PUT", `/api/gaps/${encodeURIComponent(slug)}`, { label, note });

export const fetchResumeTemplates = () => request("GET", "/api/resume/templates");
export const fetchBuiltResume = (folder) =>
  request("GET", `/api/applications/${encodeURIComponent(folder)}/resume`);

export const fetchHealth = () => request("GET", "/api/health");
export const fetchEvalItems = () => request("GET", "/api/eval/items");
export const saveEvalLabel = (folder, label, note) =>
  request("PUT", `/api/eval/labels/${encodeURIComponent(folder)}`, { label, note });
export const fetchEvalReport = (threshold) => request("GET", `/api/eval/report?threshold=${threshold}`);
export const dismissHealthIssue = (key) => request("POST", "/api/health/dismiss", { key });
export const restoreHealthIssues = () => request("DELETE", "/api/health/dismiss");
export const fetchResumeBuilds = () => request("GET", "/api/resume/builds");

export const fetchUsage = (month) => request("GET", `/api/usage${month ? `?month=${month}` : ""}`);
export const fetchUsageCalls = (since) => request("GET", `/api/usage/calls${since ? `?since=${since}` : ""}`);
export const fetchSimilar = (folder) => request("GET", `/api/applications/${encodeURIComponent(folder)}/similar`);

export const fetchFunnel = () => request("GET", "/api/funnel");
export const fetchRejections = () => request("GET", "/api/rejections");
export const fetchRejectionCount = () => request("GET", "/api/rejections?summary=1");
export const reviewRejections = (keys, reviewed = true) =>
  request("POST", "/api/rejections/review", { keys, reviewed });
