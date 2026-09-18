// Per-file-type thresholds for the Read/Bash size gates. Lockfiles and
// minified bundles are never meant to be read top-to-bottom by a human or a
// model — nobody delegates to understand them, only to grep inside them — so
// they get a much lower bar before the gate fires.
const path = require("path");

const DEFAULT_LINE_LIMIT = 350;
const DEFAULT_BYTE_LIMIT = 40 * 1024;

// Denser bar for content nobody reads end-to-end: a 60-line lockfile is
// already noise, unlike a 60-line source file.
const LOW_LINE_LIMIT = 40;
const LOW_BYTE_LIMIT = 4 * 1024;

const LOCKFILE_BASENAMES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "composer.lock",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "Pipfile.lock",
  "mix.lock",
  "go.sum",
]);

const MINIFIED_RE = /\.min\.(js|css)$/i;

function resolveLimits(filePath) {
  const base = path.basename(filePath);
  if (LOCKFILE_BASENAMES.has(base) || MINIFIED_RE.test(base)) {
    return { lineLimit: LOW_LINE_LIMIT, byteLimit: LOW_BYTE_LIMIT };
  }
  return { lineLimit: DEFAULT_LINE_LIMIT, byteLimit: DEFAULT_BYTE_LIMIT };
}

module.exports = { resolveLimits, DEFAULT_LINE_LIMIT, DEFAULT_BYTE_LIMIT, LOW_LINE_LIMIT, LOW_BYTE_LIMIT };
