import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {baseSepolia} from 'viem/chains';
import {Operator} from '../src/operator/run.js';

test('operator retries a transient receipt and block mismatch', async t=>{
  const dir=mkdtempSync(join(tmpdir(),'trust404-reorg-'));const op=new Operator(dir);
  t.after(()=>{op.close();rmSync(dir,{recursive:true,force:true});});
  const hash='0x'+'11'.repeat(32),canonical='0x'+'22'.repeat(32),stale='0x'+'33'.repeat(32);
  op.save('tx-test.json',{raw:'0x01',hash,to:'0x'+'44'.repeat(20),data:'0x1234'});
  let blockReads=0;
  op.client={
    getChainId:async()=>baseSepolia.id,
    getTransactionReceipt:async()=>({status:'success',blockNumber:1n,blockHash:canonical,transactionHash:hash}),
    getBlock:async()=>({hash:++blockReads===1?stale:canonical}),
  };
  const receipt=await op.transact('test',{to:'0x'+'44'.repeat(20),data:'0x1234'});
  assert.equal(receipt.transactionHash,hash);
  assert.equal(blockReads,2);
});
