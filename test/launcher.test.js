'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { createConfig, parsePort, checkPort, checkDependencies, mcpReady, VERSIONS } = require('../lib/launcher');

test('dependency validation enforces Node 24 and required commands', () => {
  assert.throws(() => checkDependencies({ nodeVersion: '22.22.1', pathValue: '' }), /Node.js 24 or newer/);
  assert.throws(() => checkDependencies({ nodeVersion: '24.0.0', pathValue: '' }), /required command not found: npm/);
  assert.doesNotThrow(() => checkDependencies({ nodeVersion: '24.0.0', pathValue: process.env.PATH }));
});

test('configuration pins packages and retains sandbox boundaries', () => {
  const c = createConfig('/work', '/usr/local', 8787);
  const servers = c.mcpServers.workspace.mcpServers;
  assert.equal(c.host, '127.0.0.1'); assert.equal(c.port, 8787);
  assert.match(servers.filesystem.args[1], /@2\.1\.0$/);
  assert.match(servers.terminal.args[1], /@0\.3\.3$/);
  assert.ok(servers.filesystem.args.includes('/work'));
  assert.ok(servers.terminal.args.includes('--read-only'));
  assert.equal(VERSIONS.supergateway, '4.2.1');
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
    return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'filesystem_read_file' }, { name: 'terminal_run' }] } })}\n\n`, { status: 200 });
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

async function runWithMocks({ crash, signal } = {}) {
  const fs = require('node:fs');
  const path = require('node:path');
  const children = {};
  let configDir;
  const oldExit = process.exitCode;
  const run = require('../lib/launcher').run({
    checkDependencies() {}, checkPort: async () => {}, mcpReady: async () => true,
    start(command, args, logPath) {
      const child = mockChild();
      children[command] = child;
      if (command === 'npx') {
        configDir = path.dirname(args[args.indexOf('--config') + 1]);
        if (crash === 'gateway-start') setTimeout(() => { child.exitCode = 1; child.emit('exit', 1, null); }, 20);
      } else {
        fs.writeFileSync(logPath, 'https://mock-tunnel.trycloudflare.com\n');
        if (crash === 'tunnel-start') setTimeout(() => child.emit('error', new Error('mock tunnel startup failure')), 20);
      }
      return child;
    }
  });
  if (signal) setTimeout(() => process.emit(signal), 40);
  else if (crash === 'gateway-runtime' || crash === 'tunnel-runtime') setTimeout(() => {
    const child = children[crash === 'gateway-runtime' ? 'npx' : 'cloudflared'];
    if (child) { child.exitCode = 1; child.emit('exit', 1, null); }
  }, 40);
  try { await run; return { code: process.exitCode, children, configDir, exists: fs.existsSync(configDir) }; }
  finally { process.exitCode = oldExit; }
}

test('gateway and tunnel startup failures exit nonzero and clean temporary files', async () => {
  for (const scenario of ['gateway-start', 'tunnel-start']) {
    const result = await runWithMocks({ crash: scenario });
    assert.equal(result.code, 1, `${scenario} should return failure`);
    assert.equal(result.exists, false, 'temporary files should be removed');
  }
});

test('gateway and tunnel runtime crashes stop the peer and clean temporary files', async () => {
  for (const scenario of ['gateway-runtime', 'tunnel-runtime']) {
    const result = await runWithMocks({ crash: scenario });
    assert.equal(result.code, 1, `${scenario} should return failure`);
    assert.equal(result.exists, false, 'temporary files should be removed');
    const peer = result.children[scenario === 'gateway-runtime' ? 'cloudflared' : 'npx'];
    assert.equal(peer.signalCode, 'SIGTERM', 'supervisor should terminate the other process');
  }
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
