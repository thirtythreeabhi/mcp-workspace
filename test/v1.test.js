'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {sha}=require('../lib/devtools-core');
const {applyChanges,overview}=require('../lib/devtools-v1');
const {createJobManager}=require('../lib/jobs');
function setup(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'mcp-v11-test-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.writeFileSync(path.join(root,'a.txt'),'alpha\n');fs.writeFileSync(path.join(root,'b.txt'),'beta\n');
 return root;
}
test('batch operations dryRun, create, replace, move and delete',t=>{
 const r=setup(t),ops=[
  {action:'replace',path:'a.txt',content:'ALPHA\n',expectedSha256:sha(Buffer.from('alpha\n'))},
  {action:'delete',path:'b.txt',expectedSha256:sha(Buffer.from('beta\n'))},
  {action:'create',path:'c.txt',content:'new\n'}
 ];
 const preview=applyChanges(r,{operations:ops,dryRun:true});
 assert.equal(preview.operations.length,3);
 assert.equal(fs.readFileSync(path.join(r,'a.txt'),'utf8'),'alpha\n');
 assert.ok(!fs.existsSync(path.join(r,'c.txt')));
 applyChanges(r,{operations:ops});
 assert.equal(fs.readFileSync(path.join(r,'a.txt'),'utf8'),'ALPHA\n');
 assert.ok(!fs.existsSync(path.join(r,'b.txt')));
 assert.equal(fs.readFileSync(path.join(r,'c.txt'),'utf8'),'new\n');
 applyChanges(r,{operations:[{action:'move',path:'c.txt',destination:'d.txt',expectedSha256:sha(Buffer.from('new\n'))}]});
 assert.ok(!fs.existsSync(path.join(r,'c.txt')));
 assert.equal(fs.readFileSync(path.join(r,'d.txt'),'utf8'),'new\n');
});
test('reject stale hashes, duplicate names, symlinks, traversal without mutation',t=>{
 const r=setup(t),file=path.join(r,'a.txt');
 const original=fs.readFileSync(file,'utf8');
 assert.throws(()=>applyChanges(r,{operations:[
  {action:'replace',path:'a.txt',content:'changed',expectedSha256:sha(Buffer.from(original))},
  {action:'delete',path:'b.txt',expectedSha256:'0'.repeat(64)}
 ]}),/STALE_FILE/);
 assert.equal(fs.readFileSync(file,'utf8'),original);
 assert.throws(()=>applyChanges(r,{operations:[{action:'create',path:'../escape',content:'oops'}]}),/traversal/);
 fs.symlinkSync(file,path.join(r,'linked'));
 assert.throws(()=>applyChanges(r,{operations:[{action:'delete',path:'linked',expectedSha256:sha(Buffer.from(original))}]}),/symlink/);
 assert.throws(()=>applyChanges(r,{operations:[
   {action:'delete',path:'a.txt',expectedSha256:sha(Buffer.from(original))},
   {action:'create',path:'a.txt',content:'bad'}
 ]}),/DUPLICATE_PATH/);
});
test('rollback restores earlier operations when a later write fails',t=>{
 const r=setup(t),file=path.join(r,'a.txt'),original=fs.readFileSync(file);
 const ops=[
  {action:'replace',path:'a.txt',content:'changed',expectedSha256:sha(original)},
  {action:'create',path:'c.txt',content:'new'}
 ];
 // Race simulation: monkeypatch renameSync to fail on the second rename only.
 const old=fs.renameSync;let n=0;
 fs.renameSync=function(from,to){n++;if(n===2)throw Error('injected error');return old(from,to);};
 try{assert.throws(()=>applyChanges(r,{operations:ops}),/rollback completed/);}
 finally{fs.renameSync=old;}
 assert.deepEqual(fs.readFileSync(file),original);
 assert.ok(!fs.existsSync(path.join(r,'c.txt')));
});
test('project overview identifies stack and scripts and excludes dependencies',t=>{
 const r=setup(t);
 fs.writeFileSync(path.join(r,'package.json'),JSON.stringify({
  name:'sample',version:'1.2',scripts:{test:'vitest run',dev:'next dev'},
  dependencies:{next:'15.0.0',react:'19.0.0'},devDependencies:{vitest:'2.0.0'}
 }));
 fs.mkdirSync(path.join(r,'node_modules'));
 fs.writeFileSync(path.join(r,'pnpm-lock.yaml'),'lockfileVersion: 9');
 const o=overview(r);
 assert.equal(o.name,'sample');assert.equal(o.packageManager,'pnpm');
 assert.ok(o.stack.includes('Next.js'));assert.equal(o.scripts.test,'vitest run');
 assert.ok(!o.entries.includes('node_modules'));
 assert.equal(o.git.available,false);
});
test('job manager captures results and logs and enforces concurrency',async()=>{
 let release;
 const run=async (_workspace,_input,onLog,signal)=>{
  onLog('running\n');
  await new Promise(resolve=>release=resolve);
  if(signal.aborted)throw Error('aborted');
  return {content:[{text:JSON.stringify({exit_code:0,stdout:'test passed',stderr:''})}]};
 };
 const jobs=createJobManager('/tmp',run);
 const j=jobs.start({command:'node',args:['--test']});
 assert.equal(j.status,'running');
 assert.throws(()=>jobs.start({command:'node'}),/JOB_BUSY/);
 await Promise.resolve();
 assert.match(jobs.logs({id:j.id}).log,/running/);
 release();await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
 assert.equal(jobs.status({id:j.id}).status,'completed');
 assert.match(jobs.logs({id:j.id}).log,/test passed/);
});
test('job manager cancellation, missing jobs, and schema restrictions',async()=>{
 const jobs=createJobManager('/tmp',async (_w,_a,_log,signal)=>new Promise((_r,reject)=>{
  signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true});
 }));
 assert.throws(()=>jobs.start({command:'',args:[]}),/INVALID_JOB_COMMAND/);
 assert.throws(()=>jobs.logs({id:'missing'}),/JOB_NOT_FOUND/);
 const j=jobs.start({command:'sleep',args:['5']});
 const c=jobs.cancel({id:j.id});
 assert.equal(c.cancellationRequested,true);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(jobs.status({id:j.id}).status,'cancelled');
});
