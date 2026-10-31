'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { createConfig, parsePort, tunnelSettings, tunnelArgs, checkPort, checkDependencies, mcpReady, VERSIONS } = require('../lib/launcher');

test('dependency validation enforces Node 24 and required commands', t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-workspace-deps-test-'));
  t.after(() => fs.rmSync(fakeBin, { recursive: true, force: true }));

  assert.throws(() => checkDependencies({ nodeVersion: '22.22.1', pathValue: '' }), /Node.js 24 or newer/);
  assert.throws(() => checkDependencies({ nodeVersion: '24.0.0', pathValue: '' }), /required command not found: npm/);
  for (const name of ['npm', 'npx', 'cloudflared']) fs.writeFileSync(path.join(fakeBin, name), '');
  assert.doesNotThrow(() => checkDependencies({ nodeVersion: '24.0.0', pathValue: fakeBin }));
  fs.rmSync(path.join(fakeBin, 'cloudflared'));
  assert.throws(() => checkDependencies({ nodeVersion: '24.0.0', pathValue: fakeBin }), /required command not found: cloudflared/);
  assert.throws(() => checkDependencies({ nodeVersion: '24.0.0', pathValue: fakeBin, tunnelMode: 'ngrok' }), /required command not found: ngrok/);
  fs.writeFileSync(path.join(fakeBin, 'ngrok'), '');
  assert.doesNotThrow(() => checkDependencies({ nodeVersion: '24.0.0', pathValue: fakeBin, tunnelMode: 'ngrok' }));
});

test('configuration pins packages and retains sandbox boundaries', () => {
  const c = createConfig('/work', '/usr/local', 8787);
  const servers = c.mcpServers.workspace.mcpServers;
  assert.equal(c.host, '127.0.0.1'); assert.equal(c.port, 8787);
  assert.ok(servers.filesystem.args.includes('--prefer-offline'));
  assert.ok(servers.filesystem.args.some(value => /@2\.1\.0$/.test(value)));
  assert.ok(servers.terminal.args.includes('--prefer-offline'));
  assert.ok(servers.terminal.args.some(value => /@0\.3\.3$/.test(value)));
  assert.ok(servers.filesystem.args.includes('/work'));
  assert.ok(servers.terminal.args.includes('--read-only'));
  assert.equal(servers.developer.command, process.execPath);
  assert.match(servers.developer.args[0], /devtools-server\.js$/);
  assert.equal(VERSIONS.supergateway, '4.2.1');
});

