'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn,spawnSync}=require('node:child_process');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const EXT=new Set(['.mp4','.mov','.mkv','.avi','.webm','.m4v']);
function rootDir(root){let p=fs.realpathSync(root);if(!fs.statSync(p).isDirectory())throw Error('INVALID_WORKSPACE');return p;}
function safe(root,rel){
 if(typeof rel!=='string'||!rel||path.isAbsolute(rel)||rel.includes('\\')||rel.includes('\0'))throw Error('INVALID_PATH');
 const bits=rel.split('/');
 if(bits.some(b=>!b||b==='.'||b==='..'||b==='.git'||b==='.mcp-video'))throw Error('UNSAFE_PATH');
 let p=rootDir(root);for(const b of bits){p=path.join(p,b);try{if(fs.lstatSync(p).isSymbolicLink())throw Error('SYMLINK_DENIED');}catch(e){if(e.code!=='ENOENT')throw e;}}
 return p;
}
function file(root,rel,ext=EXT){
 const p=safe(root,rel);
 if(!ext.has(path.extname(p).toLowerCase()))throw Error('INVALID_EXTENSION');
 const s=fs.lstatSync(p);if(!s.isFile()||s.nlink!==1||s.size>4*1024**3)throw Error('INVALID_FILE');
 return p;
}
function dest(root,rel,ext=new Set(['.mp4'])){
 const p=safe(root,rel);
 if(!ext.has(path.extname(p).toLowerCase()))throw Error('INVALID_OUTPUT_EXTENSION');
 const s=fs.lstatSync(path.dirname(p));if(!s.isDirectory()||s.isSymbolicLink())throw Error('INVALID_OUTPUT_PARENT');
 try{fs.lstatSync(p);throw Error('OUTPUT_EXISTS');}catch(e){if(e.code!=='ENOENT')throw e;}
 return p;
}
function state(root){
 const d=path.join(rootDir(root),'.mcp-video'),jobs=path.join(d,'jobs');
 for(const p of [d,jobs]){
  try{fs.mkdirSync(p,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
  let s=fs.lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink())throw Error('UNSAFE_STATE_DIRECTORY');
 }
 return {d,jobs};
}
function jobPaths(root,id){if(typeof id!=='string'||!/^[a-f0-9]{24}$/.test(id))throw Error('INVALID_JOB_ID');const j=state(root).jobs;return {record:path.join(j,id+'.json'),log:path.join(j,id+'.log'),cancel:path.join(j,id+'.cancel'),lock:path.join(j,'render.lock')};}
function readJob(root,id){const p=jobPaths(root,id).record,s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.size>32768)throw Error('INVALID_JOB');return JSON.parse(fs.readFileSync(p,'utf8'));}
function saveJob(root,id,j){const p=jobPaths(root,id).record,t=p+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';try{fs.writeFileSync(t,JSON.stringify(j)+'\n',{flag:'wx',mode:0o600});fs.renameSync(t,p);}finally{try{fs.unlinkSync(t)}catch(e){if(e.code!=='ENOENT')throw e;}}}
function num(n,a,b,label){if(typeof n!=='number'||!Number.isFinite(n)||n<a||n>b)throw Error('INVALID_'+label);return n;}
function validate(root,x){
 if(!x||typeof x!=='object'||!Array.isArray(x.clips)||!x.clips.length||x.clips.length>24)throw Error('INVALID_TIMELINE');
 const w=num(x.width??1280,320,1920,'WIDTH'),h=num(x.height??720,240,1080,'HEIGHT'),fps=num(x.fps??30,12,60,'FPS');
 if(!Number.isInteger(w)||w%2||!Number.isInteger(h)||h%2||!Number.isInteger(fps))throw Error('INVALID_VIDEO_DIMENSIONS');
 let duration=0;
 const clips=x.clips.map(c=>{
  if(!c||typeof c.path!=='string')throw Error('INVALID_CLIP');
  file(root,c.path);
  const start=num(c.start??0,0,1800,'START'),end=num(c.end,0.1,1800,'END'),speed=num(c.speed??1,0.5,2,'SPEED');
  if(end-start<0.1||end-start>600)throw Error('INVALID_CLIP_RANGE');
  duration+=(end-start)/speed;
  return {path:c.path,start,end,speed};
 });
 if(duration>1800)throw Error('TIMELINE_TOO_LONG');
 return {version:1,width:w,height:h,fps,clips,durationSeconds:Math.round(duration*1000)/1000};
}
function timelineSave(root,{path:rel,timeline,expectedSha256}={}){
 if(typeof rel!=='string'||!rel.endsWith('.timeline.json'))throw Error('INVALID_TIMELINE_PATH');
 const p=safe(root,rel),spec=validate(root,timeline),bytes=Buffer.from(JSON.stringify(spec,null,2)+'\n');
 let old=null;
 try{const st=fs.lstatSync(p);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>1024*1024)throw Error('INVALID_TIMELINE_FILE');
  old=fs.readFileSync(p);if(!/^[a-f0-9]{64}$/i.test(expectedSha256||'')||sha(old)!==expectedSha256.toLowerCase())throw Error('STALE_TIMELINE');
 }catch(e){if(e.code!=='ENOENT')throw e;if(expectedSha256)throw Error('TIMELINE_MISSING');}
 if(!fs.lstatSync(path.dirname(p)).isDirectory())throw Error('TIMELINE_DIRECTORY_MISSING');
 const t=path.join(path.dirname(p),'.mcp-video-plan-'+crypto.randomBytes(8).toString('hex'));
 try{fs.writeFileSync(t,bytes,{flag:'wx',mode:0o600});if(old&&sha(fs.readFileSync(p))!==sha(old))throw Error('STALE_TIMELINE');fs.renameSync(t,p);}
 finally{try{fs.unlinkSync(t)}catch(e){if(e.code!=='ENOENT')throw e;}}
 return {path:rel,sha256:sha(bytes),durationSeconds:spec.durationSeconds,clips:spec.clips.length};
}
function timelineRead(root,{path:rel}={}){
 if(typeof rel!=='string'||!rel.endsWith('.timeline.json'))throw Error('INVALID_TIMELINE_PATH');
 const p=file(root,rel,new Set(['.json']));if(fs.statSync(p).size>1024*1024)throw Error('TIMELINE_TOO_LARGE');const b=fs.readFileSync(p);if(b.length>1024*1024)throw Error('TIMELINE_TOO_LARGE');
 return {path:rel,sha256:sha(b),timeline:validate(root,JSON.parse(b.toString('utf8')))};
}
function command(bin,args,{cwd,signal,timeout=45000,onProgress,limit=1024*1024}={}){
 return new Promise((resolve,reject)=>{
  const child=spawn(bin,args,{cwd,detached:true,stdio:['ignore','pipe','pipe'],
    env:{PATH:process.env.PATH||'/usr/local/bin:/usr/bin:/bin',HOME:process.env.HOME||'/nonexistent',LANG:'C'}});
  let stdout=[],length=0,err='',finished=false;
  const kill=()=>{try{process.kill(-child.pid,'SIGKILL');}catch{try{child.kill('SIGKILL')}catch{}}};
  const finish=(e,v)=>{if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(e)reject(e);else resolve(v);};
  const abort=()=>{kill();finish(Error('CANCELLED'))};
  const timer=setTimeout(()=>{kill();finish(Error('PROCESS_TIMEOUT'))},timeout);
  signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted){abort();return;}
  child.stdout.on('data',b=>{length+=b.length;if(length>limit){kill();finish(Error('OUTPUT_TOO_LARGE'));}else stdout.push(b)});
  child.stderr.on('data',b=>{const t=b.toString();err=(err+t).slice(-32000);onProgress?.(t);});
  child.once('error',e=>finish(e));
  child.once('close',c=>c===0?finish(null,{stdout:Buffer.concat(stdout),stderr:err}):finish(Error(bin+' exited '+c+': '+err.slice(-2000))));
 });
}
async function probe(root,{path:rel}={},signal){
 const p=file(root,rel),r=await command('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-show_format','-show_streams','-of','json',p],
 {cwd:rootDir(root),signal,timeout:30000,limit:512000});
 const x=JSON.parse(r.stdout.toString()),v=x.streams?.find(s=>s.codec_type==='video'),a=x.streams?.find(s=>s.codec_type==='audio');
 if(!v)throw Error('VIDEO_STREAM_NOT_FOUND');
 const duration=Number(x.format?.duration||v.duration);
 return {path:rel,durationSeconds:Number.isFinite(duration)?duration:null,width:v.width,height:v.height,videoCodec:v.codec_name||null,audioCodec:a?.codec_name||null,hasAudio:!!a,bytes:fs.statSync(p).size};
}
async function preview(root,{path:rel,atSeconds=0,width=640}={}){
 const p=file(root,rel);num(atSeconds,0,1800,'TIME');num(width,160,1280,'WIDTH');
 if(!Number.isInteger(width))throw Error('INVALID_WIDTH');
 const r=await command('ffmpeg',['-hide_banner','-nostdin','-loglevel','error','-ss',String(atSeconds),'-protocol_whitelist','file,pipe','-i',p,'-frames:v','1','-vf','scale='+width+':-2','-f','image2pipe','-vcodec','mjpeg','-q:v','5','pipe:1'],
 {cwd:rootDir(root),timeout:45000,limit:2*1024*1024});
 if(r.stdout.length<4||r.stdout[0]!==255||r.stdout[1]!==216)throw Error('PREVIEW_EMPTY');
 return {mimeType:'image/jpeg',data:r.stdout.toString('base64'),bytes:r.stdout.length,path:rel,atSeconds};
}
async function contactSheet(root,{path:rel,fromSeconds=0,windowSeconds=120}={}){
 const p=file(root,rel),meta=await probe(root,{path:rel});
 num(fromSeconds,0,10800,'FROM_SECONDS');num(windowSeconds,1,600,'WINDOW_SECONDS');
 if(meta.durationSeconds===null||fromSeconds>=meta.durationSeconds)throw Error('INVALID_CONTACT_SHEET_RANGE');
 const window=Math.min(windowSeconds,meta.durationSeconds-fromSeconds);
 const frequency=(8/window).toFixed(6);
 const vf='fps='+frequency+',scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2,tile=4x2:nb_frames=8';
 const args=['-hide_banner','-nostdin','-loglevel','error','-ss',String(fromSeconds),'-t',String(window),
  '-protocol_whitelist','file,pipe','-i',p,'-vf',vf,'-frames:v','1','-f','image2pipe',
  '-vcodec','mjpeg','-q:v','6','pipe:1'];
 const result=await command('ffmpeg',args,{cwd:rootDir(root),timeout:90000,limit:2*1024*1024});
 if(result.stdout.length<4||result.stdout[0]!==255||result.stdout[1]!==216)throw Error('CONTACT_SHEET_EMPTY');
 return {path:rel,fromSeconds,windowSeconds:window,mimeType:'image/jpeg',data:result.stdout.toString('base64'),bytes:result.stdout.length};
}
function renderStart(root,{timelinePath,outputPath}={}){
 const plan=timelineRead(root,{path:timelinePath});
 dest(root,outputPath);
 const id=crypto.randomBytes(12).toString('hex'),f=jobPaths(root,id);
 const job={id,status:'queued',timelinePath,outputPath,createdAt:new Date().toISOString(),finishedAt:null,
  progressPercent:0,clips:plan.timeline.clips.length,durationSeconds:plan.timeline.durationSeconds,error:null};
 fs.writeFileSync(f.record,JSON.stringify(job)+'\n',{flag:'wx',mode:0o600});
 const child=spawn(process.execPath,[path.join(__dirname,'video-worker.js'),rootDir(root),id],
  {cwd:rootDir(root),detached:true,stdio:'ignore',env:{PATH:process.env.PATH||'/usr/local/bin:/usr/bin:/bin',HOME:process.env.HOME||'/nonexistent',LANG:'C'}});
 child.once('error',error=>{try{saveJob(root,id,{...readJob(root,id),status:'failed',error:'Worker launch failed: '+error.message,finishedAt:new Date().toISOString()});}catch{}});
 child.unref();
 return {id,status:'queued',outputPath,clips:job.clips,durationSeconds:job.durationSeconds};
}
function renderStatus(root,{id}={}){const j=readJob(root,id);return {id:j.id,status:j.status,createdAt:j.createdAt,finishedAt:j.finishedAt,
 progressPercent:j.progressPercent,outputPath:j.outputPath,error:j.error,clips:j.clips,durationSeconds:j.durationSeconds};}
