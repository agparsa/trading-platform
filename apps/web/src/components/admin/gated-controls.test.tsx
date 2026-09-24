// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Button } from '../primitives';
import { ReasonedAction } from './shared';

/**
 * A control given a gate its viewer does not hold is disabled, and says which
 * capability it needs; given one they hold, it behaves as before. What the
 * gates are, and that every admin control gets one, is `ui-gates.test.ts`;
 * this is the half that test cannot see — that a gate reaches the button.
 */
afterEach(cleanup);

describe('a gated button', () => {
  it('is disabled and names the capability when it is not held', () => {
    const onClick = vi.fn();
    render(
      <Button gate={{ allowed: false, requires: 'users.manage' }} onClick={onClick}>
        Suspend
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Suspend' });
    expect(button).toHaveProperty('disabled', true);
    expect(button.getAttribute('title')).toBe('Your role does not carry users.manage');
    expect(button.getAttribute('data-requires')).toBe('users.manage');
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('is an ordinary button when it is held', () => {
    const onClick = vi.fn();
    render(
      <Button
        gate={{ allowed: true, requires: 'users.manage' }}
        title="Suspend them"
        onClick={onClick}
      >
        Suspend
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Suspend' });
    expect(button).toHaveProperty('disabled', false);
    expect(button.getAttribute('title')).toBe('Suspend them');
    expect(button.getAttribute('data-requires')).toBeNull();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('stays disabled for its own reasons even when the capability is held', () => {
    render(
      <Button gate={{ allowed: true, requires: 'users.manage' }} disabled>
        Suspend
      </Button>,
    );
    expect(screen.getByRole('button', { name: 'Suspend' })).toHaveProperty('disabled', true);
  });
});

describe('a gated reasoned action', () => {
  it('cannot be opened without the capability', () => {
    render(
      <ReasonedAction
        label="Halt new risk"
        title="Why"
        gate={{ allowed: false, requires: 'system.kill_switch' }}
        onConfirm={vi.fn()}
      />,
    );
    const button = screen.getByRole('button', { name: 'Halt new risk' });
    expect(button).toHaveProperty('disabled', true);
    fireEvent.click(button);
    expect(screen.queryByPlaceholderText('Why')).toBeNull();
  });

  it('opens with it', () => {
    render(
      <ReasonedAction
        label="Halt new risk"
        title="Why"
        gate={{ allowed: true, requires: 'system.kill_switch' }}
        onConfirm={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Halt new risk' }));
    expect(screen.getByPlaceholderText('Why')).toBeTruthy();
  });
});
