import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LoggingEmailAdapter, NoopEmailAdapter } from './logging-email.adapter';
import { EmailModule } from './email.module';

/**
 * `EMAIL_FROM` was in the schema, in `.env.example`, and read by nothing.
 *
 * Smaller than the Argon2 pair beside it and the same shape: a setting an
 * operator can change with no effect and no error. It is on the port now rather
 * than on each message, because it is a property of the deployment — and
 * because the real provider somebody writes one day should not be able to
 * forget to ask for it.
 */
describe('the sending address', () => {
  it('is carried by the port, so an adapter cannot be built without one', () => {
    expect(new LoggingEmailAdapter('ops@firm.example').from).toBe('ops@firm.example');
    expect(new NoopEmailAdapter('ops@firm.example').from).toBe('ops@firm.example');
  });

  /**
   * Checked at the wiring rather than by booting Nest: the defect was that the
   * configured value never reached an adapter, and that is a fact about this
   * factory.
   */
  it('comes from EMAIL_FROM, not from a constant', () => {
    const source = readFileSync(join(__dirname, 'email.module.ts'), 'utf8');
    expect(source).toContain("config.get('EMAIL_FROM'");
    expect(source).toMatch(/new LoggingEmailAdapter\(from\)/);
    expect(source).toMatch(/new NoopEmailAdapter\(from\)/);
    expect(EmailModule).toBeDefined();
  });
});
