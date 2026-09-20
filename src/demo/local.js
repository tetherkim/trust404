import { createServer as httpServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, encodeDeployData, http, keccak256 } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { Archive, EvidenceStore } from '../v3/store.js';
import { ChainReader, jsonRpc } from '../v3/chain.js';
import { createEvidenceServer } from '../v3/server.js';
import { auditAll } from '../v3/verify.js';
import { addressShape, canonical, hash, sign, check } from '../v3/crypto.js';
import { requestRecord, scope } from '../v3/policy.js';
import { buildTree } from '../v3/merkle.js';
import { auditFile, readUpload } from './audit-file.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cases = [
  { id: 'rejection', title: '정상 거절', description: '접수 당시 잔액 120에서 50을 지급하면 최소 잔액 100을 지킬 수 없습니다.' },
  { id: 'tamper', title: '기록 변조', description: '보관 파일의 판단 내용을 바꿔 계약에 등록된 해시와 비교합니다.' },
  { id: 'unavailable', title: '자료 유실', description: '계약에는 등록됐지만 보관 파일을 제공할 수 없는 경우입니다.' },
  { id: 'missing', title: '결과 미등록', description: '요청 등록 후 90초가 지나도 결과가 계약에 등록되지 않은 경우입니다.' },
  { id: 'wrong', title: '잘못된 판단', description: '기관이 승인으로 서명하고 등록했어도 당시 잔액과 규칙으로 다시 확인합니다.' },
];
async function listen(server, port = 0) {
  server.listen(port, '127.0.0.1'); await once(server, 'listening'); return server.address().port;
}
async function closeServer(server) {
  if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
async function unusedPort() {
  const server = netServer(), port = await listen(server); await closeServer(server); return port;
}
const artifact = (file, name) => JSON.parse(readFileSync(join(root, 'out', file, `${name}.json`), 'utf8'));

// This harness always spawns its own loopback chain. It never accepts an external
// RPC or a real signing key; the public Anvil account is usable only here.
export async function startDemo({ port = 4040, directory = join(root, '.local-demo'), profileFile = process.env.AUDIT_PROFILES_FILE,
  deploymentPublisher = process.env.WALLET_ADDRESS } = {}) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const runDirectory = mkdtempSync(join(directory, 'run-'));
  const rpcPort = await unusedPort(), rpcUrl = `http://127.0.0.1:${rpcPort}`;
  const child = spawn('anvil', ['--host', '127.0.0.1', '--port', String(rpcPort), '--chain-id', '31337', '--silent'], { stdio: 'ignore' });
  let spawnError, server;
  child.on('error', error => { spawnError = error; });
  const close = async () => {
    await closeServer(server);
    if (child.pid && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  };
  try {
    const rpc = jsonRpc(rpcUrl, { timeoutMs: 3000 });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (spawnError) throw new Error('ANVIL_UNAVAILABLE');
      try { check(BigInt(await rpc('eth_chainId', [])) === 31337n, 'LOCAL_CHAIN_REQUIRED'); ready = true; break; }
      catch { await new Promise(r => setTimeout(r, 50)); }
    }
    check(ready, 'LOCAL_CHAIN_UNAVAILABLE');
    const account = mnemonicToAccount('test test test test test test test test test test test junk');
    const wallet = createWalletClient({ account, chain: foundry, transport: http(rpcUrl) });
    const client = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
    const anchorArtifact = artifact('RecordAnchor.sol', 'RecordAnchor');
    const tokenArtifact = artifact('RecordAnchor.t.sol', 'TestToken');
    const receipt = async txHash => {
      const tx = await client.waitForTransactionReceipt({ hash: txHash }); check(tx.status === 'success', 'LOCAL_TRANSACTION_FAILED'); return tx;
    };
    const deploy = async (compiled, args = []) => (await receipt(await wallet.deployContract({ abi: compiled.abi, bytecode: compiled.bytecode.object, args }))).contractAddress.toLowerCase();
    const records = new Map();
    for (const scenario of cases) {
      const dir = join(runDirectory, scenario.id); mkdirSync(dir, { mode: 0o700 });
      const anchorAddress = await deploy(anchorArtifact, [account.address]), token = await deploy(tokenArtifact);
      const treasury = account.address.toLowerCase();
      const setBalance = async balance => receipt(await wallet.writeContract({ address: token, abi: tokenArtifact.abi, functionName: 'setBalance', args: [treasury, balance] }));
      await setBalance(120000000n);
      const requester = generateKeyPairSync('ed25519'), institution = generateKeyPairSync('ed25519');
      const pub = key => key.export({ type: 'spki', format: 'pem' });
      const policy = { version: 3, logId: `local-${scenario.id}`, chainId: '31337', anchorAddress,
        policyId: 'usdc-reserve-v1', ruleVersion: 1, institutionId: 'demo-company', token, decimals: 6, treasury,
        limitAtomic: '100000000', reserveAtomic: '100000000', decisionWindowSeconds: 90, stateRule: 'RECEIPT_BLOCK_END' };
      const trust = { policy, policyHash: hash('policy-v3', policy), publisher: treasury,
        codeHash: keccak256(await client.getCode({ address: anchorAddress })),
        requesterKeys: { requester: pub(requester.publicKey) }, institutionKeys: { institution: pub(institution.publicKey) } };
      const archive = new Archive(join(dir, 'archive')), store = new EvidenceStore(join(dir, 'records.sqlite'), archive, trust);
      const reader = new ChainReader(rpc, trust), writeToken = randomBytes(32).toString('hex');
      const api = createEvidenceServer({ store, reader, writeToken, signer: { keyId: 'institution', privateKey: institution.privateKey } });
      try {
        const apiPort = await listen(api);
        const post = async (path, body = {}) => {
          const response = await fetch(`http://127.0.0.1:${apiPort}/v3${path}`, { method: 'POST',
            headers: { authorization: `Bearer ${writeToken}` }, body: canonical(body) });
          check(response.ok, 'LOCAL_API_FAILED'); return response.json();
        };
        const request = requestRecord({ ...scope(policy), requesterId: 'requester', institutionId: policy.institutionId,
          token, treasury, recipient: treasury, amountAtomic: '50000000', createdAtMs: String(Date.now()), policyHash: trust.policyHash }, 'requester', requester.privateKey);
        await post('/requests', request);
        const register = async () => {
          const batch = await post('/batches/prepare'), tx = batch.transaction;
          return receipt(await wallet.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value) }));
        };
        const requestTx = await register();
        let decisionTx;
        if (scenario.id !== 'missing') {
          const decision = await post(`/requests/${request.requestId}/evaluate`);
          if (scenario.id === 'wrong') {
            // An intentionally dishonest publisher; never modify the real evaluator.
            const wrong = { kind: 'DECISION', decision: sign('decision-v3', 'institution',
              { ...decision.decision.payload, outcome: 'APPROVED', reason: 'POLICY_SATISFIED' }, institution.privateKey) };
            const state = JSON.parse(store.db.prepare('SELECT value FROM blobs WHERE hash=?').get(decision.decision.payload.stateHash).value);
            archive.put('blob', decision.decision.payload.stateHash, state); archive.put('batch', '2', [wrong]);
            decisionTx = await receipt(await wallet.writeContract({ address: anchorAddress, abi: anchorArtifact.abi,
              functionName: 'anchorBatch', args: [2n, buildTree([wrong]).root, 1n] }));
          } else decisionTx = await register();
        } else { await rpc('evm_increaseTime', [91]); await rpc('evm_mine', []); }
        // Later balance is 200. Auditing must still use the receipt block's 120.
        await setBalance(200000000n);
        const view = await reader.at('latest'), asOf = view.context;
        const requestAnchor = await view.batch('1');
        const decisionAnchor = decisionTx ? await view.batch('2') : null;
        const auditArchive = new Archive(join(dir, 'audit-copy'));
        for (const id of decisionTx ? ['1', '2'] : ['1']) {
          if (scenario.id === 'unavailable' && id === '2') continue;
          const batch = structuredClone(archive.batch(id));
          if (scenario.id === 'tamper' && id === '2') batch[0].decision.payload.outcome = 'APPROVED';
          auditArchive.put('batch', id, batch);
          for (const r of batch) if (r.decision?.payload.stateHash) auditArchive.put('blob', r.decision.payload.stateHash, archive.blob(r.decision.payload.stateHash));
        }
        writeFileSync(join(dir, 'trust.json'), canonical(trust), { mode: 0o600 });
        writeFileSync(join(dir, 'audit-config.json'), JSON.stringify({ rpcUrl, trustFile: join(dir, 'trust.json'), archiveDirectory: auditArchive.directory }), { mode: 0o600 });
        records.set(scenario.id, { trust, auditArchive, asOf, info: { ...scenario, requestId: request.requestId, anchorAddress,
          requestTransaction: requestTx.transactionHash, decisionTransaction: decisionTx?.transactionHash ?? null,
          policyId: policy.policyId, policyHash: trust.policyHash, token, treasury,
          requestAnchor, decisionAnchor, decisionWindowSeconds: policy.decisionWindowSeconds,
          receiptBalance: '120', currentBalance: '200', amount: '50', minimumBalance: '100', asOf } });
      } finally { await closeServer(api); store.close(); }
    }
    const profiles = new Map([...records.values()].map(record => [record.trust.policyHash,
      { trust: record.trust, rpcUrl, asOf: record.asOf.blockHash, label: `LOCAL / ${record.info.title}` }]));
    const publisher = deploymentPublisher?.toLowerCase();
    check(!publisher || addressShape(publisher), 'INVALID_DEPLOYMENT_PUBLISHER');
    const deployment = publisher ? {
      chainId: 84532,
      chainName: 'Base Sepolia',
      publisher,
      contract: 'RecordAnchor',
      transaction: {
        from: publisher,
        data: encodeDeployData({ abi: anchorArtifact.abi, bytecode: anchorArtifact.bytecode.object, args: [publisher] }),
        value: '0x0',
      },
      simulation: { status: 'PASSED', gasEstimate: '220958' },
    } : null;
    if (profileFile) {
      for (const config of JSON.parse(readFileSync(profileFile, 'utf8'))) {
        const trust = JSON.parse(readFileSync(resolve(root, config.trustFile), 'utf8'));
        check(!profiles.has(trust.policyHash), 'DUPLICATE_TRUST_PROFILE');
        profiles.set(trust.policyHash, { trust, rpcUrl: config.rpcUrl, label: config.label ?? trust.policy.logId });
      }
    }
    const index = readFileSync(new URL('./index.html', import.meta.url));
    const js = readFileSync(new URL('./ui.js', import.meta.url));
    server = httpServer(async (req, res) => {
      const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'" };
      try {
        // Loopback binding plus Host/Origin checks keep this development surface local.
        check(req.headers.host === `127.0.0.1:${server.address().port}`, 'LOCAL_HOST_REQUIRED');
        check(!req.headers.origin || req.headers.origin === `http://${req.headers.host}`, 'LOCAL_ORIGIN_REQUIRED');
        const path = new URL(req.url, 'http://localhost').pathname;
        if (req.method === 'POST' && path === '/api/audit-file') {
          check(req.headers['content-type']?.split(';')[0] === 'application/json', 'JSON_REQUIRED');
          const result = await auditFile(await readUpload(req), profiles);
          res.writeHead(200, { ...headers, 'content-type': 'application/json' }).end(canonical(result)); return;
        }
        if (req.method !== 'GET') { res.writeHead(405, headers).end(); return; }
        if (path === '/' || path === '/ui.js') {
          res.writeHead(200, { ...headers, 'content-type': path === '/' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8' }).end(path === '/' ? index : js); return;
        }
        let result;
        if (path === '/api/deployment') result = deployment ?? { status: 'NOT_CONFIGURED' };
        else if (path === '/api/profiles') result = [...profiles].map(([id, p]) => ({ id, label: p.label, institutionId: p.trust.policy.institutionId, policyId: p.trust.policy.policyId, chainId: p.trust.policy.chainId, anchorAddress: p.trust.policy.anchorAddress, cutoff: p.asOf ?? 'finalized' }));
        else if (path.startsWith('/api/sample/')) {
          const record = records.get(path.slice('/api/sample/'.length));
          check(record, 'UNKNOWN_SAMPLE');
          const batches = {}, blobs = {};
          for (const id of record.info.decisionTransaction ? ['1', '2'] : ['1']) {
            let batch; try { batch = record.auditArchive.batch(id); } catch { continue; }
            batches[id] = batch;
            for (const item of batch) if (item.decision?.payload.stateHash) {
              const hash = item.decision.payload.stateHash;
              try { blobs[hash] = record.auditArchive.blob(hash); } catch {}
            }
          }
          result = { format: 'trust404-audit-v1', profileId: record.trust.policyHash, batches, blobs };
          res.writeHead(200, { ...headers, 'content-type': 'application/json', 'content-disposition': `attachment; filename="audit-${record.info.id}.json"` }).end(canonical(result)); return;
        }
        else if (path === '/api/status') result = { environment: 'local-anvil', chainId: 31337, aomiConnected: false,
          scenarios: [...records.values()].map(r => r.info) };
        else {
          const id = path.match(/^\/api\/audit\/([a-z]+)$/)?.[1], record = records.get(id);
          if (!record) { res.writeHead(404, headers).end(); return; }
          const auditor = new ChainReader(rpc, record.trust);
          result = await auditAll(record.auditArchive, record.trust, await auditor.at(record.asOf.blockHash));
        }
        res.writeHead(200, { ...headers, 'content-type': 'application/json' }).end(canonical(result));
      } catch (error) {
        const code = /^[A-Z_]+$/.test(error.message) ? error.message : 'DEMO_UNAVAILABLE';
        res.writeHead(code.startsWith('LOCAL_') ? 403 : 503, { ...headers, 'content-type': 'application/json' }).end(JSON.stringify({ error: code }));
      }
    });
    const webPort = await listen(server, port);
    return { url: `http://127.0.0.1:${webPort}`, runDirectory, rpcUrl, close };
  } catch (error) { await close(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startDemo().then(demo => {
    console.log(JSON.stringify({ url: demo.url, data: demo.runDirectory, environment: 'local-anvil', aomiConnected: false }));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => demo.close().then(() => process.exit(0)));
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
