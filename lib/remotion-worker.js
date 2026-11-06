'use strict';
const fs=require('node:fs'),path=require('node:path');
const {spawn}=require('node:child_process');
const video=require('./video-core'),remotion=require('./remotion-core');
const [root,id]=process.argv.slice(2);
if(!root||!id)process.exit(2);
const paths=video.jobPaths(root,id);
const state=video.state(root);
let child=null,cancelWatcher=null,lockFd=null,lockPath=null;
function note(value){try{fs.appendFileSync(paths.log,String(value).slice(-4000),{mode:0o600});}catch{}}
function terminal(value){note('TERMINAL: '+value+'\n');}
function update(fields){video.saveJob(root,id,{...video.readJob(root,id),...fields});}
function cancelRequested(){return fs.existsSync(paths.cancel);}
function kill(){
 if(child?.pid)try{process.kill(-child.pid,'SIGKILL')}catch{try{child.kill('SIGKILL')}catch{}}
}
async function runProcess(bin,args,cwd,extraEnv={}){
 return new Promise((resolve,reject)=>{
  let completed=false,tail='',lastTerminalProgress=0;
  const settle=(error)=>{if(completed)return;completed=true;error?reject(error):resolve()};
  child=spawn(bin,args,{cwd,detached:true,stdio:['ignore','pipe','pipe'],env:{
    PATH:process.env.PATH||'/usr/local/bin:/usr/bin:/bin',
    HOME:process.env.HOME||'/nonexistent',LANG:'C',...extraEnv,
  }});
  function onData(chunk){
   const s=chunk.toString('utf8');tail=(tail+s).slice(-3500);note(s);
   const m=s.match(/(?:Rendered|Rendering)\s+(\d+)\s*(?:\/|of)\s*(\d+)/i);
   if(m){const percent=Math.min(98,Math.round(100*Number(m[1])/Math.max(1,Number(m[2]))));update({progressPercent:percent});
    if(percent>=lastTerminalProgress+5){lastTerminalProgress=Math.floor(percent/5)*5;terminal('Remotion render progress: '+lastTerminalProgress+'%');}}
  }
  child.stdout.on('data',onData);
  child.stderr.on('data',onData);
  child.once('error',err=>settle(Error('CHILD_START_FAILED: '+err.message)));
  child.once('exit',(code,signal)=>settle(code===0?null:Error('CHILD_FAILED: '+code+' '+signal+' '+tail.slice(-1200))));
  cancelWatcher=setInterval(()=>{if(cancelRequested()){kill();settle(Error('CANCELLED'));}},500);
 });
}
function obtainInstallLock(){
 lockPath=path.join(state.jobs,'remotion-install.lock');
 try{lockFd=fs.openSync(lockPath,'wx',0o600);}
 catch(e){if(e.code==='EEXIST')throw Error('INSTALL_ALREADY_IN_PROGRESS');throw e;}
 fs.writeSync(lockFd,id);
}
async function main(){
 let temporary=null;
 try{
  const job=video.readJob(root,id);
  if(cancelRequested())throw Error('CANCELLED');
  update({status:'running',progressPercent:1});
  if(job.kind==='remotion-install'){
   obtainInstallLock();
   const p=remotion.projectManifest(root);
   note('Installing pinned dependencies with npm on the Ubuntu host. Lifecycle scripts disabled.\n');
   terminal('Remotion dependency installation started');
   const args=['install','--ignore-scripts','--no-audit','--no-fund','--no-progress','--registry=https://registry.npmjs.org/','--save=false'];
   await runProcess('npm',args,p.absolute,{npm_config_ignore_scripts:'true',npm_config_audit:'false',npm_config_fund:'false'});
   const status=remotion.dependencies(root);
   if(!status.installed)throw Error('DEPENDENCIES_MISSING_AFTER_INSTALL');
   update({status:'completed',progressPercent:100,finishedAt:new Date().toISOString(),error:null});
   note('Remotion '+remotion.PIN+' installed and ready on Ubuntu.\n');
   terminal('Remotion dependencies installed and ready');
  }else if(job.kind==='remotion'){
   const v=remotion.validate(root,{
    compositionId:job.compositionId,outputPath:job.outputPath,frame:job.frame??undefined,quality:job.quality
   });
   temporary=path.join(state.d,'remotion-'+id+(v.still?'.png':'.mp4'));
   const args=remotion.workerArgs(v,temporary);
   const executable=path.join(v.project.absolute,'node_modules','.bin','remotion');
   note('Rendering '+job.compositionId+' on Ubuntu host; no configured CPU/RAM/time/concurrency caps.\n');
   terminal('Remotion render started: '+job.compositionId+' → '+job.outputPath);
   await runProcess(executable,args,v.project.absolute);
   if(cancelRequested())throw Error('CANCELLED');
   const st=fs.lstatSync(temporary);
   if(!st.isFile()||st.isSymbolicLink()||st.size<100)throw Error('OUTPUT_INVALID');
   const output=video.dest(root,job.outputPath,new Set([v.still?'.png':'.mp4']));
   fs.linkSync(temporary,output);
   update({status:'completed',progressPercent:100,finishedAt:new Date().toISOString(),error:null});
   note('Created '+job.outputPath+'\n');
   terminal('Remotion render completed: '+job.outputPath);
  }else throw Error('UNKNOWN_JOB_KIND');
 }catch(error){
  const canceled=cancelRequested()||error.message==='CANCELLED';
  update({status:canceled?'cancelled':'failed',finishedAt:new Date().toISOString(),
   error:canceled?'Cancelled':String(error.message).slice(0,1200)});
  note('Failed: '+error.message+'\n');
  terminal((canceled?'Remotion job cancelled: ':'Remotion job failed: ')+error.message);
 }finally{
  if(cancelWatcher)clearInterval(cancelWatcher);
  if(temporary)try{fs.unlinkSync(temporary)}catch{}
  if(lockFd!==null){
   try{fs.closeSync(lockFd)}catch{}
   try{if(fs.readFileSync(lockPath,'utf8')===id)fs.unlinkSync(lockPath)}catch{}
  }
 }
}
main().catch(err=>{note('Unexpected worker error: '+err.message+'\n');process.exitCode=1});
