import { describe, expect, it } from 'vitest';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { signInErrorText } from './sign-in-error';

describe('the sign-in error text', () => {
  it("is the server's own message when the server answered", () => {
    expect(
      signInErrorText(
        new DomainError(
          TradingErrorCode.RATE_LIMITED,
          'Too many attempts, try again in 15 minutes',
        ),
      ),
    ).toBe('Too many attempts, try again in 15 minutes');
  });

  it('recognises a DomainError by name, as a second bundled copy would be', () => {
    const lookalike = Object.assign(new Error('Invalid email or password'), {
      name: 'DomainError',
      code: 'AUTH_FAILED',
    });
    expect(signInErrorText(lookalike)).toBe('Invalid email or password');
  });

  it('names what actually went wrong otherwise, so a screenshot can tell causes apart', () => {
    expect(signInErrorText(new TypeError("Cannot read property 'randomUUID' of undefined"))).toBe(
      "Could not reach the server. Try again. (Cannot read property 'randomUUID' of undefined)",
    );
    expect(signInErrorText('nothing useful')).toBe('Could not reach the server. Try again.');
    expect(signInErrorText(new Error('x'.repeat(500)))).toHaveLength(
      'Could not reach the server. Try again. ()'.length + 160,
    );
  });
});
