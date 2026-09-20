import { Aomi, Session } from '@aomi-labs/client';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { decodeFunctionData, parseAbi } from 'viem';
import { check } from '../v3/crypto.js';

const baseUrl = 'https://chat.aomi.dev';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export function stageArguments(expected, chainId) {
  const {args}=decodeFunctionData({abi:parseAbi(['function anchorBatch(uint256 expectedBatchId, bytes32 root, uint256 count)']),data:expected.data});
  return {to:expected.to,chain_id:chainId,value:'0',description:'Register TRUST404 evidence',
    data:{signature:'anchorBatch(uint256,bytes32,uint256)',args:args.map(String),raw:''}};
}

export function validateAomiRequest(request, expected, sender, chainId) {
  check(request?.type === 'execute_evm', 'AOMI_UNSUPPORTED_ACTION');
  check(request.simulation?.status === 'passed', 'AOMI_SIMULATION_REQUIRED');
  check(!request.simulation.guards?.some(g => g.status === 'failed'), 'AOMI_GUARD_FAILED');
  check(request.transactions?.length === 1, 'AOMI_TRANSACTION_COUNT');
  const tx = request.transactions[0];
  check(tx.chain_id === chainId && tx.from?.toLowerCase() === sender.toLowerCase(), 'AOMI_WALLET_MISMATCH');
  check(tx.to?.toLowerCase() === expected.to.toLowerCase() && tx.data?.toLowerCase() === expected.data.toLowerCase()
    && BigInt(tx.value ?? 0) === 0n, 'AOMI_PAYLOAD_MISMATCH');
}

export async function connectAomi(op) {
  const directory = join(op.dir, 'aomi-session');
  mkdirSync(directory, {recursive:true,mode:0o700});
  const readState = () => {
    try {
      const id = readFileSync(join(directory,'active-session.txt'),'utf8').trim();
      check(/^\d+$/.test(id), 'AOMI_INVALID_SESSION');
      return JSON.parse(readFileSync(join(directory,'sessions',`session-${id}.json`),'utf8'));
    } catch { return null; }
  };
  let state = readState();
  if (!state?.auth?.sessionToken || state.auth.expiresAt <= Date.now()+60000) {
    // Official CLI signs a SIWE login locally. No private key is passed in argv or sent to Aomi.
    try {
      await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../../node_modules/@aomi-labs/client/dist/cli.js',import.meta.url)),
        'account','login','--wallet','--backend-url',baseUrl,'--chain',String(op.config.chain.id),'--json'], {
        env:{...process.env,AOMI_STATE_DIR:directory,PRIVATE_KEY:op.secrets.wallet,AOMI_ACCOUNT_BEARER:''}, timeout:60000,
      });
    } catch { throw Error('AOMI_LOGIN_FAILED'); }
    state = readState();
  }
  check(state?.baseUrl===baseUrl && state?.auth?.sessionToken && state.publicKey?.toLowerCase()===op.account.address.toLowerCase(), 'AOMI_SESSION_MISMATCH');
  const bearer = async () => { check(state.auth.expiresAt>Date.now(), 'AOMI_SESSION_EXPIRED'); return state.auth.sessionToken; };
  bearer.required = true; // SDK session-auth path, distinct from an OAuth resource grant.
  const aomi = new Aomi({baseUrl, getAccountBearer:bearer, guest:false});
  const profile = await aomi.raw.fetchAccountProfile(state.sessionId);
  check(profile?.signing_policies?.some(p=>p.address.chain==='evm'&&p.address.address.toLowerCase()===op.account.address.toLowerCase()&&['manual','client_auto'].includes(p.mode)), 'AOMI_WALLET_POLICY_REQUIRED');
  return aomi;
}

