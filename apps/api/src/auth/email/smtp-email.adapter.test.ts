import { createServer, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { generateEncryptionKey } from '@tp/crypto-core';
import { validateEnv } from '../../config/env.schema';
import { SmtpEmailAdapter, smtpTransportOptions, type MailTransport } from './smtp-email.adapter';

/**
 * Production could not send a single email: `EMAIL_PROVIDER` was `log` (refused
 * in production) or `none` (discard), and nothing else existed. A pilot
 * trader who forgot a password asked for a reset, was told a link had been
 * sent, and no link was ever going to arrive.
 */
const settings = { host: 'smtp.example.com:587', user: 'mailer', password: 'not-a-real-secret' };
const message = {
  to: 'trader@firm.example',
  subject: 'Reset your password',
  text: 'Reset your password:\n\nhttps://trade.example/reset-password?token=SECRET-TOKEN',
};

/** A transport whose delivery finishes when the test says so. */
const controlled = () => {
  const sent: unknown[] = [];
  let finish: (error?: Error) => void = () => undefined;
  const transport: MailTransport = {
    sendMail: (mail) => {
      sent.push(mail);
      return new Promise((resolve, reject) => {
        finish = (error) => (error === undefined ? resolve({}) : reject(error));
      });
    },
  };
  return { transport, sent, finish: (error?: Error) => finish(error) };
};

afterEach(() => vi.restoreAllMocks());

describe('sending through SMTP', () => {
  it('sends the message as it was written, from EMAIL_FROM', async () => {
    const { transport, sent, finish } = controlled();
    const adapter = new SmtpEmailAdapter('ops@firm.example', settings, transport);
    await adapter.send(message);
    finish();
    expect(sent).toEqual([{ from: 'ops@firm.example', ...message }]);
  });

  it('returns before the server answers, so a reset takes as long for any address', async () => {
    const { transport, finish } = controlled();
    const adapter = new SmtpEmailAdapter('ops@firm.example', settings, transport);
    await adapter.send(message);
    expect(adapter.pending()).toBe(1);
    finish();
    await vi.waitFor(() => expect(adapter.pending()).toBe(0));
  });

  it('does not throw a server failure into the request, and logs it without the address or the link', async () => {
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { transport, finish } = controlled();
    const adapter = new SmtpEmailAdapter('ops@firm.example', settings, transport);
    await expect(adapter.send(message)).resolves.toBeUndefined();
    finish(Object.assign(new Error('Invalid login'), { code: 'EAUTH' }));
    await vi.waitFor(() => expect(adapter.failed()).toBe(1));

    const written = JSON.stringify(logged.mock.calls);
    expect(written).toContain('firm.example');
    expect(written).toContain('EAUTH');
    expect(written).not.toContain('trader@');
    expect(written).not.toContain('SECRET-TOKEN');
    expect(written).not.toContain('not-a-real-secret');
  });
});

describe('the transport it opens', () => {
  it('is TLS from the first byte on 465', () => {
    const options = smtpTransportOptions({ ...settings, host: 'smtp.example.com:465' });
    expect(options).toMatchObject({ host: 'smtp.example.com', port: 465, secure: true });
  });

  it('insists on STARTTLS on any other port, never the clear', () => {
    const options = smtpTransportOptions(settings);
    expect(options).toMatchObject({ port: 587, secure: false, requireTLS: true });
    expect(options.auth).toEqual({ user: 'mailer', pass: 'not-a-real-secret' });
  });
});

describe('against a server that offers no encryption', () => {
  /**
   * A real nodemailer transport against a real socket: the server greets and
   * answers EHLO without STARTTLS. The platform must hang up rather than send
   * the password or a reset link in the clear.
   */
  it('hangs up before the login or the message crosses the wire', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const heard: string[] = [];
    const server = createServer((socket) => {
      socket.write('220 plain.example ESMTP\r\n');
      socket.on('data', (chunk) => {
        for (const line of chunk.toString().split('\r\n').filter(Boolean)) {
          heard.push(line);
          if (/^(EHLO|HELO)/i.test(line))
            socket.write('250-plain.example\r\n250 AUTH PLAIN LOGIN\r\n');
          else if (/^QUIT/i.test(line)) socket.end('221 bye\r\n');
          else socket.write('250 ok\r\n');
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const adapter = new SmtpEmailAdapter('ops@firm.example', {
        ...settings,
        host: `127.0.0.1:${port}`,
      });
      await adapter.send(message);
      await vi.waitFor(() => expect(adapter.failed()).toBe(1), { timeout: 5_000 });
      expect(heard.some((line) => /^EHLO/i.test(line))).toBe(true);
      expect(heard.some((line) => /^(AUTH|MAIL FROM|RCPT TO|DATA)/i.test(line))).toBe(false);
    } finally {
      server.close();
    }
  });
});

describe('configuring it', () => {
  const base = {
    DATABASE_URL: 'postgresql://trading:pw@localhost:5432/trading_platform?schema=public',
    REDIS_URL: 'redis://localhost:6379',
    JWT_ACCESS_SECRET: 'a'.repeat(48),
    JWT_REFRESH_SECRET: 'b'.repeat(48),
    SECRET_ENCRYPTION_KEYS: generateEncryptionKey('1'),
  };
  const smtp = {
    EMAIL_PROVIDER: 'smtp',
    EMAIL_FROM: 'no-reply@firm.example',
    EMAIL_SMTP_HOST: 'smtp.example.com:587',
    EMAIL_SMTP_USER: 'mailer',
    EMAIL_SMTP_PASSWORD: 'not-a-real-secret',
  };

  it('accepts a complete setting', () => {
    expect(validateEnv({ ...base, ...smtp }).EMAIL_PROVIDER).toBe('smtp');
  });

  it.each(['EMAIL_SMTP_HOST', 'EMAIL_SMTP_USER', 'EMAIL_SMTP_PASSWORD'])(
    'refuses to start without %s rather than fail at the first reset',
    (name) => {
      expect(() => validateEnv({ ...base, ...smtp, [name]: undefined })).toThrow(name);
    },
  );

  it('refuses a host without a port', () => {
    expect(() => validateEnv({ ...base, ...smtp, EMAIL_SMTP_HOST: 'smtp.example.com' })).toThrow(
      /EMAIL_SMTP_HOST/,
    );
  });

  it('refuses the placeholder sending address', () => {
    expect(() =>
      validateEnv({ ...base, ...smtp, EMAIL_FROM: 'no-reply@trading-platform.local' }),
    ).toThrow(/EMAIL_FROM/);
  });
});
