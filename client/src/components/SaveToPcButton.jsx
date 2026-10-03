import { useEffect, useState } from "react";
import { canPickFolder, forgetDir, saveFolderToPc, savedDirName } from "../saveFolder.js";

// "Save to PC": copies the whole application folder, same name and files,
// into the PC's JobSearch\engine\applications (picked once, then remembered).
export default function SaveToPcButton({ folder, files }) {
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);
  const [dirName, setDirName] = useState(null);

  useEffect(() => {
    if (canPickFolder) savedDirName().then(setDirName);
  }, []);

  const save = async () => {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const result = await saveFolderToPc(folder, files);
      if (result) setMessage(`✅ ${result.count} files saved to ${result.where}`);
      if (canPickFolder) setDirName(await savedDirName());
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const changeFolder = async () => {
    await forgetDir();
    setDirName(null);
    setMessage(null);
  };

  return (
    <div className="d-flex flex-column align-items-end gap-1">
      <button
        type="button"
        className="btn btn-sm btn-primary rounded-pill"
        onClick={save}
        disabled={saving}
        title={
          canPickFolder
            ? dirName
              ? `Copies this folder into ${dirName}\\`
              : "First time: pick JobSearch\\engine\\applications on this PC"
            : "This browser can't write to a folder — downloads one zip of the folder"
        }
      >
        {saving ? "Saving…" : canPickFolder ? "💾 Save folder to PC" : "💾 Download folder (.zip)"}
      </button>
      {!canPickFolder && !saving && (
        <span className="small text-muted text-end">
          Unzip it into applications — or open the dashboard in Chrome/Edge to save straight there
        </span>
      )}
      {dirName && !saving && (
        <button type="button" className="btn btn-link btn-sm p-0 small" onClick={changeFolder}>
          into {dirName}\ · change
        </button>
      )}
      {canPickFolder && !dirName && !saving && (
        // Browsers can't preset an absolute path: the picker opens in
        // Downloads and this says where to go, once — after that the
        // picked folder is remembered and used every time.
        <span className="small text-muted text-end">
          First time: pick {["Downloads", "SmartLedgerAI-JobPrep", "JobSearch", "engine", "applications"].join(" \\ ")}
        </span>
      )}
      {message && <span className="small text-success">{message}</span>}
      {error && <span className="small text-danger">{error}</span>}
    </div>
  );
}
