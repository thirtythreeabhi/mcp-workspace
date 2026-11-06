#!/usr/bin/env node
'use strict';
// Separate, deliberately unauthenticated workspace-bound video MCP service.
// No generic shell tool, arbitrary ffmpeg flags, host path arguments or network input.
const video=require('./video-core');
const remotion=require('./remotion-core');
const workflow=require('./video-workflow');
const root=process.argv[2];
if(!root){process.stderr.write('video-mcp: workspace argument is required\n');process.exit(2);}
const p={path:{type:'string',description:'Workspace-relative path. Absolute paths, symlinks, traversal and .git are prohibited.'},
 id:{type:'string',pattern:'^[a-f0-9]{24}$'},
};
const schema=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const defs=[
 {name:'capabilities',description:'Check whether FFmpeg and FFprobe are available on the Ubuntu host, plus media limits.',
  inputSchema:schema({}),annotations:{readOnlyHint:true}},
 {name:'probe',description:'Inspect a local video file: duration, dimensions, codecs, and whether it contains audio. No network URLs.',
  inputSchema:schema({path:p.path},['path']),annotations:{readOnlyHint:true}},
 {name:'preview_frame',description:'Extract a JPEG frame from a workspace video at the requested timestamp, returned as an MCP image.',
  inputSchema:schema({path:p.path,atSeconds:{type:'number',minimum:0,maximum:1800,default:0},width:{type:'integer',minimum:160,maximum:1280,default:640}},['path']),
  annotations:{readOnlyHint:true}},
 {name:'contact_sheet',description:'Make an eight-frame JPEG montage covering a chosen time window of the video. Useful for finding loading screens and good edit points.',
  inputSchema:schema({path:p.path,fromSeconds:{type:'number',minimum:0,maximum:10800,default:0},windowSeconds:{type:'number',minimum:1,maximum:600,default:120}},['path']),
  annotations:{readOnlyHint:true}},
 {name:'capture_page',description:'Capture a new PNG screenshot from a locally served development app with isolated headless Chrome. Disabled unless the Ubuntu host sets MCP_WORKSPACE_CAPTURE_ORIGIN to a specific http://127.0.0.1:PORT or http://localhost:PORT. No arbitrary URLs, login sessions, shell commands or overwrites; any redirected page may be the login screen.',
  inputSchema:schema({route:{type:'string',description:'Local app route, for example /en or /en/recruiter/dashboard. Must be a simple pathname with no query string.'},outputPath:{...p.path,description:'New workspace-relative .png destination; parent directory must already exist.'},width:{type:'integer',minimum:320,maximum:1920,default:1440},height:{type:'integer',minimum:320,maximum:1920,default:900},waitMs:{type:'integer',minimum:0,maximum:6000,default:1500}},['outputPath']),
  annotations:{readOnlyHint:false,destructiveHint:false}},
 {name:'remotion_compositions',description:'List registered compositions from the approved Remotion project. Read-only.',
  inputSchema:schema({}),annotations:{readOnlyHint:true}},
 {name:'remotion_status',description:'Check the fixed local Remotion project, Chrome, installed CLI and render worker resource settings. Read-only.',
  inputSchema:schema({}),annotations:{readOnlyHint:true}},
 {name:'remotion_install_start',description:'Install approved pinned Remotion dependencies using npm on the Ubuntu host with lifecycle scripts disabled. No arbitrary package names, command arguments or paths accepted. Follow status with render_status, render_logs, render_cancel.',
  inputSchema:schema({}),annotations:{readOnlyHint:false,destructiveHint:false}},
 {name:'remotion_render_start',description:'Start a persistent, host-side Remotion job for an allowlisted composition in the configured trusted Remotion project. No arbitrary entry point or flags; writes a NEW .mp4 or .png. Use render_status, render_logs and render_cancel to track it.',
  inputSchema:schema({compositionId:{type:'string',pattern:'^[A-Za-z][A-Za-z0-9_-]*$',description:'Must be registered in the trusted Remotion project root.tsx; inspect remotion_compositions first.'},outputPath:p.path,frame:{type:'integer',minimum:0,maximum:20000},quality:{type:'string',enum:['draft','final'],default:'final'}},['outputPath']),annotations:{readOnlyHint:false,destructiveHint:false}},
 {name:'timeline_save',description:'Create or replace an editable .timeline.json file. Replacements require the SHA-256 returned by timeline_read or timeline_save. Clips are ordered; each references an existing local video with start/end seconds and optional speed.',
  inputSchema:schema({path:p.path,timeline:{type:'object',properties:{
    width:{type:'integer',minimum:320,maximum:1920},height:{type:'integer',minimum:240,maximum:1080},fps:{type:'integer',minimum:12,maximum:60},
    clips:{type:'array',minItems:1,maxItems:24,items:{type:'object',
      properties:{path:p.path,start:{type:'number',minimum:0},end:{type:'number',exclusiveMinimum:0},speed:{type:'number',minimum:0.5,maximum:2}},
      required:['path','end'],additionalProperties:false}}
  },required:['clips'],additionalProperties:false},expectedSha256:{type:'string',pattern:'^[a-fA-F0-9]{64}$'}},['path','timeline']),
  annotations:{readOnlyHint:false,destructiveHint:false}},
 {name:'timeline_read',description:'Read a saved video timeline and its current SHA-256, ready for version-checked edits.',
  inputSchema:schema({path:p.path},['path']),annotations:{readOnlyHint:true}},
 {name:'render_start',description:'Start a detached FFmpeg render of a saved timeline to a NEW .mp4 file under the workspace. Existing outputs cannot be overwritten. Returns a job ID immediately. Maximum 24 clips and 30 minutes of timeline.',
  inputSchema:schema({timelinePath:p.path,outputPath:p.path},['timelinePath','outputPath']),
  annotations:{readOnlyHint:false,destructiveHint:false}},
 {name:'render_status',description:'Get render job state and percentage by ID. Render continues even if MCP session closes.',
  inputSchema:schema({id:p.id},['id']),annotations:{readOnlyHint:true}},
 {name:'render_logs',description:'Get the latest bounded render logs and job state.',
  inputSchema:schema({id:p.id,tail:{type:'integer',minimum:1,maximum:32000,default:2000}},['id']),annotations:{readOnlyHint:true}},
 {name:'project_state',description:'Persist or retrieve concise video project state across chats. Actions: list, read, save. Saving existing state requires its latest SHA-256.',
  inputSchema:schema({action:{type:'string',enum:['list','read','save']},projectId:{type:'string',pattern:'^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'},state:{type:'object',description:'Project title, file paths, registered composition ID, ordered scenes with second-based bounds, renders, notes.',additionalProperties:true},expectedSha256:{type:'string',pattern:'^[a-fA-F0-9]{64}$'}},['action']),annotations:{readOnlyHint:false,destructiveHint:false}},
 {name:'audio_timing',description:'Measure voiceover silence intervals locally with FFmpeg and save timing JSON. NOT true word-level forced alignment; requires external word alignment for exact speech cuts.',
  inputSchema:schema({audioPath:p.path,outputPath:p.path,thresholdDb:{type:'number',minimum:-80,maximum:-8,default:-33},minSilenceSeconds:{type:'number',minimum:0.1,maximum:3,default:0.18}},['audioPath']),annotations:{readOnlyHint:false,destructiveHint:false}},
 {name:'review',description:'Inspect a local MP4, save a contact sheet and structured timing warnings beside the video; return a compact report, not embedded images.',
  inputSchema:schema({path:p.path,fromSeconds:{type:'number',minimum:0,maximum:10800,default:0},windowSeconds:{type:'number',minimum:1,maximum:600,default:60},projectId:{type:'string',pattern:'^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'},maxSceneSeconds:{type:'number',minimum:2,maximum:60,default:7}},['path']),annotations:{readOnlyHint:false,destructiveHint:false}},
 {name:'render_cancel',description:'Request cancellation of an active FFmpeg render. Does not accept or kill arbitrary host PIDs.',
  inputSchema:schema({id:p.id},['id']),annotations:{readOnlyHint:false}},
];
const handlers={
 capabilities:()=>video.capabilities(),
 remotion_status:()=>remotion.dependencies(root),
 remotion_compositions:()=>remotion.registeredCompositions(root),
 project_state:a=>workflow.projectState(root,a),
 audio_timing:a=>workflow.audioTiming(root,a),
 review:a=>workflow.review(root,a),
 remotion_install_start:()=>remotion.installStart(root),
 remotion_render_start:a=>remotion.renderStart(root,a),
 probe:a=>video.probe(root,a),
 preview_frame:a=>video.preview(root,a),
 contact_sheet:a=>video.contactSheet(root,a),
 capture_page:a=>video.capturePage(root,a),
 timeline_save:a=>video.timelineSave(root,a),
 timeline_read:a=>video.timelineRead(root,a),
 render_start:a=>video.renderStart(root,a),
 render_status:a=>video.renderStatus(root,a),
 render_logs:a=>video.renderLogs(root,a),
 render_cancel:a=>video.renderCancel(root,a),
};
const text=obj=>[{type:'text',text:JSON.stringify(obj)}];
const watchedJobs=new Set();
function watchJob(id,label){
 if(watchedJobs.has(id))return;watchedJobs.add(id);
 const paths=video.jobPaths(root,id);let offset=0,pending='';
 const timer=setInterval(()=>{
  try{
   const stat=require('node:fs').statSync(paths.log);
   if(stat.size>offset){const fd=require('node:fs').openSync(paths.log,'r');try{const buf=Buffer.alloc(Math.min(65536,stat.size-offset));const size=require('node:fs').readSync(fd,buf,0,buf.length,offset);offset+=size;pending+=buf.subarray(0,size).toString('utf8');const lines=pending.split(/\r?\n/);pending=lines.pop()||'';for(const line of lines){const event=line.match(/^TERMINAL: (.+)$/);if(event)process.stderr.write('video-mcp event: '+event[1]+'\n');}}finally{require('node:fs').closeSync(fd);}}
   const status=video.readJob(root,id).status;
   if(['completed','failed','cancelled'].includes(status)&&offset>=stat.size){clearInterval(timer);watchedJobs.delete(id);}
  }catch(e){if(e.code!=='ENOENT'){clearInterval(timer);watchedJobs.delete(id);}}
 },300);timer.unref();
 process.stderr.write('video-mcp event: '+label+' queued (job '+id+')\n');
}
async function handle(req) {
 if(req.id==null)return null;
 const result=(value)=>({jsonrpc:'2.0',id:req.id,result:value});
 if(req.method==='initialize')return result({protocolVersion:'2025-11-25',
  capabilities:{tools:{listChanged:false}},serverInfo:{name:'mcp-workspace-video',version:'1.3.0'},
  instructions:'Video editing and FFmpeg render jobs scoped to this launcher workspace. No authentication. Provide workspace-relative media paths; use probe and preview before creating a timeline.'});
 if(req.method==='ping')return result({});
 if(req.method==='tools/list')return result({tools:defs});
 if(req.method==='tools/call'){
  const name=req.params?.name;
  if(!Object.hasOwn(handlers,name))return {jsonrpc:'2.0',id:req.id,error:{code:-32602,message:'Unknown tool'}};
  try{
   const value=await handlers[name](req.params.arguments||{});
   if(['remotion_install_start','remotion_render_start','render_start'].includes(name)&&value?.id)
    watchJob(value.id,name==='remotion_render_start'?'Remotion render':name==='render_start'?'FFmpeg render':'Remotion dependency installation');
   if(name==='preview_frame'||name==='contact_sheet')return result({content:[{type:'image',data:value.data,mimeType:value.mimeType},
    {type:'text',text:JSON.stringify({path:value.path,atSeconds:value.atSeconds,fromSeconds:value.fromSeconds,windowSeconds:value.windowSeconds,bytes:value.bytes})}]});
   return result({content:text(value)});
  }catch(e){return result({isError:true,content:text({error:String(e.message||e)})});}
 }
 return {jsonrpc:'2.0',id:req.id,error:{code:-32601,message:'Method not found'}};
}
let buffer='',queue=Promise.resolve();
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{
 buffer+=chunk;
 if(buffer.length>2*1024*1024){process.stderr.write('video-mcp: request exceeded 2 MB\n');process.exit(1);}
 let pos;
 while((pos=buffer.indexOf('\n'))>=0){
  const line=buffer.slice(0,pos).trim();buffer=buffer.slice(pos+1);if(!line)continue;
  queue=queue.then(async()=>{
   try{const res=await handle(JSON.parse(line));if(res)process.stdout.write(JSON.stringify(res)+'\n');}
   catch(e){process.stderr.write('video-mcp invalid JSON-RPC: '+e.message+'\n');}
  });
 }
});
