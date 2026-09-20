import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SimpleMerkleTree } from '@openzeppelin/merkle-tree';
import {
  AbiCoder,
  ContractFactory,
  JsonRpcProvider,
  ZeroHash,
  concat,
  getAddress,
  getNumber,
  getUint,
  isHexString,
  keccak256,
} from 'ethers';

function uint(value) {
  const result = getUint(value);
  assert(result < 2n ** 256n, 'INVALID_INTEGER');
  return result;
}

export function safeNumber(value) {
  const result = getNumber(value);
  assert(result >= 0, 'INVALID_INTEGER');
  return result;
}

function bytes32(value) {
  assert(isHexString(value, 32), 'INVALID_HASH');
  return value.toLowerCase();
}

export function payloadHash(bytes) {
  assert(isHexString(bytes, true), 'INVALID_PAYLOAD_BYTES');
  return keccak256(bytes);
}

function entryOf(entry) {
  return {
    index: uint(entry.index),
    kind: uint(entry.kind),
    actor: getAddress(entry.actor),
    requestIndex: uint(entry.requestIndex),
    payloadHash: bytes32(entry.payloadHash),
    recordedAt: uint(entry.recordedAt),
  };
}

function checkpointOf(checkpoint) {
  return {
    size: uint(checkpoint.size),
    root: bytes32(checkpoint.root),
    issuedAt: uint(checkpoint.issuedAt)
  };
}

export function checkpointInfo(verificationContext) {
  const depth = safeNumber(verificationContext.depth);
  assert.equal(depth, 6, 'INVALID_DEPTH');

  const checkpoint = checkpointOf(verificationContext.checkpoint);
  assert(checkpoint.size <= 64n, 'INVALID_CHECKPOINT_SIZE');

  return {
    chainId: uint(verificationContext.chainId),
    evidenceLogAddress: getAddress(verificationContext.evidenceLogAddress),
    depth,
    checkpointId: uint(verificationContext.checkpointId),
    checkpoint,
  };
}

const abi = AbiCoder.defaultAbiCoder();
const parent = (a, b) => keccak256(concat(a < b ? [a, b] : [b, a]));

export function leafHash(rawEntry, context) {
  const e = rawEntry;

  return keccak256(
    keccak256(
      abi.encode(
        ['uint256', 'address', 'uint256', 'uint8', 'address', 'uint256', 'bytes32', 'uint256'],
        [
          context.chainId,
          context.evidenceLogAddress,
          e.index,
          e.kind,
          e.actor,
          e.requestIndex,
          e.payloadHash,
          e.recordedAt
        ],
      )
    )
  );
}

export function buildTree(rawEntries, context) {
  assert.equal(safeNumber(context.depth), 6, 'INVALID_DEPTH');
  const size = rawEntries.length;
  assert(size <= 64, 'TREE_CAPACITY_EXCEEDED');
  const leaves = Array.from({ length: 64 }, (_, i) =>
    i < size ? leafHash(rawEntries[i], context) : ZeroHash);
  const tree = SimpleMerkleTree.of(leaves, { sortLeaves: false });

  return {
    root: tree.root,

    proof(index) {
      const position = safeNumber(index);
      assert(position < size, 'INVALID_INDEX');
      return tree.getProof(position);
    },
  };
}

function checkEntry(rawEntry, info, context) {
  const entry = entryOf(rawEntry);
  assert(
    entry.index < info.checkpoint.size && entry.recordedAt <= info.checkpoint.issuedAt,
    'ENTRY_OUTSIDE_CHECKPOINT'
  );
  assert(entry.kind === 0n || entry.kind === 1n, 'INVALID_KIND');
  assert(entry.payloadHash !== ZeroHash, 'ZERO_PAYLOAD_HASH');

  assert(entry.actor === getAddress(context.institutionAddress), 'ACTOR_MISMATCH');
  assert(
    entry.kind === 0n ? entry.requestIndex === entry.index : entry.requestIndex < entry.index,
    'REQUEST_LINK_MISMATCH'
  );

  return entry;
}

export function verifyLogRecords(rawEntries, verificationContext) {
  const info = checkpointInfo(verificationContext);
  assert(
    Array.isArray(rawEntries) && BigInt(rawEntries.length) === info.checkpoint.size,
    'LOG_SIZE_MISMATCH'
  );

  const entries = rawEntries.map(entry => checkEntry(entry, info, verificationContext));
  const requests = new Set();
  const decisions = new Set();
  const hashes = new Set();

  for (const [i, entry] of entries.entries()) {
    assert(
      entry.index === BigInt(i) && (i === 0 || entry.recordedAt >= entries[i - 1].recordedAt),
      'INVALID_LOG_ORDER'
    );

    if (entry.kind === 0n) {
      const key = `${entry.actor}:${entry.payloadHash}`;
      assert(!hashes.has(key), 'DUPLICATE_REQUEST_HASH');
      hashes.add(key);
      requests.add(entry.index);
    } else {
      assert(
        requests.has(entry.requestIndex) && !decisions.has(entry.requestIndex),
        'INVALID_DECISION_LINK'
      );
      decisions.add(entry.requestIndex);
    }
  }

  const tree = buildTree(entries, info);
  assert.equal(tree.root, info.checkpoint.root, 'LOG_ROOT_MISMATCH');
  return { checkpointInfo: info, entries, tree };
}

