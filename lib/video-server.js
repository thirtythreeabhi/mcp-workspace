#!/usr/bin/env node
'use strict';
// Separate, deliberately unauthenticated workspace-bound video MCP service.
// No generic shell tool, arbitrary ffmpeg flags, host path arguments or network input.
const video=require('./video-core');
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
  inputSchema:schema({id:p.id,tail:{type:'integer',minimum:1,maximum:32000,default:12000}},['id']),annotations:{readOnlyHint:true}},
 {name:'render_cancel',description:'Request cancellation of an active FFmpeg render. Does not accept or kill arbitrary host PIDs.',
  inputSchema:schema({id:p.id},['id']),annotations:{readOnlyHint:false}},
];
const handlers={
 capabilities:()=>video.capabilities(),
 probe:a=>video.probe(root,a),
 preview_frame:a=>video.preview(root,a),
 contact_sheet:a=>video.contactSheet(root,a),
 timeline_save:a=>video.timelineSave(root,a),
 timeline_read:a=>video.timelineRead(root,a),
 render_start:a=>video.renderStart(root,a),
 render_status:a=>video.renderStatus(root,a),
 render_logs:a=>video.renderLogs(root,a),
 render_cancel:a=>video.renderCancel(root,a),
};
const text=obj=>[{type:'text',text:JSON.stringify(obj)}];
async function handle(req) {
 if(req.id==null)return null;
 const result=(value)=>({jsonrpc:'2.0',id:req.id,result:value});
 if(req.method==='initialize')return result({protocolVersion:'2025-11-25',
  capabilities:{tools:{listChanged:false}},serverInfo:{name:'mcp-workspace-video',version:'1.2.0'},
  instructions:'Video editing and FFmpeg render jobs scoped to this launcher workspace. No authentication. Provide workspace-relative media paths; use probe and preview before creating a timeline.'});
 if(req.method==='ping')return result({});
 if(req.method==='tools/list')return result({tools:defs});
 if(req.method==='tools/call'){
  const name=req.params?.name;
  if(!Object.hasOwn(handlers,name))return {jsonrpc:'2.0',id:req.id,error:{code:-32602,message:'Unknown tool'}};
  try{
   const value=await handlers[name](req.params.arguments||{});
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
