import { useEffect, useState } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import {
  fetchApplication,
  fetchPipelineStages,
  moveApplicationStage,
  undoApplicationStage,
  logFollowup,
  updateApplication,
  buildPackage,
  reanalyzePackage,
  deleteApplication,
  fileUrl,
} from "../api.js";
import StageTimeline from "../components/StageTimeline.jsx";
import ContactCard from "../components/ContactCard.jsx";
import ContactEditor from "../components/ContactEditor.jsx";
import { daysUntilFollowup, followupMailto } from "../contact.js";
import { TrackBadge } from "../components/TrackBadge.jsx";
import { trackOf } from "../track.js";
import SaveToPcButton from "../components/SaveToPcButton.jsx";
import PackageCostCard from "../components/PackageCostCard.jsx";

// Pipeline event dates are usually a plain YYYY-MM-DD, but the "Record a
// stage update" form can attach a time too ("...T14:30") — show that as a
// space instead of a raw "T" wherever an event date is displayed.
function formatEventDate(value) {
  return value && value.includes("T") ? value.replace("T", " ") : value;
}

function Field({ label, value }) {
  if (!value) return null;
  return (
    <div className="col-sm-6 mb-3">
      <div className="detail-field-label">{label}</div>
      <div>{value}</div>
    </div>
  );
}

