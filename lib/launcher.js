#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const VERSIONS = Object.freeze({ supergateway: '4.2.1', filesystem: '2.1.0', terminal: '0.3.3' });
const STARTUP_TIMEOUT_MS = 90_000;

function createConfig(workspace, nodeRoot, port) {
  const config = {
    host: '127.0.0.1', port, outputTransport: 'streamableHttp',
    mcpServers: { workspace: { mcpServers: {
      filesystem: { command: 'npx', args: ['--yes', `@modelcontextprotocol/server-filesystem@${VERSIONS.filesystem}`, workspace], toolPrefix: 'filesystem_' },
      terminal: { command: 'npx', args: ['--yes', `nanosandbox-mcp@${VERSIONS.terminal}`, '--workspace', workspace, '--read-only', nodeRoot, '--timeout', '180', '--memory', '1G', '--max-output', '1M', '--max-concurrent', '1', '--no-cache', '--env', `PATH=${nodeRoot}/bin:/usr/bin:/bin`], toolPrefix: 'terminal_' },
      developer: { command: process.execPath, args: [path.join(__dirname, 'devtools-server.js'), workspace], toolPrefix: 'developer_' }
    } } }
  };
  if (process.platform === 'linux') config.mcpServers.workspace.mcpServers.terminal.args.push('--cpu', '2', '--max-pids', '128');
  return config;
}

function parsePort(value = process.env.MCP_WORKSPACE_PORT || '8787') {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error('MCP_WORKSPACE_PORT must be a TCP port from 1 to 65535');
  return Number(value);
}
function checkPort(port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error(`port ${port} is already in use; set MCP_WORKSPACE_PORT to another port`)));
    server.listen(port, host, () => server.close(resolve));
  });
}
function checkDependencies({ nodeVersion = process.versions.node, pathValue = process.env.PATH } = {}) {
  const nodeMajor = Number(nodeVersion.split('.')[0]);
  if (!Number.isFinite(nodeMajor) || nodeMajor < 24) throw new Error(`Node.js 24 or newer is required (found ${nodeVersion})`);
  for (const command of ['npm', 'npx', 'cloudflared']) {
    if (!pathValue.split(path.delimiter).some(dir => fs.existsSync(path.join(dir || '.', command)) && fs.statSync(path.join(dir || '.', command)).isFile())) {
      throw new Error(`required command not found: ${command}`);
    }
  }
}
function nodeRoot() {
  let real = process.execPath;
  try { real = fs.realpathSync(real); } catch {}
  return path.dirname(path.dirname(real));
}
function stopChild(child, signal = 'SIGTERM') {
  if (!child) return;
  if (!child.pid) { try { child.kill?.(signal); } catch {} return; }
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} }
}
function start(command, args, logPath) {
  const fd = fs.openSync(logPath, 'a', 0o600);
  const child = spawn(command, args, { detached: true, stdio: ['ignore', fd, fd], env: process.env });
  fs.closeSync(fd);
  return child;
}
function readLog(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } }
function cleanupTemp(tempDir) { fs.rmSync(tempDir, { recursive: true, force: true }); }
function watchChild(child, name, notify) {
  child.once('error', error => notify(`${name} failed to start: ${error.message}`));
  child.once('exit', (code, signal) => notify(`${name} exited (code ${code ?? 'none'}, signal ${signal ?? 'none'})`));
}
function urlFrom(log) { return log.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/)?.[0]; }
async function rpcResult(response, id) {
  const body = await response.text();
  const values = body.split(/\n\n/).map(x => x.match(/^data:\s*(.+)$/m)?.[1]).filter(Boolean);
  const payloads = values.map(x => { try { return JSON.parse(x); } catch { return null; } });
  if (!payloads.length) { try { payloads.push(JSON.parse(body)); } catch {} }
  return payloads.find(x => x?.id === id) || null;
}

async function mcpReady(endpoint, timeout = 2_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const init = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'mcp-workspace-readiness', version: '1.0.0' } } }), signal: controller.signal });
    if (!init.ok) return false;
    const initialized = await rpcResult(init, 1);
    if (!initialized?.result?.protocolVersion) return false;
    const protocolVersion = initialized.result.protocolVersion;
    const session = init.headers.get('mcp-session-id');
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': protocolVersion, ...(session ? { 'mcp-session-id': session } : {}) };
    await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), signal: controller.signal });
    const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }), signal: controller.signal });
    if (!response.ok) return false;
    const json = await rpcResult(response, 2);
    const names = json?.result?.tools?.map(t => t.name) || [];
    return names.some(n => n.startsWith('filesystem_')) && names.some(n => n.startsWith('terminal_')) && names.some(n => n.startsWith('developer_'));
  } catch { return false; } finally { clearTimeout(timer); }
}

