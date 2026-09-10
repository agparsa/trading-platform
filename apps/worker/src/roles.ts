import { ALL_QUEUES, QueueName } from './queues';

/**
 * What one worker process does (§77).
 *
 * The worker used to be one shape: every process registered every schedule
 * and processed every queue. That is the right default for a small deployment
 * and the wrong ceiling for a larger one, where the thing that needs more
 * copies — webhook delivery to slow endpoints, say — is not the thing that
 * needs exactly one (the schedules). BullMQ's job scheduler already produces
 * one job per tick however many processes register it, so several schedulers
 * are harmless; but a process that only processes has no business writing
 * schedules at all, and a process that only schedules should hold no queue
 * open for work it will never take.
 *
 * So a worker has a role, and a processor may be narrowed to some queues:
 *
 *   WORKER_ROLE=all                          (default) schedules and processes everything
 *   WORKER_ROLE=scheduler                    registers the schedules, processes nothing
 *   WORKER_ROLE=processor                    processes, registers no schedules
 *   WORKER_ROLE=processor WORKER_QUEUES=webhook-delivery,notifications
 *                                            processes only those
 *
 * A queue name nobody declared is refused at boot rather than silently
 * processed by no one — a typo here would be a queue that fills forever.
 */
export const WorkerRole = {
  ALL: 'all',
  SCHEDULER: 'scheduler',
  PROCESSOR: 'processor',
} as const;
export type WorkerRole = (typeof WorkerRole)[keyof typeof WorkerRole];

export interface WorkerAssignment {
  /** Whether this process registers the repeating schedules. */
  readonly schedules: boolean;
  /** The queues this process attaches a processor to. */
  readonly processes: readonly QueueName[];
}

export function workerAssignment(role: WorkerRole, queues?: string): WorkerAssignment {
  const selected = selectQueues(queues);
  switch (role) {
    case WorkerRole.SCHEDULER:
      if (queues !== undefined) {
        throw new Error(
          'WORKER_QUEUES narrows what a process *processes*; a scheduler processes nothing. Unset one of them.',
        );
      }
      return { schedules: true, processes: [] };
    case WorkerRole.PROCESSOR:
      return { schedules: false, processes: selected };
    case WorkerRole.ALL:
      return { schedules: true, processes: selected };
  }
}

function selectQueues(queues: string | undefined): readonly QueueName[] {
  if (queues === undefined || queues.trim() === '') return ALL_QUEUES;
  const names = queues
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (names.length === 0) return ALL_QUEUES;
  const known = new Set<string>(ALL_QUEUES);
  const unknown = names.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `WORKER_QUEUES names queue(s) nobody declared: ${unknown.join(', ')}. Known: ${ALL_QUEUES.join(', ')}.`,
    );
  }
  return [...new Set(names)] as QueueName[];
}
