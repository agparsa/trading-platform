import { describe, expect, it } from 'vitest';
import { smtpTransportOptions } from '@tp/email-core';
import { SmtpNotificationMailer, composeNotificationEmail } from './notification-mailer';

describe('a notification email', () => {
  it("is the server's own words, with the account and a plain link — no token", () => {
    const mail = composeNotificationEmail({
      title: 'Stopped out',
      body: 'EURUSD BUY 1.00 was closed at 1.0812.',
      severity: 'CRITICAL',
      accountNumber: 'TP-100284',
      appUrl: 'https://devopss.ir//',
    });
    expect(mail.subject).toBe('Action needed: Stopped out');
    expect(mail.text.split('\n')).toEqual([
      'EURUSD BUY 1.00 was closed at 1.0812.',
      '',
      'Account: TP-100284',
      '',
      'Open the terminal: https://devopss.ir/terminal',
      '',
      '—',
      'Turn these emails on or off in the mobile app, under Settings → By email.',
    ]);
  });

  it('leaves out an account it does not have, and says nothing urgent about a notice', () => {
    const mail = composeNotificationEmail({
      title: 'Price alert',
      body: 'XAUUSD crossed 4600.',
      severity: 'INFO',
      accountNumber: null,
      appUrl: 'https://devopss.ir',
    });
    expect(mail.subject).toBe('Price alert');
    expect(mail.text).not.toContain('Account:');
  });
});

describe('the SMTP mailer', () => {
  it('waits for the server, so a refusal reaches the caller', async () => {
    const sent: unknown[] = [];
    const ok = new SmtpNotificationMailer(
      'alerts@example.com',
      { host: 'x:587', auth: null },
      {
        sendMail: async (mail) => sent.push(mail),
      },
    );
    await ok.send({ to: 'a@example.com', subject: 's', text: 't' });
    expect(sent).toEqual([
      { from: 'alerts@example.com', to: 'a@example.com', subject: 's', text: 't' },
    ]);

    const refused = new SmtpNotificationMailer(
      'alerts@example.com',
      { host: 'x:587', auth: null },
      {
        sendMail: () => Promise.reject(new Error('550 relay denied')),
      },
    );
    await expect(refused.send({ to: 'a@example.com', subject: 's', text: 't' })).rejects.toThrow(
      /relay denied/,
    );
  });

  it('speaks to the server under the API’s TLS rule — the same function', () => {
    expect(smtpTransportOptions({ host: 'smtp.example.com:587', auth: null })).toMatchObject({
      secure: false,
      requireTLS: true,
    });
  });
});
