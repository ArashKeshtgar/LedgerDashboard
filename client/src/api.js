// In a production build the app is served by the API server itself, so use a
// relative base. In `vite dev` the app runs on another port, so point at 4310.
const API_BASE = import.meta.env.DEV ? "http://localhost:4310" : "";

export async function fetchApplications() {
  const res = await fetch(`${API_BASE}/api/applications`);
  if (!res.ok) throw new Error(`Failed to load applications (${res.status})`);
  return res.json();
}

export async function fetchApplication(id) {
  const res = await fetch(`${API_BASE}/api/applications/${id}`);
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

export async function fetchMotivation() {
  const res = await fetch(`${API_BASE}/api/motivation`);
  if (!res.ok) throw new Error(`Failed to load motivation (${res.status})`);
  return res.json();
}

export async function fetchRecruiters() {
  const res = await fetch(`${API_BASE}/api/recruiters`);
  if (!res.ok) throw new Error(`Failed to load recruiters (${res.status})`);
  return res.json();
}

export async function updateRecruiterStatus(id, field, value) {
  const res = await fetch(`${API_BASE}/api/recruiters/${id}`, {
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
  const res = await fetch(`${API_BASE}/api/applications/${id}`, {
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
