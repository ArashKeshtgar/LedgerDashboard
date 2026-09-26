import path from "path";

// Application folders are always generated as date__Company__Role slugs, so
// anything outside this character set — including "", ".", "..", slashes and
// drive letters — is rejected before it gets near the filesystem.
const FOLDER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isSafeFolderName(name) {
  return typeof name === "string" && FOLDER_NAME_RE.test(name) && !name.includes("..");
}

// Resolves an application folder to an absolute path strictly inside
// applicationsDir, or throws. Used before every read, write or delete, so a
// folder value from a request body or a hand-edited ledger row can never
// point at the fact bank, the engine scripts, or applicationsDir itself.
export function resolveApplicationFolder(applicationsDir, name) {
  if (!isSafeFolderName(name)) {
    throw new UnsafeFolderError(name);
  }
  const root = path.resolve(applicationsDir);
  const resolved = path.resolve(root, name);
  if (path.dirname(resolved) !== root) throw new UnsafeFolderError(name);
  return resolved;
}

export class UnsafeFolderError extends Error {
  constructor(name) {
    super(`Invalid application folder: ${JSON.stringify(name)}`);
    this.name = "UnsafeFolderError";
  }
}
