/**
 * The worker's heartbeat: how a process that serves no HTTP says it is alive,
 * and which build it is.
 *
 * `/health` on the API answers "which build?" for the HTTP instances, and the
 * real-time service answers on its handshake. The worker could answer nowhere.
 * `/health/jobs` sees its *schedules* — rows written when a job runs — and a
 * schedule that runs daily keeps yesterday's worker's row for a day, so the
 * rows cannot say what is running now. On 21 September a container two days
 * older than its neighbours went unnoticed through three upgrades; the worker
 * is the one remaining container that could do the same with nothing to show
 * it.
 *
 * So each worker process writes one key to Redis on boot and every
 * `WORKER_HEARTBEAT_INTERVAL_MS`, with a TTL of `WORKER_HEARTBEAT_TTL_SECONDS`,
 * and deletes it on a clean shutdown. A key that exists is a process that was
 * alive within the TTL; a key that has gone is one that stopped — cleanly (the
 * delete) or otherwise (the expiry). The API reads them all under the prefix.
 *
 * Redis, deliberately, unlike the schedule log: that is *evidence* of what ran
 * and belongs in the database. This is *presence*, and presence that survives
 * the process it describes is the failure mode — a durable "I am alive" from a
 * process that is not. A Redis flush costs at most one interval of "no worker
 * seen", and the next beat repairs it.
 *
 * This file is the contract both sides depend on. The worker writes exactly
 * this shape; the API parses exactly this shape and treats anything else as
 * not a heartbeat rather than as a half-read one.
 */
export const WORKER_HEARTBEAT_PREFIX = 'tp:worker:heartbeat:';

/** How often a worker writes its heartbeat. */
export const WORKER_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * How long a heartbeat is believed. Three intervals: one missed beat is a
 * stalled event loop or a slow Redis, three is a process that is not there.
 */
export const WORKER_HEARTBEAT_TTL_SECONDS = 90;

export interface WorkerHeartbeat {
  /** Host name and pid, so two processes on one host are two entries. */
  readonly instance: string;
  /** `buildMarker()` of the worker — the same digest `/health` publishes for the API. */
  readonly build: string;
  /** `WORKER_ROLE`: all, scheduler or processor. */
  readonly role: string;
  /** The queues this process attaches a processor to. Empty for a scheduler. */
  readonly queues: readonly string[];
  /** When the process started, ISO 8601. */
  readonly startedAt: string;
  /** When this beat was written, ISO 8601. */
  readonly at: string;
}

export function workerHeartbeatKey(instance: string): string {
  return `${WORKER_HEARTBEAT_PREFIX}${instance}`;
}

const isString = (value: unknown): value is string => typeof value === 'string' && value !== '';
const isIso = (value: unknown): value is string =>
  isString(value) && !Number.isNaN(Date.parse(value));

/**
 * A heartbeat, or `null` for anything that is not one.
 *
 * Strict on purpose. A key under the prefix written by an older or newer
 * worker with a different shape is reported as absent rather than as a worker
 * with an `undefined` build, because "no heartbeat" is a state the reader
 * already handles and "a heartbeat with holes in it" is one it would have to
 * invent handling for at three in the morning.
 */
export function parseWorkerHeartbeat(raw: unknown): WorkerHeartbeat | null {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!isString(record['instance']) || !isString(record['build']) || !isString(record['role'])) {
    return null;
  }
  if (!Array.isArray(record['queues']) || !record['queues'].every(isString)) return null;
  if (!isIso(record['startedAt']) || !isIso(record['at'])) return null;
  return {
    instance: record['instance'],
    build: record['build'],
    role: record['role'],
    queues: [...(record['queues'] as string[])],
    startedAt: record['startedAt'],
    at: record['at'],
  };
}
