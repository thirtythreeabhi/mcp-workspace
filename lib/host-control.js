'use strict';

// Restricted maintenance for this MCP installation. Never accepts shell commands,
// arbitrary paths, target PIDs, or filenames from remote callers.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const FILES = Object.freeze([
  ['bin/mcp-workspace', 'mcp-workspace', 0o755],
  ['lib/launcher.js', 'launcher.js', 0o644],
  ['lib/devtools-core.js', 'devtools-core.js', 0o644],
  ['lib/devtools-server.js', 'devtools-server.js', 0o644],
  ['lib/host-control.js', 'host-control.js', 0o644],
  ['lib/devtools-v1.js', 'devtools-v1.js', 0o644],
  ['lib/jobs.js', 'jobs.js', 0o644],
  ['lib/video-core.js', 'video-core.js', 0o644],
  ['lib/video-server.js', 'video-server.js', 0o644],
  ['lib/video-workflow.js', 'video-workflow.js', 0o644],
  ['lib/video-worker.js', 'video-worker.js', 0o644],
  ['lib/resources.js', 'resources.js', 0o644],
  ['lib/remotion-core.js', 'remotion-core.js', 0o644],
  ['lib/remotion-worker.js', 'remotion-worker.js', 0o644],
]);
const GRANT_TTL_MS = 5 * 60_000;
function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function stateDirectory(options = {}, create = false) {
  const dir = options.stateDir || path.join(os.homedir(), '.local', 'state', 'mcp-workspace');
  if (create) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(dir)) return dir;
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error('unsafe maintenance state directory');
  return dir;
}
function portNumber(options = {}) {
  const value = options.port ?? process.env.MCP_WORKSPACE_PORT ?? '8787';
  if (!/^\d+$/.test(String(value)) || Number(value) < 1 || Number(value) > 65535) throw new Error('invalid MCP port');
  return Number(value);
}
function paths(options = {}, create = false) {
  const dir = stateDirectory(options, create), port = portNumber(options);
  return {
    registration: path.join(dir, 'instance-' + port + '.json'),
    grant: path.join(dir, 'grant-' + port + '.json'),
  };
}
function writePrivate(file, object) {
  const tmp = file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(object) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}
