import { describe, expect, it } from 'vitest';
import { ALL_QUEUES, QueueName } from './queues';
import { WorkerRole, workerAssignment } from './roles';

describe('workerAssignment', () => {
  it('does everything by default', () => {
    const assignment = workerAssignment(WorkerRole.ALL);
    expect(assignment.schedules).toBe(true);
    expect(assignment.processes).toEqual(ALL_QUEUES);
  });

  it('lets a scheduler schedule and process nothing', () => {
    expect(workerAssignment(WorkerRole.SCHEDULER)).toEqual({ schedules: true, processes: [] });
  });

  it('lets a processor process without writing schedules', () => {
    const assignment = workerAssignment(WorkerRole.PROCESSOR);
    expect(assignment.schedules).toBe(false);
    expect(assignment.processes).toEqual(ALL_QUEUES);
  });

  it('narrows a processor to the queues named, once each, whitespace forgiven', () => {
    const assignment = workerAssignment(
      WorkerRole.PROCESSOR,
      ' webhook-delivery, notifications ,webhook-delivery',
    );
    expect(assignment.processes).toEqual([QueueName.WEBHOOK_DELIVERY, QueueName.NOTIFICATIONS]);
  });

  it('refuses a queue nobody declared, naming it and the known ones', () => {
    expect(() => workerAssignment(WorkerRole.PROCESSOR, 'webhook-delivery,webhooks')).toThrow(
      /nobody declared: webhooks\. Known: swap-accrual/,
    );
  });

  it('refuses to narrow a scheduler, because it processes nothing to narrow', () => {
    expect(() => workerAssignment(WorkerRole.SCHEDULER, 'notifications')).toThrow(
      /scheduler processes nothing/,
    );
  });

  it('treats an empty list as everything rather than nothing', () => {
    expect(workerAssignment(WorkerRole.ALL, ' , ').processes).toEqual(ALL_QUEUES);
  });
});
