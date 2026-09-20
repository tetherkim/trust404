import canonicalize from 'canonicalize';
import { createHash, sign as cryptoSign, verify as cryptoVerify, createPublicKey } from 'node:crypto';

/**
 * Asserts a condition; throws an Error with the specified code if falsy.
 *
 * @param {boolean} condition - The condition that must be true.
 * @param {string} code - The error message/code if condition is false.
 */
export function check(condition, code) {
  if (!condition) {
    throw new Error(code);
  }
}

/**
 * Validates that an object contains strictly the expected fields,
 * with no extra or missing keys, and is a plain object prototype.
 *
 * @param {object} value - The object to validate.
 * @param {string[]} expected - Array of expected property names.
 */
export function fields(value, expected) {
  const isPlainObject = value && Object.getPrototypeOf(value) === Object.prototype;
  const hasExactKeys = isPlainObject &&
    Object.keys(value).length === expected.length &&
    expected.every(key => Object.hasOwn(value, key));

  check(hasExactKeys, 'INVALID_SCHEMA');
}

/**
 * Serializes a value into a canonical JSON string (RFC 8785 / JCS rules).
 * Enforces strict Unicode (NFC / well-formed without lone surrogates),
 * finite numbers, and plain objects.
 *
 * @param {unknown} value - The value to canonicalize.
 * @returns {string} The canonical JSON string.
 */
export function canonical(value) {
  function validate(v) {
    if (typeof v === 'string') {
      check(v.isWellFormed(), 'INVALID_UNICODE');
      return;
    }
    if (v === null || typeof v === 'boolean') {
      return;
    }
    if (typeof v === 'number') {
      check(Number.isFinite(v), 'INVALID_NUMBER');
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) {
        validate(item);
      }
      return;
    }
    check(v && Object.getPrototypeOf(v) === Object.prototype, 'INVALID_JSON');
    for (const [key, item] of Object.entries(v)) {
      validate(key);
      validate(item);
    }
  }

  validate(value);
  return canonicalize(value);
}

/**
 * Parses JSON text and verifies that the text is strictly identical to its canonical form.
 * Prevents non-canonical whitespace, duplicate keys, or irregular encodings on the wire.
 *
 * @param {string} text - Canonical JSON wire representation.
 * @returns {unknown} The parsed JSON object.
 */
export function parseWire(text) {
  const value = JSON.parse(text);
  check(canonical(value) === text, 'NON_CANONICAL_WIRE');
  return value;
}

/**
 * Computes SHA-256 digest of input bytes with '0x' prefix.
 *
 * @param {Buffer|Uint8Array} bytes - Binary data to hash.
 * @returns {string} 0x-prefixed 64-character hex string.
 */
export const sha = bytes => '0x' + createHash('sha256').update(bytes).digest('hex');

/**
 * Computes a domain-separated SHA-256 hash of a payload.
 *
 * @param {string} domain - Domain separator (e.g., 'request-v3', 'policy-v3').
 * @param {unknown} payload - Structured payload.
 * @returns {string} 0x-prefixed 64-character hex hash.
 */
export const hash = (domain, payload) => sha(Buffer.from(canonical({ domain, payload })));

/**
 * Checks if a value is a valid 32-byte 0x-prefixed hex string.
 *
 * @param {unknown} v - Value to check.
 * @returns {boolean} True if matching 0x[0-9a-f]{64}.
 */
export const hashShape = v => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v);

/**
 * Checks if a value is a valid 20-byte 0x-prefixed hex address string.
 *
 * @param {unknown} v - Value to check.
 * @returns {boolean} True if matching 0x[0-9a-f]{40}.
 */
export const addressShape = v => typeof v === 'string' && /^0x[0-9a-f]{40}$/.test(v);

/**
 * Parses and validates an unsigned 256-bit integer represented as a string.
 *
 * @param {string} value - String representation of an integer.
 * @param {boolean} [positive=false] - Whether the integer must be strictly > 0.
 * @returns {bigint} Parsed BigInt value.
 */
export function integer(value, positive = false) {
  check(
    typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 78,
    'INVALID_INTEGER'
  );
  const n = BigInt(value);
  const maxUint256 = (1n << 256n) - 1n;
  check(n <= maxUint256 && (!positive || n > 0n), 'INVALID_INTEGER');
  return n;
}

/**
 * Signs a domain-separated payload using Ed25519.
 *
 * @param {string} domain - Domain separator.
 * @param {string} keyId - Identifier of the signing key.
 * @param {unknown} payload - Payload to sign.
 * @param {KeyObject|string} privateKey - Ed25519 private key.
 * @returns {object} Signature envelope { domain, keyId, payload, signature }.
 */
export function sign(domain, keyId, payload, privateKey) {
  const dataToSign = Buffer.from(canonical({ domain, keyId, payload }));
  const signatureBase64 = cryptoSign(null, dataToSign, privateKey).toString('base64');
  return {
    domain,
    keyId,
    payload,
    signature: signatureBase64
  };
}

/**
 * Verifies an Ed25519 signature envelope against known public keys.
 *
 * @param {object} envelope - Signature envelope { domain, keyId, payload, signature }.
 * @param {string} domain - Expected domain separator.
 * @param {Record<string, string|KeyObject>} keys - Map of keyId to public key.
 * @returns {unknown} The verified payload.
 */
export function verifySignature(envelope, domain, keys) {
  fields(envelope, ['domain', 'keyId', 'payload', 'signature']);
  check(envelope.domain === domain && Object.hasOwn(keys, envelope.keyId), 'UNKNOWN_SIGNER');
  check(typeof envelope.signature === 'string', 'INVALID_SIGNATURE');

  const sig = Buffer.from(envelope.signature, 'base64');
  const publicKey = createPublicKey(keys[envelope.keyId]);

  check(
    publicKey.asymmetricKeyType === 'ed25519' &&
    sig.length === 64 &&
    sig.toString('base64') === envelope.signature,
    'INVALID_SIGNATURE'
  );

  const signedContent = Buffer.from(canonical({
    domain,
    keyId: envelope.keyId,
    payload: envelope.payload
  }));

  const isValid = cryptoVerify(null, signedContent, publicKey, sig);
  check(isValid, 'INVALID_SIGNATURE');

  return envelope.payload;
}