function verifyEntryInclusion(item, info, context) {
  assert(
    item && Array.isArray(item.proof) && item.proof.length === info.depth,
    'INVALID_PROOF_LENGTH'
  );

  const entry = checkEntry(item.entry, info, context);

  let current = leafHash(entry, info);
  for (const sibling of item.proof) current = parent(current, bytes32(sibling));
  assert.equal(current, info.checkpoint.root, 'INVALID_INCLUSION_PROOF');
  return entry;
}

export function verifyInclusions(items, checkpointId, verificationContext) {
  const info = checkpointInfo(verificationContext);
  assert.equal(uint(checkpointId), info.checkpointId, 'CHECKPOINT_MISMATCH');
  assert(Array.isArray(items), 'INVALID_EVIDENCE');
  return { checkpointInfo: info, entries: items.map(item => verifyEntryInclusion(item, info, verificationContext)) };
}

function providerOf(evidenceLog) {
  return evidenceLog.runner?.provider ?? evidenceLog.runner;
}

function events(evidenceLog, receipt, address, name) {
  const topic = evidenceLog.interface.getEvent(name).topicHash;
  address = getAddress(address);
  return receipt.logs
    .filter(log => log.address === address && log.topics[0] === topic)
    .map(log => evidenceLog.interface.parseLog(log).args.toObject());
}

export async function readRecord(evidenceLog, txHash, context) {
  txHash = bytes32(txHash);

  const provider = providerOf(evidenceLog);
  const receipt = await provider.getTransactionReceipt(txHash);
  if (receipt?.status === 0)
    throw Object.assign(new Error('REGISTRATION_NOT_CONFIRMED'), { receipt });

  assert(receipt?.status === 1, 'REGISTRATION_NOT_CONFIRMED');
  assert.equal(receipt.hash.toLowerCase(), txHash, 'TRANSACTION_MISMATCH');

  const blockNumber = BigInt(receipt.blockNumber);
  const blockHash = receipt.blockHash.toLowerCase();
  const block = await provider.getBlock(receipt.blockNumber);
  assert(block && block.hash.toLowerCase() === blockHash, 'BLOCK_MISMATCH');

  const checkpoints = events(evidenceLog, receipt, context.evidenceLogAddress, 'CheckpointPublished');
  const entries = events(evidenceLog, receipt, context.evidenceLogAddress, 'EntryRecorded');
  assert(checkpoints.length === 1 && entries.length <= 1, 'INVALID_RECEIPT');

  const checkpointId = checkpoints[0].checkpointId;
  const checkpoint = checkpointOf(checkpoints[0]);
  const entry = entries.length ? entryOf(entries[0]) : null;

  return { txHash, entry, checkpointId, checkpoint, blockNumber, blockHash };
}

async function sendAndReadRecord(evidenceLog, context, method, args) {
  const actor = context.institutionAddress;
  if (method !== 'createCheckpoint') {
    assert.equal(
      getAddress(await evidenceLog.runner.getAddress()),
      getAddress(actor),
      'SIGNER_MISMATCH'
    );
  }

  let tx;

  try {
    tx = await evidenceLog[method](...args);
    await tx.wait();

    const record = await readRecord(evidenceLog, tx.hash, context);
    if (method === 'createCheckpoint') {
      assert.equal(record.entry, null, 'UNEXPECTED_ENTRY');
    } else {
      const entry = record.entry;
      const kind = method === 'registerRequest' ? 0n : 1n;
      assert(
        entry && entry.kind === kind && entry.payloadHash === args.at(-1),
        'REGISTRATION_MISMATCH'
      );
      assert.equal(entry.actor, getAddress(actor), 'ACTOR_MISMATCH');
      if (kind === 1n) {
        assert.equal(entry.requestIndex, args[0], 'REQUEST_LINK_MISMATCH');
      }
    }

    return record;
  } catch (error) {
    error.txHash = tx?.hash ?? error.info?.sendTransactionHash;
    error.registrationStatus = 'UNKNOWN';

    if (
      !error.txHash
      && (
        (error.code === 'CALL_EXCEPTION' && error.action === 'estimateGas')
        || ['INSUFFICIENT_FUNDS', 'ACTION_REJECTED'].includes(error.code)
      )
    ) {
      error.registrationStatus = 'NOT_SENT';
    }

    const receipt = error.receipt;
    if (
      error.txHash
      && receipt?.status === 0
      && receipt.hash?.toLowerCase() === error.txHash.toLowerCase()
    ) {
      try {
        const block = await providerOf(evidenceLog).getBlock(receipt.blockNumber);
        if (block && block.hash.toLowerCase() === receipt.blockHash.toLowerCase())
          error.registrationStatus = 'FAILED';
      } catch {

      }
    }

    throw error;
  }
}

