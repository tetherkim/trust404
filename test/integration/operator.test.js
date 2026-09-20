import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {foundry} from 'viem/chains';
import {createWalletClient,http} from 'viem';
import {mnemonicToAccount} from 'viem/accounts';
import {Operator} from '../../src/operator/run.js';

test('automatic operator handles three requests, replay and process restart without duplicate batches', {timeout:60000}, async t=>{
 const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
 const rpcUrl=`http://127.0.0.1:${port}`,anvil=spawn('anvil',['--port',String(port),'--silent'],{stdio:'ignore'});
 const dir=mkdtempSync(join(tmpdir(),'trust404-op-'));let op;
 t.after(()=>{op?.close();anvil.kill();rmSync(dir,{recursive:true,force:true});});
 const config={rpcUrl,chain:foundry,token:'0x0000000000000000000000000000000000000001'};
 op=new Operator(dir,config);const identity=op.init();
 for(let i=0;i<50;i++){try{await op.client.getBlockNumber();break;}catch{await new Promise(r=>setTimeout(r,100));}}
 await op.client.request({method:'anvil_setBalance',params:[identity.address,'0xde0b6b3a7640000']});
 const account=mnemonicToAccount('test test test test test test test test test test test junk');const wallet=createWalletClient({account,chain:foundry,transport:http(rpcUrl)});
 const token=JSON.parse(readFileSync('out/RecordAnchor.t.sol/TestToken.json'));
 const receipt=await op.client.waitForTransactionReceipt({hash:await wallet.deployContract({abi:token.abi,bytecode:token.bytecode.object})});config.token=receipt.contractAddress.toLowerCase();
 await op.deploy();op.open();
 for(let i=1;i<=3;i++)op.request('50000000',`request${i}`);
 const result=await op.cycle();assert.equal(result.ok,true);assert.equal(result.requests.length,3);assert.equal(result.batchCount,'2');
 assert(result.requests.every(r=>r.decisions[0].outcome==='REJECTED'));
 op.close();op=new Operator(dir,config);op.init();op.open();
 assert.equal(op.request('50000000','request1').duplicate,true);
 assert.throws(()=>op.request('60000000','request1'),/IDEMPOTENCY_CONFLICT/);
 const repeated=await op.cycle();assert.equal(repeated.batchCount,'2');assert.equal(repeated.ok,true);
 const journal=op.load('tx-batch-2.json');const count=await op.client.getTransactionCount({address:identity.address});
 await op.transact('batch-2',{to:journal.to,data:journal.data});assert.equal(await op.client.getTransactionCount({address:identity.address}),count);
});
