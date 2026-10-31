'use strict';
const fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto');
const {safePath,sha,repoStatus}=require('./devtools-core');
const MAX=1024*1024;
const hashOk=h=>typeof h==='string'&&/^[a-f0-9]{64}$/i.test(h);
function getFile(root,rel) {
  const file=safePath(root,rel), s=fs.lstatSync(file);
  if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>MAX) throw Error('UNSAFE_FILE: '+rel);
  const b=fs.readFileSync(file);
  return {file,bytes:b,hash:sha(b),mode:s.mode&0o777};
}
function noFile(root,rel) {
  const file=safePath(root,rel);
  const parent=path.dirname(file), ps=fs.lstatSync(parent);
  if(!ps.isDirectory()||ps.isSymbolicLink()||fs.existsSync(file))throw Error('DESTINATION_UNAVAILABLE: '+rel);
  return file;
}
function applyChanges(root,{operations,dryRun=false}={}) {
  if(!Array.isArray(operations)||operations.length<1||operations.length>12)throw Error('operations must contain 1..12 entries');
  const used=new Set(),prepared=[];
  for(const op of operations) {
    if(!op||!['create','replace','delete','move'].includes(op.action)||typeof op.path!=='string'||op.path==='.')throw Error('INVALID_OPERATION');
    const src=path.relative(fs.realpathSync(root),safePath(root,op.path));
    if(used.has(src))throw Error('DUPLICATE_PATH: '+src);
    used.add(src);
    if(op.action==='create') {
      if(typeof op.content!=='string'||Buffer.byteLength(op.content)>MAX)throw Error('INVALID_CONTENT');
      prepared.push({action:op.action,path:src,dest:noFile(root,src),content:Buffer.from(op.content),mode:0o644});
    } else {
      if(!hashOk(op.expectedSha256))throw Error('EXPECTED_SHA256_REQUIRED: '+src);
      const f=getFile(root,src);
      if(f.hash!==op.expectedSha256.toLowerCase())throw Error('STALE_FILE: '+src);
      if(op.action==='replace') {
        if(typeof op.content!=='string'||Buffer.byteLength(op.content)>MAX)throw Error('INVALID_CONTENT');
        prepared.push({action:op.action,path:src,source:f.file,content:Buffer.from(op.content),mode:f.mode,original:f.bytes});
      } else if(op.action==='move') {
        if(typeof op.destination!=='string'||op.destination==='.')throw Error('INVALID_DESTINATION');
        const dst=path.relative(fs.realpathSync(root),safePath(root,op.destination));
        if(used.has(dst))throw Error('DUPLICATE_PATH: '+dst);
        used.add(dst);
        prepared.push({action:op.action,path:src,source:f.file,dest:noFile(root,dst),mode:f.mode,original:f.bytes});
      } else {
        prepared.push({action:op.action,path:src,source:f.file,mode:f.mode,original:f.bytes});
      }
    }
  }
  const summary=prepared.map(p=>({action:p.action,path:p.path,destination:p.dest?path.relative(fs.realpathSync(root),p.dest):null,oldSha256:p.original?sha(p.original):null,newSha256:p.content?sha(p.content):p.original&&p.action==='move'?sha(p.original):null}));
  if(dryRun)return {dryRun:true,operations:summary};
  // Revalidate before touching any file. Each rollback is best effort under external concurrent edits.
  for(const p of prepared) {
    if(p.original&&getFile(root,p.path).hash!==sha(p.original))throw Error('STALE_FILE: '+p.path);
    if(p.dest)noFile(root,path.relative(fs.realpathSync(root),p.dest));
  }
  const completed=[],temps=[];
  const staging=(p,bytes)=> {
    const file=path.join(path.dirname(p),'.mcp-stage-'+crypto.randomBytes(12).toString('hex'));
    fs.writeFileSync(file,bytes,{flag:'wx',mode:0o600});temps.push(file);return file;
  };
  try {
    for(const p of prepared) {
      if(p.action==='create'||p.action==='replace') {
        const target=p.action==='create'?p.dest:p.source;
        const tmp=staging(target,p.content);fs.chmodSync(tmp,p.mode);
        fs.renameSync(tmp,target);completed.push(p);
      } else if(p.action==='move') {
        fs.renameSync(p.source,p.dest);completed.push(p);
      } else {
        fs.unlinkSync(p.source);completed.push(p);
      }
    }
  } catch(error) {
    const failures=[];
    for(const p of completed.reverse())try {
      if(p.action==='create')fs.unlinkSync(p.dest);
      else if(p.action==='move')fs.renameSync(p.dest,p.source);
      else {
        const tmp=staging(p.source,p.original);fs.chmodSync(tmp,p.mode);fs.renameSync(tmp,p.source);
      }
    }catch(e){failures.push(p.path+': '+e.message);}
    throw Error('CHANGE_FAILED: '+error.message+(failures.length?'; ROLLBACK_FAILED: '+failures.join('; '):'; rollback completed'));
  } finally {
    for(const tmp of temps)try{fs.unlinkSync(tmp);}catch(e){if(e.code!=='ENOENT')throw e;}
  }
  return {dryRun:false,operations:summary};
}
function overview(root,{path:rel='.'}={}) {
  const dir=safePath(root,rel), st=fs.lstatSync(dir);
  if(!st.isDirectory()||st.isSymbolicLink())throw Error('path must be a directory');
  const names=fs.readdirSync(dir).filter(n=>n!=='.git'&&n!=='node_modules').sort();
  const exists=n=>names.includes(n);
  const result={path:rel,entries:names.slice(0,80),truncated:names.length>80,stack:[],scripts:{},dependencies:[],testInfrastructure:[],packageManager:null,git:null};
  if(exists('package.json')) {
    const p=JSON.parse(fs.readFileSync(path.join(dir,'package.json'),'utf8'));
    result.name=p.name||null;result.version=p.version||null;
    result.scripts=Object.fromEntries(Object.entries(p.scripts||{}).slice(0,35).map(([k,v])=>[k,String(v).slice(0,240)]));
    result.dependencies=Object.keys({...p.dependencies,...p.devDependencies}).slice(0,45);
    result.stack.push('Node.js');
    for(const [term,label] of [['next','Next.js'],['react','React'],['typescript','TypeScript'],['vite','Vite'],['express','Express'],['drizzle-orm','Drizzle'],['vitest','Vitest'],['playwright','Playwright']])
      if(result.dependencies.includes(term))result.stack.push(label);
  }
  if(exists('pyproject.toml')||exists('requirements.txt'))result.stack.push('Python');
  if(exists('go.mod'))result.stack.push('Go');
  if(exists('Cargo.toml'))result.stack.push('Rust');
  if(exists('Dockerfile')||exists('docker-compose.yml')||exists('compose.yaml'))result.stack.push('Docker');
  result.packageManager=exists('pnpm-lock.yaml')?'pnpm':exists('yarn.lock')?'yarn':exists('bun.lock')||exists('bun.lockb')?'bun':exists('package-lock.json')?'npm':null;
  result.testInfrastructure=names.filter(n=>/^(test|tests|__tests__|e2e|vitest\.config|jest\.config|playwright\.config|pytest\.ini|tox\.ini)/.test(n)).slice(0,25);
  try{result.git=repoStatus(root,{repoPath:rel});}catch(e){result.git={available:false,reason:String(e.message)};}
  return result;
}
module.exports={applyChanges,overview};
