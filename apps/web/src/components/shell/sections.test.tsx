import { describe, expect, it } from 'vitest';
import { TRADER_GROUPS, TRADER_SECTIONS } from './sections';

describe('the trader menu', () => {
  it('puts every section in exactly one group', () => {
    const grouped = TRADER_GROUPS.flatMap((group) => group.items.map((item) => item.href));
    expect([...grouped].sort()).toEqual(TRADER_SECTIONS.map((item) => item.href).sort());
  });
});
