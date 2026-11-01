'use strict';
const fs=require('node:fs'),path=require('node:path');
const crypto=require('node:crypto');
const core=require('./video-core');
const [root,id]=process.argv.slice(2);
if(!root||!id)process.exit(2);
let abort=new AbortController(),timer,working;
const hardDeadline=setTimeout(()=>abort.abort(),2*60*60*1000);hardDeadline.unref();
const paths=core.jobPaths(root,id);
const log=t=>{
 try{fs.appendFileSync(paths.log,t.slice(-2000),{mode:0o600});}catch{}
};
const update=patch=>{const current=core.readJob(root,id);core.saveJob(root,id,{...current,...patch});};
function concatLine(file){return "file '"+file+"'\n";}
async function execute(){
 let lock;
 try{
  try{lock=fs.openSync(paths.lock,'wx',0o600);}
  catch(e){
   if(e.code!=='EEXIST')throw e;
   const age=Date.now()-fs.statSync(paths.lock).mtimeMs;
   if(age<2*60*60*1000)throw Error('RENDER_BUSY: another render is running');
   fs.unlinkSync(paths.lock);lock=fs.openSync(paths.lock,'wx',0o600);
  }
  fs.writeSync(lock,id);
  if(fs.existsSync(paths.cancel))throw Error('CANCELLED');
  const plan=core.timelineRead(root,{path:core.readJob(root,id).timelinePath}).timeline;
  const output=core.dest(root,core.readJob(root,id).outputPath);
  update({status:'running',progressPercent:0});
  log('Starting '+plan.clips.length+' clip(s)\n');
  working=fs.mkdtempSync(path.join(core.state(root).d,'render-'+id+'-'));
  const sources=[];
  for(let i=0;i<plan.clips.length;i++){
   if(abort.signal.aborted||fs.existsSync(paths.cancel))throw Error('CANCELLED');
   const c=plan.clips[i];
   const info=await core.probe(root,{path:c.path},abort.signal);
   if(info.durationSeconds!==null&&c.end>info.durationSeconds+0.25)throw Error('CLIP_EXCEEDS_SOURCE_DURATION: '+c.path);
   const src=core.file(root,c.path),name=String(i).padStart(3,'0')+'.mp4',dst=path.join(working,name);
   const duration=(c.end-c.start)/c.speed;
   const args=['-hide_banner','-nostdin','-loglevel','error','-progress','pipe:2','-ss',String(c.start),'-t',String(c.end-c.start),
    '-protocol_whitelist','file,pipe','-i',src];
   if(!info.hasAudio)args.push('-f','lavfi','-i','anullsrc=r=48000:cl=stereo');
   const vf='fps='+plan.fps+',scale='+plan.width+':'+plan.height+':force_original_aspect_ratio=decrease,pad='+plan.width+':'+plan.height+':(ow-iw)/2:(oh-ih)/2,setsar=1,setpts=(PTS-STARTPTS)/'+c.speed;
   args.push('-map','0:v:0','-map',info.hasAudio?'0:a:0':'1:a:0','-vf',vf);
   if(info.hasAudio)args.push('-af','aresample=48000,atempo='+c.speed+',asetpts=PTS-STARTPTS');
   args.push('-t',String(duration),'-c:v','libx264','-preset','veryfast','-crf','23','-pix_fmt','yuv420p',
    '-threads','2','-c:a','aac','-b:a','128k','-ar','48000','-ac','2','-y',dst);
   log('Rendering clip '+(i+1)+'/'+plan.clips.length+': '+c.path+'\n');
   await core.command('ffmpeg',args,{cwd:working,signal:abort.signal,timeout:2*60*60*1000,
    onProgress:t=>{const match=t.match(/out_time=(\d+):(\d+):([\d.]+)/);if(match){const seconds=Number(match[1])*3600+Number(match[2])*60+Number(match[3]);
       update({progressPercent:Math.min(95,Math.round(95*(i+Math.min(1,seconds/duration))/plan.clips.length))});}}});
   sources.push(name);
   update({progressPercent:Math.round(95*(i+1)/plan.clips.length)});
  }
  fs.writeFileSync(path.join(working,'concat.txt'),sources.map(concatLine).join(''),{mode:0o600});
  log('Joining clips\n');
  const final=path.join(working,'render.mp4');
  await core.command('ffmpeg',['-hide_banner','-nostdin','-loglevel','error','-f','concat','-safe','1',
    '-protocol_whitelist','file,pipe','-i','concat.txt','-c','copy','-movflags','+faststart','-y',final],
   {cwd:working,signal:abort.signal,timeout:600000});
  if(fs.existsSync(paths.cancel)||abort.signal.aborted)throw Error('CANCELLED');
  // Hard link creates the output only when no file of the same name exists.
  fs.linkSync(final,output);
  update({status:'completed',progressPercent:100,finishedAt:new Date().toISOString()});
  log('Completed: '+core.readJob(root,id).outputPath+'\n');
 }catch(e){
  const cancelled=abort.signal.aborted||fs.existsSync(paths.cancel)||e.message==='CANCELLED';
  update({status:cancelled?'cancelled':'failed',error:cancelled?'Cancelled':String(e.message).slice(0,1500),finishedAt:new Date().toISOString()});
  log('Render '+(cancelled?'cancelled: ':'failed: ')+String(e.message).slice(0,1500)+'\n');
 }finally{
  clearTimeout(hardDeadline);
  if(timer)clearInterval(timer);
  if(working)try{fs.rmSync(working,{recursive:true,force:true});}catch(e){log('Cleanup issue: '+e.message+'\n')}
  if(lock!==undefined){
   try{fs.closeSync(lock);}catch{}
   try{if(fs.readFileSync(paths.lock,'utf8')===id)fs.unlinkSync(paths.lock);}catch{}
  }
 }
}
timer=setInterval(()=>{if(fs.existsSync(paths.cancel))abort.abort();},500);
execute().catch(e=>{log('Unexpected worker failure: '+e.message+'\n');process.exitCode=1;});
