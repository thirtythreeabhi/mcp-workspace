#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const hostControl = require('./host-control');


const VERSIONS = Object.freeze({ supergateway: '4.2.1', filesystem: '2.1.0', terminal: '0.3.3' });
const STARTUP_TIMEOUT_MS = 90_000;

function ollamaToken(env = process.env) {
  const direct = typeof env.MCP_WORKSPACE_OLLAMA_TOKEN === 'string' ? env.MCP_WORKSPACE_OLLAMA_TOKEN.trim() : '';
  if (direct) return direct;
  try { return fs.readFileSync(path.join(os.homedir(), '.config', 'mcp-workspace', 'ollama-token'), 'utf8').trim(); }
  catch { return ''; }
}

function createConfig(workspace, nodeRoot, port, env = process.env) {
  const config = {
    host: '127.0.0.1', port, outputTransport: 'streamableHttp',
    mcpServers: { workspace: { mcpServers: {
      filesystem: { command: 'npx', args: ['--yes', '--prefer-offline', `@modelcontextprotocol/server-filesystem@${VERSIONS.filesystem}`, workspace], toolPrefix: 'filesystem_' },
      terminal: { command: 'npx', args: ['--yes', '--prefer-offline', `nanosandbox-mcp@${VERSIONS.terminal}`, '--workspace', workspace, '--read-only', nodeRoot, '--no-cache', '--env', `PATH=${nodeRoot}/bin:/usr/bin:/bin`], toolPrefix: 'terminal_' },
      developer: { command: process.execPath, args: [path.join(__dirname, 'devtools-server.js'), workspace], toolPrefix: 'developer_' },
      ollama: { command: process.execPath, args: [path.join(__dirname, 'ollama-server.js')],
        env: { MCP_WORKSPACE_OLLAMA_TOKEN: ollamaToken(env) }, toolPrefix: 'ollama_' }
    } },
      video: { command: process.execPath, args: [path.join(__dirname, 'video-server.js'), workspace],
        env: { MCP_WORKSPACE_REMOTION_HOST_ENABLED: '1' }, toolPrefix: 'video_' }
    }
  };
  return config;
}

/**
 * Quick tunnels have ephemeral URLs. Named Cloudflare tunnels and ngrok's
 * account-assigned development domains can retain a hostname across restarts.
 * Cloudflare credentials and ngrok authentication stay in their own agents.
 */
