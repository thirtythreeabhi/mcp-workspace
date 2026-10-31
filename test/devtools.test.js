'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'),os=require('node:os'),path=require('node:path'), cp=require('node:child_process');
const d=require('../lib/devtools-core');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'mcp-tools-test-'));t.after(()=>fs.rmSync(root,{force:true,recursive:true}));fs.writeFileSync(path.join(root,'example.ts'),'const coffee = "hello";\nconst tea = "hello";\n');return root;}
test('code search finds source lines and omits dependencies',t=>{const r=fixture(t);fs.mkdirSync(path.join(r,'node_modules'));fs.writeFileSync(path.join(r,'node_modules','x.js'),'hello');const x=d.codeSearch(r,{query:'hello'});assert.equal(x.matches.length,2);assert.equal(x.matches[0].path,'example.ts');});
test('checked edit requires hash and rejects stale or ambiguous changes',t=>{const r=fixture(t),f=path.join(r,'example.ts'),hash=d.sha(fs.readFileSync(f));assert.throws(()=>d.editChecked(r,{path:'example.ts',expectedSha256:'0'.repeat(64),edits:[{oldText:'coffee',newText:'water'}]}),/STALE_FILE/);assert.throws(()=>d.editChecked(r,{path:'example.ts',expectedSha256:hash,edits:[{oldText:'hello',newText:'bye'}]}),/AMBIGUOUS/);const x=d.editChecked(r,{path:'example.ts',expectedSha256:hash,edits:[{oldText:'coffee',newText:'water'}],dryRun:true});assert.equal(x.changed,true);assert.match(fs.readFileSync(f,'utf8'),/coffee/);d.editChecked(r,{path:'example.ts',expectedSha256:hash,edits:[{oldText:'coffee',newText:'water'}]});assert.match(fs.readFileSync(f,'utf8'),/water/);});
test('paths reject escapes and symlinks',t=>{const r=fixture(t);assert.throws(()=>d.safePath(r,'../oops'));assert.throws(()=>d.safePath(r,'/tmp'));fs.symlinkSync('/tmp',path.join(r,'link'));assert.throws(()=>d.safePath(r,'link/escape'));});
test('repo_status and repo_diff do not modify git worktree',async t=>{const r=fixture(t);cp.execFileSync('git',['init','-q'],{cwd:r});cp.execFileSync('git',['-c','user.name=T','-c','user.email=t@t','add','example.ts'],{cwd:r});cp.execFileSync('git',['-c','user.name=T','-c','user.email=t@t','commit','-qm','initial'],{cwd:r});fs.appendFileSync(path.join(r,'example.ts'),'extra\n');const st=d.repoStatus(r);assert.match(st.status,/example.ts/);assert.match((await d.repoDiff(r)).diff,/\+extra/);});
test('Git tools select nested repos and reject traversal, links, and non-repo directories', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-nested-'));
  t.after(() => fs.rmSync(workspace, { force: true, recursive: true }));
  const repo = path.join(workspace, 'project');
  fs.mkdirSync(repo);
  cp.execFileSync('git', ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'data.txt'), 'initial\n');
  cp.execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@local', 'add', 'data.txt'], { cwd: repo });
  cp.execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@local', 'commit', '-qm', 'start'], { cwd: repo });
  fs.appendFileSync(path.join(repo, 'data.txt'), 'changed\n');
  assert.equal(d.repoStatus(workspace, { repoPath: 'project' }).repoPath, 'project');
  assert.match((await d.repoDiff(workspace, { repoPath: 'project', path: 'data.txt' })).diff, /\+changed/);
  assert.throws(() => d.repoStatus(workspace), /NOT_A_REPOSITORY/);
  assert.throws(() => d.repoStatus(workspace, { repoPath: '../escape' }), /path traversal/);
  await assert.rejects(d.repoDiff(workspace, { repoPath: 'project', path: '../escape' }), /path traversal/);
  const linked = path.join(workspace, 'linked');
  fs.mkdirSync(linked);
  fs.writeFileSync(path.join(linked, '.git'), 'gitdir: ../project/.git');
  assert.throws(() => d.repoStatus(workspace, { repoPath: 'linked' }), /UNSUPPORTED_REPOSITORY/);
});

