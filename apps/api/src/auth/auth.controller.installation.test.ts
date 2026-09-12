import { describe, expect, it } from 'vitest';
import { AuthController } from './auth.controller';

/**
 * The wiring from the request body to the session, checked at the controller.
 *
 * A mutation that made the controller pass `installationId: null` instead of
 * the body's value survived every other test in the repository — the service
 * tests call `auth.login` directly and never go through the controller, so the
 * one line that reads the request was covered by nothing.
 *
 * What that line being wrong would cost: the mobile app sends its installation
 * id, the API drops it, every phone session belongs to no device, and revoking
 * a lost handset leaves it signed in. Nothing about the failure is visible
 * until somebody loses a phone — which is the worst possible time to discover
 * that a security control was quietly inert.
 */
function controller(): {
  readonly controller: AuthController;
  readonly seen: { installationId?: string | null }[];
} {
  const seen: { installationId?: string | null }[] = [];
  const auth = {
    login: async (_email: string, _password: string, context: { installationId?: string | null }) => {
      seen.push(context);
      return { kind: 'authenticated' as const, pair: pair() };
    },
    completeTwoFactor: async (
      _challenge: string,
      _code: string,
      context: { installationId?: string | null },
    ) => {
      seen.push(context);
      return pair();
    },
  };
  /**
   * (auth, totp, sessions, config) — only the first is exercised. The config
   * answers what `cookieOptions()` reads on the way out, because the response
   * cookie is set before the handler returns.
   */
  const settings: Record<string, string> = {
    API_GLOBAL_PREFIX: 'api',
    NODE_ENV: 'test',
    JWT_REFRESH_TTL: '30d',
  };
  const config = { get: (key: string) => settings[key] };
  return {
    controller: new AuthController(auth as never, {} as never, {} as never, config as never),
    seen,
  };
}

function pair() {
  return { accessToken: 'access', refreshToken: 'refresh', expiresIn: 900 };
}

const request = {
  requestId: 'req-1',
  header: () => undefined,
  get: () => undefined,
  headers: {},
  socket: {},
} as never;

const response = {
  append: () => undefined,
  cookie: () => undefined,
  clearCookie: () => undefined,
  setHeader: () => undefined,
} as never;

describe('sign-in carries the installation to the session', () => {
  it('forwards what the mobile app sent', async () => {
    const { controller: subject, seen } = controller();
    await subject.login(
      { email: 'a@b.test', password: 'x', installationId: 'installation-iphone-0001' } as never,
      request,
      response,
    );
    expect(seen[0]?.installationId).toBe('installation-iphone-0001');
  });

  it('forwards null for a browser, rather than undefined', async () => {
    const { controller: subject, seen } = controller();
    await subject.login({ email: 'a@b.test', password: 'x' } as never, request, response);
    // Null, not undefined: the column is nullable and the intent is "this
    // client has no installation", not "nobody filled this in".
    expect(seen[0]?.installationId).toBeNull();
  });

  /**
   * The second half of a two-factor sign-in issues the session, so it is the
   * half that has to carry the installation. A phone with 2FA on would
   * otherwise end up with a session belonging to no device — the one account
   * shape where the control silently does not apply.
   */
  it('forwards it through the second factor too', async () => {
    const { controller: subject, seen } = controller();
    await subject.loginTwoFactor(
      { challengeToken: 'challenge', code: '123456', installationId: 'installation-ipad-0002' } as never,
      request,
      response,
    );
    expect(seen[0]?.installationId).toBe('installation-ipad-0002');
  });
});
