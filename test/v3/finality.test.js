import test from 'node:test';
import assert from 'node:assert/strict';
import {auditView} from '../../src/v3/finality.js';
const fixture=(height,count=2)=>{
 const latest={count:async()=>2,batch:async()=>({blockNumber:'100'}),assertCanonical:async()=>{},finality:'PROVISIONAL'};
 const finalized={count:async()=>count,finality:'FINALIZED'};
 return {at:async tag=>tag==='latest'?latest:finalized,rpc:async()=>({number:'0x'+height.toString(16),hash:'finalized'})};
};
test('체인 완결성: finalized 블록이 모든 배치를 포함할 때만 승격(Promote)',async()=>{
 assert.equal((await auditView(fixture(99))).finality,'PROVISIONAL');
 assert.equal((await auditView(fixture(100))).finality,'FINALIZED');
 assert.equal((await auditView(fixture(100,1))).finality,'PROVISIONAL');
});
