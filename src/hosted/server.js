import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {mkdirSync,existsSync,readFileSync,chmodSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {auditFile,readUpload} from '../demo/audit-file.js';
import {check} from '../v3/crypto.js';

const root=fileURLToPath(new URL('../../',import.meta.url));
const equal=(a,b)=>timingSafeEqual(createHash('sha256').update(a).digest(),createHash('sha256').update(b).digest());
const publicFiles=new Set(['audit.json','trust.json','profiles.json','audit-result.json','execution.json']);

export async function startHostedServer({directory,accessCode,origin,port=8080,host='0.0.0.0',runJob}={}) {
 check(typeof accessCode==='string'&&accessCode.length>=24,'ACCESS_CODE_TOO_SHORT');
 if(origin){const u=new URL(origin);check(u.origin===origin&&(u.protocol==='https:'||['localhost','127.0.0.1'].includes(u.hostname)),'INVALID_PUBLIC_ORIGIN');}
 const dir=resolve(directory);mkdirSync(dir,{recursive:true,mode:0o700});
 const opDir=join(dir,'operator');
 const db=new DatabaseSync(join(dir,'jobs.sqlite'));chmodSync(join(dir,'jobs.sqlite'),0o600);
 db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, amount TEXT NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL, result TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0); UPDATE jobs SET state='queued' WHERE state='running';");
 let working=false,stopping=false,audits=0;let current=Promise.resolve();
 // ponytail: one worker and one persistent disk; distributed leases are required before scaling out.
 const execute=runJob??(async job=>{
  await promisify(execFile)(process.execPath,[join(root,'src/operator/run.js'),'aomi-submit',job.amount,`web-${job.id}`],{
   cwd:root,env:{...process.env,OPERATOR_DIR:opDir},timeout:900000,maxBuffer:131072,
  });
  const folder=join(opDir,'exports',`web-${job.id}`);
  const audit=JSON.parse(readFileSync(join(folder,'audit-result.json')));
  const request=JSON.parse(readFileSync(join(opDir,`request-web-${job.id}.json`)));
  return {requestId:request.requestId,auditOk:audit.ok,finality:audit.finality,requestAudit:audit.requests.find(r=>r.requestId===request.requestId)};
 });
 const publicJob=j=>({...j,result:j.result?JSON.parse(j.result):null});
 function pump(){
  if(working||stopping||db.prepare("SELECT 1 FROM jobs WHERE state='failed' LIMIT 1").get())return;
  const job=db.prepare("SELECT * FROM jobs WHERE state='queued' ORDER BY created,rowid LIMIT 1").get();if(!job)return;
  working=true;db.prepare("UPDATE jobs SET state='running',error=NULL,attempts=attempts+1 WHERE id=?").run(job.id);
  current=(async()=>{
   try{const result=await execute(job);db.prepare("UPDATE jobs SET state='done',result=?,error=NULL WHERE id=?").run(JSON.stringify(result),job.id);}
   catch{db.prepare("UPDATE jobs SET state='failed',error='EXECUTION_FAILED' WHERE id=?").run(job.id);}
   finally{working=false;if(!stopping)queueMicrotask(pump);}
  })();
 }
 function profiles(){
  const map=new Map();
  const example=join(root,'examples/aomi-base-sepolia');
  for(const folder of [example,opDir]){
   const file=join(folder,'trust.json');if(!existsSync(file))continue;
   const trust=JSON.parse(readFileSync(file));
   const cutoff=folder===example?JSON.parse(readFileSync(join(folder,'profiles.json')))[0].asOf:'auto';
   map.set(trust.policyHash,{trust,rpcUrl:'https://sepolia.base.org',asOf:cutoff});
  }return map;
 }
 const signature=stamp=>createHmac('sha256',accessCode).update(stamp).digest('hex');
 const authenticated=req=>{
  const token=req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('trust404_session='))?.slice(17)??'';
  const [stamp,sig]=token.split('.');return /^\d+$/.test(stamp??'')&&Number(stamp)>Date.now()&&Number(stamp)<=Date.now()+14400000&&equal(sig??'',signature(stamp));
 };
 let loginAttempts=0,loginWindow=Date.now();
 const headers={'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer',
  'content-security-policy':"default-src 'self'; style-src 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"};
 const server=createServer(async(req,res)=>{
  const serveFile=(path,type,extra={})=>{
   let content;try{content=readFileSync(path);}catch(error){if(error.code==='ENOENT'){send(404,{error:'FILE_UNAVAILABLE'});return;}throw error;}
   res.writeHead(200,{...headers,'content-type':type,...extra}).end(content);
  };
  const send=(status,value,extra={})=>res.writeHead(status,{...headers,'content-type':'application/json',...extra}).end(JSON.stringify(value));
  try{
   const path=new URL(req.url,'http://localhost').pathname;
   if(req.method==='GET'&&path==='/healthz'){send(200,{status:'up'});return;}
   const expected=origin??`http://127.0.0.1:${server.address().port}`;
   check(req.headers.host===new URL(expected).host,'HOST_NOT_ALLOWED');
   check(!req.headers.origin||req.headers.origin===expected,'ORIGIN_NOT_ALLOWED');
   if(req.method==='POST'){
    check(req.headers.origin===expected,'ORIGIN_NOT_ALLOWED');
    check(req.headers['content-type']?.split(';')[0]==='application/json','JSON_REQUIRED');
   }
   if(req.method==='POST'&&path==='/api/login'){
    if(Date.now()-loginWindow>60000){loginAttempts=0;loginWindow=Date.now();}
    if(++loginAttempts>20){send(429,{error:'LOGIN_RATE_LIMIT'});return;}
    const body=await readUpload(req);if(typeof body.code!=='string'||!equal(body.code,accessCode)){send(401,{error:'ACCESS_DENIED'});return;}
    const stamp=String(Date.now()+14400000);
    send(200,{ok:true},{'set-cookie':`trust404_session=${stamp}.${signature(stamp)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=14400${expected.startsWith('https:')?'; Secure':''}`});return;
   }
   const pages={'/':['./portal.html','text/html; charset=utf-8'],'/portal.js':['./portal.js','text/javascript; charset=utf-8'],'/audit':['../demo/index.html','text/html; charset=utf-8'],'/ui.js':['../demo/ui.js','text/javascript; charset=utf-8']};
   if(req.method==='GET'&&pages[path]){const [file,type]=pages[path];serveFile(new URL(file,import.meta.url),type);return;}
   if(!authenticated(req)){send(401,{error:'LOGIN_REQUIRED'});return;}
   if(req.method==='GET'&&path==='/api/status'){
    send(200,{ready:existsSync(join(opDir,'trust.json')),mode:'aomi-client',paused:!!db.prepare("SELECT 1 FROM jobs WHERE state='failed'").get(),jobs:db.prepare('SELECT * FROM jobs ORDER BY created DESC,rowid DESC LIMIT 30').all().map(publicJob)});return;
   }
   if(req.method==='POST'&&path==='/api/requests'){
    check(existsSync(join(opDir,'trust.json')),'OPERATOR_NOT_READY');const {id,amount}=await readUpload(req);
    check(typeof id==='string'&&/^[a-zA-Z0-9_-]{8,76}$/.test(id),'INVALID_REQUEST_ID');
    check(typeof amount==='string'&&/^[1-9][0-9]{0,11}$/.test(amount)&&BigInt(amount)<=10000000000n,'INVALID_AMOUNT');
    const existing=db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    if(existing){check(existing.amount===amount,'IDEMPOTENCY_CONFLICT');send(200,publicJob(existing));return;}
    check(db.prepare("SELECT count(*) n FROM jobs WHERE state IN ('queued','running','failed')").get().n<5,'QUEUE_FULL');
    check(db.prepare('SELECT count(*) n FROM jobs WHERE created>=?').get(Date.now()-86400000).n<20,'DAILY_REQUEST_LIMIT');
    db.prepare("INSERT INTO jobs(id,amount,state,created) VALUES (?,?,'queued',?)").run(id,amount,Date.now());
    send(202,publicJob(db.prepare('SELECT * FROM jobs WHERE id=?').get(id)));pump();return;
   }
   const retry=path.match(/^\/api\/jobs\/([a-zA-Z0-9_-]{8,76})\/retry$/);
   if(req.method==='POST'&&retry){
    const job=db.prepare('SELECT * FROM jobs WHERE id=?').get(retry[1]);check(job?.state==='failed','JOB_NOT_FAILED');
    check(job.attempts<3,'RETRY_LIMIT_REACHED');
    db.prepare("UPDATE jobs SET state='queued' WHERE id=?").run(job.id);send(202,{id:job.id,state:'queued'});pump();return;
   }
   const download=path.match(/^\/api\/jobs\/([a-zA-Z0-9_-]{8,76})\/files\/([a-z-]+\.json)$/);
   if(req.method==='GET'&&download){
    check(publicFiles.has(download[2]),'FILE_NOT_ALLOWED');const job=db.prepare('SELECT state FROM jobs WHERE id=?').get(download[1]);check(job?.state==='done','JOB_NOT_DONE');
    serveFile(join(opDir,'exports',`web-${download[1]}`,download[2]),'application/json',{'content-disposition':`attachment; filename="${download[2]}"`});return;
   }
   if(req.method==='GET'&&path==='/api/profiles'){send(200,[...profiles()].map(([id,{trust,asOf}])=>({id,institutionId:trust.policy.institutionId,policyId:trust.policy.policyId,chainId:trust.policy.chainId,anchorAddress:trust.policy.anchorAddress,cutoff:asOf})));return;}
   if(req.method==='GET'&&path==='/api/samples'){send(200,[]);return;}
   if(req.method==='GET'&&path==='/api/example'){serveFile(join(root,'examples/aomi-base-sepolia/audit.json'),'application/json',{'content-disposition':'attachment; filename="audit.json"'});return;}
   if(req.method==='POST'&&path==='/api/audit-file'){
    if(audits>=2){send(429,{error:'AUDIT_BUSY'});return;}audits++;
    try{send(200,await auditFile(await readUpload(req),profiles()));}finally{audits--;}return;
   }
   send(404,{error:'NOT_FOUND'});
  }catch(error){const code=/^[A-Z_]+$/.test(error.message)?error.message:'REQUEST_FAILED';send(code.endsWith('NOT_ALLOWED')?403:400,{error:code});}
 });
 server.requestTimeout=150000;server.headersTimeout=15000;
 server.listen(port,host);await once(server,'listening');pump();
 return {server,async close(){stopping=true;await new Promise(r=>server.close(r));await current;db.close();}};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const app=await startHostedServer({directory:process.env.DATA_DIR??'.local-demo/hosted',accessCode:process.env.DEMO_ACCESS_CODE,origin:process.env.PUBLIC_ORIGIN??process.env.RENDER_EXTERNAL_URL,port:Number(process.env.PORT??8080),host:process.env.HOST??'0.0.0.0'});
 console.log(`TRUST404 server listening on ${app.server.address().port}`);
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>app.close().then(()=>process.exit(0)));
}
