// The engine folder's local git repo (no remote) is the truth bank's history:
// every save from the dashboard is one commit, so "when did this fact change
// and what did it say before" has a real answer instead of a pile of .bak
// files. Everything degrades to a no-op when the folder isn't a repo (tests,
// or a copy deployed somewhere without one).
import { existsSync } from "fs";
import path from "path";
import { runProcess } from "./process.js";

export const TRACKED_PATHS = ["facts", "gap_tags.yml", "gap_aliases.yml", "templates", "health_dismissed.yml"];

export function createEngineGit(engineDir, { gitCommand = "git" } = {}) {
  const enabled = () => existsSync(path.join(engineDir, ".git"));
  const git = (args) => runProcess(gitCommand, args, { cwd: engineDir, timeoutMs: 15_000 });

  async function commit(paths, message) {
    if (!enabled()) return null;
    const add = await git(["add", "--", ...paths]);
    // No git binary (an image built without it): the file is already saved,
    // so the save shouldn't answer 500 — it just goes unrecorded.
    if (add.status === null && /ENOENT/.test(add.stderr)) {
      console.warn(`[engine-git] git not found — "${message}" saved without a commit`);
      return null;
    }
    if (add.status !== 0) throw new Error(`git add failed: ${add.stderr || add.stdout}`);
    const staged = await git(["diff", "--cached", "--quiet", "--", ...paths]);
    if (staged.status === 0) return null; // nothing actually changed
    const res = await git(["commit", "-q", "-m", message, "--", ...paths]);
    if (res.status !== 0) throw new Error(`git commit failed: ${res.stderr || res.stdout}`);
    const head = await git(["rev-parse", "--short", "HEAD"]);
    return head.stdout.trim();
  }

  // Files under the tracked paths that differ from the last commit — edits
  // made by hand or by a chat session rather than through the dashboard.
  async function uncommitted() {
    if (!enabled()) return [];
    const res = await git(["status", "--porcelain", "--", ...TRACKED_PATHS]);
    if (res.status !== 0) return [];
    return res.stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => l.slice(3).trim().replace(/^"|"$/g, ""));
  }

  // grep: only commits whose message mentions it (fact ids and gap slugs are
  // always in the message of a dashboard commit).
  async function log({ grep, limit = 50 } = {}) {
    if (!enabled()) return [];
    const args = ["log", `-n${limit}`, "--date=iso-strict", "--format=%h%x1f%ad%x1f%s"];
    if (grep) args.push("-F", `--grep=${grep}`);
    args.push("--", ...TRACKED_PATHS);
    const res = await git(args);
    if (res.status !== 0) return [];
    return res.stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [hash, date, subject] = l.split("\x1f");
        return { hash, date, subject };
      });
  }

  async function show(hash) {
    if (!enabled() || !/^[0-9a-f]{4,40}$/.test(hash)) return null;
    const res = await git(["show", "--format=%h%x1f%ad%x1f%s", "--date=iso-strict", hash, "--", ...TRACKED_PATHS]);
    if (res.status !== 0) return null;
    const [head, ...rest] = res.stdout.split("\n");
    const [h, date, subject] = head.split("\x1f");
    return { hash: h, date, subject, diff: rest.join("\n") };
  }

  return { enabled, commit, uncommitted, log, show };
}
