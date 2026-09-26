import { spawn, spawnSync } from "child_process";
import { existsSync } from "fs";
import path from "path";

// Runs a child process without blocking the event loop (the old spawnSync
// froze every other request for the whole LibreOffice render) and kills it
// — with its children, e.g. the soffice process build.py starts — if it
// runs past `timeoutMs`.
export function runProcess(command, args, { timeoutMs = 60_000, cwd } = {}) {
  return new Promise((resolve) => {
    const isWindows = process.platform === "win32";
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      // Own process group on POSIX, so the whole tree can be killed at once.
      detached: !isWindows,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf-8").on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf-8").on("data", (d) => (stderr += d));

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid, isWindows);
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr: stderr + err.message, timedOut });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status: timedOut ? null : status, stdout, stderr, timedOut });
    });
  });
}

function killTree(pid, isWindows) {
  if (!pid) return;
  try {
    if (isWindows) spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    else process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}

// PYTHON wins if set. Otherwise try the per-user Windows install location
// (the interpreter isn't always on PATH for an already-running shell right
// after install — see JobSearch/engine/requirements.txt), then PATH.
export function findPython(configured) {
  if (configured) return configured;
  if (process.env.LOCALAPPDATA) {
    const winPython = path.join(process.env.LOCALAPPDATA, "Programs", "Python", "Python312", "python.exe");
    if (existsSync(winPython)) return winPython;
  }
  return process.platform === "win32" ? "python" : "python3";
}