function parseHttpsOrigin(value, setting) {
  let address;
  try { address = new URL(value); } catch { throw new Error(setting + ' must be an HTTPS origin'); }
  if (address.protocol !== 'https:' || !address.hostname || address.username || address.password ||
      address.search || address.hash || address.pathname !== '/' || address.port) {
    throw new Error(setting + ' must be an HTTPS origin without path, credentials, query, hash or port');
  }
  return address.origin;
}
function tunnelSettings(env = process.env) {
  const ngrokUrl = env.MCP_WORKSPACE_NGROK_URL;
  const name = env.MCP_WORKSPACE_TUNNEL_NAME;
  const publicUrl = env.MCP_WORKSPACE_PUBLIC_URL;
  const configFile = env.MCP_WORKSPACE_TUNNEL_CONFIG;
  if (ngrokUrl) {
    if (name || publicUrl || configFile) throw new Error('ngrok and Cloudflare named tunnel settings cannot be combined');
    const publicOrigin = parseHttpsOrigin(ngrokUrl, 'MCP_WORKSPACE_NGROK_URL');
    if (!/(?:^|\.)(?:ngrok-free\.(?:app|dev)|ngrok\.app|ngrok\.io)$/.test(new URL(publicOrigin).hostname)) {
      throw new Error('MCP_WORKSPACE_NGROK_URL must be your assigned ngrok hostname');
    }
    return { mode: 'ngrok', publicUrl: publicOrigin };
  }
  if (!name && !publicUrl && !configFile) return { mode: 'quick' };
  if (!name || !publicUrl || !configFile) {
    throw new Error('named tunnel requires MCP_WORKSPACE_TUNNEL_NAME, MCP_WORKSPACE_PUBLIC_URL and MCP_WORKSPACE_TUNNEL_CONFIG');
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name)) throw new Error('invalid MCP_WORKSPACE_TUNNEL_NAME');
  const publicOrigin = parseHttpsOrigin(publicUrl, 'MCP_WORKSPACE_PUBLIC_URL');
  const resolvedConfig = path.resolve(configFile);
  if (!fs.statSync(resolvedConfig, { throwIfNoEntry: false })?.isFile()) {
    throw new Error('MCP_WORKSPACE_TUNNEL_CONFIG must point to an existing local cloudflared YAML config');
  }
  return { mode: 'named', name, publicUrl: publicOrigin, configFile: resolvedConfig };
}
function tunnelArgs(settings, port) {
  if (settings.mode === 'ngrok') return ['http', String(port), '--url', settings.publicUrl];
  if (settings.mode === 'named') return ['tunnel', '--no-autoupdate', '--config', settings.configFile, 'run', settings.name];
  return ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`];
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
function checkDependencies({ nodeVersion = process.versions.node, pathValue = process.env.PATH, tunnelMode = 'quick' } = {}) {
  const nodeMajor = Number(nodeVersion.split('.')[0]);
  if (!Number.isFinite(nodeMajor) || nodeMajor < 24) throw new Error(`Node.js 24 or newer is required (found ${nodeVersion})`);
  for (const command of ['npm', 'npx', tunnelMode === 'ngrok' ? 'ngrok' : 'cloudflared']) {
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
  const child = spawn(command, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  let pending = '';
  const forward = chunk => {
    fs.writeSync(fd, chunk);
    pending += chunk.toString('utf8');
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || '';
    for (const line of lines) {
      const call = line.match(/\[video\].*StreamableHttp → Child: .*"method":"tools\/call".*"name":"([a-z_]+)"/);
      const event = line.match(/video-mcp event: (.+)$/);
      if (call) process.stderr.write(`[video] tool call: ${call[1]}\n`);
      else if (event) process.stderr.write(`[video] ${event[1]}\n`);
    }
  };
  child.stdout.on('data', forward);
  child.stderr.on('data', forward);
  child.once('close', () => { if (pending) forward(Buffer.from('\n')); fs.closeSync(fd); });
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
    const requiredVideo = ['video_capabilities', 'video_probe', 'video_preview_frame', 'video_contact_sheet', 'video_review', 'video_audio_timing', 'video_project_state', 'video_remotion_compositions', 'video_remotion_status', 'video_remotion_install_start', 'video_remotion_render_start', 'video_timeline_save', 'video_timeline_read', 'video_render_start', 'video_render_status', 'video_render_logs', 'video_render_cancel'];
    if (endpoint.endsWith('/video/mcp')) return requiredVideo.every(name => names.includes(name));
    const requiredDeveloper = ['developer_code_search', 'developer_read_lines', 'developer_apply_patch', 'developer_apply_changes', 'developer_project_overview', 'developer_job_start', 'developer_job_status', 'developer_job_logs', 'developer_job_cancel', 'developer_host_status', 'developer_host_maintenance'];
    const requiredOllama = ['ollama_list_models', 'ollama_chat'];
    return names.some(n => n.startsWith('filesystem_')) && names.some(n => n.startsWith('terminal_')) && requiredDeveloper.every(name => names.includes(name)) && requiredOllama.every(name => names.includes(name));
  } catch { return false; } finally { clearTimeout(timer); }
}

async function run(options = {}) {
  const validateDependencies = options.checkDependencies || checkDependencies;
  const validatePort = options.checkPort || checkPort;
  const launch = options.start || start;
  const ready = options.mcpReady || mcpReady;
  const writeOutput = options.writeOutput || (message => process.stdout.write(message));
  const writeProgress = options.writeProgress || (message => process.stderr.write(message));
  const startedAt = Date.now();
  const progress = message => writeProgress(`[+${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${message}\n`);
  const tunnel = tunnelSettings(options.environment || process.env);
  validateDependencies({ tunnelMode: tunnel.mode });
  const workspace = fs.realpathSync(process.cwd());
  const port = parsePort();
  await validatePort(port);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-workspace.'));
  fs.chmodSync(tempDir, 0o700);
  const configFile = path.join(tempDir, 'servers.json');
  const gatewayLog = path.join(tempDir, 'gateway.log');
  const tunnelLog = path.join(tempDir, 'tunnel.log');
  fs.writeFileSync(configFile, `${JSON.stringify(createConfig(workspace, nodeRoot(), port), null, 2)}\n`, { mode: 0o600 });
  const hostOptions = { port, ...(options.hostControlOptions || {}) };
  const hostRegistration = options.hostControlEnabled === false ? null : hostControl.registerInstance(hostOptions);
  let gateway, tunnelProcess, shuttingDown = false, startupTimer, reloading = false;
  let exitCode = 0;
  const shutdown = async (code = 0, signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    exitCode = code;
    clearTimeout(startupTimer);
    stopChild(tunnelProcess, signal || 'SIGTERM'); stopChild(gateway, signal || 'SIGTERM');
    await Promise.all([tunnelProcess, gateway].filter(Boolean).map(child => new Promise(resolve => { if (child.exitCode !== null || child.signalCode !== null) return resolve(); child.once('exit', resolve); setTimeout(() => { stopChild(child, 'SIGKILL'); resolve(); }, 2_000).unref(); })));
    cleanupTemp(tempDir);
    if (hostRegistration) hostControl.unregisterInstance(hostRegistration, hostOptions);
    process.removeListener('SIGINT', onSigint); process.removeListener('SIGTERM', onSigterm);
    process.removeListener('SIGUSR2', onReload);
    process.exitCode = exitCode;
  };
  const onSigint = () => shutdown(130);
  const onSigterm = () => shutdown(143);
  process.once('SIGINT', onSigint); process.once('SIGTERM', onSigterm);
  let resolveFailure;
  const failure = new Promise(resolve => { resolveFailure = resolve; });
  const watchGateway = child => watchChild(child, 'gateway', reason => {
    if (!shuttingDown && !reloading) resolveFailure(reason);
  });
  const onReload = () => {
    if (shuttingDown || reloading || !gateway) return;
    reloading = true;
    (async () => {
      const old = gateway;
      stopChild(old);
      await new Promise(resolve => {
        if (old.exitCode !== null || old.signalCode !== null) return resolve();
        old.once('exit', resolve);
        setTimeout(() => { stopChild(old, 'SIGKILL'); resolve(); }, 2_000).unref();
      });
      if (shuttingDown) return;
      gateway = launch('npx', ['--yes', '--prefer-offline', `supergateway@${VERSIONS.supergateway}`, '--config', configFile], gatewayLog);
      watchGateway(gateway);
      const deadline = Date.now() + STARTUP_TIMEOUT_MS;
      while (!shuttingDown && Date.now() < deadline) {
        if (await ready(`http://127.0.0.1:${port}/workspace/mcp`) && await ready(`http://127.0.0.1:${port}/video/mcp`)) {
          progress('Gateway reloaded; refresh ChatGPT tool schema');
          return;
        }
        await delay(500);
      }
      if (!shuttingDown) throw new Error('gateway reload failed readiness check');
    })().catch(error => { if (!shuttingDown) resolveFailure(error.message); })
      .finally(() => { reloading = false; });
  };
  if (hostRegistration) process.on('SIGUSR2', onReload);
  try {
    // Start the selected tunnel immediately rather than after gateway readiness.
    // Both probes run concurrently; the URL is announced only after BOTH pass.
    const tunnelCommand = tunnel.mode === 'ngrok' ? 'ngrok' : 'cloudflared';
    const tunnelLabel = tunnel.mode === 'ngrok' ? 'ngrok' : 'Cloudflare Tunnel';
    progress('Starting MCP gateway and ' + tunnelLabel + ' concurrently');
    gateway = launch('npx', ['--yes', '--prefer-offline', `supergateway@${VERSIONS.supergateway}`, '--config', configFile], gatewayLog);
    watchGateway(gateway);
    tunnelProcess = launch(tunnelCommand, tunnelArgs(tunnel, port), tunnelLog);
    watchChild(tunnelProcess, tunnelLabel, reason => { if (!shuttingDown) resolveFailure(reason); });

    const pollUntilReady = async (probe, timeoutMs) => {
      const end = Date.now() + timeoutMs;
      while (!shuttingDown && Date.now() < end) {
        const result = await probe();
        if (result) return result;
        await delay(500);
      }
      return null;
    };
    const gatewayEndpoint = `http://127.0.0.1:${port}/workspace/mcp`;
    const gatewayReady = pollUntilReady(async () => {
      if (!await ready(gatewayEndpoint) || !await ready(`http://127.0.0.1:${port}/video/mcp`)) return null;
      progress('Local gateway MCP initialize + tools/list verified');
      return true;
    }, STARTUP_TIMEOUT_MS);

    const publicReady = pollUntilReady(async () => {
      const url = tunnel.mode === 'quick' ? urlFrom(readLog(tunnelLog)) : tunnel.publicUrl;
      if (!url || !await ready(`${url}/workspace/mcp`, 5_000) || !await ready(`${url}/video/mcp`, 5_000)) return null;
      progress('Public MCP initialize + tools/list verified');
      return url;
    }, STARTUP_TIMEOUT_MS);
    const result = await Promise.race([
      Promise.all([gatewayReady, publicReady]).then(([local, url]) => ({ ok: true, local, url })),
      failure.then(reason => ({ ok: false, reason }))
    ]);
    if (shuttingDown) return;
    if (!result.ok) throw new Error(result.reason);
    if (!result.local) throw new Error('timed out waiting for local MCP initialization and tools/list');
    if (!result.url) throw new Error(`timed out waiting for public MCP endpoint\n${readLog(tunnelLog).trim()}`);
    progress(`Ready in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    writeOutput(`MCP URL: ${result.url}/workspace/mcp\nVideo MCP URL: ${result.url}/video/mcp\nTransport: Streamable HTTP\nAuthentication: disabled\nTunnel mode: ${tunnel.mode}\nPress Ctrl+C to stop.\n`);
    const earlyFailure = await Promise.race([failure, new Promise(resolve => { const monitor = setInterval(() => {
      if (!reloading && gateway.exitCode !== null) { clearInterval(monitor); resolve('gateway process stopped'); }
      else if (tunnelProcess.exitCode !== null) { clearInterval(monitor); resolve('Cloudflare Tunnel process stopped'); }
    }, 200); })]);
    throw new Error(earlyFailure);
  } catch (error) {
    if (!shuttingDown) {
      process.stderr.write(`mcp-workspace: ${error.message}\n`);
      if (gateway && error.message.includes('gateway')) process.stderr.write(`${readLog(gatewayLog)}\n`);
      if (tunnelProcess && error.message.toLowerCase().includes('tunnel')) process.stderr.write(`${readLog(tunnelLog)}\n`);
      await shutdown(1);
    }
  }
}

if (require.main === module) {
  if (process.argv[2] === 'maintenance' && process.argv[3] === 'grant' && process.argv.length === 4) {
    try {
      const grant = hostControl.grantMaintenance();
      process.stdout.write(`One-use maintenance token (expires in 5 minutes): ${grant.token}\n`);
      process.stdout.write('Only share this token for the specific maintenance operation you approve.\n');
    } catch (error) { process.stderr.write(`mcp-workspace: ${error.message}\n`); process.exitCode = 1; }
  } else if (process.argv.length > 2) {
    process.stderr.write('Usage: mcp-workspace [maintenance grant]\n');
    process.exitCode = 2;
  } else run().catch(error => { process.stderr.write(`mcp-workspace: ${error.message}\n`); process.exitCode = 1; });
}
module.exports = { VERSIONS, createConfig, parsePort, tunnelSettings, tunnelArgs, checkPort, checkDependencies, mcpReady, watchChild, cleanupTemp, run };