test('host Git does not execute repository diff helpers', async t => {
  const repo = fixture(t);
  cp.execFileSync('git', ['init', '-q'], { cwd: repo });
  cp.execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@local', 'add', 'example.ts'], { cwd: repo });
  cp.execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@local', 'commit', '-qm', 'start'], { cwd: repo });
  const marker = path.join(repo, 'helper-ran');
  fs.writeFileSync(path.join(repo, '.gitattributes'), 'example.ts diff=evil\n');
  cp.execFileSync('git', ['config', 'diff.evil.command', 'touch ' + marker], { cwd: repo });
  fs.appendFileSync(path.join(repo, 'example.ts'), 'updated\n');
  assert.match((await d.repoDiff(repo)).diff, /updated/);
  assert.equal(fs.existsSync(marker), false);
});

test('checked edit rejects invalid UTF-8 and preserves valid Unicode bytes', t => {
  const r=fixture(t), f=path.join(r,'example.ts');
  const invalid=Buffer.from([0x61, 0x80, 0x62]);
  fs.writeFileSync(f,invalid);
  assert.throws(()=>d.editChecked(r,{path:'example.ts',expectedSha256:d.sha(invalid),edits:[{oldText:'a',newText:'z'}]}),/INVALID_ENCODING/);
  assert.deepEqual(fs.readFileSync(f),invalid, 'invalid UTF-8 file must stay unchanged');
  const unicode='\uFEFFhello \uFFFD world\n';
  fs.writeFileSync(f,unicode);
  d.editChecked(r,{path:'example.ts',expectedSha256:d.sha(fs.readFileSync(f)),edits:[{oldText:'hello',newText:'goodbye'}]});
  assert.equal(fs.readFileSync(f,'utf8'),'\uFEFFgoodbye \uFFFD world\n');
});

test('repo_diff streams oversized diffs with an explicit truncation flag', async t => {
  const r=fixture(t),f=path.join(r,'example.ts');
  cp.execFileSync('git',['init','-q'],{cwd:r});
  cp.execFileSync('git',['add','example.ts'],{cwd:r});
  cp.execFileSync('git',['-c','user.name=Audit','-c','user.email=audit@example.invalid','commit','-qm','initial'],{cwd:r});
  fs.appendFileSync(f, Array.from({length:12000},(_,i)=>'line-'+String(i).padStart(5,'0')+' some unique content').join('\n')+'\n');
  const diff=await d.repoDiff(r,{maxChars:750});
  assert.equal(diff.truncated,true);
  assert.match(diff.diff,/diff --git/);
  assert.match(diff.diff,/\[output truncated\]/);
  assert.ok(diff.diff.length<=750+'\n[output truncated]'.length);
});

test('read_lines returns bounded numbered UTF-8 lines and a content hash', t => {
  const r=fixture(t), f=path.join(r,'example.ts');
  fs.writeFileSync(f,'α one\r\nsecond\r\nthird\r\n');
  const result=d.readLines(r,{path:'example.ts',startLine:2,maxLines:1});
  assert.equal(result.content,'2 | second\n');
  assert.equal(result.totalLines,3);
  assert.equal(result.endLine,2);
  assert.equal(result.truncated,true);
  assert.equal(result.sha256,d.sha(fs.readFileSync(f)));
  assert.equal(d.readLines(r,{path:'example.ts',startLine:4}).content,'');
  assert.throws(()=>d.readLines(r,{path:'example.ts',startLine:0}),/startLine/);
  assert.throws(()=>d.readLines(r,{path:'example.ts',maxLines:251}),/maxLines/);
  assert.throws(()=>d.readLines(r,{path:'../outside'}),/path traversal/);
  fs.symlinkSync(f,path.join(r,'linked.ts'));
  assert.throws(()=>d.readLines(r,{path:'linked.ts'}),/symlink/);
  fs.writeFileSync(f,Buffer.from([0x61,0x80]));
  assert.throws(()=>d.readLines(r,{path:'example.ts'}),/INVALID_ENCODING/);
});

test('read_lines bounds enormous individual lines without exceeding maxChars', t => {
  const r=fixture(t);
  fs.writeFileSync(path.join(r,'long.txt'),'x'.repeat(20000)+'\n');
  const result=d.readLines(r,{path:'long.txt',maxChars:130});
  assert.equal(result.content.length,130);
  assert.equal(result.truncated,true);
  assert.equal(result.endLine,0);
});

