/**
 * What each live price source is doing, for the admin's Market Data screen
 * and for the metrics.
 *
 * Kept by the ingesting instance, which is the only one holding the sockets,
 * and published to Redis (`PROVIDER_STATUS_KEY`) so any instance can answer
 * the admin. No URL and no key is ever recorded — an error is kept as its
 * message, which for these sources is a status code or a transport reason.
 */
export const PROVIDER_STATUS_KEY = 'market:providers';
/** How long a published snapshot is believed; past this the ingester is presumed gone. */
export const PROVIDER_STATUS_TTL_SECONDS = 120;

export type ProviderState = 'connecting' | 'connected' | 'disconnected';

export interface ProviderStatus {
  readonly name: string;
  readonly symbols: readonly string[];
  readonly state: ProviderState;
  /** Epoch ms of the last change of state. */
  readonly since: number;
  /** Epoch ms of the last message of any kind, quotes or heartbeats. */
  readonly lastMessageAt: number | null;
  /** Epoch ms the last tick was received, and its source time. */
  readonly lastTickAt: number | null;
  readonly lastSourceTime: number | null;
  readonly ticks: number;
  readonly reconnects: number;
  readonly lastError: string | null;
}

interface Mutable {
  name: string;
  symbols: string[];
  state: ProviderState;
  since: number;
  lastMessageAt: number | null;
  lastTickAt: number | null;
  lastSourceTime: number | null;
  ticks: number;
  reconnects: number;
  lastError: string | null;
}

export class ProviderStatusBook {
  private readonly rows = new Map<string, Mutable>();

  register(name: string, symbols: readonly string[], now: number): void {
    this.rows.set(name, {
      name,
      symbols: [...symbols].sort(),
      state: 'connecting',
      since: now,
      lastMessageAt: null,
      lastTickAt: null,
      lastSourceTime: null,
      ticks: 0,
      reconnects: 0,
      lastError: null,
    });
  }

  connecting(name: string, now: number): void {
    const row = this.rows.get(name);
    if (row === undefined || row.state === 'connecting') return;
    row.state = 'connecting';
    row.since = now;
    row.reconnects += 1;
  }

  connected(name: string, now: number): void {
    const row = this.rows.get(name);
    if (row === undefined) return;
    row.state = 'connected';
    row.since = now;
  }

  disconnected(name: string, now: number, error?: unknown): void {
    const row = this.rows.get(name);
    if (row === undefined) return;
    row.state = 'disconnected';
    row.since = now;
    if (error !== undefined) row.lastError = describe(error);
  }

  error(name: string, error: unknown): void {
    const row = this.rows.get(name);
    if (row !== undefined) row.lastError = describe(error);
  }

  message(name: string, now: number): void {
    const row = this.rows.get(name);
    if (row !== undefined) row.lastMessageAt = now;
  }

  tick(name: string, sourceTime: number, now: number): void {
    const row = this.rows.get(name);
    if (row === undefined) return;
    row.ticks += 1;
    row.lastTickAt = now;
    row.lastSourceTime = sourceTime;
  }

  snapshot(): ProviderStatus[] {
    return [...this.rows.values()].map((row) => ({ ...row, symbols: [...row.symbols] }));
  }

  clear(): void {
    this.rows.clear();
  }
}

/**
 * An error as a short reason, never a URL: a fetch failure's message can
 * contain the address it was fetching, and a source's address may carry a key.
 */
export function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : 'error';
  return text.replace(/(https?|wss?):\/\/\S+/g, '<url>').slice(0, 200);
}
