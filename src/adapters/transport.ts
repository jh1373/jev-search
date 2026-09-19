import type { RequestUrlParam, RequestUrlResponse } from 'obsidian';
import { requestFor, type Transport, type TransportResponse, type Endpoint } from '../core/jev.ts';

export type Requester = (params: RequestUrlParam) => Promise<RequestUrlResponse>;

/**
 * Creates an Obsidian-compatible Transport backed by requestUrl.
 * Fully compliant with Obsidian Plugin Guidelines and works seamlessly
 * across Desktop (Electron) and Mobile (iOS / Android).
 */
export function createRequestUrlTransport(
  requester?: Requester
): Transport {
  return async (body: string, key: string, signal: AbortSignal, endpoint?: Endpoint): Promise<TransportResponse> => {
    const fn = requester ?? (globalThis as unknown as { requestUrl?: Requester }).requestUrl;
    if (typeof fn !== 'function') {
      throw new Error('requestUrl is not available in current environment');
    }
    const target = endpoint ?? requestFor('direct');
    if (signal.aborted) throw new Error('cancelled');

    const headers: Record<string, string> = {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...target.headers,
    };

    const requestPromise = fn({
      url: target.url,
      method: 'POST',
      headers,
      body,
      throw: false,
    });

    const abortPromise = new Promise<never>((_, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(new Error('cancelled'));
      };
      if (signal.aborted) {
        reject(new Error('cancelled'));
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });

    const res = await Promise.race([requestPromise, abortPromise]);

    // Enforce 1MiB payload ceiling
    const responseText = res.text ?? '';
    if (responseText.length > 1048576 || (res.arrayBuffer && res.arrayBuffer.byteLength > 1048576)) {
      throw new Error('response-too-large');
    }

    // Extract retry-after header (case-insensitive)
    let retryAfter: string | undefined;
    if (res.headers) {
      for (const [k, v] of Object.entries(res.headers)) {
        if (k.toLowerCase() === 'retry-after') {
          retryAfter = String(v);
          break;
        }
      }
    }

    return {
      status: res.status,
      retryAfter,
      body: responseText,
    };
  };
}
