'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');

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
/**
 * Select a repository explicitly beneath the workspace. Do not let Git climb
 * above the selected path to discover a parent repository or follow worktree
 * .git redirection files into host directories outside the workspace.
 */
function repoRoot(workspace, repoPath = '.') {
  const dir = safePath(workspace, repoPath);
  if (!fs.statSync(dir).isDirectory()) throw new Error('repoPath must point to a directory');
  let gitStat;
  try { gitStat = fs.lstatSync(path.join(dir, '.git')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('NOT_A_REPOSITORY: select a Git checkout root using repoPath (for example "mcp-workspace")');
    throw error;
  }
  if (!gitStat.isDirectory() || gitStat.isSymbolicLink()) {
    throw new Error('UNSUPPORTED_REPOSITORY: .git must be a real directory inside repoPath (linked worktrees and submodules with .git files are not supported)');
  }
  return dir;
}

const GIT_ENV = Object.freeze({
  PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin',
  HOME: '/nonexistent',
  LANG: 'C',
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  GIT_EXTERNAL_DIFF: '',
  GIT_ATTR_NOSYSTEM: '1',
});

const GIT_FLAGS = [
  '--no-optional-locks',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.pager=cat',
  '-c', 'diff.external=',
  '-c', 'submodule.recurse=false',
];

function git(repo, args, maxBuffer = MAX_OUTPUT * 4) {
  try {
    return execFileSync('git', [...GIT_FLAGS, ...args], {
      cwd: repo,
      env: GIT_ENV,
      encoding: 'utf8', timeout: 8000, maxBuffer, stdio: ['ignore', 'pipe', 'pipe'],
    }).trimEnd();
  } catch (e) {
    const message = typeof e.stderr === 'string' ? e.stderr.trim() : e.message;
    throw new Error('git command failed: ' + message.slice(0, 1200));
  }
}
/**
 * Stream Git output instead of asking execFileSync to buffer the entire diff.
 * End the process as soon as the requested output limit is exceeded.
 */
function gitDiffBounded(repo, args, maxChars) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...GIT_FLAGS, ...args], {
      cwd: repo, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const decoder = new StringDecoder('utf8');
    let diff = '', stderr = '', truncated = false, timedOut = false, spawnError;
    const add = part => {
      if (truncated) return;
      const remaining = maxChars - diff.length;
      if (part.length > remaining) {
        diff += part.slice(0, remaining);
        truncated = true;
        child.kill('SIGTERM');
      } else {
        diff += part;
      }
    };
    child.stdout.on('data', chunk => add(decoder.write(chunk)));
    child.stderr.on('data', chunk => {
      stderr += chunk.toString('utf8').slice(0, Math.max(0, 1200 - stderr.length));
    });
    child.once('error', error => { spawnError = error; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 8000);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (!truncated) add(decoder.end());
      if (timedOut) return reject(new Error('git diff timed out after 8 seconds'));
      if (spawnError) return reject(new Error('git diff failed: ' + spawnError.message));
      if (truncated) return resolve({ diff: diff + '\n[output truncated]', truncated: true });
      if (code !== 0) return reject(new Error(
        'git diff failed (exit ' + (code ?? signal ?? 'unknown') + '): ' + (stderr.trim() || 'no stderr')
      ));
      resolve({ diff, truncated: false });
    });
  });
}
function clip(s, max = MAX_OUTPUT) { return s.length > max ? s.slice(0, max) + '\n[output truncated]' : s; }

