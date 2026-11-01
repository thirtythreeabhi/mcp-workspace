'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const v=require('../lib/video-core');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'mcp-video-test-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.writeFileSync(path.join(root,'one.mp4'),'fake video data');
 fs.writeFileSync(path.join(root,'two.mp4'),'fake video data');
 return root;
}
function plan(){return {width:640,height:360,fps:24,clips:[
 {path:'one.mp4',start:0,end:1,speed:1},
 {path:'two.mp4',start:0,end:1,speed:2}]};}
test('timeline files are editable using SHA-256 and remain workspace-scoped',t=>{
 const root=fixture(t),first=v.timelineSave(root,{path:'demo.timeline.json',timeline:plan()});
 assert.equal(first.clips,2);assert.equal(first.durationSeconds,1.5);
 const loaded=v.timelineRead(root,{path:'demo.timeline.json'});
 assert.equal(loaded.sha256,first.sha256);assert.equal(loaded.timeline.clips.length,2);
 assert.throws(()=>v.timelineSave(root,{path:'demo.timeline.json',timeline:plan()}),/STALE_TIMELINE/);
 const changed=plan();changed.clips[0].end=0.8;
 const next=v.timelineSave(root,{path:'demo.timeline.json',timeline:changed,expectedSha256:first.sha256});
 assert.notEqual(next.sha256,first.sha256);
 assert.throws(()=>v.timelineSave(root,{path:'demo.timeline.json',timeline:plan(),expectedSha256:first.sha256}),/STALE_TIMELINE/);
});
test('unsafe traversal, symlink, missing output dir, invalid extensions, overwrites and ranges fail',t=>{
 const root=fixture(t);
 assert.throws(()=>v.file(root,'../etc/hosts'),/UNSAFE_PATH/);
 assert.throws(()=>v.file(root,'/etc/passwd'),/INVALID_PATH/);
 fs.symlinkSync('/etc/hosts',path.join(root,'linked.mp4'));
 assert.throws(()=>v.file(root,'linked.mp4'),/SYMLINK_DENIED/);
 assert.throws(()=>v.dest(root,'one.mp4'),/OUTPUT_EXISTS/);
 assert.throws(()=>v.dest(root,'nothing/new.mp4'),/ENOENT/);
 assert.throws(()=>v.dest(root,'new.sh'),/INVALID_OUTPUT_EXTENSION/);
 assert.throws(()=>v.validate(root,{clips:[{path:'one.mp4',start:2,end:1}]}),/INVALID_CLIP_RANGE/);
 assert.throws(()=>v.validate(root,{width:639,clips:[{path:'one.mp4',end:1}]}),/DIMENSIONS/);
 assert.throws(()=>v.validate(root,{clips:[{path:'one.mp4',end:1,speed:5}]}),/INVALID_SPEED/);
});
test('stdio video MCP lists workflow and render tools and keeps existing workspace separate',async t=>{
 const root=fixture(t);
 const child=cp.spawn(process.execPath,[path.join(__dirname,'../lib/video-server.js'),root],{stdio:['pipe','pipe','pipe']});
 t.after(()=>child.kill());
 let result='',buffer='';
 child.stdout.on('data',b=>{buffer+=b.toString();result+=b.toString();});
 for(const msg of [
  {jsonrpc:'2.0',id:1,method:'initialize',params:{}},
  {jsonrpc:'2.0',id:2,method:'tools/list',params:{}},
  {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'timeline_save',arguments:{path:'example.timeline.json',timeline:plan()}}},
 ] ) child.stdin.write(JSON.stringify(msg)+'\n');
 for(let i=0;i<100&&result.trim().split('\n').length<3;i++)await new Promise(resolve=>setTimeout(resolve,10));
 const lines=result.trim().split('\n').map(JSON.parse);
 assert.equal(lines.length,3);
 assert.equal(lines[0].result.serverInfo.version,'1.3.0');
 assert.equal(lines[1].result.tools.length,18);
 for(const name of ['project_state','audio_timing','review','remotion_compositions'])assert.ok(lines[1].result.tools.some(x=>x.name===name));
 assert.ok(lines[1].result.tools.some(x=>x.name==='capture_page'));
 assert.ok(lines[1].result.tools.some(x=>x.name==='remotion_status'));
 assert.ok(lines[1].result.tools.some(x=>x.name==='remotion_render_start'));
 assert.ok(lines[1].result.tools.some(x=>x.name==='render_start'));
 assert.ok(!lines[1].result.tools.some(x=>x.name==='filesystem_write_file'));
 assert.ok(fs.existsSync(path.join(root,'example.timeline.json')));
});

test('browser capture is disabled by default and validates local-only routes and output constraints',t=>{
 const root=fixture(t);
 const env={MCP_WORKSPACE_CAPTURE_ORIGIN:'http://127.0.0.1:3000'};
 assert.throws(()=>v.captureSettings({outputPath:'capture.png'},{}),/CAPTURE_DISABLED/);
 assert.equal(v.captureSettings({route:'/en/recruiter/dashboard',outputPath:'capture.png'},env).url,
  'http://127.0.0.1:3000/en/recruiter/dashboard');
 for(const origin of [
  'https://127.0.0.1:3000','http://example.com:3000','http://192.168.1.1:3000',
  'http://127.0.0.1:3000/private','http://user:pw@127.0.0.1:3000','http://localhost'
 ])assert.throws(()=>v.captureSettings({outputPath:'capture.png'},{MCP_WORKSPACE_CAPTURE_ORIGIN:origin}),/INVALID_CAPTURE_ORIGIN/);
 for(const route of ['//private','/../private','/api/secret','/en?key=x','/en#foo','http://remote','/foo//bar']){
  assert.throws(()=>v.captureSettings({route,outputPath:'capture.png'},env),/INVALID_CAPTURE_ROUTE/);
 }
 assert.throws(()=>v.captureSettings({outputPath:'capture.jpg'},env),/INVALID_CAPTURE_OUTPUT/);
 assert.throws(()=>v.captureSettings({outputPath:'capture.png',width:10000},env),/INVALID_WIDTH/);
 assert.equal(path.basename(v.dest(root,'new.png',new Set(['.png']))),'new.png');
});

