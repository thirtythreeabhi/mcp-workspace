#!/usr/bin/env node
'use strict';

// Minimal stdio MCP server. No package install, shell execution, or network access.
// Filesystem access is confined to the workspace passed by the launcher.
const fs = require('node:fs');
const { safePath, sha, codeSearch, repoStatus, repoDiff, editChecked, workspaceDiagnostics } = require('./devtools-core');

const root = process.argv[2];
if (!root) { process.stderr.write('devtools: missing workspace root\n'); process.exit(2); }

const text = x => ({ content: [{ type: 'text', text: JSON.stringify(x, null, 2) }] });
const properties = {
  query: { type: 'string', description: 'Literal substring to find in source files (not a regex), 1–200 characters.' },
  path: { type: 'string', description: 'Relative path inside the selected workspace. Never use an absolute path.' },
};
const toolDefinitions = [
  {
    name: 'code_search',
    description: 'Find source-code text and line numbers inside this workspace. Literal substring search; ignores .git, node_modules, build outputs, symlinks and large files. Prefer over ad-hoc grep. Read matching files before editing.',
    inputSchema: { type: 'object', properties: {
      query: properties.query, path: { ...properties.path, default: '.' },
      extensions: { type: 'array', items: { type: 'string' }, description: 'Optional suffixes such as [".ts", ".tsx", ".go"].' },
      caseSensitive: { type: 'boolean', default: false }, maxResults: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
    }, required: ['query'], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'repo_status',
    description: 'Read-only Git snapshot: current branch, HEAD, staged/unstaged changes, and diff summaries. Call before editing and again before reporting completion; other local editors may commit or modify files while you work.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'repo_diff',
    description: 'Read-only Git diff for unstaged (default) or staged changes, optionally limited to one workspace-relative path. This excludes untracked files. Output is bounded.',
    inputSchema: { type: 'object', properties: {
      path: properties.path, staged: { type: 'boolean', default: false }, maxChars: { type: 'integer', minimum: 100, maximum: 28000, default: 22000 },
    }, additionalProperties: false }, annotations: { readOnlyHint: true },
  },
  {
    name: 'file_hash',
    description: 'Compute SHA-256 for one existing regular workspace file. Use this hash as expectedSha256 with edit_checked to reject stale edits after another local process changes the file.',
    inputSchema: { type: 'object', properties: { path: properties.path }, required: ['path'], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'edit_checked',
    description: 'Make exact-match edits to ONE existing text file, only if its SHA-256 still matches expectedSha256. Reject missing or ambiguous matches, symlinks, and mismatched hashes. Writes via same-directory rename. No git commit or push. Use dryRun first for important edits. Concurrent noncooperating host editors can still race after the final hash check.',
    inputSchema: { type: 'object', properties: {
      path: properties.path,
      expectedSha256: { type: 'string', pattern: '^[0-9a-fA-F]{64}$', description: 'Original content hash returned by file_hash or computed from the exact contents you read.' },
      edits: { type: 'array', minItems: 1, maxItems: 25, items: { type: 'object', required: ['oldText', 'newText'], properties: {
        oldText: { type: 'string', minLength: 1 }, newText: { type: 'string' },
      }, additionalProperties: false } },
      dryRun: { type: 'boolean', default: false },
    }, required: ['path','expectedSha256','edits'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'workspace_diagnostics',
    description: 'Read-only environment information: workspace root, platform, available Git, tool limits and sandbox capabilities. Use before attempting a build or Docker workflow; Docker access is not exposed through these tools.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true },
  },
];
const tools = Object.freeze({
  code_search: a => codeSearch(root, a),
  repo_status: () => repoStatus(root),
  repo_diff: a => repoDiff(root, a),
  file_hash: a => {
    const file = safePath(root, a.path);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('file must be regular and at most 1 MB');
    return { path: a.path, sha256: sha(fs.readFileSync(file)), bytes: stat.size };
  },
  edit_checked: a => editChecked(root, a),
  workspace_diagnostics: () => workspaceDiagnostics(root),
});
function processRequest(msg) {
  const { id, method, params } = msg;
  if (id == null) return null; // Notification.
  if (method === 'initialize') return { jsonrpc:'2.0', id, result: {
    protocolVersion: '2025-11-25', capabilities: { tools: { listChanged:false } },
    serverInfo: { name:'mcp-workspace-developer', version:'0.2.0' },
    instructions: 'Workspace-scoped developer tools. No shell or network access in this server. For commands use the separate nanosandbox terminal tools.',
  } };
  if (method === 'ping') return { jsonrpc:'2.0', id, result:{} };
  if (method === 'tools/list') return { jsonrpc:'2.0', id, result:{ tools: toolDefinitions } };
  if (method === 'tools/call') {
    if (!params || !Object.hasOwn(tools, params.name)) return { jsonrpc:'2.0', id, error:{code:-32602,message:'Unknown tool'} };
    try { return { jsonrpc:'2.0', id, result: text(tools[params.name](params.arguments || {})) }; }
    catch(e) { return { jsonrpc:'2.0', id, result: { isError:true, content:[{type:'text',text:String(e?.message || e)}] } }; }
  }
  return { jsonrpc:'2.0', id, error:{code:-32601,message:'Method not found'} };
}
let buffer='';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  if (buffer.length > 2 * 1024 * 1024) { process.stderr.write('devtools: message too large\n'); process.exit(1); }
  let index;
  while ((index=buffer.indexOf('\n')) !== -1) {
    const line=buffer.slice(0,index).trim();buffer=buffer.slice(index+1);
    if (!line) continue;
    try { const res=processRequest(JSON.parse(line)); if (res) process.stdout.write(JSON.stringify(res)+'\n'); }
    catch(e) { process.stderr.write('devtools: invalid request: '+e.message+'\n'); }
  }
});
