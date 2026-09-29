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

export async function analyzePosting({ company, role, postingText, location, source, posting_url }) {
  const res = await fetch(`${API_BASE}/api/packages/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ company, role, postingText, location, source, posting_url }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Analysis failed (${res.status})`);
  return body;
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
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `Build failed (${res.status})`);
    err.details = body.details;
    throw err;
  }
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
