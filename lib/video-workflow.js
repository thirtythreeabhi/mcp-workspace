'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const video=require('./video-core');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const NAME=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const AUDIO=new Set(['.mp3','.wav','.m4a','.aac','.flac','.ogg','.opus']);
function dir(root){const p=path.join(video.state(root).d,'projects');fs.mkdirSync(p,{recursive:true,mode:0o700});const s=fs.lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink())throw Error('UNSAFE_PROJECT_DIRECTORY');return p;}
function filePath(root,id){if(typeof id!=='string'||!NAME.test(id))throw Error('INVALID_PROJECT_ID');return path.join(dir(root),id+'.json');}
function readProject(root,id){
 const file=filePath(root,id);let data;
 try{const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>16384)throw Error('INVALID_PROJECT_FILE');data=fs.readFileSync(file);}
 catch(e){if(e.code==='ENOENT')return {projectId:id,exists:false,sha256:null,state:null};throw e;}
 const obj=JSON.parse(data.toString('utf8'));return {projectId:id,exists:true,sha256:hash(data),state:obj.state,updatedAt:obj.updatedAt};
}
function validString(v,n,max){if(typeof v!=='string'||!v.trim()||v.length>max)throw Error('INVALID_'+n);return v;}
function validateState(root,v){
 if(!v||typeof v!=='object'||Array.isArray(v))throw Error('INVALID_PROJECT_STATE');
 const allowed=new Set(['title','notes','audioPath','transcriptPath','alignmentPath','sourcePath','compositionId','fps','scenes','renders']);
 for(const k of Object.keys(v))if(!allowed.has(k))throw Error('UNKNOWN_PROJECT_FIELD: '+k);
 const s={};
 for(const k of ['title','notes'])if(v[k]!==undefined)s[k]=validString(v[k],k.toUpperCase(),k==='notes'?4000:150);
 for(const k of ['audioPath','transcriptPath','alignmentPath','sourcePath'])if(v[k]!==undefined){s[k]=validString(v[k],k.toUpperCase(),400);video.safe(root,s[k]);}
 if(v.compositionId!==undefined){s.compositionId=validString(v.compositionId,'COMPOSITION',80);if(!/^[A-Za-z][A-Za-z0-9_-]*$/.test(s.compositionId))throw Error('INVALID_COMPOSITION');}
 if(v.fps!==undefined){if(!Number.isInteger(v.fps)||v.fps<12||v.fps>120)throw Error('INVALID_FPS');s.fps=v.fps;}
 if(v.scenes!==undefined){
  if(!Array.isArray(v.scenes)||v.scenes.length>80)throw Error('INVALID_SCENES');
  let last=0;s.scenes=v.scenes.map(x=>{
   if(!x||typeof x!=='object')throw Error('INVALID_SCENE');
   const id=validString(x.id,'SCENE_ID',90);if(!/^[A-Za-z0-9_-]+$/.test(id))throw Error('INVALID_SCENE_ID');
   const a=x.startSeconds,b=x.endSeconds;
   if(!Number.isFinite(a)||!Number.isFinite(b)||a<0||b<=a||b>10800||a<last-0.001)throw Error('INVALID_SCENE_TIMING');
   last=b;return {id,startSeconds:a,endSeconds:b,...(x.notes===undefined?{}:{notes:validString(x.notes,'SCENE_NOTES',400)})};
  });
 }
 if(v.renders!==undefined){
  if(!Array.isArray(v.renders)||v.renders.length>40)throw Error('INVALID_RENDERS');
  s.renders=v.renders.map(r=>{const outputPath=validString(r?.outputPath,'RENDER_PATH',400);video.safe(root,outputPath);
   return {outputPath,...(r.jobId===undefined?{}:{jobId:validString(r.jobId,'JOB_ID',80)}),...(r.status===undefined?{}:{status:validString(r.status,'RENDER_STATUS',40)})};});
 }
 return s;
}
function saveProject(root,id,value,expectedSha256){
 const target=filePath(root,id),prev=readProject(root,id);
 if(prev.exists&&(!/^[a-f0-9]{64}$/i.test(expectedSha256||'')||prev.sha256!==expectedSha256.toLowerCase()))throw Error('STALE_PROJECT');
 if(!prev.exists&&expectedSha256)throw Error('PROJECT_NOT_FOUND');
 const state=validateState(root,value),updatedAt=new Date().toISOString();
 const bytes=Buffer.from(JSON.stringify({version:1,projectId:id,updatedAt,state},null,2)+'\n');
 if(bytes.length>16384)throw Error('PROJECT_TOO_LARGE');
 const tmp=target+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';
 try{fs.writeFileSync(tmp,bytes,{flag:'wx',mode:0o600});if(prev.exists&&hash(fs.readFileSync(target))!==prev.sha256)throw Error('STALE_PROJECT');fs.renameSync(tmp,target);}
 finally{try{fs.unlinkSync(tmp);}catch(e){if(e.code!=='ENOENT')throw e;}}
 return {projectId:id,exists:true,sha256:hash(bytes),updatedAt,sceneCount:state.scenes?.length||0,renderCount:state.renders?.length||0};
}
function projectState(root,{action,projectId,state,expectedSha256}={}){
 if(action==='read')return readProject(root,projectId);
 if(action==='save')return saveProject(root,projectId,state,expectedSha256);
 if(action==='list'){
  const names=fs.readdirSync(dir(root)).filter(n=>n.endsWith('.json')&&NAME.test(n.slice(0,-5)));
  return {projects:names.slice(0,100).map(n=>{try{const p=readProject(root,n.slice(0,-5));return {projectId:p.projectId,updatedAt:p.updatedAt,title:p.state?.title||null};}catch{return {projectId:n.slice(0,-5),error:'UNREADABLE_PROJECT'};}}),truncated:names.length>100};
 }
 throw Error('INVALID_PROJECT_ACTION');
}
async function audioTiming(root,{audioPath,thresholdDb=-33,minSilenceSeconds=0.18,outputPath}={}){
 if(typeof audioPath!=='string')throw Error('INVALID_AUDIO_PATH');
 const file=video.file(root,audioPath,AUDIO);
 if(!Number.isFinite(thresholdDb)||thresholdDb<-80||thresholdDb>-8)throw Error('INVALID_SILENCE_THRESHOLD');
 if(!Number.isFinite(minSilenceSeconds)||minSilenceSeconds<0.1||minSilenceSeconds>3)throw Error('INVALID_SILENCE_DURATION');
 const info=await video.command('ffprobe',['-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',file],{cwd:video.rootDir(root),timeout:30000,limit:1024});
 const duration=Number(info.stdout.toString().trim());if(!Number.isFinite(duration)||duration<=0||duration>10800)throw Error('INVALID_AUDIO_DURATION');
 const window=Math.min(duration,1800);
 const result=await video.command('ffmpeg',['-hide_banner','-nostdin','-loglevel','info','-t',String(window),'-i',file,'-vn','-af','silencedetect=noise='+thresholdDb+'dB:d='+minSilenceSeconds,'-f','null','-'],{cwd:video.rootDir(root),timeout:120000,limit:1024});
 const starts=[...result.stderr.matchAll(/silence_start:\s*(\d+(?:\.\d+)?)/g)].map(x=>Number(x[1]));
 const ends=[...result.stderr.matchAll(/silence_end:\s*(\d+(?:\.\d+)?)/g)].map(x=>Number(x[1]));
 const silences=starts.slice(0,300).map((start,i)=>{const end=Math.min(window,ends[i]??window);return {startSeconds:start,endSeconds:end,midSeconds:Math.round((start+end)*500)/1000};}).filter(x=>x.endSeconds>=x.startSeconds);
 const body={version:1,audioPath,durationSeconds:duration,analyzedSeconds:window,method:'ffmpeg_silence_detection',wordLevel:false,
  note:'These are measured pauses, NOT strict word-level forced alignment.',silences};
 const rel=outputPath||audioPath+'.pauses.json',dest=video.dest(root,rel,new Set(['.json']));
 const bytes=Buffer.from(JSON.stringify(body,null,2)+'\n');
 fs.writeFileSync(dest,bytes,{flag:'wx',mode:0o600});
 return {audioPath,durationSeconds:duration,analyzedSeconds:window,method:body.method,wordLevel:false,silenceCount:silences.length,
  firstSilences:silences.slice(0,12),outputPath:rel,sha256:hash(bytes)};
}
async function review(root,{path:rel,fromSeconds=0,windowSeconds=60,projectId,maxSceneSeconds=7}={}){
 if(!Number.isFinite(maxSceneSeconds)||maxSceneSeconds<2||maxSceneSeconds>60)throw Error('INVALID_SCENE_THRESHOLD');
 const metadata=await video.probe(root,{path:rel});
 if(!Number.isFinite(fromSeconds)||fromSeconds<0||fromSeconds>=metadata.durationSeconds)throw Error('INVALID_REVIEW_START');
 if(!Number.isFinite(windowSeconds)||windowSeconds<1||windowSeconds>600)throw Error('INVALID_REVIEW_WINDOW');
 const window=Math.min(windowSeconds,metadata.durationSeconds-fromSeconds);
 let project;
 if(projectId!==undefined){project=readProject(root,projectId);if(!project.exists)throw Error('PROJECT_NOT_FOUND');}
 const sheet=await video.contactSheet(root,{path:rel,fromSeconds,windowSeconds:window});
 const base=rel.slice(0,rel.lastIndexOf('.')),suffix=crypto.randomBytes(5).toString('hex');
 const out=base+'-review-'+suffix+'.jpg',reportPath=base+'-review-'+suffix+'.json';
 const destination=video.dest(root,out,new Set(['.jpg'])),report=video.dest(root,reportPath,new Set(['.json']));
 const warnings=[],scenes=project?.state?.scenes||[];
 for(const scene of scenes){const duration=scene.endSeconds-scene.startSeconds;
  if(duration>maxSceneSeconds)warnings.push({sceneId:scene.id,reason:'LONG_SCENE',durationSeconds:Math.round(duration*100)/100});}
 if(scenes.length&&scenes[scenes.length-1].endSeconds>metadata.durationSeconds+0.25)warnings.push({reason:'SCENES_EXCEED_VIDEO_DURATION'});
 if(project&&!project.state?.alignmentPath)warnings.push({reason:'WORD_ALIGNMENT_NOT_VERIFIED'});
 const data={version:1,path:rel,fromSeconds,windowSeconds:window,frames:8,contactSheetPath:out,
  video:{durationSeconds:metadata.durationSeconds,width:metadata.width,height:metadata.height,hasAudio:metadata.hasAudio},
  scenesChecked:scenes.length,warnings,limitations:'Static sampling and timing checks only; not a semantic quality or word-alignment test.'};
 fs.writeFileSync(destination,Buffer.from(sheet.data,'base64'),{flag:'wx',mode:0o600});
 fs.writeFileSync(report,JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});
 return {...data,reportPath};
}
module.exports={projectState,readProject,saveProject,validateState,audioTiming,review};