async function run(options = {}) {
  const validateDependencies = options.checkDependencies || checkDependencies;
  const validatePort = options.checkPort || checkPort;
  const launch = options.start || start;
  const ready = options.mcpReady || mcpReady;
  const writeOutput = options.writeOutput || (message => process.stdout.write(message));
  validateDependencies();
  const workspace = fs.realpathSync(process.cwd());
  const port = parsePort();
  await validatePort(port);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-workspace.'));
  fs.chmodSync(tempDir, 0o700);
  const configFile = path.join(tempDir, 'servers.json');
  const gatewayLog = path.join(tempDir, 'gateway.log');
  const tunnelLog = path.join(tempDir, 'cloudflared.log');
  fs.writeFileSync(configFile, `${JSON.stringify(createConfig(workspace, nodeRoot(), port), null, 2)}\n`, { mode: 0o600 });
  let gateway, tunnel, shuttingDown = false, startupTimer;
  let exitCode = 0;
  const shutdown = async (code = 0, signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    exitCode = code;
    clearTimeout(startupTimer);
    stopChild(tunnel, signal || 'SIGTERM'); stopChild(gateway, signal || 'SIGTERM');
    await Promise.all([tunnel, gateway].filter(Boolean).map(child => new Promise(resolve => { if (child.exitCode !== null || child.signalCode !== null) return resolve(); child.once('exit', resolve); setTimeout(() => { stopChild(child, 'SIGKILL'); resolve(); }, 2_000).unref(); })));
    cleanupTemp(tempDir);
    process.removeListener('SIGINT', onSigint); process.removeListener('SIGTERM', onSigterm);
    process.exitCode = exitCode;
  };
  const onSigint = () => shutdown(130);
  const onSigterm = () => shutdown(143);
  process.once('SIGINT', onSigint); process.once('SIGTERM', onSigterm);
  let resolveFailure;
  const failure = new Promise(resolve => { resolveFailure = resolve; });
  try {
    gateway = launch('npx', ['--yes', `supergateway@${VERSIONS.supergateway}`, '--config', configFile], gatewayLog);
    watchChild(gateway, 'gateway', reason => { if (!shuttingDown) resolveFailure(reason); });
    const gatewayEndpoint = `http://127.0.0.1:${port}/workspace/mcp`;
    const gatewayReady = (async () => {
      const end = Date.now() + STARTUP_TIMEOUT_MS;
      while (!shuttingDown && Date.now() < end) {
        if (await ready(gatewayEndpoint)) return true;
        await delay(500);
      }
      return false;
    })();
    const endpointOK = await Promise.race([gatewayReady, failure]);
    if (endpointOK !== true) throw new Error(typeof endpointOK === 'string' ? endpointOK : 'timed out waiting for MCP initialize and tools/list (gateway or an underlying server did not become ready)');
    tunnel = launch('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], tunnelLog);
    watchChild(tunnel, 'Cloudflare Tunnel', reason => { if (!shuttingDown) resolveFailure(reason); });
    const tunnelReady = (async () => {
      const startupEnd = Date.now() + STARTUP_TIMEOUT_MS;
      while (!shuttingDown && Date.now() < startupEnd) {
        const candidate = urlFrom(readLog(tunnelLog));
        if (candidate && await ready(`${candidate}/workspace/mcp`, 5_000)) return candidate;
        await delay(500);
      }
      return null;
    })();
    const tunnelResult = await Promise.race([
      tunnelReady.then(url => ({ ok: true, url })),
      failure.then(reason => ({ ok: false, reason }))
    ]);
    if (shuttingDown) return;
    if (!tunnelResult.ok) throw new Error(tunnelResult.reason);
    if (!tunnelResult.url) throw new Error(`timed out waiting for a valid Cloudflare Quick Tunnel MCP endpoint\n${readLog(tunnelLog).trim()}`);
    writeOutput(`MCP URL: ${tunnelResult.url}/workspace/mcp\nTransport: Streamable HTTP\nAuthentication: disabled\nPress Ctrl+C to stop.\n`);
    const earlyFailure = await Promise.race([failure, new Promise(resolve => { const monitor = setInterval(() => {
      if (gateway.exitCode !== null) { clearInterval(monitor); resolve('gateway process stopped'); }
      else if (tunnel.exitCode !== null) { clearInterval(monitor); resolve('Cloudflare Tunnel process stopped'); }
    }, 200); })]);
    throw new Error(earlyFailure);
  } catch (error) {
    if (!shuttingDown) {
      process.stderr.write(`mcp-workspace: ${error.message}\n`);
      if (gateway && error.message.includes('gateway')) process.stderr.write(`${readLog(gatewayLog)}\n`);
      if (tunnel && error.message.toLowerCase().includes('tunnel')) process.stderr.write(`${readLog(tunnelLog)}\n`);
      await shutdown(1);
    }
  }
}

if (require.main === module) run().catch(error => { process.stderr.write(`mcp-workspace: ${error.message}\n`); process.exitCode = 1; });
module.exports = { VERSIONS, createConfig, parsePort, checkPort, checkDependencies, mcpReady, watchChild, cleanupTemp, run };
