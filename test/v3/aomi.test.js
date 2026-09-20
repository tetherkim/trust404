import test from 'node:test';
import assert from 'node:assert/strict';
import {validateAomiRequest,stageArguments} from '../../src/operator/aomi.js';
import {encodeFunctionData,parseAbi} from 'viem';
const sender='0x1111111111111111111111111111111111111111';
const expected={to:'0x2222222222222222222222222222222222222222',data:'0x4257ede9'};
const valid=()=>({type:'execute_evm',simulation:{status:'passed',guards:[]},transactions:[{...expected,from:sender,chain_id:84532,value:'0'}]});
test('Aomi 연동: 서명자 권한 확장 방지 및 시뮬레이션 성공 필수 검증',()=>{
 assert.doesNotThrow(()=>validateAomiRequest(valid(),expected,sender,84532));
 for(const mutate of [r=>r.simulation.status='failed',r=>r.simulation.guards.push({status:'failed'}),r=>r.transactions.push({...r.transactions[0]}),r=>r.transactions[0].to=sender,r=>r.transactions[0].data='0xdeadbeef',r=>r.transactions[0].from=expected.to,r=>r.transactions[0].chain_id=1,r=>r.transactions[0].value='1',r=>r.type='sign']) {
  const request=valid();mutate(request);assert.throws(()=>validateAomiRequest(request,expected,sender,84532));
 }
});
test('Aomi 연동: 0 패딩 calldata 복사 없이 ABI 인자 자동 구조화 검증',()=>{
 const abi=parseAbi(['function anchorBatch(uint256 expectedBatchId,bytes32 root,uint256 count)']);
 const args=[6n,'0x65e4476b5099b067d8097b17718f5d673c26f39073753a7ce015017b369567de',1n];
 const data=encodeFunctionData({abi,functionName:'anchorBatch',args});
 const staged=stageArguments({...expected,data},84532);
 assert.deepEqual(staged.data.args,args.map(String));assert.equal(staged.data.raw,'');
 assert.equal(encodeFunctionData({abi,functionName:'anchorBatch',args:staged.data.args}),data);
 assert.throws(()=>stageArguments(expected,84532));
});
