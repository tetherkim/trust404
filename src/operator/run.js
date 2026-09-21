import { auditView } from '../verifier/finality.js';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync, readdirSync, linkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, keccak256, encodeDeployData } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { Archive, EvidenceStore } from '../storage/store.js';
import { ChainReader } from '../chain/reader.js';
import { jsonRpc } from '../common/rpc.js';
import { hash, check, canonical } from '../common/crypto.js';
import { scope, requestRecord } from '../policy/policy.js';
import { auditAll } from '../verifier/verify.js';

export class Operator {
  constructor(directory, config = { rpcUrl:'https://sepolia.base.org', chain:baseSepolia, token:'0x036cbd53842c5426634e7929541ec2318f3dcf7e' }) {
    this.dir=resolve(directory);this.config=config;
    mkdirSync(this.dir,{recursive:true,mode:0o700});
    const lock=join(this.dir,'operator.lock');
    const fd=openSync(lock,'wx',0o600);writeFileSync(fd,String(process.pid));closeSync(fd);this.lock=lock;
    this.client=createPublicClient({transport:http(config.rpcUrl),chain:config.chain,
      ...(config.chain.id===31337?{pollingInterval:50,cacheTime:0}:{})});
  }
  load(name){return JSON.parse(readFileSync(join(this.dir,name),'utf8'));}
  has(name){return existsSync(join(this.dir,name));}
  save(name,value){const file=join(this.dir,name);writeFileSync(file+'.tmp',JSON.stringify(value,null,2)+'\n',{mode:0o600,flush:true});renameSync(file+'.tmp',file);}
  init(){
    if(!this.has('secrets.json')){
      const key=()=>{const pair=generateKeyPairSync('ed25519');return {private:pair.privateKey.export({format:'pem',type:'pkcs8'}),public:pair.publicKey.export({format:'pem',type:'spki'})};};
      this.save('secrets.json',{wallet:generatePrivateKey(),requester:key(),institution:key()});
    }
    this.secrets=this.load('secrets.json');this.account=privateKeyToAccount(this.secrets.wallet);
    this.wallet=createWalletClient({account:this.account,chain:this.config.chain,transport:http(this.config.rpcUrl)});
    return {address:this.account.address,chainId:this.config.chain.id};
  }
  async transact(id,tx){
    check(await this.client.getChainId()===this.config.chain.id,'CHAIN_MISMATCH');
    const file=`tx-${id}.json`;
    let journal;
    if(this.has(file))journal=this.load(file);
    else{
      const gas=await this.client.estimateGas({...tx,account:this.account.address});
      check(gas<=600000n,'GAS_LIMIT_EXCEEDED');
      const prepared=await this.wallet.prepareTransactionRequest({...tx,gas:gas*12n/10n,value:0n});
      const fee=prepared.maxFeePerGas??prepared.gasPrice;check(fee&&prepared.gas*fee<=1000000000000000n,'FEE_LIMIT_EXCEEDED');
      const day=new Date().toISOString().slice(0,10);const budget=this.has('budget.json')?this.load('budget.json'):{};
      const total=BigInt(budget[day]??0)+prepared.gas*fee;check(total<=10000000000000000n,'DAILY_BUDGET_EXCEEDED');
      budget[day]=String(total);this.save('budget.json',budget);
      const raw=await this.wallet.signTransaction(prepared);
      journal={raw,hash:keccak256(raw),to:tx.to??null,data:tx.data};this.save(file,journal);
    }
    check(journal.to===(tx.to??null)&&journal.data===tx.data,'JOURNAL_MISMATCH');
    let receipt=await this.client.getTransactionReceipt({hash:journal.hash}).catch(()=>null);
    if(!receipt){
      try{await this.client.sendRawTransaction({serializedTransaction:journal.raw});}catch{ /* Check exact saved hash before considering any retry. */ }
      receipt=await this.client.waitForTransactionReceipt({hash:journal.hash,timeout:60000});
    }
    let block,lastError,sawMismatch=false;
    for(let attempt=0;;attempt++){
      try{
        receipt=await this.client.getTransactionReceipt({hash:journal.hash});
        check(receipt.status==='success','TRANSACTION_REVERTED');
        block=await this.client.getBlock({blockNumber:receipt.blockNumber});
        if(block.hash===receipt.blockHash)break;
        sawMismatch=true;
      }catch(error){
        if(!['BlockNotFoundError','TransactionReceiptNotFoundError'].includes(error.name))throw error;
        lastError=error;
      }
      if(attempt>=4){if(sawMismatch)throw Error('REORG');throw lastError;}
      await new Promise(r=>setTimeout(r,2000));
    }
    return receipt;
  }
  async deploy(){
    if(this.has('trust.json'))return this.load('trust.json').policy.anchorAddress;
    const compiled=JSON.parse(readFileSync(new URL('../../out/RecordAnchor.sol/RecordAnchor.json',import.meta.url)));
    const data=encodeDeployData({abi:compiled.abi,bytecode:compiled.bytecode.object,args:[this.account.address]});
    const receipt=await this.transact('deploy',{data});const anchor=receipt.contractAddress.toLowerCase();
    const policy={version:3,logId:'operator-'+anchor.slice(2,14),chainId:String(this.config.chain.id),anchorAddress:anchor,
      policyId:'usdc-reserve-v1',ruleVersion:1,institutionId:'testnet-operator',token:this.config.token,decimals:6,treasury:this.account.address.toLowerCase(),
      limitAtomic:'100000000',reserveAtomic:'100000000',decisionWindowSeconds:90,stateRule:'RECEIPT_BLOCK_END'};
    const trust={policy,policyHash:hash('policy-v3',policy),publisher:policy.treasury,codeHash:keccak256(await this.client.getCode({address:anchor})),requesterKeys:{requester:this.secrets.requester.public},institutionKeys:{institution:this.secrets.institution.public}};
    this.save('trust.json',trust);this.save('profiles.json',[{trustFile:join(this.dir,'trust.json'),rpcUrl:this.config.rpcUrl,asOf:'auto',label:'자동 운영 테스트넷'}]);return anchor;
  }
  open(){this.trust=this.load('trust.json');this.archive=new Archive(join(this.dir,'archive'));this.store=new EvidenceStore(join(this.dir,'records.sqlite'),this.archive,this.trust);this.reader=new ChainReader(jsonRpc(this.config.rpcUrl),this.trust);}
  request(amount,id){
    check(/^[a-zA-Z0-9_-]{1,80}$/.test(id),'INVALID_IDEMPOTENCY_KEY');
    const name=`request-${id}.json`;const p=this.trust.policy;let record;
    if(this.has(name)){record=this.load(name);check(record.request.payload.amountAtomic===amount,'IDEMPOTENCY_CONFLICT');}
    else{record=requestRecord({...scope(p),requesterId:'requester',institutionId:p.institutionId,token:p.token,treasury:p.treasury,recipient:p.treasury,amountAtomic:amount,createdAtMs:String(Date.now()),policyHash:this.trust.policyHash},'requester',this.secrets.requester.private);this.save(name,record);}
    return this.store.submit(record);
  }
  async submit(amount,id){
    check(/^[1-9][0-9]*$/.test(amount??''),'INVALID_AMOUNT');
    const request=this.request(amount,id);
    const audit=await this.cycle();
    const folder=join(this.dir,'exports',id);mkdirSync(folder,{recursive:true,mode:0o700});
    // Export public evidence only. Never copy keys, SQLite or signed transaction journals.
    for(const [name,value] of Object.entries({
      'audit.json':this.load('audit.json'),'trust.json':this.trust,'audit-result.json':audit,
      'evidence.json':this.store.bundle(request.requestId),
      'verify-config.json':{trustFile:'trust.json',rpcUrl:this.config.rpcUrl,asOf:audit.asOf.blockHash},
      ...(this.executionMode==='aomi-client'?{'execution.json':{mode:this.executionMode,batches:readdirSync(this.dir).filter(n=>/^aomi-batch-\d+\.json$/.test(n)).map(n=>{const j=this.load(n);return {batchId:n.slice(11,-5),sessionId:j.sessionId,actionId:j.actionId,state:j.state,transactionHash:j.transactionHash,actionResult:j.actionResult};})}}:{}),
      'profiles.json':[{trustFile:'trust.json',rpcUrl:this.config.rpcUrl,asOf:'auto',label:this.trust.policy.logId}],
    })){
      const file=join(folder,name);writeFileSync(file+'.tmp',name==='evidence.json'?canonical(value):JSON.stringify(value,null,2)+'\n',{mode:0o600,flush:true});renameSync(file+'.tmp',file);
    }
    return {request,status:'RECORDED',executionMode:this.executionMode??'direct-rpc',auditOk:audit.ok,finality:audit.finality,exportDirectory:folder,auditFile:join(folder,'audit.json'),profilesFile:join(folder,'profiles.json')};
  }
  async register(){
    const chain=await this.reader.at('latest');const count=BigInt(await chain.count());
    const pending=this.store.db.prepare('SELECT id FROM batches').all().some(b=>BigInt(b.id)>count)||this.store.db.prepare('SELECT 1 FROM entries WHERE batch_id IS NULL LIMIT 1').get();
    if(!pending)return;
    const batch=await this.store.prepare(chain);const tx=batch.transaction;
    check(tx.to===this.trust.policy.anchorAddress&&tx.chainId===this.trust.policy.chainId&&BigInt(tx.value)===0n&&tx.data.startsWith('0x4257ede9'),'TRANSACTION_OUT_OF_SCOPE');
    await (this.executeBatch??this.transact.bind(this))(`batch-${batch.batchId}`,{to:tx.to,data:tx.data});
  }
  async cycle(){
    for(const name of readdirSync(this.dir).filter(n=>/^request-[a-zA-Z0-9_-]+\.json$/.test(n)))this.store.submit(this.load(name));
    // Finish frozen batches first; never allocate another nonce while their outcome is unknown.
    await this.register();
    const chain=await this.reader.at('latest');
    const requests=this.store.db.prepare("SELECT request_id FROM entries WHERE kind='REQUEST' AND batch_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM entries d WHERE d.kind='DECISION' AND d.request_id=entries.request_id)").all();
    for(const r of requests)await this.store.decide(r.request_id,chain,'institution',this.secrets.institution.private);
    await this.register();
    const view=await auditView(this.reader);const count=BigInt(await view.count());const batches={},blobs={};
    for(let id=1n;id<=count;id++){const batch=this.archive.batch(String(id));batches[String(id)]=batch;for(const record of batch){const key=record.decision?.payload.stateHash;if(key)blobs[key]=this.archive.blob(key);}}
    this.save('audit.json',{format:'trust404-audit-v1',profileId:this.trust.policyHash,batches,blobs});
    const result=await auditAll(this.archive,this.trust,view);this.save('audit-result.json',result);return result;
  }
  close(){this.store?.close();if(this.lock){unlinkSync(this.lock);this.lock=null;}}
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
 const command=process.argv[2]??'status';let op;
 try{
  if(command==='request'){
    // A separate producer can enqueue while the worker holds its single-writer lock.
    const dir=resolve(process.env.OPERATOR_DIR??'.local-demo/operator'),id=process.argv[4];
    check(/^[a-zA-Z0-9_-]{1,80}$/.test(id??''),'IDEMPOTENCY_KEY_REQUIRED');
    const trust=JSON.parse(readFileSync(join(dir,'trust.json'))),secrets=JSON.parse(readFileSync(join(dir,'secrets.json'))),p=trust.policy,amount=process.argv[3];
    check(/^[1-9][0-9]*$/.test(amount??''),'INVALID_AMOUNT');
    const file=join(dir,`request-${id}.json`);
    if(existsSync(file)){const old=JSON.parse(readFileSync(file));check(old.request.payload.amountAtomic===amount,'IDEMPOTENCY_CONFLICT');console.log(JSON.stringify({requestId:old.requestId,duplicate:true}));}
    else{const record=requestRecord({...scope(p),requesterId:'requester',institutionId:p.institutionId,token:p.token,treasury:p.treasury,recipient:p.treasury,amountAtomic:amount,createdAtMs:String(Date.now()),policyHash:trust.policyHash},'requester',secrets.requester.private);const temp=file+'.'+process.pid+'.tmp';writeFileSync(temp,JSON.stringify(record),{flag:'wx',mode:0o600,flush:true});try{linkSync(temp,file);}finally{unlinkSync(temp);}console.log(JSON.stringify({requestId:record.requestId,queued:true}));}
    process.exit(0);
  }
  op=new Operator(process.env.OPERATOR_DIR??'.local-demo/operator');const identity=op.init();
  if(command==='init'||command==='status')console.log(JSON.stringify({...identity,balanceWei:String(await op.client.getBalance({address:identity.address})),deployed:op.has('trust.json')}));
  else if(command==='deploy')console.log(JSON.stringify({anchor:await op.deploy()}));
  else{
   op.open();
   if(command==='aomi-submit'){const {attachAomi}=await import('./aomi.js');await attachAomi(op);console.log(JSON.stringify(await op.submit(process.argv[3],process.argv[4])));}
   else if(command==='submit')console.log(JSON.stringify(await op.submit(process.argv[3],process.argv[4])));
   else if(command==='tick')console.log(JSON.stringify(await op.cycle()));
   else if(command==='run'){
    let stop=false;process.once('SIGINT',()=>{stop=true;});process.once('SIGTERM',()=>{stop=true;});
    while(!stop){try{const r=await op.cycle();console.log(JSON.stringify({ok:r.ok,requests:r.requests.length,finality:r.finality}));}catch{console.error('WORKER_RETRY_PENDING: inspect chain and local journal');}await new Promise(r=>setTimeout(r,3000));}
   }else throw Error('UNKNOWN_COMMAND');
  }
 }catch(e){console.error(/^[A-Z_]+$/.test(e.message)?e.message:'OPERATOR_FAILED');process.exitCode=1;}finally{op?.close();}
}
