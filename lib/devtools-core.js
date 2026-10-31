'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const EXCLUDE = new Set(['.git', 'node_modules', '.next', '.venv', 'venv', 'dist', 'build', 'coverage', '.turbo', 'target']);
const MAX_MATCHES = 100;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 6000;
const MAX_OUTPUT = 28000;

function workspaceRoot(root) {
  const real = fs.realpathSync(root);
  if (!fs.statSync(real).isDirectory()) throw new Error('workspace must be a directory');
  return real;
}
function safePath(root, relativePath = '.') {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\0') || path.isAbsolute(relativePath))
    throw new Error('path must be a nonempty relative workspace path');
  const clean = relativePath.split(/[\\/]+/).filter(Boolean);
  if (clean.some(part => part === '..' || part === '.git')) throw new Error('path traversal and .git access are not permitted');
  let current = workspaceRoot(root);
  for (const part of clean) {
    current = path.join(current, part);
    if (fs.existsSync(current) || fs.lstatSync(path.dirname(current)).isDirectory()) {
      try {
        if (fs.lstatSync(current).isSymbolicLink()) throw new Error('symlink paths are not permitted');
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }
  if (current !== workspaceRoot(root) && !current.startsWith(workspaceRoot(root) + path.sep)) throw new Error('path escapes workspace');
  return current;
}
function sha(content) { return crypto.createHash('sha256').update(content).digest('hex'); }
function git(root, args, maxBuffer = MAX_OUTPUT * 4) {
  try {
    return execFileSync('git', ['--no-optional-locks', ...args], {
      cwd: workspaceRoot(root),
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      encoding: 'utf8', timeout: 8000, maxBuffer, stdio: ['ignore', 'pipe', 'pipe'],
    }).trimEnd();
  } catch (e) {
    const message = typeof e.stderr === 'string' ? e.stderr.trim() : e.message;
    throw new Error('git command failed: ' + message.slice(0, 1200));
  }
}
function clip(s, max = MAX_OUTPUT) { return s.length > max ? s.slice(0, max) + '\n[output truncated]' : s; }

function repoStatus(root) {
  return {
    branch: git(root, ['branch', '--show-current']) || '(detached)',
    head: git(root, ['rev-parse', '--short', 'HEAD']),
    status: clip(git(root, ['status', '--short', '--branch']), 10000),
    stagedSummary: clip(git(root, ['diff', '--cached', '--stat']), 6000),
    unstagedSummary: clip(git(root, ['diff', '--stat']), 6000),
  };
}
function repoDiff(root, { path: rel, staged = false, maxChars = 22000 } = {}) {
  if (!Number.isInteger(maxChars) || maxChars < 100 || maxChars > MAX_OUTPUT) throw new Error('maxChars must be 100..28000');
  const args = ['diff', '--no-ext-diff', '--no-color'];
  if (staged) args.push('--cached');
  if (rel) { const full = safePath(root, rel); if (!full.startsWith(workspaceRoot(root))) throw new Error('invalid path'); args.push('--', rel); }
  const output = git(root, args);
  return { staged, path: rel || null, diff: clip(output, maxChars), note: 'Git diff excludes untracked files. Use code search/read tools for those.' };
}

function codeSearch(root, { query, path: scope = '.', extensions = [], caseSensitive = false, maxResults = 50 } = {}) {
  if (typeof query !== 'string' || !query.trim() || query.length > 200) throw new Error('query must be 1..200 characters (literal substring)');
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_MATCHES) throw new Error('maxResults must be 1..100');
  if (!Array.isArray(extensions) || extensions.length > 15 || extensions.some(x => typeof x !== 'string' || !/^\.[a-zA-Z0-9]+$/.test(x))) throw new Error('extensions must be an array of extensions such as [".ts",".go"]');
  const base = safePath(root, scope);
  const rootStat = fs.statSync(base);
  const matches = [], stack = [base];
  let filesScanned = 0, skipped = 0, truncated = false;
  const needle = caseSensitive ? query : query.toLowerCase();
  while (stack.length && matches.length < maxResults && filesScanned < MAX_FILES) {
    const file = stack.pop();
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(file, { withFileTypes: true }).sort((a,b) => b.name.localeCompare(a.name));
      for (const e of entries) {
        if (EXCLUDE.has(e.name) || e.isSymbolicLink()) continue;
        stack.push(path.join(file,e.name));
      }
      continue;
    }
    if (!stat.isFile() || (extensions.length && !extensions.includes(path.extname(file))) || stat.size > MAX_FILE_BYTES) { skipped++; continue; }
    filesScanned++;
    let source;
    try { source = fs.readFileSync(file, 'utf8'); } catch { skipped++; continue; }
    if (source.includes('\0')) { skipped++; continue; }
    const lines = source.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = caseSensitive ? lines[i] : lines[i].toLowerCase();
      if (line.includes(needle)) {
        matches.push({ path: path.relative(workspaceRoot(root), file), line: i + 1, text: lines[i].slice(0, 260) });
        if (matches.length === maxResults) { truncated = true; break; }
      }
    }
  }
  return { query, matches, filesScanned, skipped, truncated: truncated || stack.length > 0 || filesScanned >= MAX_FILES };
}

