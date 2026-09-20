import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, parseWire, check, hash, hashShape, integer } from '../common/crypto.js';
import { buildTree } from '../common/merkle.js';
import { validateRequest, makeDecision, receiptRef } from '../policy/policy.js';
import { anchorCall } from '../chain/reader.js';

/**
 * Manages immutable on-disk storage of public archive files (batches and state blobs).
 */
export class Archive {
  /**
   * @param {string} directory - Directory for public archive exports.
   */
  constructor(directory) {
    this.directory = directory;
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true });
    }
  }

  /**
   * Derives filesystem path for a batch or blob archive item.
   *
   * @param {'batch'|'blob'} kind
   * @param {string|number} id
   * @returns {string} Absolute file path
   */
  path(kind, id) {
    check(
      kind === 'batch' ? /^[1-9][0-9]*$/.test(String(id)) : hashShape(id),
      'INVALID_ARCHIVE_ID'
    );
    return join(this.directory, `${kind}-${id}.json`);
  }

  /**
   * Persists an archive item atomically. If already exists, checks byte equality.
   *
   * @param {'batch'|'blob'} kind
   * @param {string|number} id
   * @param {unknown} value
   */
  put(kind, id, value) {
    const filePath = this.path(kind, id);
    const bytes = canonical(value);

    if (existsSync(filePath)) {
      check(readFileSync(filePath, 'utf8') === bytes, 'ARCHIVE_CONFLICT');
      return;
    }

    const tempPath = `${filePath}.tmp`;
    writeFileSync(tempPath, bytes, { mode: 0o600, flush: true });
    renameSync(tempPath, filePath);
  }

  /**
   * Reads and parses an archived batch.
   *
   * @param {string|number} id
   * @returns {Array<object>}
   */
  batch(id) {
    return parseWire(readFileSync(this.path('batch', id), 'utf8'));
  }

  /**
   * Reads and parses an archived state blob.
   *
   * @param {string} id - 0x-prefixed 32-byte hash
   * @returns {object}
   */
  blob(id) {
    return parseWire(readFileSync(this.path('blob', id), 'utf8'));
  }
}

/**
 * SQLite WAL backed storage for requests, decisions, batches, and blobs.
 * Enforces idempotency, sequential ordering, and batch freezing.
 */
