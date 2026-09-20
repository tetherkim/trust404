import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {DatabaseSync} from 'node:sqlite';
import {startHostedServer} from '../../src/hosted/server.js';

const code='test-only-access-code-32-characters';
async function client(app){
 const base=`http://127.0.0.1:${app.server.address().port}`;
 const login=await fetch(base+'/api/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({code})});
 assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
 return {base,cookie,call:(path,body,headers={})=>fetch(base+path,{signal:AbortSignal.timeout(2000),method:body===undefined?'GET':'POST',headers:{cookie,origin:base,'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})})};
}
async function until(fn){for(let i=0;i<100;i++){if(await fn())return;await new Promise(r=>setTimeout(r,10));}assert.fail('worker did not settle');}

test('[웹 포털] 인증, Origin, 요청 금액 검증, 멱등성 보장 및 작업 실패 시 일시중지/재시작 복구',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'trust404-hosted-'));mkdirSync(join(directory,'operator'));writeFileSync(join(directory,'operator/trust.json'),'{}');
 let fail=true,calls=0,app;
 const runJob=async()=>{calls++;if(fail)throw Error('private error must not be returned');return {requestId:'verified-request',auditOk:true};};
 t.after(async()=>{await app?.close();rmSync(directory,{recursive:true,force:true});});
 app=await startHostedServer({directory,accessCode:code,port:0,host:'127.0.0.1',runJob});let c=await client(app);
 assert.equal((await fetch(c.base+'/api/status')).status,401);
 assert.equal((await c.call('/api/requests',{id:'request-0001',amount:'150000000'},{origin:'https://attacker.example'})).status,403);
 assert.equal((await c.call('/api/requests',{id:'request-0001',amount:'0'})).status,400);
 assert.equal((await c.call('/api/requests',{id:'request-0001',amount:'150000000'})).status,202);
 await until(async()=> (await (await c.call('/api/status')).json()).paused);
 assert.equal((await c.call('/api/requests',{id:'request-0001',amount:'150000000'})).status,200);
 assert.equal((await c.call('/api/requests',{id:'request-0001',amount:'1'})).status,400);
 assert.equal(calls,1);
 const failed=(await (await c.call('/api/status')).json()).jobs[0];assert.equal(failed.error,'EXECUTION_FAILED');assert.equal(failed.attempts,1);
 await app.close();app=null;
 app=await startHostedServer({directory,accessCode:code,port:0,host:'127.0.0.1',runJob});c=await client(app);
 assert.equal((await (await c.call('/api/status')).json()).paused,true);assert.equal(calls,1);
 fail=false;assert.equal((await c.call('/api/jobs/request-0001/retry',{})).status,202);
 await until(async()=> (await (await c.call('/api/status')).json()).jobs[0].state==='done');assert.equal(calls,2);
 assert.equal((await c.call('/api/jobs/request-0001/files/secrets.json')).status,403);
 assert.equal((await c.call('/api/jobs/request-0001/files/../../secrets.json')).status,404);
 assert.equal((await c.call('/api/status',undefined,{cookie:c.cookie+'tampered'})).status,401);
});

test('[웹 포털] 중단된 작업 우선 복구 및 허용된 공개 파일만 다운로드 제공',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'trust404-hosted-'));let app;
 t.after(async()=>{await app?.close();rmSync(directory,{recursive:true,force:true});});
 app=await startHostedServer({directory,accessCode:code,port:0,host:'127.0.0.1',runJob:async()=>({})});
 let c=await client(app);assert.equal((await c.call('/api/requests',{id:'request-0002',amount:'1'})).status,400);
 await app.close();app=null;
 const db=new DatabaseSync(join(directory,'jobs.sqlite'));db.prepare("INSERT INTO jobs(id,amount,state,created) VALUES ('request-0002','1','running',1)").run();db.close();
 const files=join(directory,'operator/exports/web-request-0002');mkdirSync(files,{recursive:true});writeFileSync(join(files,'audit.json'),'{"proof":"public"}');
 let calls=0;app=await startHostedServer({directory,accessCode:code,port:0,host:'127.0.0.1',runJob:async()=>{calls++;return {auditOk:true};}});c=await client(app);
 await until(async()=> (await (await c.call('/api/status')).json()).jobs[0].state==='done');
 assert.equal((await c.call('/api/jobs/request-0002/files/execution.json')).status,404);
 assert.equal((await c.call('/api/status')).status,200);
 assert.equal(calls,1);const download=await c.call('/api/jobs/request-0002/files/audit.json');assert.equal(download.status,200);assert.deepEqual(await download.json(),{proof:'public'});
 for(const name of ['evidence.json','verify-config.json']){
  writeFileSync(join(files,name),'{"public":true}');
  const file=await c.call(`/api/jobs/request-0002/files/${name}`);
  assert.equal(file.status,200);assert.deepEqual(await file.json(),{public:true});
 }
});


test('[웹 포털] 웹 접두어(web-) 부여 후 오퍼레이터 키 규격 일치 검증',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'trust404-hosted-'));
 mkdirSync(join(directory,'operator'));writeFileSync(join(directory,'operator/trust.json'),'{}');
 const app=await startHostedServer({directory,accessCode:code,port:0,host:'127.0.0.1',runJob:async()=>({})});
 t.after(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});});
 const c=await client(app);
 for(const length of [77,80])assert.equal((await c.call('/api/requests',{id:'a'.repeat(length),amount:'1'})).status,400);
 assert.equal((await c.call('/api/requests',{id:'a'.repeat(76),amount:'1'})).status,202);
});

test('[웹 포털] 세션 만료 시 로그인 화면 복원 및 폴링 중단 검증',async()=>{
 const elements=new Map();const timers=[];
 const document={getElementById(id){if(!elements.has(id))elements.set(id,{hidden:id==='login-panel',addEventListener(){}});return elements.get(id);}};
 const context={document,sessionStorage:{getItem:()=>null},fetch:async()=>({ok:false,status:401,json:async()=>({error:'LOGIN_REQUIRED'})}),clearTimeout(){},setTimeout:fn=>timers.push(fn)};
 // Exercise the shipped script, including its initial refresh.
 runInNewContext(readFileSync(new URL('../../src/hosted/portal.js',import.meta.url),'utf8'),context);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(document.getElementById('login-panel').hidden,false);
 assert.equal(document.getElementById('workspace').hidden,true);
 assert.equal(timers.length,0);
});


test('[웹 포털] 저장 완료 상태와 감사 성공 및 체인 완결성(Finality) 구분 표시 검증',()=>{
 const context={document:{getElementById:()=>({addEventListener(){}})},sessionStorage:{getItem:()=>null},fetch:()=>new Promise(()=>{})};
 runInNewContext(readFileSync(new URL('../../src/hosted/portal.js',import.meta.url),'utf8'),context);
 const result={auditOk:false,finality:'PROVISIONAL',requestAudit:{decisions:[{record:'VALID',policy:'MATCH'}]}};
 assert.equal(context.auditSummary(result),'개별 서명·정책 일치 / 전체 감사 이상 있음 / 체인 확정 대기');
 assert.equal(context.auditSummary(null),'미검증');
 result.requestAudit.decisions=[{error:'POLICY_MISMATCH'}];result.auditOk=true;result.finality='FINALIZED';
 assert.equal(context.auditSummary(result),'개별 검증 확인 필요 / 전체 감사 통과 / 체인 확정');
 assert.equal(context.auditSummary({}),'개별 검증 확인 필요 / 전체 감사 미확인 / 체인 확정 미확인');
});
