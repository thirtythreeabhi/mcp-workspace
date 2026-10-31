'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'),os=require('node:os'),path=require('node:path'), cp=require('node:child_process');
const d=require('../lib/devtools-core');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'mcp-tools-test-'));t.after(()=>fs.rmSync(root,{force:true,recursive:true}));fs.writeFileSync(path.join(root,'example.ts'),'const coffee = "hello";\nconst tea = "hello";\n');return root;}
test('code search finds source lines and omits dependencies',t=>{const r=fixture(t);fs.mkdirSync(path.join(r,'node_modules'));fs.writeFileSync(path.join(r,'node_modules','x.js'),'hello');const x=d.codeSearch(r,{query:'hello'});assert.equal(x.matches.length,2);assert.equal(x.matches[0].path,'example.ts');});
test('checked edit requires hash and rejects stale or ambiguous changes',t=>{const r=fixture(t),f=path.join(r,'example.ts'),hash=d.sha(fs.readFileSync(f));assert.throws(()=>d.editChecked(r,{path:'example.ts',expectedSha256:'0'.repeat(64),edits:[{oldText:'coffee',newText:'water'}]}),/STALE_FILE/);assert.throws(()=>d.editChecked(r,{path:'example.ts',expectedSha256:hash,edits:[{oldText:'hello',newText:'bye'}]}),/AMBIGUOUS/);const x=d.editChecked(r,{path:'example.ts',expectedSha256:hash,edits:[{oldText:'coffee',newText:'water'}],dryRun:true});assert.equal(x.changed,true);assert.match(fs.readFileSync(f,'utf8'),/coffee/);d.editChecked(r,{path:'example.ts',expectedSha256:hash,edits:[{oldText:'coffee',newText:'water'}]});assert.match(fs.readFileSync(f,'utf8'),/water/);});
test('paths reject escapes and symlinks',t=>{const r=fixture(t);assert.throws(()=>d.safePath(r,'../oops'));assert.throws(()=>d.safePath(r,'/tmp'));fs.symlinkSync('/tmp',path.join(r,'link'));assert.throws(()=>d.safePath(r,'link/escape'));});
test('repo_status and repo_diff do not modify git worktree',t=>{const r=fixture(t);cp.execFileSync('git',['init','-q'],{cwd:r});cp.execFileSync('git',['-c','user.name=T','-c','user.email=t@t','add','example.ts'],{cwd:r});cp.execFileSync('git',['-c','user.name=T','-c','user.email=t@t','commit','-qm','initial'],{cwd:r});fs.appendFileSync(path.join(r,'example.ts'),'extra\n');const st=d.repoStatus(r);assert.match(st.status,/example.ts/);assert.match(d.repoDiff(r).diff,/\+extra/);});
test('stdio MCP announces developer tools and serves search', async t => {
  const root = fixture(t);
  const child = cp.spawn(process.execPath, [path.resolve(__dirname, '../lib/devtools-server.js'), root], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const responses = [];
  let buffer = '';
  child.stdout.on('data', x => {
    buffer += x;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) if (line) responses.push(JSON.parse(line));
  });
  const calls = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'code_search', arguments: { query: 'hello' } } }
  ];
  for (const msg of calls) child.stdin.write(JSON.stringify(msg) + '\n');
  for (let i = 0; i < 100 && responses.length < 3; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(responses.length, 3);
  assert.equal(responses[1].result.tools.length, 6);
  assert.match(JSON.stringify(responses[2]), /example.ts/);
});
