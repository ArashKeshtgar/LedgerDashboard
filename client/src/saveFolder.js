// Builds run on the server, so a package's files only exist there. This
// copies one application folder onto the PC, under the same name, into the
// folder the user picked once (JobSearch\engine\applications). Chrome/Edge
// remember that pick across visits; the handle is kept in IndexedDB because
// localStorage can't hold it. Browsers without the File System Access API
// (phones, Firefox) get one <folder>.zip holding the folder instead.

import { fileUrl } from "./api.js";
import { makeZip } from "./zip.js";

const DB = "ledger-dashboard";
const STORE = "handles";
const KEY = "applicationsDir";

export const canPickFolder = typeof window !== "undefined" && "showDirectoryPicker" in window;

function idb(mode, run) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction(STORE, mode);
      const req = run(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    };
  });
}

async function savedDir() {
  try {
    return (await idb("readonly", (s) => s.get(KEY))) || null;
  } catch {
    return null; // storage blocked: just ask again
  }
}

async function rememberDir(handle) {
  try {
    await idb("readwrite", (s) => s.put(handle, KEY));
  } catch { /* not remembered — asked again next time */ }
}

export async function forgetDir() {
  try {
    await idb("readwrite", (s) => s.delete(KEY));
  } catch { /* nothing to forget */ }
}

export async function savedDirName() {
  return (await savedDir())?.name || null;
}

async function pickDir() {
  const handle = await window.showDirectoryPicker({ id: "ledger-applications", mode: "readwrite", startIn: "downloads" });
  if (handle.name !== "applications" &&
      !window.confirm(`You picked "${handle.name}", not "applications". Save packages there anyway?`)) {
    return null;
  }
  await rememberDir(handle);
  return handle;
}

async function fetchFile(folder, name) {
  const res = await fetch(fileUrl(folder, name));
  if (!res.ok) throw new Error(`Couldn't download ${name} (${res.status})`);
  return res.blob();
}

// Returns { where, count }. Throws on a real failure; returns null when the
// user cancels the folder picker.
export async function saveFolderToPc(folder, files) {
  if (!canPickFolder) {
    // Firefox/phones can't write into a folder: one zip named after the
    // folder, holding the folder itself, so unzipping it in applications
    // gives exactly the layout a direct save would.
    const entries = [];
    for (const name of files) {
      const bytes = new Uint8Array(await (await fetchFile(folder, name)).arrayBuffer());
      entries.push({ path: `${folder}/${name}`, bytes });
    }
    const url = URL.createObjectURL(makeZip(entries));
    const a = Object.assign(document.createElement("a"), { href: url, download: `${folder}.zip` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return { where: `Downloads\\${folder}.zip`, count: files.length };
  }

  let dir = await savedDir();
  // The permission is per visit: asking needs this click, so it comes first.
  if (dir && (await dir.requestPermission({ mode: "readwrite" })) !== "granted") dir = null;
  if (!dir) {
    try {
      dir = await pickDir();
    } catch (err) {
      if (err.name === "AbortError") return null;
      throw err;
    }
    if (!dir) return null;
  }

  const target = await dir.getDirectoryHandle(folder, { create: true });
  for (const name of files) {
    const blob = await fetchFile(folder, name);
    const file = await target.getFileHandle(name, { create: true });
    const out = await file.createWritable();
    await out.write(blob);
    await out.close();
  }
  return { where: `${dir.name}\\${folder}`, count: files.length };
}
