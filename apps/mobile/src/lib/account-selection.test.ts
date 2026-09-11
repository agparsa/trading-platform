import { describe, expect, it } from 'vitest';
import { resolveSelection, shouldOfferChoice } from './account-selection';

const accounts = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

describe('resolveSelection', () => {
  it('honours a choice that is still in the list', () => {
    expect(resolveSelection(accounts, 'b')).toEqual({ id: 'b' });
  });

  it('falls back to the first when nothing has been chosen', () => {
    expect(resolveSelection(accounts, null)).toEqual({ id: 'a' });
  });

  /**
   * The case the fallback exists for. An account can be closed, or a master's
   * grant revoked, between one screen and the next; a phone that kept sending
   * the id would answer every tap with a 404 and no explanation.
   */
  it('falls back when the chosen account has gone from the list', () => {
    expect(resolveSelection(accounts, 'gone')).toEqual({ id: 'a' });
    expect(resolveSelection([{ id: 'b' }, { id: 'c' }], 'a')).toEqual({ id: 'b' });
  });

  it('says there is no account rather than inventing one', () => {
    expect(resolveSelection([], 'a')).toBeNull();
    expect(resolveSelection([], null)).toBeNull();
  });
});

describe('shouldOfferChoice', () => {
  it('offers a choice only when there is one to make', () => {
    expect(shouldOfferChoice([])).toBe(false);
    expect(shouldOfferChoice([{ id: 'a' }])).toBe(false);
    expect(shouldOfferChoice(accounts)).toBe(true);
  });
});
