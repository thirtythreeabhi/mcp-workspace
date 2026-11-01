'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const video=require('./video-core');
const DEFAULT_PROJECT='remotion-project';
const COMPOSITIONS=new Set(['TalentStreamOpening','TalentStreamV4']);
const PIN='4.0.539';
const EXPECTED={name:'talentstream-remotion',version:'0.1.0',private:true,type:'module',
  dependencies:{'@remotion/cli':PIN,remotion:PIN,react:'19.2.0','react-dom':'19.2.0'},
  devDependencies:{'@types/react':'19.2.2','@types/react-dom':'19.2.0',typescript:'5.9.3'}};

function projectPath(root,env=process.env) {
 const rel=env.MCP_WORKSPACE_REMOTION_PROJECT||DEFAULT_PROJECT;
 const absolute=video.safe(root,rel);
 const exists=fs.existsSync(absolute);
 if(exists){
  const stat=fs.lstatSync(absolute);
  if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('UNSAFE_REMOTION_PROJECT');
 }
 return {relative:rel,absolute,exists};
}
function projectManifest(root,env=process.env){
 const project=projectPath(root,env);
 if(!project.exists)throw Error('REMOTION_PROJECT_MISSING');
 const file=video.file(root,project.relative+'/package.json',new Set(['.json']));
 const stat=fs.statSync(file);
 if(stat.size>16*1024)throw Error('REMOTION_MANIFEST_TOO_LARGE');
 const actual=JSON.parse(fs.readFileSync(file,'utf8'));
 for(const key of ['name','version','private','type'])
  if(actual[key]!==EXPECTED[key])throw Error('UNAPPROVED_REMOTION_MANIFEST: '+key);
 for(const key of ['dependencies','devDependencies'])
  if(JSON.stringify(Object.entries(actual[key]||{}).sort())!==JSON.stringify(Object.entries(EXPECTED[key]).sort()))
   throw Error('UNAPPROVED_REMOTION_DEPENDENCIES');
 if(actual.scripts&&Object.keys(actual.scripts).some(key=>!/^(studio|render)$/.test(key)))throw Error('UNAPPROVED_REMOTION_SCRIPTS');
 if(actual.workspaces||actual.overrides||actual.resolutions||actual.publishConfig||actual.bin)throw Error('UNAPPROVED_REMOTION_PACKAGE_CONFIG');
 return project;
}
function registeredCompositions(root,env=process.env){
 const p=projectManifest(root,env);
 const result=new Map([['TalentStreamOpening',null],['TalentStreamV4',null]]);
 const source=path.join(p.absolute,'src','root.tsx');
 try{
  const st=fs.lstatSync(source);
  if(!st.isFile()||st.isSymbolicLink()||st.size>65536)throw Error('INVALID_COMPOSITION_REGISTRY');
  const code=fs.readFileSync(source,'utf8');
  // Only literal IDs in the trusted fixed project qualify; never pass arbitrary CLI composition IDs.
  const regex=/<Composition\s+id=["']([A-Za-z][A-Za-z0-9_-]*)["'][^>]*>/g;
  for(const match of code.matchAll(regex)){
   const duration=match[0].match(/durationInFrames=\{(\d+)\}/);
   result.set(match[1],duration?Number(duration[1]):null);
  }
 }catch(e){if(e.code!=='ENOENT')throw e;}
 return {projectPath:p.relative,compositions:[...result].map(([id,durationInFrames])=>({id,durationInFrames}))};
}
function dependencies(root,env=process.env){
 const project=projectPath(root,env);
 const chrome='/usr/bin/google-chrome';
 const cli=path.join(project.absolute,'node_modules','.bin','remotion');
 const entry=path.join(project.absolute,'src','index.ts');
 let manifestApproved=false;
 try{projectManifest(root,env);manifestApproved=true;}catch{}
 let cliAvailable=false;
 try{const s=fs.lstatSync(cli);cliAvailable=s.isFile()||s.isSymbolicLink();}catch{}
 return {projectPath:project.relative,projectExists:project.exists,manifestApproved,
  hostEnabled:env.MCP_WORKSPACE_REMOTION_HOST_ENABLED==='1',
  chromeAvailable:fs.existsSync(chrome),cliAvailable,entryAvailable:fs.existsSync(entry),
  installed:project.exists&&manifestApproved&&cliAvailable&&fs.existsSync(entry)&&fs.existsSync(chrome),
  remotionVersion:PIN,execution:'Ubuntu host — OS scheduling, no configured CPU/RAM/render time limits',
  note:'The terminal sandbox is separate and may retain platform-enforced limits.'};
}
function validate(root,params={},env=process.env){
 const {compositionId='TalentStreamOpening',outputPath,frame,quality='final'}=params;
 const composition=registeredCompositions(root,env).compositions.find(c=>c.id===compositionId);
 if(!composition)throw Error('COMPOSITION_NOT_ALLOWLISTED');
 if(!['draft','final'].includes(quality))throw Error('INVALID_QUALITY');
 const still=frame!==undefined;
 if(still&&(!Number.isSafeInteger(frame)||frame<0||frame>20000||(composition.durationInFrames!==null&&frame>=composition.durationInFrames)))throw Error('INVALID_FRAME');
 const target=video.dest(root,outputPath,new Set([still?'.png':'.mp4']));
 const dep=dependencies(root,env);
 if(!dep.installed)throw Error('REMOTION_NOT_INSTALLED');
 return {project:projectManifest(root,env),outputPath,target,compositionId,frame:still?frame:null,still,quality,chrome:'/usr/bin/google-chrome'};
}
function queue(root,record,env=process.env){
 const id=crypto.randomBytes(12).toString('hex');
 const paths=video.jobPaths(root,id);
 const value={id,status:'queued',createdAt:new Date().toISOString(),finishedAt:null,progressPercent:0,error:null,...record};
 fs.writeFileSync(paths.record,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});
 const child=spawn(process.execPath,[path.join(__dirname,'remotion-worker.js'),video.rootDir(root),id],{
  cwd:video.rootDir(root),detached:true,stdio:'ignore',
  env:{PATH:process.env.PATH||'/usr/local/bin:/usr/bin:/bin',HOME:process.env.HOME||'/nonexistent',LANG:'C',
    MCP_WORKSPACE_REMOTION_PROJECT:projectPath(root,env).relative}
 });
 child.once('error',err=>{try{video.saveJob(root,id,{...video.readJob(root,id),status:'failed',error:'Failed to spawn worker: '+err.message,finishedAt:new Date().toISOString()});}catch{}});
 child.unref();
 return {id,status:'queued',kind:record.kind,outputPath:record.outputPath||null};
}
function renderStart(root,args={},env=process.env){
 if(env.MCP_WORKSPACE_REMOTION_HOST_ENABLED!=='1')throw Error('HOST_REMOTION_DISABLED');
 const v=validate(root,args,env);
 return queue(root,{kind:'remotion',outputPath:v.outputPath,compositionId:v.compositionId,frame:v.frame,quality:v.quality},env);
}
function installStart(root,env=process.env){
 if(env.MCP_WORKSPACE_REMOTION_HOST_ENABLED!=='1')throw Error('HOST_REMOTION_DISABLED');
 const project=projectManifest(root,env);
 const current=dependencies(root,env);
 if(current.installed)return {status:'already-installed',projectPath:project.relative,remotionVersion:PIN};
 return queue(root,{kind:'remotion-install',outputPath:null,projectPath:project.relative},env);
}
function workerArgs(verified,temp){
 const args=[verified.still?'still':'render','src/index.ts',verified.compositionId,temp,
  '--browser-executable=/usr/bin/google-chrome','--log=error'];
 if(verified.still)args.push('--frame='+verified.frame);
 else args.push('--codec=h264','--crf='+(verified.quality==='draft'?'22':'17'));
 // No --concurrency: Remotion uses its default CPU scheduling on the host.
 return args;
}
module.exports={PIN,EXPECTED,projectPath,projectManifest,registeredCompositions,dependencies,validate,queue,installStart,renderStart,workerArgs,COMPOSITIONS};
