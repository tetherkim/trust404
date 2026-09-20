import { createServer } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Archive, EvidenceStore } from '../v3/store.js';
import { ChainReader, jsonRpc } from '../v3/chain.js';
import { hash, canonical, check } from '../v3/crypto.js';
import { requestRecord, scope } from '../v3/policy.js';
import { auditAll } from '../v3/verify.js';

const directory = resolve('.local-demo/testnet');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const save = (name, value) => writeFileSync(join(directory, name), JSON.stringify(value, null, 2)+'\n', { mode: 0o600 });
const load = name => JSON.parse(readFileSync(join(directory, name), 'utf8'));
const deployed = JSON.parse(readFileSync('.local-demo/base-sepolia-deployed.json', 'utf8'));
const rpcUrl = 'https://sepolia.base.org';
if (!existsSync(join(directory, 'trust.json'))) {
  const requester = generateKeyPairSync('ed25519'), institution = generateKeyPairSync('ed25519');
  const pub = key => key.export({ type: 'spki', format: 'pem' });
  save('keys.json', { requester: requester.privateKey.export({ type:'pkcs8',format:'pem' }), institution: institution.privateKey.export({ type:'pkcs8',format:'pem' }) });
  const policy = { version:3, logId:'base-sepolia-demo', chainId:'84532', anchorAddress:deployed.anchorAddress,
    policyId:'usdc-reserve-v1', ruleVersion:1, institutionId:'testnet-demo-institution',
    token:'0x036cbd53842c5426634e7929541ec2318f3dcf7e', decimals:6, treasury:deployed.publisher.toLowerCase(),
    limitAtomic:'100000000', reserveAtomic:'100000000', decisionWindowSeconds:90, stateRule:'RECEIPT_BLOCK_END' };
  save('trust.json', { policy, policyHash:hash('policy-v3',policy), publisher:deployed.publisher.toLowerCase(),codeHash:deployed.codeHash,
    requesterKeys:{ requester:pub(requester.publicKey) }, institutionKeys:{ institution:pub(institution.publicKey) } });
}
const trust=load('trust.json'), keys=load('keys.json');
check(trust.policy.anchorAddress===deployed.anchorAddress,'ANCHOR_MISMATCH');
const archive=new Archive(join(directory,'archive')), store=new EvidenceStore(join(directory,'records.sqlite'),archive,trust);
const reader=new ChainReader(jsonRpc(rpcUrl),trust);
if(!existsSync(join(directory,'request.json'))) {
  const p=trust.policy;
  save('request.json',requestRecord({...scope(p),requesterId:'requester',institutionId:p.institutionId,token:p.token,treasury:p.treasury,
    recipient:p.treasury,amountAtomic:'50000000',createdAtMs:String(Date.now()),policyHash:trust.policyHash},'requester',keys.requester));
}
const request=load('request.json'); store.submit(request);
save('profiles.json',[{trustFile:join(directory,'trust.json'),rpcUrl,asOf:'latest',label:'Base Sepolia / 확정 대기 기록'}]);
let locked=false;
async function advance() {
  check(!locked,'OPERATION_IN_PROGRESS'); locked=true;
  try {
    const chain=await reader.at('latest'), count=BigInt(await chain.count());
    if(count===0n) return {stage:'REQUEST',publisher:trust.publisher,transaction:(await store.prepare(chain)).transaction};
    if(count===1n) {
      await store.decide(request.requestId,chain,'institution',keys.institution);
      return {stage:'DECISION',publisher:trust.publisher,transaction:(await store.prepare(chain)).transaction};
    }
    check(count===2n,'UNEXPECTED_BATCH_COUNT');
    const batches={'1':archive.batch('1'),'2':archive.batch('2')},blobs={};
    for(const batch of Object.values(batches)) for(const record of batch) if(record.decision?.payload.stateHash) blobs[record.decision.payload.stateHash]=archive.blob(record.decision.payload.stateHash);
    const file={format:'trust404-audit-v1',profileId:trust.policyHash,batches,blobs};
    save('audit.json',file);
    const tampered=structuredClone(file);tampered.batches['2'][0].decision.payload.outcome='APPROVED';save('audit-tampered.json',tampered);
    const missing=structuredClone(file);delete missing.batches['2'];save('audit-missing.json',missing);
    const result=await auditAll(archive,trust,chain);save('audit-result.json',result);
    return {stage:'COMPLETE',publisher:trust.publisher,result};
  } finally {locked=false;}
}
const html=`<!doctype html><html lang="ko"><meta charset="utf-8"><title>TRUST404 · 테스트넷 기록 등록</title><style>body{background:#101018;color:#eee;font:16px system-ui;max-width:900px;margin:60px auto}button,a{padding:12px;margin:8px;color:#ab9cff}button{background:#29233b;border:1px solid #74608f}pre{white-space:pre-wrap;overflow-wrap:anywhere}button:disabled{opacity:.5}</style><h1>테스트넷 기록 등록</h1><p>Base Sepolia · 요청 등록 → 거절 판단 등록 → 감사 파일</p><p>요청자·기관 서명은 이 시연용 키를 사용합니다. MetaMask는 온체인 등록 거래에 서명합니다.</p><button id="prepare">다음 단계 준비</button><button id="sign" disabled>MetaMask 서명 요청</button><pre id="status">준비 대기</pre><div id="downloads" hidden><a href="/audit.json" download>감사 파일</a><a href="/audit-tampered.json" download>변조 파일</a><a href="/audit-missing.json" download>누락 파일</a></div><script src="/operator.js"></script></html>`;
const server=createServer(async(req,res)=>{
  try {
    check(req.headers.host==='127.0.0.1:4041','LOCAL_HOST_REQUIRED');
    check(!req.headers.origin||req.headers.origin==='http://127.0.0.1:4041','LOCAL_ORIGIN_REQUIRED');
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',"default-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
    const path=new URL(req.url,'http://localhost').pathname;
    if(req.method==='POST'&&path==='/prepare'){check(req.headers.origin==='http://127.0.0.1:4041','LOCAL_ORIGIN_REQUIRED');res.setHeader('Content-Type','application/json');res.end(canonical(await advance()));return;}
    check(req.method==='GET','METHOD_NOT_ALLOWED');
    if(path==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);return;}
    if(path==='/operator.js'){res.setHeader('Content-Type','text/javascript');res.end(readFileSync(new URL('./testnet-ui.js',import.meta.url)));return;}
    check(['/audit.json','/audit-tampered.json','/audit-missing.json'].includes(path),'NOT_FOUND');
    res.setHeader('Content-Type','application/json');res.end(readFileSync(join(directory,path.slice(1))));
  }catch(e){res.statusCode=400;res.end(JSON.stringify({error:/^[A-Z_]+$/.test(e.message)?e.message:'OPERATION_FAILED'}));}
});
server.listen(4041,'127.0.0.1',()=>console.log('Testnet operator: http://127.0.0.1:4041'));