function readRecord(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 4096 || (st.mode & 0o077)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}
function processStartTicks(pid) {
  if (process.platform !== 'linux') return null;
  try {
    const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]; // field 22
  } catch { return null; }
}
function liveInstance(options = {}) {
  const data = readRecord(paths(options).registration);
  if (!data || !Number.isSafeInteger(data.pid) || data.pid < 2 ||
      typeof data.instanceId !== 'string' || !/^[a-f0-9]{32}$/.test(data.instanceId)) return null;
  try { process.kill(data.pid, 0); } catch { return null; }
  if (process.platform === 'linux' && (!data.startTicks || processStartTicks(data.pid) !== data.startTicks)) return null;
  return data;
}
function registerInstance(options = {}) {
  const data = { pid: process.pid, instanceId: crypto.randomBytes(16).toString('hex'), startTicks: processStartTicks(process.pid) };
  writePrivate(paths(options, true).registration, data);
  return data;
}
function unregisterInstance(data, options = {}) {
  const file = paths(options).registration;
  if (readRecord(file)?.instanceId === data.instanceId) fs.unlinkSync(file);
}
function grantMaintenance(options = {}) {
  const instance = liveInstance(options);
  if (!instance) throw new Error('No running mcp-workspace launcher is registered for this port');
  const token = crypto.randomBytes(32).toString('hex');
  writePrivate(paths(options).grant, {
    tokenHash: sha(token), instanceId: instance.instanceId, expiresAt: Date.now() + GRANT_TTL_MS,
  });
  return { token, expiresInSeconds: GRANT_TTL_MS / 1000, port: portNumber(options) };
}
function validateGrant(token, options = {}) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('MAINTENANCE_NOT_AUTHORIZED');
  const file = paths(options).grant;
  const grant = readRecord(file);
  const instance = liveInstance(options);
  if (!grant || !instance || grant.instanceId !== instance.instanceId ||
      !Number.isFinite(grant.expiresAt) || grant.expiresAt < Date.now() ||
      typeof grant.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(grant.tokenHash)) {
    throw new Error('MAINTENANCE_NOT_AUTHORIZED');
  }
  if (!crypto.timingSafeEqual(Buffer.from(sha(token), 'hex'), Buffer.from(grant.tokenHash, 'hex')))
    throw new Error('MAINTENANCE_NOT_AUTHORIZED');
  return { instance, file };
}
function consumeGrant(grant) {
  const used = grant.file + '.' + crypto.randomBytes(8).toString('hex') + '.used';
  fs.renameSync(grant.file, used); // only one operation can consume the grant
  fs.unlinkSync(used);
}
function sourceDirectory(workspace) {
  const realWorkspace = fs.realpathSync(workspace);
  const candidate = fs.existsSync(path.join(realWorkspace, 'package.json')) ? realWorkspace :
    path.join(realWorkspace, 'mcp-workspace');
  const dir = fs.realpathSync(candidate);
  if (dir !== realWorkspace && !dir.startsWith(realWorkspace + path.sep))
    throw new Error('source checkout must be inside the workspace');
  const packageFile = path.join(dir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  if (pkg.name !== 'mcp-workspace') throw new Error('source is not mcp-workspace');
  return dir;
}
function installLocations(options = {}) {
  const bin = path.resolve(options.installDir || process.env.MCP_WORKSPACE_INSTALL_DIR ||
    path.join(os.homedir(), '.local', 'bin'));
  return { bin, lib: path.resolve(bin, '..', 'lib', 'mcp-workspace') };
}
function regularFile(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 1024 * 1024)
      throw new Error('unsafe maintenance file: ' + file);
    return { sha256: sha(fs.readFileSync(file)), bytes: st.size };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
function fileEntries(workspace, options = {}) {
  const source = sourceDirectory(workspace);
  const dest = installLocations(options);
  return FILES.map(([relative, installedName, mode]) => {
    const from = path.join(source, relative);
    const to = path.join(relative.startsWith('bin/') ? dest.bin : dest.lib, installedName);
    return { relative, from, to, mode, source: regularFile(from), installed: regularFile(to) };
  });
}
function hostStatus(workspace, options = {}) {
  const instance = liveInstance(options);
  return {
    running: Boolean(instance),
    port: portNumber(options),
    files: fileEntries(workspace, options).map(({ relative, source, installed }) => ({
      file: relative, sourceSha256: source?.sha256 || null, installedSha256: installed?.sha256 || null,
      matches: Boolean(source && installed && source.sha256 === installed.sha256),
    })),
  };
}
function atomicCopy(bytes, to, mode) {
  const dir = path.dirname(to);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const parent = fs.lstatSync(dir);
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('unsafe install directory');
  const existing = regularFile(to);
  if (existing === null && fs.existsSync(to)) throw new Error('unsafe installed destination');
  const temp = path.join(dir, '.mcp-workspace-' + crypto.randomBytes(10).toString('hex'));
  try {
    fs.writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 });
    fs.chmodSync(temp, mode);
    fs.renameSync(temp, to);
  } finally { try { fs.unlinkSync(temp); } catch {} }
}
function maintain(workspace, args, options = {}) {
  if (!args || !['reload', 'sync_and_reload'].includes(args.action)) throw new Error('invalid maintenance action');
  const grant = validateGrant(args.token, options);
  let entries = [];
  if (args.action === 'sync_and_reload') {
    entries = fileEntries(workspace, options);
    const expected = args.expectedSources;
    if (!expected || typeof expected !== 'object' || Array.isArray(expected) ||
        Object.keys(expected).sort().join(',') !== FILES.map(x => x[0]).sort().join(','))
      throw new Error('expectedSources must contain all pinned source paths');
    for (const entry of entries) {
      if (!entry.source || !/^[a-f0-9]{64}$/.test(expected[entry.relative]) ||
          entry.source.sha256 !== expected[entry.relative]) throw new Error('STALE_SOURCE: ' + entry.relative);
      // Capture approved bytes now, rather than reading mutable files again while installing.
      entry.approvedBytes = fs.readFileSync(entry.from);
      if (sha(entry.approvedBytes) !== expected[entry.relative]) throw new Error('STALE_SOURCE: ' + entry.relative);
    }
  }
  consumeGrant(grant);
  if (args.action === 'sync_and_reload') for (const entry of entries) atomicCopy(entry.approvedBytes, entry.to, entry.mode);
  const signal = options.signal || ((pid) => process.kill(pid, 'SIGUSR2'));
  // Respond to the tool call before the gateway disconnects for its reload.
  setTimeout(() => signal(grant.instance.pid), options.delayMs ?? 900).unref();
  return { accepted: true, action: args.action, filesUpdated: entries.map(x => x.relative), gatewayReloadScheduled: true,
    note: 'The tunnel stays running. Refresh the ChatGPT tool schema after the gateway reload.' };
}
module.exports = { FILES, stateDirectory, registerInstance, unregisterInstance, grantMaintenance, liveInstance,
  hostStatus, maintain, paths, sha };