function editChecked(root, { path: rel, expectedSha256, edits, dryRun = false } = {}) {
  if (typeof rel !== 'string' || rel === '.' || rel === '') throw new Error('path is required');
  if (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedSha256)) throw new Error('expectedSha256 must be a SHA-256 hex digest obtained from the file');
  if (!Array.isArray(edits) || edits.length < 1 || edits.length > 25) throw new Error('edits must contain 1..25 exact replacements');
  const file = safePath(root, rel);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('target must be a regular text file up to 1MB');
  const original = fs.readFileSync(file);
  const actual = sha(original);
  if (actual !== expectedSha256.toLowerCase()) throw new Error('STALE_FILE: file has changed since it was read; reread before editing');
  let next = original.toString('utf8');
  if (next.includes('\0')) throw new Error('binary files cannot be edited');
  for (const edit of edits) {
    if (!edit || typeof edit.oldText !== 'string' || !edit.oldText.length || typeof edit.newText !== 'string')
      throw new Error('each edit must have nonempty oldText and string newText');
    const first = next.indexOf(edit.oldText);
    if (first === -1) throw new Error('MATCH_MISSING: replacement text not found; no changes written');
    if (next.indexOf(edit.oldText, first + edit.oldText.length) !== -1) throw new Error('MATCH_AMBIGUOUS: text appears multiple times; no changes written');
    next = next.slice(0,first) + edit.newText + next.slice(first + edit.oldText.length);
  }
  if (Buffer.byteLength(next) > MAX_FILE_BYTES) throw new Error('result would exceed 1 MB');
  const nextSha256 = sha(Buffer.from(next));
  if (!dryRun && nextSha256 !== actual) {
    // Recheck immediately before atomic rename. Other editors do not honor our
    // lock, so a tiny external-writer race is still theoretically possible.
    if (sha(fs.readFileSync(file)) !== actual) throw new Error('STALE_FILE: target changed during patch');
    const temp = path.join(path.dirname(file), '.' + path.basename(file) + '.mcp-' + crypto.randomBytes(6).toString('hex'));
    try {
      fs.writeFileSync(temp, next, { mode: stat.mode & 0o777, flag: 'wx' });
      fs.renameSync(temp, file);
    } finally { try { fs.unlinkSync(temp); } catch(e) { if (e.code !== 'ENOENT') throw e; } }
  }
  return { path: rel, dryRun, changed: nextSha256 !== actual, oldSha256: actual, newSha256: nextSha256 };
}
function workspaceDiagnostics(root) {
  return {
    workspace: workspaceRoot(root),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    gitAvailable: (() => { try { git(root, ['--version']); return true; } catch { return false; } })(),
    toolLimits: { searchFiles: MAX_FILES, searchResults: MAX_MATCHES, editFileBytes: MAX_FILE_BYTES },
    terminal: 'Separate nanosandbox MCP: 180 seconds, 1 GB RAM, network off, host Docker socket unavailable.',
    note: 'Developer tools do not execute arbitrary project code. Use sandboxed terminal for tests.',
  };
}
module.exports = { safePath, sha, codeSearch, repoStatus, repoDiff, editChecked, workspaceDiagnostics };