test('apply_patch dryRun leaves files unchanged, then patches two files with hashes', t => {
  const r=fixture(t),a=path.join(r,'a.txt'),b=path.join(r,'b.txt');
  fs.writeFileSync(a,'alpha\nmiddle\nomega\n',{mode:0o640});
  fs.writeFileSync(b,'one\ntwo\n');
  const aBytes=fs.readFileSync(a), bBytes=fs.readFileSync(b);
  const patch=[
    'diff --git a/a.txt b/a.txt',
    'index abc123..def456 100644',
    '--- a/a.txt','+++ b/a.txt',
    '@@ -1,3 +1,3 @@',' alpha','-middle','+replaced',' omega',
    'diff --git a/b.txt b/b.txt',
    '--- a/b.txt','+++ b/b.txt',
    '@@ -1,2 +1,3 @@',' one','+inserted',' two','',
  ].join('\n');
  const args={patch,expectedFiles:[
    {path:'a.txt',expectedSha256:d.sha(aBytes)},
    {path:'b.txt',expectedSha256:d.sha(bBytes)},
  ]};
  const preview=d.applyPatch(r,{...args,dryRun:true});
  assert.equal(preview.files.length,2);
  assert.equal(preview.files[0].changed,true);
  assert.equal(preview.dryRun,true);
  assert.deepEqual(fs.readFileSync(a),aBytes);
  assert.deepEqual(fs.readFileSync(b),bBytes);
  const result=d.applyPatch(r,args);
  assert.equal(result.dryRun,false);
  assert.equal(fs.readFileSync(a,'utf8'),'alpha\nreplaced\nomega\n');
  assert.equal(fs.readFileSync(b,'utf8'),'one\ninserted\ntwo\n');
  assert.equal(result.files[0].newSha256,d.sha(fs.readFileSync(a)));
  assert.equal(fs.statSync(a).mode & 0o777,0o640);
});

test('apply_patch validates every file and hunk before modifying any file', t => {
  const r=fixture(t),a=path.join(r,'a.txt'),b=path.join(r,'b.txt');
  fs.writeFileSync(a,'first\n');fs.writeFileSync(b,'second\n');
  const original=fs.readFileSync(a);
  const patch=[
    '--- a/a.txt','+++ b/a.txt','@@ -1 +1 @@','-first','+new first',
    '--- a/b.txt','+++ b/b.txt','@@ -1 +1 @@','-incorrect','+new second','',
  ].join('\n');
  const expectedFiles=[
    {path:'a.txt',expectedSha256:d.sha(fs.readFileSync(a))},
    {path:'b.txt',expectedSha256:d.sha(fs.readFileSync(b))},
  ];
  assert.throws(()=>d.applyPatch(r,{patch,expectedFiles}),/PATCH_CONFLICT/);
  assert.deepEqual(fs.readFileSync(a),original);
  fs.writeFileSync(b,'changed\n');
  assert.throws(()=>d.applyPatch(r,{patch,expectedFiles}),/STALE_FILE/);
  assert.deepEqual(fs.readFileSync(a),original);
});

test('apply_patch rejects traversal, symlinks, unsupported operations and invalid input', t => {
  const r=fixture(t), f=path.join(r,'example.ts'),h=d.sha(fs.readFileSync(f));
  const edit=(name)=>['--- a/'+name,'+++ b/'+name,'@@ -1 +1 @@','-const coffee = "hello";','+const coffee = "bye";',''].join('\n');
  assert.throws(()=>d.applyPatch(r,{patch:edit('../escape'),expectedFiles:[{path:'../escape',expectedSha256:h}]}),/path traversal/);
  fs.symlinkSync(f,path.join(r,'linked.ts'));
  assert.throws(()=>d.applyPatch(r,{patch:edit('linked.ts'),expectedFiles:[{path:'linked.ts',expectedSha256:h}]}),/symlink/);
  assert.throws(()=>d.applyPatch(r,{patch:'--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+new\n',
    expectedFiles:[{path:'new.txt',expectedSha256:h}]}),/only changes to existing/);
  assert.throws(()=>d.applyPatch(r,{patch:edit('example.ts'),expectedFiles:[{path:'example.ts',expectedSha256:'0'.repeat(64)}]}),/STALE_FILE/);
  assert.throws(()=>d.applyPatch(r,{patch:edit('example.ts'),expectedFiles:[]}),/expectedFiles/);
  assert.throws(()=>d.applyPatch(r,{patch:'--- a/example.ts\n+++ b/example.ts\n@@ -1,3 +1,3 @@\n-a\n+b\n',
    expectedFiles:[{path:'example.ts',expectedSha256:h}]}),/hunk line counts/);
  assert.equal(fs.readFileSync(f,'utf8'),'const coffee = "hello";\nconst tea = "hello";\n');
});