test('quick and named tunnel settings are validated', t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-tunnel-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = path.join(dir, 'config.yml');
  fs.writeFileSync(config, 'tunnel: example\n');
  assert.deepEqual(tunnelSettings({}), { mode: 'quick' });
  assert.deepEqual(tunnelArgs({ mode: 'quick' }, 8787), ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:8787']);
  const ngrok = tunnelSettings({ MCP_WORKSPACE_NGROK_URL: 'https://assigned.ngrok-free.app' });
  assert.deepEqual(ngrok, { mode: 'ngrok', publicUrl: 'https://assigned.ngrok-free.app' });
  assert.deepEqual(tunnelArgs(ngrok, 8787), ['http', '8787', '--url', 'https://assigned.ngrok-free.app']);
  assert.equal(tunnelSettings({ MCP_WORKSPACE_NGROK_URL: 'https://assigned.ngrok-free.dev' }).mode, 'ngrok');
  assert.throws(() => tunnelSettings({ MCP_WORKSPACE_NGROK_URL: 'http://assigned.ngrok-free.app' }), /HTTPS/);
  assert.throws(() => tunnelSettings({ MCP_WORKSPACE_NGROK_URL: 'https://other-domain.example.com' }), /assigned ngrok hostname/);
  assert.throws(() => tunnelSettings({ MCP_WORKSPACE_NGROK_URL: 'https://assigned.ngrok-free.app/unsafe' }), /HTTPS/);
  assert.throws(() => tunnelSettings({ MCP_WORKSPACE_NGROK_URL: 'https://assigned.ngrok-free.app', MCP_WORKSPACE_TUNNEL_NAME: 'cloud' }), /cannot be combined/);
  const env = { MCP_WORKSPACE_TUNNEL_NAME: 'my-tunnel', MCP_WORKSPACE_PUBLIC_URL: 'https://mcp.example.com',
    MCP_WORKSPACE_TUNNEL_CONFIG: config };
  const named = tunnelSettings(env);
  assert.equal(named.mode, 'named');
  assert.equal(named.publicUrl, 'https://mcp.example.com');
  assert.deepEqual(tunnelArgs(named, 8787), ['tunnel', '--no-autoupdate', '--config', config, 'run', 'my-tunnel']);
  assert.throws(() => tunnelSettings({ MCP_WORKSPACE_TUNNEL_NAME: 'my-tunnel' }), /requires/);
  assert.throws(() => tunnelSettings({ ...env, MCP_WORKSPACE_PUBLIC_URL: 'http://mcp.example.com' }), /HTTPS/);
  assert.throws(() => tunnelSettings({ ...env, MCP_WORKSPACE_PUBLIC_URL: 'https://mcp.example.com/unsafe' }), /HTTPS/);
  assert.throws(() => tunnelSettings({ ...env, MCP_WORKSPACE_TUNNEL_CONFIG: path.join(dir, 'missing.yml') }), /config/);
});

test('occupied and invalid ports are detected', async () => {
  const server = net.createServer().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const port = server.address().port;
  await assert.rejects(checkPort(port), /already in use/);
  await new Promise(resolve => server.close(resolve));
  await assert.doesNotReject(checkPort(port));
  assert.throws(() => parsePort('nope'), /MCP_WORKSPACE_PORT/);
  assert.throws(() => parsePort('65536'), /MCP_WORKSPACE_PORT/);
  assert.equal(parsePort('9900'), 9900);
});

