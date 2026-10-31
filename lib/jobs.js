'use strict';
const {spawn}=require('node:child_process');
const path=require('node:path');
const crypto=require('node:crypto');
const fs=require('node:fs');
const MAX_LOG=100000, TIMEOUT_MS=195000;
function sandboxRun(workspace,{command,args,stdin},onLog,signal) {
  return new Promise((resolve,reject)=>{
    let nodeRoot=path.dirname(path.dirname(fs.realpathSync(process.execPath)));
    const cli=['--yes','--prefer-offline','nanosandbox-mcp@0.3.3','--workspace',workspace,'--read-only',nodeRoot,
      '--timeout','180','--memory','1G','--max-output','1M','--max-concurrent','1','--no-cache','--env',
      'PATH='+nodeRoot+'/bin:/usr/bin:/bin'];
    if(process.platform==='linux')cli.push('--cpu','2','--max-pids','128');
    const child=spawn('npx',cli,{detached:true,stdio:['pipe','pipe','pipe'],env:process.env});
    let buffer='',seq=0,pending=new Map(),done=false;
    const stop=()=>{try{process.kill(-child.pid,'SIGKILL');}catch{try{child.kill('SIGKILL');}catch{}}};
    const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',aborted);stop();if(error)reject(error);else resolve(result);};
    const aborted=()=>finish(Error('JOB_CANCELLED'));
    signal?.addEventListener('abort',aborted,{once:true});
    const timer=setTimeout(()=>finish(Error('JOB_TIMEOUT: 195 seconds')),TIMEOUT_MS);
    function send(method,params) {
      const id=++seq;
      if(!child.stdin.writable)throw Error('SANDBOX_CLOSED');
      child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
      return new Promise((resolve,reject)=>pending.set(id,{resolve,reject}));
    }
    child.stdout.on('data',chunk=>{
      buffer+=chunk.toString();
      if(buffer.length>2_000_000){finish(Error('SANDBOX_PROTOCOL_OVERFLOW'));return;}
      let i;
      while((i=buffer.indexOf('\n'))>=0) {
        const line=buffer.slice(0,i);buffer=buffer.slice(i+1);
        if(!line.trim())continue;
        let m;try{m=JSON.parse(line);}catch{continue;}
        if(m.id==null)continue;
        const p=pending.get(m.id);if(!p)continue;
        pending.delete(m.id);
        if(m.error)p.reject(Error(JSON.stringify(m.error)));else p.resolve(m.result);
      }
    });
    child.stderr.on('data',chunk=>onLog(chunk.toString().slice(0,1000)));
    child.on('error',e=>finish(e));
    child.on('close',(code)=>finish(Error('SANDBOX_EXITED: '+code)));
    (async()=>{
      try {
        await send('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'mcp-workspace-job-manager',version:'1.0.0'}});
        const listed=await send('tools/list',{});
        const tool=listed?.tools?.find(t=>t.name==='run_command');
        if(!tool)throw Error('SANDBOX_TOOL_MISSING: run_command');
        const result=await send('tools/call',{name:'run_command',arguments:{command,args,stdin}});
        if(result?.isError)throw Error('SANDBOX_ERROR: '+JSON.stringify(result.content||[]).slice(0,1500));
        return finish(null,result);
      }catch(e){finish(e);}
    })();
  });
}
function createJobManager(workspace,run=sandboxRun){
  const jobs=new Map();let running=null;
  const publicJob=j=>({id:j.id,status:j.status,command:j.command,args:j.args,startedAt:j.startedAt,
    finishedAt:j.finishedAt,exitCode:j.exitCode,error:j.error});
  return {
    start({command,args=[],stdin}={}){
      if(typeof command!=='string'||!command||command.length>160||command.includes('\0')||
        !Array.isArray(args)||args.length>64||args.some(a=>typeof a!=='string'||a.length>4096||a.includes('\0'))||
        (stdin!==undefined&&(typeof stdin!=='string'||stdin.length>65536)))throw Error('INVALID_JOB_COMMAND');
      if(running)throw Error('JOB_BUSY: one concurrent sandbox job allowed');
      if(jobs.size>=25){const finished=[...jobs.values()].find(j=>j.status!=='running');if(finished)jobs.delete(finished.id);else throw Error('JOB_LIMIT');}
      const id=crypto.randomBytes(12).toString('hex'), controller=new AbortController();
      const j={id,status:'running',command,args,startedAt:new Date().toISOString(),finishedAt:null,exitCode:null,error:null,log:'',controller};
      jobs.set(id,j);running=id;
      const onLog=t=>{j.log=(j.log+t).slice(-MAX_LOG);};
      Promise.resolve().then(()=>{if(controller.signal.aborted)throw Error('JOB_CANCELLED');return run(workspace,{command,args,stdin},onLog,controller.signal);})
        .then(result=>{
          const payload=(result?.content||[]).map(c=>c.text||'').join('\n');
          onLog(payload);
          let value;try{value=JSON.parse(payload)}catch{}
          j.exitCode=value?.exit_code??value?.exitCode??null;
          j.status=j.exitCode===0?'completed':j.exitCode===null?'completed':'failed';
        },e=>{j.status=controller.signal.aborted?'cancelled':'failed';j.error=String(e.message||e);onLog('\n'+j.error);})
        .finally(()=>{j.finishedAt=new Date().toISOString();if(running===id)running=null;});
      return publicJob(j);
    },
    status({id}){const j=jobs.get(id);if(!j)throw Error('JOB_NOT_FOUND');return publicJob(j);},
    logs({id,tail=12000}={}){const j=jobs.get(id);if(!j)throw Error('JOB_NOT_FOUND');if(!Number.isInteger(tail)||tail<1||tail>MAX_LOG)throw Error('INVALID_LOG_TAIL');return {...publicJob(j),log:j.log.slice(-tail),truncated:j.log.length>=MAX_LOG};},
    cancel({id}){const j=jobs.get(id);if(!j)throw Error('JOB_NOT_FOUND');if(j.status!=='running')return publicJob(j);j.controller.abort();return {...publicJob(j),cancellationRequested:true};},
  };
}
module.exports={createJobManager,sandboxRun};
