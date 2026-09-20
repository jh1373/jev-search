import {
  MODEL,
  OPENROUTER_MODEL,
  GATEWAY_MODEL,
  PRICE_PER_MTOK,
  type Target,
} from './core/jev';

export const VIEW = 'jev-search-view';
/** Indexing yields to the event loop on this time budget rather than after every note. */
export const YIELD_BUDGET_MS = 8;

export interface Settings {
  folders: string[];
  tags: string[];
  enabled: boolean;
  endpoint: Target;
  secrets: Record<Target, string>;
  cacheTtlMinutes: number;
  confirmTransmission: boolean;
}

export const DEFAULT: Settings = {
  folders: ['Templates', 'Attachments'],
  tags: ['private', 'secret'],
  enabled: false,
  endpoint: 'openrouter',
  secrets: { openrouter: '', direct: '', gateway: '' },
  cacheTtlMinutes: 30,
  confirmTransmission: true,
};

/** Cache TTL in minutes. 0 disables the cache; anything outside 0-60 falls back to the default. */
export const asTtl = (value: unknown): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 60
    ? value
    : DEFAULT.cacheTtlMinutes;

export const asTarget = (value: unknown): Target =>
  value === 'direct' ? 'direct' : value === 'gateway' ? 'gateway' : 'openrouter';

/** SecretStorage ids must be lowercase alphanumeric with optional dashes. Only the name is persisted, never the value. */
export const asSecretId = (value: unknown): string =>
  typeof value === 'string' && /^[a-z0-9-]{0,64}$/.test(value) ? value : '';

export const modelName = (target: Target): string =>
  target === 'direct' ? MODEL : target === 'openrouter' ? OPENROUTER_MODEL : GATEWAY_MODEL;

/** Prefer the actual charged cost when the route reports it; otherwise show a token-based estimate. */
export const costText = (
  r: { inputTokens: number | null; cost: number | null },
  target: Target,
): string =>
  r.cost !== null
    ? `$${r.cost.toFixed(6)} (actual)`
    : r.inputTokens === null
      ? '$unknown'
      : `$${((r.inputTokens * PRICE_PER_MTOK[target]) / 1e6).toFixed(6)} (est.)`;