test('apply_patch handles multiple hunks and a final line without newline', t => {
  const r=fixture(t),f=path.join(r,'example.ts');
  fs.writeFileSync(f,'first\nsecond\nthird\nlast');
  const patch=[
    '--- a/example.ts','+++ b/example.ts',
    '@@ -1 +1 @@','-first','+FIRST',
    '@@ -4 +4 @@','-last','\\ No newline at end of file','+LAST','\\ No newline at end of file','',
  ].join('\n');
  d.applyPatch(r,{patch,expectedFiles:[{path:'example.ts',expectedSha256:d.sha(fs.readFileSync(f))}]});
  assert.equal(fs.readFileSync(f,'utf8'),'FIRST\nsecond\nthird\nLAST');
});

test('apply_patch rejects different relative paths resolving to the same file', t => {
  const r=fixture(t), f=path.join(r,'example.ts');
  const patch=[
    '--- a/example.ts','+++ b/example.ts',
    '@@ -1 +1 @@','-const coffee = "hello";','+const coffee = "bye";',
    '--- a/./example.ts','+++ b/./example.ts',
    '@@ -1 +1 @@','-const coffee = "hello";','+const coffee = "tea";','',
  ].join('\n');
  const hash=d.sha(fs.readFileSync(f));
  assert.throws(()=>d.applyPatch(r,{patch,expectedFiles:[
    {path:'example.ts',expectedSha256:hash},
    {path:'./example.ts',expectedSha256:hash},
  ]}),/same file appears more than once/);
  assert.equal(fs.readFileSync(f,'utf8'),'const coffee = "hello";\nconst tea = "hello";\n');
});

test('stdio MCP announces developer tools and serves search', async t => {
  const root = fixture(t);
  cp.execFileSync('git',['init','-q'],{cwd:root});
  cp.execFileSync('git',['add','example.ts'],{cwd:root});
  cp.execFileSync('git',['-c','user.name=Audit','-c','user.email=audit@example.invalid','commit','-qm','initial'],{cwd:root});
  fs.appendFileSync(path.join(root,'example.ts'),'updated\n');
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
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'code_search', arguments: { query: 'hello' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'repo_diff', arguments: {} } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'workspace_diagnostics', arguments: {} } },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'read_lines', arguments: { path: 'example.ts', startLine: 2, maxLines: 2 } } },
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'apply_patch', arguments: {
      patch: '--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-const coffee = "hello";\n+const coffee = "changed";\n',
      expectedFiles: [{ path: 'example.ts', expectedSha256: d.sha(fs.readFileSync(path.join(root, 'example.ts'))) }], dryRun: true,
    } } }
  ];
  for (const msg of calls) child.stdin.write(JSON.stringify(msg) + '\n');
  for (let i = 0; i < 100 && responses.length < 7; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(responses.length, 7);
  assert.equal(responses[1].result.tools.length, 16);
  assert.ok(responses[1].result.tools.some(tool=>tool.name==='host_status'));
  assert.ok(responses[1].result.tools.some(tool=>tool.name==='host_maintenance'));
  assert.ok(responses[1].result.tools.some(tool=>tool.name==='read_lines'));
  assert.ok(responses[1].result.tools.some(tool=>tool.name==='apply_patch'));
  assert.match(JSON.stringify(responses[2]), /example.ts/);
  assert.match(JSON.stringify(responses[3]), /updated/);
  assert.match(JSON.stringify(responses[4]), /nodeVersion/);
  assert.match(JSON.stringify(responses[5]), /2 \| const tea/);
  assert.equal(JSON.parse(responses[6].result.content[0].text).dryRun, true);
  assert.match(fs.readFileSync(path.join(root,'example.ts'),'utf8'),/coffee = "hello"/);
});
