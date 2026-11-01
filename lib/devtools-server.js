#!/usr/bin/env node
'use strict';

// Minimal stdio MCP server. No package install, shell execution, or network access.
// Filesystem access is confined to the workspace passed by the launcher.
const fs = require('node:fs');
const { safePath, sha, codeSearch, repoStatus, repoDiff, editChecked, readLines, applyPatch, workspaceDiagnostics } = require('./devtools-core');
const hostControl = require('./host-control');
const {applyChanges,overview} = require('./devtools-v1');
const {createJobManager} = require('./jobs');

const root = process.argv[2];
if (!root) { process.stderr.write('devtools: missing workspace root\n'); process.exit(2); }
const jobManager=createJobManager(root);

const text = x => ({ content: [{ type: 'text', text: JSON.stringify(x, null, 2) }] });
const properties = {
  query: { type: 'string', description: 'Literal substring to find in source files (not a regex), 1–200 characters.' },
  path: { type: 'string', description: 'Relative path inside the selected workspace. Never use an absolute path.' },
  repoPath: { type: 'string', default: '.', description: 'Workspace-relative path to a Git repository root, for example "mcp-workspace" or "rupee-os". Defaults to the workspace itself if it is a Git repo.' },
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
    description: 'Read-only Git snapshot for a selected repository root (repoPath). For a Downloads workspace, specify repoPath like "mcp-workspace". Returns branch, HEAD, staged/unstaged changes and summaries. Git runs with sanitized environment and hooks/fsmonitor disabled. Linked worktrees with .git redirection files are unsupported. Call before editing and before reporting completion.',
    inputSchema: { type: 'object', properties: { repoPath: properties.repoPath }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'repo_diff',
    description: 'Read-only, bounded Git diff in repoPath (the workspace-relative Git checkout root). The optional path is relative to repoPath, not the workspace. Defaults to unstaged changes; excludes untracked files, external diff drivers, text converters and submodule recursion.',
    inputSchema: { type: 'object', properties: {
      repoPath: properties.repoPath, path: properties.path, staged: { type: 'boolean', default: false }, maxChars: { type: 'integer', minimum: 100, maximum: 28000, default: 22000 },
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
    name: 'read_lines',
    description: 'Read a precise numbered line range from one existing UTF-8 workspace file. Bounded to 1 MB files, 250 lines, and 28,000 response characters. Returns the file SHA-256 for safe subsequent edits. No shell access.',
    inputSchema: { type: 'object', properties: {
      path: properties.path,
      startLine: { type: 'integer', minimum: 1, default: 1 },
      maxLines: { type: 'integer', minimum: 1, maximum: 250, default: 100 },
      maxChars: { type: 'integer', minimum: 100, maximum: 28000, default: 12000 },
    }, required: ['path'], additionalProperties: false }, annotations: { readOnlyHint: true },
  },
  {
    name: 'apply_patch',
    description: 'Apply a standard unified diff to up to 12 EXISTING UTF-8 files (no creates, deletes, renames or binary patches). Every path must have a matching SHA-256 in expectedFiles. Validates ALL files and hunks before writing; supports dryRun. File changes are individually atomic, but a multi-file patch is not a cross-file transaction if an I/O error occurs during rename. Use dryRun first.',
    inputSchema: { type: 'object', properties: {
      patch: { type: 'string', minLength: 1, description: 'Unified diff with --- a/path, +++ b/path, @@ hunk headers. Optional diff --git/index headers.' },
      expectedFiles: { type: 'array', minItems: 1, maxItems: 12, items: {
        type: 'object', properties: {
          path: properties.path,
          expectedSha256: { type: 'string', pattern: '^[0-9a-fA-F]{64}$' },
        }, required: ['path', 'expectedSha256'], additionalProperties: false,
      } },
      dryRun: { type: 'boolean', default: false },
    }, required: ['patch', 'expectedFiles'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'apply_changes',
    description: 'Batch up to 12 hash-checked file creates/replacements/deletions/moves. Rejects symlinks, hard links, traversal and stale content. Validates all operations before writing; supports dryRun and best-effort rollback if a write fails. For line-by-line patches of existing files use apply_patch.',
    inputSchema: { type:'object',properties: {
      operations:{type:'array',minItems:1,maxItems:12,items:{type:'object',properties:{
        action:{type:'string',enum:['create','replace','delete','move']},
        path:properties.path,destination:properties.path,content:{type:'string'},
        expectedSha256:{type:'string',pattern:'^[a-f0-9A-F]{64}$'},
      },required:['action','path'],additionalProperties:false}},
      dryRun:{type:'boolean',default:false},
    },required:['operations'],additionalProperties:false },
    annotations:{readOnlyHint:false,destructiveHint:true},
  },
  {
    name:'project_overview',
    description:'Read a bounded project overview: top-level files, detected languages/frameworks, package manager, package scripts, test infrastructure and Git status. Select nested project with relative path.',
    inputSchema:{type:'object',properties:{path:{...properties.path,default:'.'}},additionalProperties:false},
    annotations:{readOnlyHint:true},
  },
  {
    name:'job_start',
    description:'Start one managed nanosandbox command asynchronously, returning a job ID. Offline sandbox, workspace writable, 1GB memory, 180s command limit. No host terminal execution. Jobs last for the running MCP server session.',
    inputSchema:{type:'object',properties:{
      command:{type:'string',minLength:1,maxLength:160},
      args:{type:'array',items:{type:'string'},maxItems:64},
      stdin:{type:'string',maxLength:65536},
    },required:['command'],additionalProperties:false},
    annotations:{readOnlyHint:false},
  },
  ...['job_status','job_logs','job_cancel'].map(name=>({
    name,
    description:name==='job_status'?'Read managed job state by ID':name==='job_logs'?'Read bounded output from a managed job by ID':'Cancel a running managed sandbox job by ID',
    inputSchema:{type:'object',properties:{id:{type:'string',pattern:'^[a-f0-9]{24}$'},
      ...(name==='job_logs'?{tail:{type:'integer',minimum:1,maximum:100000,default:12000}}:{})},
      required:['id'],additionalProperties:false},
    annotations:{readOnlyHint:name!=='job_cancel'},
  })),
  {
    name: 'host_status',
    description: 'Read-only check of the running host launcher and SHA-256 hashes for thirteen pinned mcp-workspace source/installed files. No arbitrary path access, installation or process control. Safe to call without a grant.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true },
  },
  {
    name: 'host_maintenance',
    description: 'One-use locally approved host maintenance: reload the MCP gateway (preserving the ngrok tunnel), optionally atomically sync fourteen pinned mcp-workspace files after verifying ALL expected source hashes. Requires a 5-minute token created locally with "mcp-workspace maintenance grant". Never accepts paths, commands, or PIDs. Refresh tool schema after reload.',
    inputSchema: { type: 'object', properties: {
      action: { type: 'string', enum: ['reload', 'sync_and_reload'] },
      token: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'One-use token from the Ubuntu host terminal; do not place it in source code.' },
      expectedSources: { type: 'object', properties: {
        'bin/mcp-workspace': { type: 'string', pattern: '^[a-f0-9]{64}$' },
        'lib/launcher.js': { type: 'string', pattern: '^[a-f0-9]{64}$' },
        'lib/devtools-core.js': { type: 'string', pattern: '^[a-f0-9]{64}$' },
        'lib/devtools-server.js': { type: 'string', pattern: '^[a-f0-9]{64}$' },
        'lib/host-control.js': { type: 'string', pattern: '^[a-f0-9]{64}$' },
        'lib/devtools-v1.js': { type: 'string', pattern: '^[a-f0-9]{64}$' },
        'lib/jobs.js': { type: 'string', pattern: '^[a-f0-9]{64}$' },
        'lib/video-core.js': { type: 'string', pattern: '^[a-f0-9]{64}$' },
        'lib/video-server.js': { type: 'string', pattern: '^[a-f0-9]{64}$' },
        'lib/video-workflow.js': { type: 'string', pattern: '^[a-f0-9]{64}$' },
        'lib/video-worker.js': { type: 'string', pattern: '^[a-f0-9]{64}$' },
        'lib/resources.js': { type: 'string', pattern: '^[a-f0-9]{64}$' },
        'lib/remotion-core.js': { type: 'string', pattern: '^[a-f0-9]{64}$' },
        'lib/remotion-worker.js': { type: 'string', pattern: '^[a-f0-9]{64}$' },
      }, required: ['bin/mcp-workspace','lib/launcher.js','lib/devtools-core.js',
        'lib/devtools-server.js','lib/host-control.js','lib/devtools-v1.js','lib/jobs.js','lib/video-core.js','lib/video-server.js','lib/video-workflow.js','lib/video-worker.js','lib/resources.js','lib/remotion-core.js','lib/remotion-worker.js'], additionalProperties: false },
    }, required: ['action', 'token'], additionalProperties: false },
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
  repo_status: a => repoStatus(root, a),
  repo_diff: a => repoDiff(root, a),
  file_hash: a => {
    const file = safePath(root, a.path);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('file must be regular and at most 1 MB');
    return { path: a.path, sha256: sha(fs.readFileSync(file)), bytes: stat.size };
  },
  edit_checked: a => editChecked(root, a),
  read_lines: a => readLines(root, a),
  apply_patch: a => applyPatch(root, a),
  apply_changes: a => applyChanges(root,a),
  project_overview: a => overview(root,a),
  job_start: a => jobManager.start(a),
  job_status: a => jobManager.status(a),
  job_logs: a => jobManager.logs(a),
  job_cancel: a => jobManager.cancel(a),
  host_status: () => hostControl.hostStatus(root),
  host_maintenance: a => hostControl.maintain(root, a),
  workspace_diagnostics: () => workspaceDiagnostics(root),
});
async function processRequest(msg) {
  const { id, method, params } = msg;
  if (id == null) return null; // Notification.
  if (method === 'initialize') return { jsonrpc:'2.0', id, result: {
    protocolVersion: '2025-11-25', capabilities: { tools: { listChanged:false } },
    serverInfo: { name:'mcp-workspace-developer', version:'1.1.0' },
    instructions: 'Workspace-scoped developer tools. No shell or network access in this server. For commands use the separate nanosandbox terminal tools.',
  } };
  if (method === 'ping') return { jsonrpc:'2.0', id, result:{} };
  if (method === 'tools/list') return { jsonrpc:'2.0', id, result:{ tools: toolDefinitions } };
  if (method === 'tools/call') {
    if (!params || !Object.hasOwn(tools, params.name)) return { jsonrpc:'2.0', id, error:{code:-32602,message:'Unknown tool'} };
    try { return { jsonrpc:'2.0', id, result: text(await tools[params.name](params.arguments || {})) }; }
    catch(e) { return { jsonrpc:'2.0', id, result: { isError:true, content:[{type:'text',text:String(e?.message || e)}] } }; }
  }
  return { jsonrpc:'2.0', id, error:{code:-32601,message:'Method not found'} };
}
let buffer='';
let requestQueue = Promise.resolve();
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  if (buffer.length > 2 * 1024 * 1024) { process.stderr.write('devtools: message too large\n'); process.exit(1); }
  let index;
  while ((index=buffer.indexOf('\n')) !== -1) {
    const line=buffer.slice(0,index).trim();buffer=buffer.slice(index+1);
    if (!line) continue;
    requestQueue = requestQueue.then(async () => {
      try { const res = await processRequest(JSON.parse(line)); if (res) process.stdout.write(JSON.stringify(res)+'\n'); }
      catch(e) { process.stderr.write('devtools: invalid request: '+e.message+'\n'); }
    });
  }
});
