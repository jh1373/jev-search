import type { Judgement } from './jev.ts';

const encoder = new TextEncoder();

/**
 * Cache key for one judgement.
 *
 * The request body already contains the query and the clipped text of every candidate, so an edited
 * note, a changed exclusion, a different candidate set or a different route all produce a different
 * key on their own. The key material is hashed so the API key is never held in the map.
 * Fully compatible with Web Crypto API across Desktop and Mobile (iOS / Android).
 */
export async function judgementKey(body: string, target: string, key: string): Promise<string> {
  const data = encoder.encode(`${target}\u0000${key}\u0000${body}`);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Memory-only LRU of judgements. Nothing here is written to disk, and it is cleared when the plugin
 * unloads.
 *
 * A hit only avoids paying twice for an identical request. It is not an exactly-once guarantee: a
 * failed, partial or post-deadline response is never stored, and two requests that start together
 * both go out.
 */
export class JudgementCache {
  private entries = new Map<string, { value: Judgement; expires: number }>();
  private ttlMinutes: number;
  private maxEntries: number;
  /** ttlMinutes 0 disables the cache entirely. */
  constructor(ttlMinutes = 30, maxEntries = 200) {
    this.ttlMinutes = ttlMinutes;
    this.maxEntries = maxEntries;
  }
  get enabled(): boolean { return this.ttlMinutes > 0; }
  get size(): number { return this.entries.size; }
  get(body: string, now = Date.now()): Judgement | null {
    if (!this.enabled) return null;
    const hit = this.entries.get(body);
    if (!hit) return null;
    if (hit.expires <= now) { this.entries.delete(body); return null; }
    // Re-inserting moves the entry to the end, which is how a Map tracks recency.
    this.entries.delete(body);
    this.entries.set(body, hit);
    return hit.value;
  }
  set(body: string, value: Judgement, now = Date.now()): void {
    if (!this.enabled) return;
    this.entries.delete(body);
    this.entries.set(body, { value, expires: now + this.ttlMinutes * 60000 });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
  clear(): void { this.entries.clear(); }
}