test('MCP readiness requires initialize and both prefixed tool families', async t => {
  const original = global.fetch;
  let step = 0;
  global.fetch = async (_url, options) => {
    step++;
    if (step > 1) assert.equal(options.headers['mcp-protocol-version'], '2025-11-25');
    if (step === 1) return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-11-25' } }), { status: 200, headers: { 'mcp-session-id': 'test' } });
    if (step === 2) return new Response(null, { status: 202 });
    return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'filesystem_read_file' }, { name: 'terminal_run' }, { name: 'developer_code_search' }, { name: 'developer_read_lines' }, { name: 'developer_apply_patch' }, { name: 'developer_apply_changes' }, { name: 'developer_project_overview' }, { name: 'developer_job_start' }, { name: 'developer_job_status' }, { name: 'developer_job_logs' }, { name: 'developer_job_cancel' }, { name: 'developer_host_status' }, { name: 'developer_host_maintenance' }] } })}\n\n`, { status: 200 });
  };
  t.after(() => { global.fetch = original; });
  assert.equal(await mcpReady('http://127.0.0.1:8787/workspace/mcp'), true);
});

test('MCP readiness rejects failed initialization or missing tools', async t => {
  const original = global.fetch;
  global.fetch = async () => new Response('unsupported protocol', { status: 400 });
  t.after(() => { global.fetch = original; });
  assert.equal(await mcpReady('http://127.0.0.1:8787/workspace/mcp'), false);
});

test('gateway and tunnel startup or runtime exits are reported to supervision', async () => {
  const { EventEmitter } = require('node:events');
  const { watchChild } = require('../lib/launcher');
  for (const name of ['gateway', 'Cloudflare Tunnel']) {
    const child = new EventEmitter();
    const failure = new Promise(resolve => watchChild(child, name, resolve));
    child.emit('exit', 1, null);
    assert.match(await failure, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  const failedStart = new EventEmitter();
  const failure = new Promise(resolve => watchChild(failedStart, 'gateway', resolve));
  failedStart.emit('error', new Error('mock launch failure'));
  assert.match(await failure, /failed to start.*mock launch failure/);
});

test('temporary config and logs are removed on cleanup', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { cleanupTemp } = require('../lib/launcher');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-workspace-test-'));
  fs.writeFileSync(path.join(dir, 'servers.json'), '{}');
  fs.writeFileSync(path.join(dir, 'gateway.log'), 'mock');
  cleanupTemp(dir);
  assert.equal(fs.existsSync(dir), false);
});

function mockChild() {
  const { EventEmitter } = require('node:events');
  const child = new EventEmitter();
  child.exitCode = null; child.signalCode = null;
  child.kill = signal => { child.signalCode = signal; child.exitCode = 0; child.emit('exit', 0, signal); };
  return child;
}

async function runWithMocks({ crash, signal, assertParallel = false, named = false, ngrok = false, reload = false } = {}) {
  const fs = require('node:fs');
  const path = require('node:path');
  const children = {};
  const tunnelCommand = ngrok ? 'ngrok' : 'cloudflared';
  let configDir;
  let stdout = '';
  const startOrder = [];
  const tmpConfig = named ? require('node:path').join(require('node:os').tmpdir(), 'mcp-test-named-' + process.pid + '.yml') : null;
  const stateDir = reload ? fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'mcp-reload-test-')) : null;
  if (tmpConfig) fs.writeFileSync(tmpConfig, 'tunnel: demo\n');
  const oldExit = process.exitCode;
  const run = require('../lib/launcher').run({
    checkDependencies() {}, checkPort: async () => {}, hostControlEnabled: reload,
    hostControlOptions: stateDir ? { stateDir } : {},
    environment: ngrok ? { MCP_WORKSPACE_NGROK_URL: 'https://assigned.ngrok-free.app' } :
      named ? { MCP_WORKSPACE_TUNNEL_NAME: 'persistent',
      MCP_WORKSPACE_PUBLIC_URL: 'https://mcp.example.com',
      MCP_WORKSPACE_TUNNEL_CONFIG: tmpConfig } : {},
    mcpReady: async endpoint => {
      if (assertParallel) assert.deepEqual(startOrder, ['npx', 'cloudflared'],
        'both processes should start before either readiness probe');
      if (crash === 'gateway-during-tunnel' && endpoint.startsWith('https://')) return new Promise(() => {});
      return true;
    },
    writeOutput(message) { stdout += message; },
    writeProgress() {},
    start(command, args, logPath) {
      startOrder.push(command);
      const child = mockChild();
      children[command] = child;
      if (command === 'npx') {
        configDir = path.dirname(args[args.indexOf('--config') + 1]);
        if (crash === 'gateway-start') setTimeout(() => { child.exitCode = 1; child.emit('exit', 1, null); }, 20);
      } else {
        fs.writeFileSync(logPath, 'https://mock-tunnel.trycloudflare.com\n');
        if (crash === 'tunnel-start') setTimeout(() => child.emit('error', new Error('mock tunnel startup failure')), 20);
        if (crash === 'gateway-during-tunnel') setTimeout(() => {
          children.npx.exitCode = 1;
          children.npx.emit('exit', 1, null);
        }, 20);
      }
      return child;
    }
  });
  if (reload) {
    setTimeout(() => {
      const listener = process.listeners('SIGUSR2').find(fn => fn.name === 'onReload');
      assert.ok(listener, 'launcher registered its reload handler');
      listener();
    }, 45);
    setTimeout(() => { const c = children[tunnelCommand]; c.exitCode = 1; c.emit('exit', 1, null); }, 110);
  }
  if (signal) setTimeout(() => process.emit(signal), 40);
  else if (crash === 'gateway-runtime' || crash === 'tunnel-runtime') setTimeout(() => {
    const child = children[crash === 'gateway-runtime' ? 'npx' : tunnelCommand];
    if (child) { child.exitCode = 1; child.emit('exit', 1, null); }
  }, 40);
  try { await run; return { code: process.exitCode, children, configDir, stdout, exists: fs.existsSync(configDir), startOrder }; }
  finally { process.exitCode = oldExit; if (tmpConfig) fs.rmSync(tmpConfig, { force: true });
    if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true }); }
}

test('gateway and tunnel startup failures exit nonzero and clean temporary files', async () => {
  for (const scenario of ['gateway-start', 'tunnel-start']) {
    const result = await runWithMocks({ crash: scenario });
    assert.equal(result.code, 1, `${scenario} should return failure`);
    assert.equal(result.exists, false, 'temporary files should be removed');
  }
});

test('gateway crash while tunnel initializes cannot be printed as an MCP URL', async () => {
  const result = await runWithMocks({ crash: 'gateway-during-tunnel' });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '', 'must not announce a URL when the gateway crashed');
  assert.equal(result.exists, false, 'temporary files should be removed');
  assert.equal(result.children.cloudflared.signalCode, 'SIGTERM');
});

test('gateway and tunnel start concurrently before readiness probes', async () => {
  const result = await runWithMocks({ assertParallel: true, crash: 'tunnel-runtime' });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /MCP URL:/);
});

test('named tunnel uses a stable hostname through startup and tool discovery', async () => {
  const result = await runWithMocks({ named: true, crash: 'tunnel-runtime' });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /MCP URL: https:\/\/mcp\.example\.com\/workspace\/mcp/);
  assert.match(result.stdout, /Tunnel mode: named/);
  assert.doesNotMatch(result.stdout, /trycloudflare/);
});

test('ngrok launches with the assigned free static URL and supervises lifecycle', async () => {
  const result = await runWithMocks({ ngrok: true, assertParallel: false, crash: 'tunnel-runtime' });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /MCP URL: https:\/\/assigned\.ngrok-free\.app\/workspace\/mcp/);
  assert.match(result.stdout, /Tunnel mode: ngrok/);
  assert.equal(result.children.npx.signalCode, 'SIGTERM');
  assert.equal(result.exists, false);
});

test('gateway and tunnel runtime crashes stop the peer and clean temporary files', async () => {
  for (const scenario of ['gateway-runtime', 'tunnel-runtime']) {
    const result = await runWithMocks({ crash: scenario });
    assert.equal(result.code, 1, `${scenario} should return failure`);
    assert.match(result.stdout, /^MCP URL: https:\/\/mock-tunnel\.trycloudflare\.com\/workspace\/mcp\n/,
      'valid tunnel readiness should still announce the real MCP URL');
    assert.equal(result.exists, false, 'temporary files should be removed');
    const peer = result.children[scenario === 'gateway-runtime' ? 'cloudflared' : 'npx'];
    assert.equal(peer.signalCode, 'SIGTERM', 'supervisor should terminate the other process');
  }
});

test('authorized SIGUSR2 reloads the gateway without restarting the ngrok tunnel', async () => {
  const result = await runWithMocks({ ngrok: true, reload: true });
  assert.equal(result.code, 1, 'simulated tunnel failure should terminate supervision after reload');
  assert.deepEqual(result.startOrder, ['npx', 'ngrok', 'npx']);
  assert.match(result.stdout, /Tunnel mode: ngrok/);
  assert.equal(result.exists, false);
});

test('SIGINT and SIGTERM terminate both children and remove temporary files', async () => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const result = await runWithMocks({ signal });
    assert.equal(result.code, signal === 'SIGINT' ? 130 : 143);
    assert.equal(result.exists, false, 'temporary files should be removed');
    assert.equal(result.children.npx.signalCode, 'SIGTERM');
    assert.equal(result.children.cloudflared.signalCode, 'SIGTERM');
  }
});
