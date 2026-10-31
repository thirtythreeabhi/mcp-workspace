'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const host = require('../lib/host-control');

function setup(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-host-control-test-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const checkout = path.join(workspace, 'mcp-workspace');
  fs.mkdirSync(checkout);
  fs.writeFileSync(path.join(checkout, 'package.json'), '{"name":"mcp-workspace"}');
  for (const [relative] of host.FILES) {
    const file = path.join(checkout, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'source for ' + relative + '\n');
  }
  const opts = { stateDir: path.join(workspace, 'state'), installDir: path.join(workspace, 'installed', 'bin'), port: 8787, delayMs: 5 };
  return { workspace, checkout, opts };
}
function expectations(status) {
  return Object.fromEntries(status.files.map(entry => [entry.file, entry.sourceSha256]));
}

test('host status compares only the fixed installation files', t => {
  const { workspace, opts } = setup(t);
  const status = host.hostStatus(workspace, opts);
  assert.equal(status.files.length, 7);
  assert.equal(status.running, false);
  assert.ok(status.files.every(entry => entry.matches === false && entry.installedSha256 === null));
  assert.deepEqual(status.files.map(entry => entry.file), host.FILES.map(file => file[0]));
});

test('short-lived local grant is required, single-use and never accepted if wrong', async t => {
  const { workspace, opts } = setup(t);
  const registration = host.registerInstance(opts);
  t.after(() => host.unregisterInstance(registration, opts));
  assert.equal(host.hostStatus(workspace, opts).running, true);
  const grant = host.grantMaintenance(opts);
  assert.match(grant.token, /^[a-f0-9]{64}$/);
  assert.throws(() => host.maintain(workspace, { action: 'reload', token: '0'.repeat(64) }, opts), /NOT_AUTHORIZED/);
  const signaled = [];
  const result = host.maintain(workspace, { action: 'reload', token: grant.token },
    { ...opts, signal: pid => signaled.push(pid) });
  assert.equal(result.gatewayReloadScheduled, true);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(signaled, [process.pid]);
  assert.throws(() => host.maintain(workspace, { action: 'reload', token: grant.token }, opts), /NOT_AUTHORIZED/);
});

test('sync requires pinned hashes, installs only the fixed files, and schedules reload', async t => {
  const { workspace, opts } = setup(t);
  const registration = host.registerInstance(opts);
  t.after(() => host.unregisterInstance(registration, opts));
  const original = host.hostStatus(workspace, opts);
  const token = host.grantMaintenance(opts).token;
  const signaled = [];
  const result = host.maintain(workspace, {
    action: 'sync_and_reload', token, expectedSources: expectations(original),
  }, { ...opts, signal: pid => signaled.push(pid) });
  assert.equal(result.filesUpdated.length, 7);
  assert.ok(host.hostStatus(workspace, opts).files.every(entry => entry.matches));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(signaled, [process.pid]);
  const executable = path.join(opts.installDir, 'mcp-workspace');
  assert.equal(fs.statSync(executable).mode & 0o777, 0o755);
  assert.equal(fs.statSync(path.join(workspace, 'installed', 'lib', 'mcp-workspace', 'launcher.js')).mode & 0o777, 0o644);
});

test('source hash mismatch rejects entire sync without consuming grant', t => {
  const { workspace, checkout, opts } = setup(t);
  const registration = host.registerInstance(opts);
  t.after(() => host.unregisterInstance(registration, opts));
  const expectedSources = expectations(host.hostStatus(workspace, opts));
  const token = host.grantMaintenance(opts).token;
  fs.writeFileSync(path.join(checkout, 'lib', 'launcher.js'), 'changed before deploy\n');
  assert.throws(() => host.maintain(workspace, {
    action: 'sync_and_reload', token, expectedSources,
  }, opts), /STALE_SOURCE/);
  assert.equal(host.hostStatus(workspace, opts).files.filter(x => x.installedSha256 !== null).length, 0);
  assert.throws(() => host.maintain(workspace, {
    action: 'sync_and_reload', token, expectedSources: { 'lib/launcher.js': '0'.repeat(64) },
  }, opts), /all pinned source paths/);
  assert.ok(fs.existsSync(host.paths(opts).grant), 'failed validation must not consume grant');
});

test('expired grant and stale instance are rejected', t => {
  const { workspace, opts } = setup(t);
  const registered = host.registerInstance(opts);
  const token = host.grantMaintenance(opts).token;
  fs.writeFileSync(host.paths(opts).grant, JSON.stringify({
    tokenHash: host.sha(token), instanceId: registered.instanceId, expiresAt: Date.now() - 10,
  }), { mode: 0o600 });
  assert.throws(() => host.maintain(workspace, { action: 'reload', token }, opts), /NOT_AUTHORIZED/);
  host.unregisterInstance(registered, opts);
  assert.throws(() => host.grantMaintenance(opts), /No running/);
});

test('symlinked install targets and sources are rejected', t => {
  const { workspace, checkout, opts } = setup(t);
  const dest = path.join(opts.installDir, 'mcp-workspace');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.symlinkSync('/tmp/nonexistent-target', dest);
  const instance = host.registerInstance(opts);
  t.after(() => host.unregisterInstance(instance, opts));
  const token = host.grantMaintenance(opts).token;
  assert.throws(() => host.hostStatus(workspace, opts), /unsafe/);
  assert.throws(() => host.maintain(workspace, { action:'sync_and_reload', token,
    expectedSources: Object.fromEntries(host.FILES.map(([relative]) => [relative, '0'.repeat(64)])),
  }, opts), /unsafe/);
  fs.unlinkSync(dest);
  const source = path.join(checkout, 'lib', 'launcher.js');
  fs.unlinkSync(source);
  fs.symlinkSync('/etc/hosts', source);
  assert.throws(() => host.hostStatus(workspace, opts), /unsafe/);
});