export async function executeAomiBatch(op, aomi, id, expected) {
  check(/^batch-\d+$/.test(id), 'AOMI_INVALID_BATCH');
  const filename = `aomi-${id}.json`;
  const journal = op.has(filename) ? op.load(filename) : {sessionId:randomUUID(),expected,state:'pending'};
  check(JSON.stringify(journal.expected)===JSON.stringify(expected), 'AOMI_JOURNAL_MISMATCH');
  op.save(filename,journal);
  if (journal.state==='confirmed') return op.transact(id,expected);
  let receipt;
  const stage=JSON.stringify(stageArguments(expected,op.config.chain.id));
  const instructions=`Use evm_stage_tx with these ABI arguments: ${stage}. Let the runtime ABI-encode them; do not manually copy or construct raw hex. Use only this call. Sync the chain fork before simulation. Simulate then commit only the matching, successful transaction to the connected client wallet ${op.account.address}. Never skip simulation, override contract storage, add fees/calls or change signing policy. This registers evidence, not a token payment. Execute the tools, not just a description.`;
  const session = new Session(aomi.raw, {sessionId:journal.sessionId,target:{mode:'direct',app:'default'},
    getUserState:()=>({connection:{is_connected:true},evm:{address:op.account.address,chain_id:op.config.chain.id,broadcaster:'wallet'}}),
    actions:{execute_evm:async request=>{
      validateAomiRequest(request,expected,op.account.address,op.config.chain.id);
      // Persist the exact Aomi request before calling the local, restricted signer.
      journal.request=request;op.save(filename,journal);
      for(let attempt=0;;attempt++) {
        try { receipt=await op.transact(id,expected);break; }
        catch(error){if(attempt>=3 || (error.message!=='REORG' && error.name!=='BlockNotFoundError'))throw error;await pause(2000);}
      }
      journal.transactionHash=receipt.transactionHash;op.save(filename,journal);
      return {status:'submitted',legs:[{id:'leg_1',status:'submitted',transactionId:receipt.transactionHash}]};
    }},
  });
  try {
    // Restore the server-owned session first: a lost response must not start a second execution.
    if(journal.started) {
      try { await session.fetchCurrentState(); }
      catch(error) { if(error.status!==404)throw error;journal.started=false; }
    }
    if(!journal.started) {
      journal.started=true;op.save(filename,journal);
      await session.sendAsync(`TRUST404 authorized evidence registration. ${instructions}`);
    }
    const deadline=Date.now()+180000;
    while(Date.now()<deadline) {
      // The server may have accepted the result before the local process saved its acknowledgement.
      const acknowledged=session.actions.all().find(a=>a.result?.status==='submitted' &&
        a.result.legs?.some(l=>l.transactionId===journal.transactionHash));
      if(acknowledged && journal.transactionHash) {
        validateAomiRequest(acknowledged.request,expected,op.account.address,op.config.chain.id);
        receipt=await op.transact(id,expected);
        journal.state='confirmed';journal.actionId=acknowledged.id;journal.actionResult=acknowledged.result;
        journal.confirmedAt=new Date().toISOString();op.save(filename,journal);return receipt;
      }
      const action=session.actions.pending()[0];
      if(action) {
        check(action.expires_at*1000>Date.now(), 'AOMI_ACTION_EXPIRED');
        const resolved=await session.actions.execute(action.id);
        // Submission is acknowledged by Aomi, receipt is independently checked by op.transact.
        check(resolved.result?.status==='submitted' && journal.transactionHash, 'AOMI_ACK_REQUIRED');
        journal.state='confirmed';journal.actionId=resolved.id;journal.actionResult=resolved.result;
        journal.confirmedAt=new Date().toISOString();op.save(filename,journal);
        return receipt;
      }
      const snapshot=session.getSnapshot();
      if(['complete','failed','interrupted'].includes(snapshot.turnState)) {
        const simulations=(snapshot.messages??[]).filter(m=>m.tool_name==='simulate_batch').flatMap(m=>{
          try{return JSON.parse(m.tool_result?.[1]).simulation?.steps??[];}catch{return [];}
        });
        const last=simulations.at(-1);
        if(last?.call?.data?.toLowerCase()!==expected.data.toLowerCase() && last && !journal.payloadRepairAttempted && !journal.transactionHash) {
          journal.payloadRepairAttempted=true;op.save(filename,journal);
          await session.sendAsync(`The last staged calldata DOES NOT match the authorized request. Discard that unsubmitted staged call; do not commit it. Replace it with the authorized ABI call below and run a fresh simulation. ${instructions}`);
          continue;
        }
        // A warm fork can lag the preceding registration. Retry via Aomi, never sign a failed simulation.
        check((journal.turnAttempts??0)<2, 'AOMI_NO_EXECUTION_ACTION');
        await op.client.call({account:op.account.address,to:expected.to,data:expected.data});
        journal.turnAttempts=(journal.turnAttempts??0)+1;op.save(filename,journal);
        await session.sendAsync(`Retry the authorized transaction. A current independent eth_call succeeds. Your fork may predate the preceding batch. Reuse a matching staged call or replace an incorrect unsubmitted call, then sync and resimulate. ${instructions}`);
      }
      await pause(1500);await session.fetchCurrentState();
    }
    throw Error('AOMI_TIMEOUT');
  } finally { session.close(); }
}

export async function attachAomi(op) {
  const client=await connectAomi(op);
  op.executionMode='aomi-client';
  op.executeBatch=(id,tx)=>executeAomiBatch(op,client,id,tx);
  for(const name of readdirSync(op.dir).filter(n=>/^aomi-batch-\d+\.json$/.test(n))) {
    const j=op.load(name);
    if(j.state!=='confirmed')await op.executeBatch(name.slice(5,-5),j.expected);
  }
}