export async function createEvmLogClient({ evidenceLog, institutionSigner, deploymentBlock }) {
  const [network, address, depthValue, institution, signerAddress] = await Promise.all([
    providerOf(evidenceLog).getNetwork(),
    evidenceLog.getAddress(),
    evidenceLog.depth(),
    evidenceLog.institution(),
    institutionSigner.getAddress(),
  ]);
  const depth = Number(depthValue);
  assert.equal(depth, 6, 'INVALID_DEPTH');

  const context = Object.freeze({
    chainId: network.chainId,
    evidenceLogAddress: getAddress(address),
    depth,
    deploymentBlock: BigInt(deploymentBlock),
    institutionAddress: getAddress(institution),
  });
  assert.equal(getAddress(signerAddress), context.institutionAddress, 'SIGNER_MISMATCH');

  const institutionLog = evidenceLog.connect(institutionSigner);
  assert.equal(
    getAddress(await institutionLog.getAddress()),
    context.evidenceLogAddress,
    'CONTRACT_MISMATCH'
  );
  assert.equal(
    (await providerOf(institutionLog).getNetwork()).chainId,
    uint(context.chainId),
    'CHAIN_MISMATCH'
  );

  return {
    context,

    registerRequest(bytes) {
      return sendAndReadRecord(institutionLog, context, 'registerRequest', [payloadHash(bytes)]);
    },

    registerDecision(requestIndex, bytes) {
      return sendAndReadRecord(institutionLog, context, 'registerDecision', [uint(requestIndex), payloadHash(bytes)]);
    },

    readRecord(txHash) {
      return readRecord(evidenceLog, txHash, context);
    },

    readCheckpoint(checkpointId) {
      return readCheckpoint(evidenceLog, checkpointId);
    },

    createCheckpoint() {
      return sendAndReadRecord(institutionLog, context, 'createCheckpoint', []);
    },

    close() { },
  };
}

export async function evidenceLogArtifact() {
  return JSON.parse(
    await readFile(
      new URL('../contracts/out/EvidenceLog.sol/EvidenceLog.json', import.meta.url),
      'utf8'
    )
  );
}

export async function checkEvmContext(evidenceLog, context) {
  const expected = Object.freeze({
    chainId: uint(context?.chainId),
    evidenceLogAddress: getAddress(context?.evidenceLogAddress),
    depth: safeNumber(context?.depth),
    deploymentBlock: uint(context?.deploymentBlock),
    institutionAddress: getAddress(context?.institutionAddress),
  });
  assert.equal(expected.depth, 6, 'INVALID_DEPTH');

  const [network, address, depth, institution] = await Promise.all([
    providerOf(evidenceLog).getNetwork(),
    evidenceLog.getAddress(),
    evidenceLog.depth(),
    evidenceLog.institution(),
  ]);
  assert.equal(network.chainId, expected.chainId, 'CHAIN_MISMATCH');
  assert.equal(getAddress(address), expected.evidenceLogAddress, 'CONTRACT_MISMATCH');
  assert.equal(safeNumber(depth), expected.depth, 'INVALID_DEPTH');
  assert.equal(getAddress(institution), expected.institutionAddress, 'INSTITUTION_MISMATCH');
  return expected;
}

export async function readCheckpoint(evidenceLog, checkpointId) {
  if (checkpointId === undefined) {
    const count = uint(await evidenceLog.checkpointCount());
    assert(count > 0n, 'CHECKPOINT_NOT_FOUND');
    checkpointId = count - 1n;
  }
  checkpointId = uint(checkpointId);
  const checkpoint = checkpointOf(await evidenceLog.getCheckpoint(checkpointId));
  return { checkpointId, checkpoint };
}

export async function deployEvmWitness({ rpcUrl, depth = 6 } = {}) {
  assert(typeof rpcUrl === 'string' && rpcUrl.trim().length > 0, 'RPC_URL_REQUIRED');
  depth = safeNumber(depth);
  assert.equal(depth, 6, 'INVALID_DEPTH');

  const artifact = await evidenceLogArtifact();
  const provider = new JsonRpcProvider(rpcUrl);

  try {
    const [customerSigner, institutionSigner] = await Promise.all([
      provider.getSigner(0),
      provider.getSigner(1)
    ]);
    const evidenceLog = await new ContractFactory(artifact.abi, artifact.bytecode.object, customerSigner)
      .deploy(await institutionSigner.getAddress(), depth);

    const receipt = await evidenceLog.deploymentTransaction().wait();
    assert(receipt?.status === 1, 'DEPLOYMENT_NOT_CONFIRMED');

    const logClient = await createEvmLogClient({
      evidenceLog,
      institutionSigner,
      deploymentBlock: receipt.blockNumber
    });

    return {
      ...logClient,
      close() {
        provider.destroy();
      }
    };
  } catch (error) {
    provider.destroy();
    throw error;
  }
}