// A free-text tracking field (notes, next action, …) the user edits directly
// instead of going through ledger.csv by hand — click to edit in place.
function EditableField({
  label, value, editing, draft, onEdit, onChangeDraft, onSave, onCancel, saving, multiline, fullWidth,
}) {
  const wrapClass = fullWidth ? "mb-1" : "col-sm-6 mb-3";
  if (!editing) {
    return (
      <div className={wrapClass}>
        <div className="detail-field-label d-flex align-items-center justify-content-between">
          <span>{label}</span>
          <button type="button" className="btn btn-link btn-sm p-0" onClick={onEdit}>
            ✏️ Edit
          </button>
        </div>
        <div>{value || <span className="text-muted fst-italic">—</span>}</div>
      </div>
    );
  }
  return (
    <div className={wrapClass}>
      <div className="detail-field-label">{label}</div>
      {multiline ? (
        <textarea
          className="form-control form-control-sm"
          rows={2}
          value={draft}
          onChange={onChangeDraft}
          autoFocus
        />
      ) : (
        <input
          className="form-control form-control-sm"
          value={draft}
          onChange={onChangeDraft}
          autoFocus
        />
      )}
      <div className="mt-1 d-flex gap-2">
        <button type="button" className="btn btn-sm btn-success" disabled={saving} onClick={onSave}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" className="btn btn-sm btn-outline-secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// Manual "record a stage update" form — for updates drag-and-drop on the
// Pipeline board doesn't cover well: a real note, or a date other than today
// (an interview that already happened, or one booked for next week).
function StageUpdateForm({ options, onSubmit, pending }) {
  const [stage, setStage] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [note, setNote] = useState("");

  return (
    <form
      className="mt-3 pt-3 border-top d-flex flex-wrap gap-2 align-items-end"
      onSubmit={(e) => {
        e.preventDefault();
        if (!stage) return;
        // Time only means anything paired with a date — if no date was
        // picked (defaults to today server-side), drop a leftover time too.
        const when = date && time ? `${date}T${time}` : date;
        onSubmit(stage, note, when);
        setStage("");
        setDate("");
        setTime("");
        setNote("");
      }}
    >
      <div>
        <label className="form-label small mb-1">Record a stage update</label>
        <select
          className="form-select form-select-sm"
          value={stage}
          onChange={(e) => setStage(e.target.value)}
          aria-label="Stage"
        >
          <option value="">— pick a stage —</option>
          {options.map((s) => (
            <option key={s.key} value={s.key}>
              {s.icon} {s.label}
            </option>
          ))}
        </select>
      </div>
      <div style={{ width: 150 }}>
        <label className="form-label small mb-1">Date</label>
        <input
          type="date"
          className="form-control form-control-sm"
          value={date}
          onChange={(e) => {
            const v = e.target.value;
            setDate(v);
            if (!v) setTime("");
          }}
        />
      </div>
      <div style={{ width: 120 }}>
        <label className="form-label small mb-1">Time</label>
        <input
          type="time"
          className="form-control form-control-sm"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          disabled={!date}
          title={date ? "" : "Pick a date first"}
        />
      </div>
      <div style={{ flex: "1 1 200px" }}>
        <label className="form-label small mb-1">Note</label>
        <input
          className="form-control form-control-sm"
          placeholder="optional"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
      <button
        type="submit"
        className="btn btn-sm btn-outline-primary rounded-pill"
        disabled={pending || !stage}
      >
        {pending ? "Logging…" : "Log update"}
      </button>
    </form>
  );
}

export default function ApplicationDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [app, setApp] = useState(null);
  const [stages, setStages] = useState({ stages: [], terminal: [] });
  const [error, setError] = useState(null);
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  const [deciding, setDeciding] = useState(null); // null | "apply" | "apply_with_caveats" | "skip"
  const [decisionError, setDecisionError] = useState(null);
  const [decisionErrorDetails, setDecisionErrorDetails] = useState(null);
  const [justBuilt, setJustBuilt] = useState(false);
  // Marking as sent first asks for the hiring contact: that's the moment the
  // posting and the ATS confirmation email are right in front of you.
  const [askContact, setAskContact] = useState(false);
  const [contactSaving, setContactSaving] = useState(false);
  const [contactError, setContactError] = useState(null);
  const [mailOpened, setMailOpened] = useState(false);
  const [showRebuild, setShowRebuild] = useState(false);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [reanalyzeResult, setReanalyzeResult] = useState(null);
  const [reanalyzeError, setReanalyzeError] = useState(null);
  const [followupPending, setFollowupPending] = useState(false);
  const [followupError, setFollowupError] = useState(null);
  const [editingField, setEditingField] = useState(null);
  const [draftValue, setDraftValue] = useState("");
  const [savingField, setSavingField] = useState(false);
  const [editError, setEditError] = useState(null);
  const [stageUpdatePending, setStageUpdatePending] = useState(false);
  const [stageUpdateError, setStageUpdateError] = useState(null);
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [rejectNote, setRejectNote] = useState("");
  const [rejectPending, setRejectPending] = useState(false);
  const [rejectError, setRejectError] = useState(null);
  const [undoPending, setUndoPending] = useState(false);
  const [undoError, setUndoError] = useState(null);

  useEffect(() => {
    setApp(null);
    fetchApplication(id).then(setApp).catch((e) => setError(e.message));
  }, [id]);

  useEffect(() => {
    fetchPipelineStages().then(setStages).catch(() => {});
  }, []);

  if (error) return <div className="alert alert-danger">{error}</div>;
  if (!app) return <div className="text-center py-5 text-muted">Loading…</div>;

  function startApprove() {
    if (app.contact_email) handleApprove();
    else setAskContact(true);
  }

  async function saveContactAndApprove(fields) {
    setContactError(null);
    setContactSaving(true);
    try {
      if (fields.contact_email || fields.contact_name) {
        const updated = await updateApplication(app.id, fields);
        setApp((a) => ({ ...a, ...updated }));
      }
      await handleApprove();
    } catch (e) {
      setContactError(e.message);
    } finally {
      setContactSaving(false);
    }
  }

  async function saveContact(fields) {
    const updated = await updateApplication(app.id, fields);
    setApp((a) => ({ ...a, ...updated }));
  }

  async function handleEmailFollowupLogged() {
    await handleLogFollowup(`Emailed ${app.contact_email}`);
    setMailOpened(false);
  }

  async function handleApprove() {
    setApproveError(null);
    setApproving(true);
    try {
      const updated = await moveApplicationStage(app.folder, "applied");
      setApp((a) => ({ ...a, ...updated }));
      setAskContact(false);
    } catch (e) {
      setApproveError(e.message);
    } finally {
      setApproving(false);
    }
  }

  // Discard a draft outright — your own call, no need to go through a build
  // decision first. Same server action "Skip" uses below, exposed here as
  // its own explicit step so it's available before you've decided anything.
  async function handleDeleteDraft() {
    setDeleteError(null);
    setDeleting(true);
    try {
      await deleteApplication(app.id);
      navigate("/");
    } catch (e) {
      setDeleteError(e.message);
      setDeleting(false);
    }
  }

  // Mirrors NewPackage.jsx's analyze→decide gate, for a draft you're
  // revisiting later instead of deciding on immediately after analyzing.
  async function handleDecision(decision) {
    if (decision === "skip") {
      setDecisionError(null);
      setDeciding("skip");
      try {
        await deleteApplication(app.id);
        navigate("/");
      } catch (e) {
        setDecisionError(e.message);
        setDeciding(null);
      }
      return;
    }
    setDecisionError(null);
    setDecisionErrorDetails(null);
    setJustBuilt(false);
    setDeciding(decision);
    try {
      await buildPackage({
        folder: app.folder,
        company: app.company,
        role: app.role,
        postingText: app.postingText,
        base_variant: app.variant,
        match_score: app.match_score,
        // The field the server reads. This used to be sent as `gaps`, so the
        // server saw no gap_tags and wiped the ones /analyze had saved.
        gap_tags: (app.gap_tags || "").split(",").filter(Boolean),
        caveats: decision === "apply_with_caveats",
      });
      // Building fills in the SAME draft row/folder, it never creates a new
      // one — navigating to `/applications/${id}` here would be a no-op (same
      // path this page is already on), which used to leave the UI stuck on
      // "Building…" forever even though the package was written to disk.
      // Re-fetch in place instead so the new files/fields actually show up.
      const refreshed = await fetchApplication(id);
      setApp(refreshed);
      setJustBuilt(true);
      setShowRebuild(false);
    } catch (e) {
      setDecisionError(e.message);
      setDecisionErrorDetails(e.details || null);
    } finally {
      setDeciding(null);
    }
  }

  // Gap tags are saved once, when the posting is first analyzed — evidence
  // added to the fact bank later doesn't reach them until this re-scores it.
  async function handleReanalyze() {
    setReanalyzeError(null);
    setReanalyzeResult(null);
    setReanalyzing(true);
    try {
      const result = await reanalyzePackage(app.folder);
      setApp((a) => ({ ...a, ...result.application, analysis: { ...a.analysis, source: "engine" } }));
      setReanalyzeResult(result);
    } catch (e) {
      setReanalyzeError(e.message);
    } finally {
      setReanalyzing(false);
    }
  }

  async function handleLogFollowup(note = "") {
    setFollowupError(null);
    setFollowupPending(true);
    try {
      const updated = await logFollowup(app.folder, note);
      setApp((a) => ({ ...a, ...updated }));
    } catch (e) {
      setFollowupError(e.message);
    } finally {
      setFollowupPending(false);
    }
  }

  function startEdit(field) {
    setEditingField(field);
    setDraftValue(app[field] || "");
    setEditError(null);
  }

  function cancelEdit() {
    setEditingField(null);
  }

  async function saveEdit() {
    setSavingField(true);
    setEditError(null);
    try {
      const updated = await updateApplication(app.id, { [editingField]: draftValue });
      setApp((a) => ({ ...a, ...updated }));
      setEditingField(null);
    } catch (e) {
      setEditError(e.message);
    } finally {
      setSavingField(false);
    }
  }

  async function handleReject() {
    setRejectError(null);
    setRejectPending(true);
    try {
      const updated = await moveApplicationStage(app.folder, "rejected", rejectNote);
      setApp((a) => ({ ...a, ...updated }));
      setShowRejectForm(false);
      setRejectNote("");
    } catch (e) {
      setRejectError(e.message);
    } finally {
      setRejectPending(false);
    }
  }

  async function handleUndo(all) {
    const question = all
      ? "Reset this application back to draft? Every stage after the draft is removed."
      : "Undo the last stage? It is removed from the history.";
    if (!window.confirm(question)) return;
    setUndoError(null);
    setUndoPending(true);
    try {
      const { removed, ...updated } = await undoApplicationStage(app.folder, all);
      setApp((a) => ({ ...a, ...updated }));
    } catch (e) {
      setUndoError(e.message);
    } finally {
      setUndoPending(false);
    }
  }

  async function handleStageUpdate(stage, note, date) {
    setStageUpdateError(null);
    setStageUpdatePending(true);
    try {
      const updated = await moveApplicationStage(app.folder, stage, note, date);
      setApp((a) => ({ ...a, ...updated }));
    } catch (e) {
      setStageUpdateError(e.message);
    } finally {
      setStageUpdatePending(false);
    }
  }

  // A built package leaves résumé files in the folder. Building doesn't
  // move the stage (a draft only counts once you've actually sent it), so
  // without this the page kept offering "Apply — build" again after a
  // successful build, with no way to mark it sent here.
  const packageBuilt = (app.files || []).some((f) => /Resume\.(docx|pdf)$/i.test(f));
  // Saved by the nightly search without a Claude call: there's no variant to
  // build with until it's analyzed, which only happens when you click.
  const unscored = !app.variant;
  // Scored by the nightly search in its own session, not by the engine.
  const estimated = !unscored && app.analysis?.source === "nightly-estimate";
  const offerBuild = !unscored && (!packageBuilt || showRebuild);

  const waitingKeys = new Set((stages.stages || []).filter((s) => s.waiting).map((s) => s.key));
  const canFollowup = waitingKeys.has(app.stage);
  const stageLabels = new Map(
    [...(stages.stages || []), ...(stages.terminal || []), ...(stages.actions || [])].map((s) => [
      s.key,
      s,
    ])
  );

  return (
    <div>
      <Link to="/" className="btn btn-sm btn-outline-secondary rounded-pill mb-3">
        ← Back to list
      </Link>

      {approveError && (
        <div className="alert alert-danger py-2 px-3 mb-3" role="alert">
          {approveError}
        </div>
      )}

      {app.stage === "draft" && app.postingText && (
        <div className="alert alert-warning mb-3">
          <div className="d-flex flex-wrap justify-content-between align-items-center gap-2">
            <span>
              {unscored
                ? "🕒 Saved without a score — no API credit has been spent on it yet. Analyze it if it looks worth it; building comes after that, also only when you click."
                : estimated && !packageBuilt
                ? `🌙 ${app.match_score}% is the nightly search's estimate (no API credit spent). You can build from it, or click Analyze first for the engine's exact score.`
                : packageBuilt
                ? "📦 The package is built but not sent yet — review the files below, send the application, then mark it as sent. Until then it won't show up on the Pipeline or count in Stats."
                : "📝 This package hasn't been sent yet — it won't show up on the Pipeline or count in Stats until you decide. Nothing gets built until you say so."}
            </span>
            <div className="d-flex flex-wrap gap-2">
              <button
                type="button"
                className={`btn btn-sm rounded-pill ${unscored ? "btn-primary" : "btn-outline-primary"}`}
                disabled={reanalyzing || deleting || !!deciding}
                title="Score this posting against today's fact bank (one Claude call — uses API credit)"
                onClick={handleReanalyze}
              >
                {reanalyzing
                  ? "Analyzing…"
                  : unscored
                  ? "🤖 Analyze — score it (uses API credit)"
                  : estimated
                  ? "🤖 Analyze — exact score (uses API credit)"
                  : "🔄 Re-analyze gaps"}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-outline-danger rounded-pill"
                disabled={deleting || !!deciding}
                onClick={() => setShowDeleteConfirm((v) => !v)}
              >
                🗑️ Delete draft
              </button>
            </div>
          </div>

          {reanalyzeError && (
            <div className="alert alert-danger py-2 px-3 mt-2 mb-0" role="alert">
              {reanalyzeError}
            </div>
          )}
          {reanalyzeResult && (
            <div className="alert alert-info py-2 px-3 mt-2 mb-0" role="status">
              <div>
                🔄 Re-analyzed — match {reanalyzeResult.previous.match_score || "—"} →{" "}
                {reanalyzeResult.match_score}; gap tags{" "}
                <code>{reanalyzeResult.previous.gap_tags || "none"}</code> →{" "}
                <code>{reanalyzeResult.gap_tags.join(",") || "none"}</code>
              </div>
              {reanalyzeResult.gaps.length > 0 && (
                <ul className="mb-0 mt-1 small">
                  {reanalyzeResult.gaps.map((g, i) => (
                    <li key={i}>{g}</li>
                  ))}
                </ul>
              )}
              {packageBuilt && (
                <div className="small mt-1">
                  The built résumé and cover letter still reflect the old analysis — rebuild to
                  refresh them.
                </div>
              )}
            </div>
          )}

          {showDeleteConfirm && (
            <div className="d-flex flex-wrap gap-2 align-items-center mt-2 pt-2 border-top">
              <span className="text-muted small">
                Delete this draft and its folder right now, no build, no questions asked?
              </span>
              <button
                type="button"
                className="btn btn-sm btn-danger rounded-pill"
                disabled={deleting}
                onClick={handleDeleteDraft}
              >
                {deleting ? "Deleting…" : "Confirm delete"}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-outline-secondary rounded-pill"
                disabled={deleting}
                onClick={() => setShowDeleteConfirm(false)}
              >
                Cancel
              </button>
            </div>
          )}
          {deleteError && (
            <div className="alert alert-danger py-2 px-3 mt-2 mb-0" role="alert">
              {deleteError}
            </div>
          )}

          {decisionError && (
            <div className="alert alert-danger py-2 px-3 mt-2 mb-0" role="alert">
              {decisionError}
              {decisionErrorDetails && (
                <ul className="mb-0 mt-2 small">
                  {decisionErrorDetails.map((d, i) => (
                    <li key={i}>{d}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {justBuilt && (
            <div className="alert alert-success py-2 px-3 mt-2 mb-0" role="status">
              ✅ Package built — résumé, cover letter, match report and interview questions are
              ready below.
            </div>
          )}

          {!unscored && !offerBuild && (
            <div className="d-flex flex-wrap gap-2 mt-3 pt-3 border-top">
              <button
                type="button"
                className="btn btn-sm btn-success rounded-pill"
                disabled={approving || deleting || askContact}
                onClick={startApprove}
              >
                {approving ? "Approving…" : "📤 Approve & Apply — mark as sent"}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-outline-secondary rounded-pill"
                disabled={approving || deleting}
                onClick={() => {
                  setShowRebuild(true);
                  setJustBuilt(false);
                }}
              >
                🔁 Rebuild the package
              </button>
            </div>
          )}

          {offerBuild && (
          <div className="d-flex flex-wrap gap-2 mt-3 pt-3 border-top">
            <button
              type="button"
              className="btn btn-sm btn-success rounded-pill"
              disabled={!!deciding || deleting}
              onClick={() => handleDecision("apply")}
            >
              {deciding === "apply" ? "Building…" : "✅ Apply — build the full package"}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-warning rounded-pill"
              disabled={!!deciding || deleting}
              onClick={() => handleDecision("apply_with_caveats")}
            >
              {deciding === "apply_with_caveats" ? "Building…" : "⚠️ Apply with caveats"}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary rounded-pill"
              disabled={!!deciding || deleting}
              onClick={() => handleDecision("skip")}
            >
              {deciding === "skip" ? "Removing…" : "⛔ Skip"}
            </button>
            {showRebuild && (
              <button
                type="button"
                className="btn btn-sm btn-link"
                disabled={!!deciding}
                onClick={() => setShowRebuild(false)}
              >
                Cancel rebuild
              </button>
            )}
          </div>
          )}
          {(deciding === "apply" || deciding === "apply_with_caveats") && (
            <div className="text-muted small mt-2">
              Writing the résumé, cover letter, match report and interview questions — this can
              take a minute…
            </div>
          )}
        </div>
      )}

      {app.stage === "draft" && !app.postingText && (
        <div className="alert alert-warning d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
          <span>📝 This package hasn't been sent yet — it won't show up on the Pipeline or count in Stats until approved.</span>
          <button
            type="button"
            className="btn btn-sm btn-success rounded-pill"
            disabled={approving || askContact}
            onClick={startApprove}
          >
            {approving ? "Approving…" : "✅ Approve & Apply"}
          </button>
        </div>
      )}

      {app.stage === "draft" && askContact && (
        <div className="alert alert-info mb-3">
          <div className="fw-semibold mb-1">✉️ Who did you apply to?</div>
          <div className="small text-muted mb-2">
            Grab the recruiter or hiring manager's email now, while you have the posting and the ATS
            confirmation open. It's what the follow-up email goes to. Only published or verified addresses are saved.
          </div>
          <ContactEditor
            initial={app}
            onSave={saveContactAndApprove}
            onCancel={() => { setAskContact(false); setContactError(null); }}
            saveLabel="Save contact & mark as sent"
            saving={contactSaving || approving}
            extraActions={
              <button type="button" className="btn btn-sm btn-outline-primary rounded-pill"
                disabled={contactSaving || approving} onClick={() => saveContactAndApprove({})}>
                Mark as sent without a contact
              </button>
            }
          />
          {contactError && (
            <div className="alert alert-danger py-2 px-3 mt-2 mb-0" role="alert">{contactError}</div>
          )}
        </div>
      )}

      {!app.isTerminal && app.stage !== "draft" && (
        <div className="alert alert-light border mb-3">
          <div className="d-flex flex-wrap justify-content-between align-items-center gap-2">
            <span className="text-muted small">
              Heard back from the employer? You can mark this rejected from wherever it
              currently is in the pipeline — no need to go through the Pipeline board.
            </span>
            {!showRejectForm && (
              <button
                type="button"
                className="btn btn-sm btn-outline-danger rounded-pill"
                onClick={() => setShowRejectForm(true)}
              >
                ❌ Mark as Rejected
              </button>
            )}
          </div>
          {showRejectForm && (
            <div className="d-flex flex-wrap gap-2 align-items-end mt-2 pt-2 border-top">
              <div style={{ flex: "1 1 240px" }}>
                <label className="form-label small mb-1">Note (optional)</label>
                <input
                  className="form-control form-control-sm"
                  placeholder="e.g. generic rejection email, no reason given"
                  value={rejectNote}
                  onChange={(e) => setRejectNote(e.target.value)}
                  autoFocus
                />
              </div>
              <button
                type="button"
                className="btn btn-sm btn-danger rounded-pill"
                disabled={rejectPending}
                onClick={handleReject}
              >
                {rejectPending ? "Marking…" : "Confirm rejection"}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-outline-secondary rounded-pill"
                disabled={rejectPending}
                onClick={() => {
                  setShowRejectForm(false);
                  setRejectNote("");
                }}
              >
                Cancel
              </button>
            </div>
          )}
          {rejectError && (
            <div className="alert alert-danger py-2 px-3 mt-2 mb-0" role="alert">
              {rejectError}
            </div>
          )}
        </div>
      )}

      <div className="card mb-4">
        <div className="card-body">
          <div className="d-flex justify-content-between align-items-start flex-wrap gap-2">
            <div>
              <h4 className="mb-0 page-title">
                {app.company} <TrackBadge track={trackOf(app)} always />
              </h4>
              <div className="text-muted">{app.role}</div>
            </div>
            <span className="badge bg-dark fs-6">{app.match_score}% match</span>
          </div>

          <hr />

          <div className="row">
            <Field label="Location" value={app.location} />
            <Field label="Branch" value={app.branch} />
            <Field label="Source" value={app.source} />
            <Field label="Poster type" value={app.poster_type} />
            <Field label="End client" value={app.end_client} />
            <Field label="Applied via" value={app.applied_via} />
            <Field label="Date seen" value={app.date_seen} />
            <Field label="Date posted" value={app.date_posted} />
            <Field label="Variant" value={app.variant} />
            <Field label="Gap tags" value={app.gap_tags} />
            {["last_contact", "next_action", "outcome"].map((field) => (
              <EditableField
                key={field}
                label={{ last_contact: "Last contact", next_action: "Next action", outcome: "Outcome" }[field]}
                value={app[field]}
                editing={editingField === field}
                draft={draftValue}
                onEdit={() => startEdit(field)}
                onChangeDraft={(e) => setDraftValue(e.target.value)}
                onSave={saveEdit}
                onCancel={cancelEdit}
                saving={savingField}
              />
            ))}
          </div>

          {app.posting_url && (
            <div className="mt-1">
              <a href={app.posting_url} target="_blank" rel="noreferrer">
                View original posting ↗
              </a>
            </div>
          )}

          {editError && (
            <div className="alert alert-danger py-2 px-3 mt-3 mb-0" role="alert">
              {editError}
            </div>
          )}

          <div className="mt-3 pt-3 border-top">
            <EditableField
              label="Notes"
              value={app.notes}
              editing={editingField === "notes"}
              draft={draftValue}
              onEdit={() => startEdit("notes")}
              onChangeDraft={(e) => setDraftValue(e.target.value)}
              onSave={saveEdit}
              onCancel={cancelEdit}
              saving={savingField}
              multiline
              fullWidth
            />
          </div>
        </div>
      </div>

      <ContactCard app={app} onSave={saveContact} />

      {stages.stages && stages.stages.length > 0 && (
        <div className="card mb-4">
          <div className="card-header">Pipeline stage</div>
          <div className="card-body">
            <StageTimeline
              stages={stages.stages}
              terminal={stages.terminal}
              current={app.stage}
              history={app.stageHistory}
            />
            {app.stageHistory && app.stageHistory.length > 0 && (
              <ul className="list-unstyled mt-3 mb-0 small text-muted">
                {app.stageHistory.map((h, i) => {
                  const meta = stageLabels.get(h.stage);
                  return (
                    <li key={i}>
                      <span className="fw-semibold">{formatEventDate(h.date)}</span> —{" "}
                      {meta ? `${meta.icon} ${meta.label}` : h.stage}
                      {h.note ? ` · ${h.note}` : ""}
                    </li>
                  );
                })}
              </ul>
            )}
            {app.stageHistory && app.stageHistory.length > 1 && (
              <div className="d-flex flex-wrap align-items-center gap-2 mt-2">
                <button type="button" className="btn btn-sm btn-outline-secondary rounded-pill"
                  disabled={undoPending} onClick={() => handleUndo(false)}>
                  ↩️ Undo last stage
                </button>
                {app.stageHistory.length > 2 && (
                  <button type="button" className="btn btn-sm btn-outline-secondary rounded-pill"
                    disabled={undoPending} onClick={() => handleUndo(true)}>
                    ⏮️ Reset to draft
                  </button>
                )}
                {undoError && <span className="small text-danger">{undoError}</span>}
              </div>
            )}

            {canFollowup && (
              <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mt-3 pt-3 border-top">
                <div className="small text-muted">
                  {app.followupCount > 0
                    ? `🔁 ${app.followupCount} follow-up${app.followupCount === 1 ? "" : "s"} sent${
                        app.lastFollowupDate ? ` · last on ${app.lastFollowupDate}` : ""
                      }`
                    : "No follow-up logged yet in this stage."}
                </div>
                <div className="d-flex flex-wrap gap-2">
                  {app.contact_email && app.needsFollowup && (
                    <a
                      className="btn btn-sm btn-warning rounded-pill"
                      href={followupMailto(app)}
                      onClick={() => setMailOpened(true)}
                    >
                      ✉️ Email follow-up
                    </a>
                  )}
                  <button
                    type="button"
                    className={`btn btn-sm rounded-pill ${
                      app.needsFollowup && !app.contact_email ? "btn-warning" : "btn-outline-secondary"
                    }`}
                    disabled={followupPending}
                    onClick={() => handleLogFollowup()}
                  >
                    {followupPending ? "Logging…" : "🔁 Log follow-up"}
                  </button>
                </div>
              </div>
            )}
            {canFollowup && mailOpened && (
              <div className="alert alert-warning py-2 px-3 mt-2 mb-0 d-flex flex-wrap align-items-center justify-content-between gap-2">
                <span className="small">Your mail app opened with the draft. Sent it?</span>
                <button type="button" className="btn btn-sm btn-success rounded-pill" disabled={followupPending}
                  onClick={handleEmailFollowupLogged}>
                  ✅ Yes, log it
                </button>
              </div>
            )}
            {canFollowup && !app.needsFollowup && app.contact_email && daysUntilFollowup(app) > 0 && (
              <div className="small text-muted mt-2">
                ✉️ Email follow-up unlocks in {daysUntilFollowup(app)} day{daysUntilFollowup(app) === 1 ? "" : "s"}
                {" "}(7 days without a reply).
              </div>
            )}
            {canFollowup && !app.contact_email && (
              <div className="small text-muted mt-2">
                ✉️ Add the hiring contact's email above to follow up by email.
              </div>
            )}
            {followupError && (
              <div className="alert alert-danger py-2 px-3 mt-2 mb-0" role="alert">
                {followupError}
              </div>
            )}

            <StageUpdateForm
              options={[...(stages.stages || []), ...(stages.terminal || [])]}
              onSubmit={handleStageUpdate}
              pending={stageUpdatePending}
            />
            {stageUpdateError && (
              <div className="alert alert-danger py-2 px-3 mt-2 mb-0" role="alert">
                {stageUpdateError}
              </div>
            )}
          </div>
        </div>
      )}

      {app.matchReport && (
        <div className="card mb-4">
          <div className="card-header">Match Report</div>
          <div className="card-body">
            <pre className="mb-0" style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>
              {app.matchReport}
            </pre>
          </div>
        </div>
      )}

      {app.interviewQuestions && (
        <div className="card mb-4">
          <div className="card-header">Interview Questions</div>
          <div className="card-body">
            <pre className="mb-0" style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>
              {app.interviewQuestions}
            </pre>
          </div>
        </div>
      )}

      <PackageCostCard usage={app.usage} />

      {app.files && app.files.length > 0 && (
        <div className="card mb-4">
          <div className="card-header d-flex justify-content-between align-items-center">
            <span>Files in application folder</span>
            <div className="d-flex align-items-start gap-2">
              {packageBuilt && (
                <Link to={`/resume/${encodeURIComponent(app.folder)}`} className="btn btn-sm btn-outline-primary rounded-pill">
                  📄 View résumé — bullets linked to facts
                </Link>
              )}
              <SaveToPcButton folder={app.folder} files={app.files} />
            </div>
          </div>
          <ul className="list-group list-group-flush">
            {app.files.map((f) => (
              <li key={f} className="list-group-item">
                <a href={fileUrl(app.folder, f)} download={f}>{f}</a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