test('browser capture uses clean Chrome profile and promotes only new verified PNG files',async t=>{
 const root=fixture(t),env={MCP_WORKSPACE_CAPTURE_ORIGIN:'http://localhost:3000'};
 const args={route:'/en',outputPath:'screenshot.png',width:640,height:480,waitMs:500};
 let commandArgs,commandName;
 const runner=async(bin,argv)=>{
  commandName=bin;commandArgs=argv;
  const output=argv.find(s=>s.startsWith('--screenshot=')).slice('--screenshot='.length);
  // Test runner simulates Chrome's PNG envelope; no external browser needed.
  const png=Buffer.alloc(130);
  Buffer.from([137,80,78,71,13,10,26,10]).copy(png,0);
  png.write('IHDR',12);
  png.writeUInt32BE(640,16);png.writeUInt32BE(480,20);
  fs.writeFileSync(output,png);
 };
 const result=await v.capturePage(root,args,{env,runner});
 assert.equal(commandName,'google-chrome');
 assert.ok(commandArgs.includes('http://localhost:3000/en'));
 assert.ok(commandArgs.some(s=>s.startsWith('--user-data-dir=')));
 assert.ok(commandArgs.some(s=>s.startsWith('--host-resolver-rules=')));
 assert.ok(!commandArgs.includes('--no-sandbox'));
 assert.deepEqual({width:result.width,height:result.height},{width:640,height:480});
 assert.ok(fs.existsSync(path.join(root,'screenshot.png')));
 await assert.rejects(v.capturePage(root,args,{env,runner}),/OUTPUT_EXISTS/);
 await assert.rejects(v.capturePage(root,{...args,outputPath:'../elsewhere.png'},{env,runner}),/UNSAFE_PATH/);
 const noFile=async()=>{};
 await assert.rejects(v.capturePage(root,{...args,outputPath:'missing.png'},{env,runner:noFile}),/ENOENT/);
});

const ffmpegAvailable=cp.spawnSync('ffmpeg',['-version'],{timeout:5000}).status===0
 &&cp.spawnSync('ffprobe',['-version'],{timeout:5000}).status===0;
test('real FFmpeg integration: probe, preview, render, inspect output', {skip:!ffmpegAvailable,timeout:45000},async t=>{
 const root=fixture(t),sample=path.join(root,'source.mp4');
 cp.execFileSync('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=320x240:rate=12:duration=1.5',
  '-f','lavfi','-i','sine=frequency=600:duration=1.5','-c:v','libx264','-threads','2','-pix_fmt','yuv420p','-c:a','aac','-shortest','-y',sample],{timeout:15000});
 const info=await v.probe(root,{path:'source.mp4'});assert.equal(info.width,320);assert.equal(info.hasAudio,true);
 const image=await v.preview(root,{path:'source.mp4',atSeconds:0.3,width:320});
 assert.equal(image.mimeType,'image/jpeg');assert.ok(image.data.length>100);
 const sheet=await v.contactSheet(root,{path:'source.mp4',windowSeconds:1});
 assert.equal(sheet.mimeType,'image/jpeg');assert.ok(sheet.bytes>500);
 v.timelineSave(root,{path:'demo.timeline.json',timeline:{width:320,height:240,fps:12,clips:[
  {path:'source.mp4',start:0,end:0.7,speed:1},
  {path:'source.mp4',start:0.7,end:1.4,speed:1.4},
 ]}});
 const job=v.renderStart(root,{timelinePath:'demo.timeline.json',outputPath:'edited.mp4'});
 let status;
 for(let i=0;i<160;i++){
  status=v.renderStatus(root,{id:job.id});
  if(['completed','failed','cancelled'].includes(status.status))break;
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 assert.equal(status.status,'completed',v.renderLogs(root,{id:job.id}).log);
 const out=await v.probe(root,{path:'edited.mp4'});
 assert.ok(out.durationSeconds>0.6&&out.durationSeconds<1.9);
 assert.equal(out.width,320);assert.equal(out.hasAudio,true);
});


test('render cancellation requests stop a detached worker', {skip:!ffmpegAvailable,timeout:30000},async t=>{
 const root=fixture(t),sample=path.join(root,'quiet.mp4');
 cp.execFileSync('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-f','lavfi',
  '-i','testsrc2=size=320x240:rate=30:duration=12','-c:v','libx264','-threads','2','-y',sample],
  {timeout:20000});
 v.timelineSave(root,{path:'cancel.timeline.json',timeline:{width:640,height:360,fps:30,
  clips:[{path:'quiet.mp4',start:0,end:12,speed:1}]}});
 const job=v.renderStart(root,{timelinePath:'cancel.timeline.json',outputPath:'cancelled.mp4'});
 assert.equal(v.renderCancel(root,{id:job.id}).cancellationRequested,true);
 let status;
 for(let i=0;i<150;i++){
  status=v.renderStatus(root,{id:job.id});
  if(['completed','failed','cancelled'].includes(status.status))break;
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 assert.equal(status.status,'cancelled',v.renderLogs(root,{id:job.id}).log);
 assert.ok(!fs.existsSync(path.join(root,'cancelled.mp4')));
});
