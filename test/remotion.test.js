'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const remotion=require('../lib/remotion-core');
const {spawnSync}=require('node:child_process');
test('Remotion host worker passes Node syntax validation',()=>{
 const entry=path.join(__dirname,'../lib/remotion-worker.js');
 const check=spawnSync(process.execPath,['--check',entry],{encoding:'utf8'});
 assert.equal(check.status,0,check.stderr);
});
function setup(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'mcp-remotion-test-'));
 const p=path.join(root,'remotion-project');
 fs.mkdirSync(path.join(p,'src'),{recursive:true});
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const approved={...remotion.EXPECTED,scripts:{studio:'remotion studio src/index.ts',render:'remotion render'}};
 fs.writeFileSync(path.join(p,'package.json'),JSON.stringify(approved));
 fs.writeFileSync(path.join(p,'src','index.ts'),'// test stub');
 return {root,p};
}
test('Remotion host setup allows only a fixed pinned local npm project',t=>{
 const {root,p}=setup(t);
 assert.equal(remotion.projectManifest(root).relative,'remotion-project');
 assert.equal(remotion.dependencies(root).installed,false);
 const data=JSON.parse(fs.readFileSync(path.join(p,'package.json')));
 data.dependencies.remotion='*';
 fs.writeFileSync(path.join(p,'package.json'),JSON.stringify(data));
 assert.throws(()=>remotion.projectManifest(root),/UNAPPROVED_REMOTION_DEPENDENCIES/);
 data.dependencies.remotion=remotion.PIN;
 data.scripts.postinstall='bash -c something';
 fs.writeFileSync(path.join(p,'package.json'),JSON.stringify(data));
 assert.throws(()=>remotion.projectManifest(root),/UNAPPROVED_REMOTION_SCRIPTS/);
});
test('renderer builds fixed argv, no CPU, RAM, concurrency, or time flags',t=>{
 const {root,p}=setup(t);
 const bin=path.join(p,'node_modules','.bin');
 fs.mkdirSync(bin,{recursive:true});
 fs.writeFileSync(path.join(bin,'remotion'),'#!/bin/sh\nexit 0\n');
 const check=remotion.dependencies(root);
 if(!check.chromeAvailable)return;
 assert.equal(check.installed,true);
 const v=remotion.validate(root,{compositionId:'TalentStreamOpening',outputPath:'out.mp4'});
 const args=remotion.workerArgs(v,'/tmp/render.mp4');
 assert.equal(args[0],'render');
 assert.ok(args.includes('--codec=h264'));
 assert.ok(!args.some(x=>/concurrency|memory|timeout|cpu|bitrate/i.test(x)));
 assert.throws(()=>remotion.validate(root,{compositionId:'custom-script',outputPath:'out.mp4'}),/COMPOSITION_NOT_ALLOWLISTED/);
 assert.throws(()=>remotion.validate(root,{compositionId:'TalentStreamOpening',outputPath:'../escape.mp4'}),/UNSAFE_PATH/);
});

test('host installer and rendering require explicit host opt-in',t=>{
 const {root}=setup(t);
 assert.throws(()=>remotion.installStart(root),/HOST_REMOTION_DISABLED/);
 assert.throws(()=>remotion.renderStart(root,{compositionId:'TalentStreamOpening',outputPath:'render.mp4'}),/HOST_REMOTION_DISABLED/);
});