export class EvidenceStore {
  /**
   * @param {string} filename - SQLite file path.
   * @param {Archive} archive - Archive instance.
   * @param {object} trust - Trust configuration.
   */
  constructor(filename, archive, trust) {
    this.trees = new Map();
    this.db = new DatabaseSync(filename);
    this.archive = archive;
    this.trust = structuredClone(trust);

    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS config (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entries (
        seq INTEGER PRIMARY KEY,
        record TEXT NOT NULL,
        unique_key TEXT UNIQUE NOT NULL,
        request_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        batch_id TEXT
      );
      CREATE TABLE IF NOT EXISTS batches (
        id TEXT PRIMARY KEY,
        records TEXT NOT NULL,
        root TEXT NOT NULL,
        count INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS blobs (
        hash TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    const currentConfig = canonical(trust);
    const storedConfig = this.db.prepare('SELECT value FROM config WHERE id=1').get();

    check(!storedConfig || storedConfig.value === currentConfig, 'STORE_CONTEXT_MISMATCH');

    if (!storedConfig) {
      this.db.prepare('INSERT INTO config VALUES (1,?)').run(currentConfig);
    }
  }

  close() {
    this.db.close();
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Submits a request record. Enforces idempotency via unique_key constraint.
   *
   * @param {object} record
   * @returns {{ requestId: string, duplicate: boolean }}
   */
  submit(record) {
    validateRequest(record, this.trust);
    const uniqueKey = `request:${record.requestId}`;
    const bytes = canonical(record);

    const existing = this.db.prepare('SELECT record FROM entries WHERE unique_key=?').get(uniqueKey);
    if (existing) {
      check(existing.record === bytes, 'REQUEST_CONFLICT');
      return { requestId: record.requestId, duplicate: true };
    }

    this.db
      .prepare('INSERT INTO entries(record, unique_key, request_id, kind) VALUES (?,?,?,?)')
      .run(bytes, uniqueKey, record.requestId, 'REQUEST');

    return { requestId: record.requestId, duplicate: false };
  }

  /**
   * Exports an existing batch to public archive files.
   *
   * @param {string|number} id - Batch ID
   * @returns {{ batchId: string, root: string, count: number }}
   */
  exportBatch(id) {
    integer(String(id), true);
    const row = this.db.prepare('SELECT * FROM batches WHERE id=?').get(String(id));
    check(row, 'BATCH_UNAVAILABLE');

    const records = parseWire(row.records);
    for (const record of records) {
      const stateHash = record.decision?.payload.stateHash;
      if (stateHash) {
        const blobRow = this.db.prepare('SELECT value FROM blobs WHERE hash=?').get(stateHash);
        this.archive.put('blob', stateHash, parseWire(blobRow.value));
      }
    }

    this.archive.put('batch', id, records);
    return { batchId: String(id), root: row.root, count: row.count };
  }

  /**
   * Prepares the next pending batch and freezes it into batches table.
   *
   * @param {import('../chain/reader.js').ChainView} chain
   * @returns {Promise<object>} Exported batch details and anchor transaction call.
   */
  async prepare(chain) {
    await chain.assertCanonical();
    const onchainCount = BigInt(await chain.count());
    const nextBatchId = (onchainCount + 1n).toString();

    // Verify existing local batches against on-chain anchors
    const localBatches = this.db.prepare('SELECT id, root, count FROM batches').all();
    for (const local of localBatches) {
      if (BigInt(local.id) > onchainCount) continue;
      const registered = await chain.batch(local.id);
      check(
        registered.root === local.root && registered.count === local.count,
        'ANCHOR_MISMATCH'
      );
    }

    // Freeze new batch if not already prepared
    if (!this.db.prepare('SELECT id FROM batches WHERE id=?').get(nextBatchId)) {
      this.transaction(() => {
        const pendingRows = this.db
          .prepare('SELECT seq, record FROM entries WHERE batch_id IS NULL ORDER BY seq LIMIT 32')
          .all();

        check(pendingRows.length > 0, 'NO_PENDING_RECORDS');

        const records = pendingRows.map(r => parseWire(r.record));
        const tree = buildTree(records);

        this.db
          .prepare('INSERT INTO batches VALUES (?,?,?,?)')
          .run(nextBatchId, canonical(records), tree.root, tree.count);

        const updateBatchId = this.db.prepare('UPDATE entries SET batch_id=? WHERE seq=?');
        for (const row of pendingRows) {
          updateBatchId.run(nextBatchId, row.seq);
        }
      });
    }

    const batch = this.exportBatch(nextBatchId);
    await chain.assertCanonical();
    return { ...batch, transaction: anchorCall(batch, this.trust) };
  }

  /**
   * Retrieves an item with its Merkle inclusion proof.
   *
   * @param {string} requestId
   * @param {'REQUEST'|'DECISION'} kind
   * @returns {{ batchId: string, record: object, count: number, index: number, proof: Array<object> }}
   */
  item(requestId, kind) {
    check(hashShape(requestId), 'INVALID_REQUEST_ID');
    const row = this.db
      .prepare('SELECT * FROM entries WHERE request_id=? AND kind=? ORDER BY seq LIMIT 1')
      .get(requestId, kind);

    check(row?.batch_id, 'RECORD_NOT_BATCHED');

    const batchRow = this.db.prepare('SELECT records, root FROM batches WHERE id=?').get(row.batch_id);
    const records = parseWire(batchRow.records);
    const index = records.findIndex(r => canonical(r) === row.record);

    let tree = this.trees.get(batchRow.root);
    if (!tree) {
      tree = buildTree(records);
      check(tree.root === batchRow.root, 'LOCAL_DATA_CORRUPTION');
      if (this.trees.size >= 128) {
        this.trees.delete(this.trees.keys().next().value);
      }
      this.trees.set(batchRow.root, tree);
    }

    return {
      batchId: row.batch_id,
      record: parseWire(row.record),
      count: tree.count,
      index,
      proof: tree.proof(index)
    };
  }

  /**
   * Makes a decision for a previously batched request and records it in SQLite.
   *
   * @param {string} requestId
   * @param {import('../chain/reader.js').ChainView} chain
   * @param {string} keyId - Institution signing key ID
   * @param {KeyObject|string} privateKey - Institution private key
   * @returns {Promise<object>} Decision record
   */
  async decide(requestId, chain, keyId, privateKey) {
    const requestItem = this.item(requestId, 'REQUEST');
    const onchainBatchMeta = await chain.batch(requestItem.batchId);
    const localBatch = this.exportBatch(requestItem.batchId);

    check(
      onchainBatchMeta.root === localBatch.root && onchainBatchMeta.count === localBatch.count,
      'ANCHOR_MISMATCH'
    );

    const ref = receiptRef(onchainBatchMeta, requestItem.index);
    const uniqueKey = `decision:${requestId}:${hash('receipt-v3', ref)}`;

    const existingDecision = this.db.prepare('SELECT record FROM entries WHERE unique_key=?').get(uniqueKey);
    if (existingDecision) {
      return parseWire(existingDecision.record);
    }

    const { record, snapshot } = await makeDecision(
      requestItem.record,
      ref,
      this.trust,
      chain,
      keyId,
      privateKey
    );

    await chain.assertCanonical();

    this.transaction(() => {
      if (snapshot) {
        this.db
          .prepare('INSERT OR IGNORE INTO blobs VALUES (?,?)')
          .run(record.decision.payload.stateHash, canonical(snapshot));
      }
      this.db
        .prepare('INSERT OR IGNORE INTO entries(record, unique_key, request_id, kind) VALUES (?,?,?,?)')
        .run(canonical(record), uniqueKey, requestId, 'DECISION');
    });

    const recorded = this.db.prepare('SELECT record FROM entries WHERE unique_key=?').get(uniqueKey);
    return parseWire(recorded.record);
  }

  /**
   * Bundles a request, its decision, and associated state snapshot.
   *
   * @param {string} requestId
   * @returns {{ request: object, decision: object, snapshot: object|null }}
   */
  bundle(requestId) {
    const request = this.item(requestId, 'REQUEST');
    const decision = this.item(requestId, 'DECISION');
    const stateHash = decision.record.decision.payload.stateHash;

    let snapshot = null;
    if (stateHash) {
      const blobRow = this.db.prepare('SELECT value FROM blobs WHERE hash=?').get(stateHash);
      snapshot = blobRow ? parseWire(blobRow.value) : null;
    }

    return { request, decision, snapshot };
  }
}
