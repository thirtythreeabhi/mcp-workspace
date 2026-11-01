'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const workflow=require('../lib/video-workflow');
const video=require('../lib/video-core');
const remotion=require('../lib/remotion-core');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'mcp-video-workflow-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 return root;
}
test('project state survives re-reads, uses SHA to reject stale updates and blocks traversal',t=>{
 const root=fixture(t);
 const state={title:'Wordbase',audioPath:'narration.mp3',compositionId:'WordbasePortfolio',
  fps:30,scenes:[{id:'intro',startSeconds:0,endSeconds:5},{id:'stack',startSeconds:5,endSeconds:11}],
  renders:[{outputPath:'out/wordbase.mp4',status:'completed'}]};
 const created=workflow.projectState(root,{action:'save',projectId:'wordbase',state});
 assert.match(created.sha256,/^[a-f0-9]{64}$/);
 const read=workflow.projectState(root,{action:'read',projectId:'wordbase'});
 assert.deepEqual(read.state.scenes,state.scenes);
 assert.equal(workflow.projectState(root,{action:'list'}).projects[0].projectId,'wordbase');
 assert.throws(()=>workflow.projectState(root,{action:'save',projectId:'wordbase',state}),/STALE_PROJECT/);
 assert.throws(()=>workflow.projectState(root,{action:'save',projectId:'wordbase',state,expectedSha256:'0'.repeat(64)}),/STALE_PROJECT/);
 const next=workflow.projectState(root,{action:'save',projectId:'wordbase',state:{...state,notes:'Revision two'},expectedSha256:read.sha256});
 assert.notEqual(next.sha256,read.sha256);
 assert.throws(()=>workflow.projectState(root,{action:'read',projectId:'../../etc'}),/INVALID_PROJECT_ID/);
 assert.throws(()=>workflow.projectState(root,{action:'save',projectId:'bad',state:{scenes:[{id:'a',startSeconds:1,endSeconds:3},{id:'b',startSeconds:2,endSeconds:4}]}}),/INVALID_SCENE_TIMING/);
 assert.throws(()=>workflow.projectState(root,{action:'save',projectId:'bad',state:{audioPath:'../secrets.mp3'}}),/UNSAFE_PATH/);
});
test('Remotion composition IDs come from the approved local registry only',t=>{
 const root=fixture(t),dir=path.join(root,'remotion-project','src');
 fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(root,'remotion-project','package.json'),JSON.stringify(remotion.EXPECTED));
 fs.writeFileSync(path.join(dir,'root.tsx'),'<Composition id="CoffeemiumFiverr" durationInFrames={1480} />\n<Composition id="WordbasePortfolio" durationInFrames={1891} />');
 const ids=remotion.registeredCompositions(root).compositions;
 assert.ok(ids.some(v=>v.id==='CoffeemiumFiverr'&&v.durationInFrames===1480));
 assert.ok(ids.some(v=>v.id==='WordbasePortfolio'&&v.durationInFrames===1891));
 assert.ok(!ids.some(v=>v.id==='ArbitraryShell'));
 assert.throws(()=>remotion.validate(root,{compositionId:'ArbitraryShell',outputPath:'test.mp4'}),/COMPOSITION_NOT_ALLOWLISTED/);
});
const ffmpeg=cp.spawnSync('ffmpeg',['-version'],{stdio:'ignore'}).status===0;
test('audio_timing saves measured silence (not fake word-level alignment)',{skip:!ffmpeg,timeout:15000},async t=>{
 const root=fixture(t);
 const generate=cp.spawnSync('ffmpeg',['-hide_banner','-nostdin','-loglevel','error','-f','lavfi','-i','anullsrc=r=16000:cl=mono','-t','1','-c:a','pcm_s16le','voice.wav'],{cwd:root,timeout:10000});
 assert.equal(generate.status,0);
 const result=await workflow.audioTiming(root,{audioPath:'voice.wav'});
 assert.equal(result.wordLevel,false);
 assert.ok(result.silenceCount>=1);
 const json=JSON.parse(fs.readFileSync(path.join(root,result.outputPath)));
 assert.equal(json.method,'ffmpeg_silence_detection');
 assert.equal(json.wordLevel,false);
 await assert.rejects(()=>workflow.audioTiming(root,{audioPath:'../secret.mp3'}),/UNSAFE_PATH/);
});
test('video review creates a local contact sheet and flags scenes longer than threshold',{skip:!ffmpeg,timeout:30000},async t=>{
 const root=fixture(t),out=path.join(root,'sample.mp4');
 const generated=cp.spawnSync('ffmpeg',['-hide_banner','-nostdin','-loglevel','error','-f','lavfi','-i','testsrc2=size=320x180:rate=15:duration=2','-c:v','libx264','-threads','2','-y',out],{timeout:15000});
 assert.equal(generated.status,0);
 workflow.projectState(root,{action:'save',projectId:'sample',state:{title:'Sample',scenes:[{id:'opening',startSeconds:0,endSeconds:1.9}]}});
 const report=await workflow.review(root,{path:'sample.mp4',projectId:'sample',maxSceneSeconds:2});
 assert.equal(report.frames,8);
 assert.equal(report.scenesChecked,1);
 assert.ok(fs.statSync(path.join(root,report.contactSheetPath)).size>100);
 assert.ok(fs.statSync(path.join(root,report.reportPath)).size>100);
 const logsId='0'.repeat(24);
 assert.throws(()=>video.renderLogs(root,{id:logsId}),/ENOENT/);
});
