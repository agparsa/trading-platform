import { describe, expect, it } from 'vitest';
import { cn } from './cn';

describe('cn', () => {
  it('keeps a type-scale size beside a colour', () => {
    expect(cn('px-2 text-caption', 'text-terminal-muted')).toBe(
      'px-2 text-caption text-terminal-muted',
    );
    expect(cn('text-label', 'text-terminal-text')).toBe('text-label text-terminal-text');
  });

  it('still lets a later size win over an earlier one', () => {
    expect(cn('text-caption', 'text-xs')).toBe('text-xs');
    expect(cn('text-xs', 'text-micro')).toBe('text-micro');
  });

  it('still lets a later colour win over an earlier one', () => {
    expect(cn('text-terminal-muted', 'text-terminal-text')).toBe('text-terminal-text');
  });
});