function repoStatus(root, { repoPath = '.' } = {}) {
  const repo = repoRoot(root, repoPath);
  return {
    repoPath,
    branch: git(repo, ['branch', '--show-current']) || '(detached)',
    head: git(repo, ['rev-parse', '--short', 'HEAD']),
    status: clip(git(repo, ['status', '--short', '--branch', '--ignore-submodules=all']), 10000),
    stagedSummary: clip(git(repo, ['diff', '--cached', '--stat', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all']), 6000),
    unstagedSummary: clip(git(repo, ['diff', '--stat', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all']), 6000),
  };
}
async function repoDiff(root, { repoPath = '.', path: rel, staged = false, maxChars = 22000 } = {}) {
  if (!Number.isInteger(maxChars) || maxChars < 100 || maxChars > MAX_OUTPUT) throw new Error('maxChars must be 100..28000');
  const repo = repoRoot(root, repoPath);
  const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=all'];
  if (staged) args.push('--cached');
  if (rel) { safePath(repo, rel); args.push('--', rel); }
  const { diff, truncated } = await gitDiffBounded(repo, args, maxChars);
  return { repoPath, staged, path: rel || null, diff, truncated, note: 'Git diff excludes untracked files. Use code search/read tools for those.' };
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
  if (!Buffer.from(next, 'utf8').equals(original)) throw new Error('INVALID_ENCODING: file is not valid UTF-8; no changes written');
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
function readLines(root, { path: rel, startLine = 1, maxLines = 100, maxChars = 12000 } = {}) {
  if (!Number.isInteger(startLine) || startLine < 1) throw new Error('startLine must be a positive integer');
  if (!Number.isInteger(maxLines) || maxLines < 1 || maxLines > 250) throw new Error('maxLines must be 1..250');
  if (!Number.isInteger(maxChars) || maxChars < 100 || maxChars > MAX_OUTPUT) throw new Error('maxChars must be 100..28000');
  const file = safePath(root, rel);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('target must be a regular file up to 1 MB');
  const bytes = fs.readFileSync(file);
  const source = bytes.toString('utf8');
  if (!Buffer.from(source, 'utf8').equals(bytes) || source.includes('\0')) throw new Error('INVALID_ENCODING: file must be UTF-8 text');
  const lines = source.length ? source.split('\n') : [];
  if (source.endsWith('\n')) lines.pop();
  const totalLines = lines.length;
  let output = '';
  let lastLine = startLine - 1;
  for (let i = startLine - 1; i < Math.min(totalLines, startLine - 1 + maxLines); i++) {
    const text = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
    const row = String(i + 1) + ' | ' + text + '\n';
    if (output.length + row.length > maxChars) {
      const available = maxChars - output.length;
      if (available > 0) output += row.slice(0, available);
      break;
    }
    output += row;
    lastLine = i + 1;
  }
  return {
    path: rel, sha256: sha(bytes), totalLines, startLine, endLine: lastLine,
    content: output,
    truncated: lastLine < totalLines && startLine <= totalLines,
  };
}

function parseUnifiedPatch(patch) {
  if (typeof patch !== 'string' || !patch.trim() || Buffer.byteLength(patch) > 256 * 1024) {
    throw new Error('patch must be nonempty unified diff text up to 256 KB');
  }
  const lines = patch.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const files = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].startsWith('diff --git ')) i++;
    while (i < lines.length && lines[i].startsWith('index ')) i++;
    if (i >= lines.length || !lines[i].startsWith('--- ')) throw new Error('PATCH_FORMAT: expected --- a/path');
    const oldHeader = lines[i++].slice(4);
    if (i >= lines.length || !lines[i].startsWith('+++ ')) throw new Error('PATCH_FORMAT: expected +++ b/path');
    const newHeader = lines[i++].slice(4);
    if (!oldHeader.startsWith('a/') || !newHeader.startsWith('b/') ||
        oldHeader.slice(2) !== newHeader.slice(2) || oldHeader.length < 3) {
      throw new Error('PATCH_FORMAT: only changes to existing files with matching a/ and b/ paths are supported');
    }
    const rel = oldHeader.slice(2);
    if (files.some(f => f.path === rel)) throw new Error('PATCH_FORMAT: duplicate file ' + rel);
    const hunks = [];
    while (i < lines.length && lines[i].startsWith('@@ ')) {
      if (hunks.length >= 100) throw new Error('PATCH_LIMIT: at most 100 hunks per file');
      const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(lines[i++]);
      if (!header) throw new Error('PATCH_FORMAT: invalid hunk header');
      const oldStart = Number(header[1]), oldCount = header[2] == null ? 1 : Number(header[2]);
      const newStart = Number(header[3]), newCount = header[4] == null ? 1 : Number(header[4]);
      if (![oldStart, oldCount, newStart, newCount].every(Number.isSafeInteger)) throw new Error('PATCH_FORMAT: invalid hunk positions');
      const entries = [];
      let oldSeen = 0, newSeen = 0;
      while (i < lines.length) {
        const line = lines[i];
        if (line === '\\ No newline at end of file') {
          if (!entries.length || entries.at(-1).noNewline) throw new Error('PATCH_FORMAT: misplaced no-newline marker');
          entries.at(-1).noNewline = true;
          i++;
          continue;
        }
        if (oldSeen === oldCount && newSeen === newCount) break;
        if (!/^[ +\-]/.test(line)) throw new Error('PATCH_FORMAT: invalid hunk body');
        const kind = line[0], value = line.slice(1);
        if (kind !== '+') oldSeen++;
        if (kind !== '-') newSeen++;
        if (oldSeen > oldCount || newSeen > newCount) throw new Error('PATCH_FORMAT: hunk line counts exceeded');
        entries.push({ kind, value, noNewline: false });
        i++;
      }
      if (oldSeen !== oldCount || newSeen !== newCount || !entries.length) throw new Error('PATCH_FORMAT: hunk line counts do not match');
      hunks.push({ oldStart, oldCount, newStart, newCount, entries });
    }
    if (!hunks.length) throw new Error('PATCH_FORMAT: each file must contain at least one hunk');
    files.push({ path: rel, hunks });
    if (files.length > 12) throw new Error('PATCH_LIMIT: at most 12 files per patch');
  }
  return files;
}

function patchContents(original, hunks) {
  const source = original.match(/[^\n]*\n|[^\n]+$/g) || [];
  const result = [];
  let cursor = 0;
  for (const hunk of hunks) {
    const oldIndex = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
    const newIndex = hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1;
    if (oldIndex < cursor || oldIndex > source.length) throw new Error('PATCH_CONFLICT: overlapping or out-of-range hunk');
    result.push(...source.slice(cursor, oldIndex));
    cursor = oldIndex;
    if (result.length !== newIndex) throw new Error('PATCH_CONFLICT: inconsistent new hunk position');
    for (const entry of hunk.entries) {
      const expected = entry.value + (entry.noNewline ? '' : '\n');
      if (entry.kind !== '+') {
        if (source[cursor] !== expected) throw new Error('PATCH_CONFLICT: hunk context or deletion does not match original file at line ' + (cursor + 1));
        cursor++;
      }
      if (entry.kind !== '-') result.push(expected);
    }
  }
  result.push(...source.slice(cursor));
  return result.join('');
}

function applyPatch(root, { patch, expectedFiles, dryRun = false } = {}) {
  const parsed = parseUnifiedPatch(patch);
  if (!Array.isArray(expectedFiles) || expectedFiles.length !== parsed.length) {
    throw new Error('expectedFiles must contain exactly one {path, expectedSha256} for each patched file');
  }
  const hashMap = new Map();
  for (const item of expectedFiles) {
    if (!item || typeof item.path !== 'string' || typeof item.expectedSha256 !== 'string' ||
        !/^[0-9a-fA-F]{64}$/.test(item.expectedSha256) || hashMap.has(item.path)) {
      throw new Error('expectedFiles must have unique paths and valid SHA-256 hashes');
    }
    hashMap.set(item.path, item.expectedSha256.toLowerCase());
  }
  const canonicalPaths = new Set();
  const prepared = parsed.map(item => {
    if (!hashMap.has(item.path)) throw new Error('MISSING_HASH: ' + item.path);
    const file = safePath(root, item.path);
    const canonical = fs.realpathSync(file);
    if (canonicalPaths.has(canonical)) throw new Error('PATCH_FORMAT: the same file appears more than once');
    canonicalPaths.add(canonical);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES || stat.nlink !== 1) {
      throw new Error('PATCH_TARGET: must be a regular non-hardlinked file up to 1 MB: ' + item.path);
    }
    const original = fs.readFileSync(file);
    const actual = sha(original);
    if (actual !== hashMap.get(item.path)) throw new Error('STALE_FILE: ' + item.path);
    const source = original.toString('utf8');
    if (!Buffer.from(source, 'utf8').equals(original) || source.includes('\0')) throw new Error('INVALID_ENCODING: ' + item.path);
    const next = patchContents(source, item.hunks);
    if (Buffer.byteLength(next) > MAX_FILE_BYTES) throw new Error('PATCH_LIMIT: output exceeds 1 MB: ' + item.path);
    return { path: item.path, file, stat, actual, next, newHash: sha(Buffer.from(next)) };
  });
  const summary = prepared.map(f => ({
    path: f.path, changed: f.actual !== f.newHash, oldSha256: f.actual, newSha256: f.newHash,
  }));
  if (dryRun) return { dryRun: true, files: summary };
  // Validate every file before any write. This is not an atomic cross-file transaction.
  for (const f of prepared) {
    if (sha(fs.readFileSync(f.file)) !== f.actual || fs.lstatSync(f.file).isSymbolicLink()) {
      throw new Error('STALE_FILE: ' + f.path);
    }
  }
  const temps = [];
  try {
    for (const f of prepared.filter(f => f.actual !== f.newHash)) {
      const temp = path.join(path.dirname(f.file), '.' + path.basename(f.file) + '.mcp-' + crypto.randomBytes(6).toString('hex'));
      fs.writeFileSync(temp, f.next, { mode: f.stat.mode & 0o777, flag: 'wx' });
      temps.push({ temp, file: f.file });
    }
    const completed = [];
    for (const f of temps) {
      try { fs.renameSync(f.temp, f.file); completed.push(f.file); }
      catch (error) {
        throw new Error('PATCH_WRITE_FAILED: ' + error.message + '; files already written: ' + (completed.length ? completed.map(file => path.relative(workspaceRoot(root), file)).join(', ') : 'none'));
      }
    }
  } finally {
    for (const f of temps) {
      try { fs.unlinkSync(f.temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  return { dryRun: false, files: summary };
}

function workspaceDiagnostics(root) {
  return {
    workspace: workspaceRoot(root),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    gitAvailable: (() => { try { git(workspaceRoot(root), ['--version']); return true; } catch { return false; } })(),
    toolLimits: { searchFiles: MAX_FILES, searchResults: MAX_MATCHES, editFileBytes: MAX_FILE_BYTES },
    terminal: 'Separate nanosandbox MCP: 180 seconds, 1 GB RAM, network off, host Docker socket unavailable.',
    note: 'Developer tools do not execute arbitrary project code. Use sandboxed terminal for tests.',
  };
}
module.exports = { safePath, sha, codeSearch, repoStatus, repoDiff, editChecked, readLines, applyPatch, workspaceDiagnostics };
