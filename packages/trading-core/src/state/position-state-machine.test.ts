import { describe, expect, it } from 'vitest';
import { DomainError, PositionStatus } from '@tp/shared-types';
import {
  canTransitionPosition,
  isPositionTradeable,
  transitionPosition,
} from './position-state-machine';

describe('position state machine', () => {
  it('closes through the CLOSING guard', () => {
    let status: PositionStatus = PositionStatus.OPEN;
    status = transitionPosition(status, PositionStatus.CLOSING);
    status = transitionPosition(status, PositionStatus.CLOSED);
    expect(status).toBe(PositionStatus.CLOSED);
  });

  it('reopens when a close attempt fails', () => {
    expect(canTransitionPosition(PositionStatus.CLOSING, PositionStatus.OPEN)).toBe(true);
  });

  it('refuses to close an already-closed position twice', () => {
    expect(() => transitionPosition(PositionStatus.CLOSED, PositionStatus.CLOSING)).toThrow(
      DomainError,
    );
    expect(() => transitionPosition(PositionStatus.CLOSED, PositionStatus.CLOSED)).toThrow(
      DomainError,
    );
  });

  it('blocks new trading activity once a close is in flight', () => {
    expect(isPositionTradeable(PositionStatus.OPEN)).toBe(true);
    expect(isPositionTradeable(PositionStatus.CLOSING)).toBe(false);
    expect(isPositionTradeable(PositionStatus.CLOSED)).toBe(false);
  });
});