function renderLogs(root,{id,tail=2000}={}){
 num(tail,1,32000,'TAIL');const result=renderStatus(root,{id}),p=jobPaths(root,id).log;
 let log='',logBytes=0;try{const s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink())throw Error('UNSAFE_LOG');logBytes=s.size;const b=Buffer.alloc(Math.min(tail,s.size)),fd=fs.openSync(p,'r');
 try{fs.readSync(fd,b,0,b.length,s.size-b.length);}finally{fs.closeSync(fd);}
 log=b.toString();
 }catch(e){if(e.code!=='ENOENT')throw e;}
 return {...result,log,logBytes,logTruncated:logBytes>tail};
}
function renderCancel(root,{id}={}){
 const j=renderStatus(root,{id});
 if(!['queued','running'].includes(j.status))return {...j,cancellationRequested:false};
 const p=jobPaths(root,id).cancel;try{fs.writeFileSync(p,'cancel\n',{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
 return {...j,cancellationRequested:true};
}

/**
 * Capture one screenshot of an explicitly configured local development server.
 * The setting is intentionally absent by default: this endpoint is unauthenticated.
 */
function captureSettings(args={},env=process.env){
 const origin=env.MCP_WORKSPACE_CAPTURE_ORIGIN;
 if(!origin)throw Error('CAPTURE_DISABLED_SET_MCP_WORKSPACE_CAPTURE_ORIGIN');
 let address;
 try{address=new URL(origin);}catch{throw Error('INVALID_CAPTURE_ORIGIN');}
 if(address.protocol!=='http:'||
    !['127.0.0.1','localhost'].includes(address.hostname)||
    !address.port||!Number.isInteger(Number(address.port))||Number(address.port)<1||Number(address.port)>65535||
    address.username||address.password||address.search||address.hash||address.pathname!=='/'){
   throw Error('INVALID_CAPTURE_ORIGIN');
 }
 const route=args.route??'/';
 if(typeof route!=='string'||route.length>180||!/^\/[a-zA-Z0-9/_\-.]*$/.test(route)||
    route.includes('//')||route.split('/').includes('..')||route.split('/').includes('.')||
    route.startsWith('/api/')||route==='/api')throw Error('INVALID_CAPTURE_ROUTE');
 const width=num(args.width??1440,320,1920,'WIDTH'),height=num(args.height??900,320,1920,'HEIGHT');
 if(!Number.isInteger(width)||!Number.isInteger(height))throw Error('INVALID_CAPTURE_DIMENSIONS');
 const waitMs=num(args.waitMs??1500,0,6000,'WAIT_MS');
 if(!Number.isInteger(waitMs))throw Error('INVALID_CAPTURE_WAIT_MS');
 if(typeof args.outputPath!=='string'||!args.outputPath.endsWith('.png'))throw Error('INVALID_CAPTURE_OUTPUT');
 return {url:address.origin+route,route,origin:address.origin,width,height,waitMs,outputPath:args.outputPath};
}
async function capturePage(root,args={},opts={}){
 const settings=captureSettings(args,opts.env??process.env);
 const target=dest(root,settings.outputPath,new Set(['.png']));
 const profile=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'mcp-video-capture-'));
 const intermediate=path.join(path.dirname(target),'.mcp-capture-'+crypto.randomBytes(12).toString('hex')+'.png');
 const flags=[
  '--headless=new','--disable-gpu','--disable-dev-shm-usage',
  '--no-first-run','--no-default-browser-check','--disable-extensions',
  '--disable-background-networking','--disable-sync','--hide-scrollbars',
  '--force-device-scale-factor=1',
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
  '--user-data-dir='+profile,'--window-size='+settings.width+','+settings.height,
  '--virtual-time-budget='+settings.waitMs,'--screenshot='+intermediate,
  settings.url
 ];
 const runner=opts.runner??((bin,argv,settings)=>command(bin,argv,settings));
 try{
  await runner('google-chrome',flags,{cwd:rootDir(root),timeout:30000,limit:16000});
  const st=fs.lstatSync(intermediate);
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size<100||st.size>16*1024*1024)throw Error('INVALID_CAPTURE_FILE');
  const fd=fs.openSync(intermediate,'r'),head=Buffer.alloc(24);
  try{if(fs.readSync(fd,head,0,24,0)!==24)throw Error('INVALID_CAPTURE_FILE');}
  finally{fs.closeSync(fd);}
  if(!head.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||
     head.toString('ascii',12,16)!=='IHDR')throw Error('INVALID_CAPTURE_PNG');
  const imageWidth=head.readUInt32BE(16),imageHeight=head.readUInt32BE(20);
  if(imageWidth<100||imageHeight<100||imageWidth>4096||imageHeight>4096)throw Error('INVALID_CAPTURE_DIMENSIONS');
  if(fs.existsSync(target))throw Error('OUTPUT_EXISTS');
  fs.linkSync(intermediate,target);
  return {path:settings.outputPath,urlPath:settings.route,width:imageWidth,height:imageHeight,
   bytes:st.size,sha256:sha(fs.readFileSync(target)),description:'Isolated Chrome, localhost only; does not use signed-in browser sessions.'};
 }finally{
  try{fs.unlinkSync(intermediate);}catch(e){if(e.code!=='ENOENT')throw e;}
  fs.rmSync(profile,{recursive:true,force:true});
 }
}

function capabilities(){
 const which=bin=>{try{const r=spawnSync(bin,['-version'],{encoding:'utf8',timeout:3000});return r.status===0?r.stdout.split('\n')[0].slice(0,120):null;}catch{return null;}};
 return {ffmpeg:which('ffmpeg'),ffprobe:which('ffprobe'),renderEncoder:'libx264',authentication:'disabled',maxClips:24,maxTimelineSeconds:1800};
}
module.exports={rootDir,safe,file,dest,state,jobPaths,readJob,saveJob,validate,timelineSave,timelineRead,
 command,probe,preview,contactSheet,renderStart,renderStatus,renderLogs,renderCancel,capabilities,captureSettings,capturePage};
