import { check } from './crypto.js';

/**
 * Encodes a number or BigInt into Ethereum hex quantity format (0x...).
 *
 * @param {bigint|number|string} value
 * @returns {string} Hex string prefixed with '0x'
 */
export const quantity = value => '0x' + BigInt(value).toString(16);

/**
 * Creates a lightweight JSON-RPC 2.0 client function.
 *
 * @param {string} url - RPC endpoint URL.
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl=fetch] - Custom fetch implementation.
 * @param {number} [options.timeoutMs=10000] - Timeout in milliseconds.
 * @returns {(method: string, params: Array<unknown>) => Promise<unknown>}
 */
export function jsonRpc(url, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  let requestCounter = 0;

  return async (method, params) => {
    const requestId = ++requestCounter;
    let response;

    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: requestId,
          method,
          params
        }),
        signal: AbortSignal.timeout(timeoutMs)
      });

      check(response.ok, 'RPC_UNAVAILABLE');
      const body = await response.json();

      const isValidRpcResponse =
        body.id === requestId &&
        body.jsonrpc === '2.0' &&
        !body.error &&
        Object.hasOwn(body, 'result');

      check(isValidRpcResponse, 'RPC_UNAVAILABLE');
      return body.result;
    } catch {
      throw new Error('RPC_UNAVAILABLE');
    }
  };
}
