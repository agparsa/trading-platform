import { describe, expect, it } from 'vitest';
import {
  AccountStatus,
  CloseReason,
  KycDocumentKind,
  KycStatus,
  NotificationCategory,
  OrderType,
} from '@prisma/client';
import { MESSAGES, deviceLocale, refusalText, translate, english } from './messages';

describe('the app’s words', () => {
  it('has every English message in Persian, with the same placeholders', () => {
    const en = MESSAGES.en;
    const fa = MESSAGES.fa;
    expect(Object.keys(fa).sort()).toEqual(Object.keys(en).sort());
    const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      expect(names(fa[key]), key).toEqual(names(en[key]));
    }
  });

  it('writes Persian figures with Latin digits, as the web terminal does', () => {
    const persianDigits = /[۰-۹٠-٩]/;
    const offenders = Object.entries(MESSAGES.fa).filter(([, text]) => persianDigits.test(text));
    expect(offenders).toEqual([]);
  });

  it('fills placeholders and leaves a missing one visible', () => {
    expect(translate('en', 'quotes.spread', { spread: '0.14' })).toBe('Spread 0.14');
    expect(translate('fa', 'positions.open', { n: 3 })).toBe('3 باز');
    expect(translate('en', 'quotes.spread')).toBe('Spread {spread}');
  });

  it('picks Persian for a Persian phone and English otherwise', () => {
    expect(deviceLocale('fa-IR')).toBe('fa');
    expect(deviceLocale('en-GB')).toBe('en');
    expect(deviceLocale(null)).toBe('en');
  });

  it('says a refusal in words the reader has, or the server’s own', () => {
    const t = (key: Parameters<typeof english>[0]) => translate('fa', key);
    expect(refusalText({ code: 'MARKET_CLOSED', message: 'x' }, 'ticket.placeFailed', t)).toBe(
      'بازار بسته است. — x',
    );
    expect(
      refusalText({ code: 'MARKET_CLOSED', message: 'Opens 08:00' }, 'ticket.placeFailed', english),
    ).toBe('Opens 08:00');
    expect(refusalText({ code: 'OTHER', message: 'Server said no' }, 'ticket.placeFailed', t)).toBe(
      'Server said no',
    );
    expect(refusalText(new TypeError('fetch failed'), 'ticket.placeFailed', english)).toBe(
      'The order was not placed.',
    );
  });

  /**
   * The server's vocabularies the screens put into words. These were maps in
   * each screen, checked by `client-vocabularies.test.ts`; they are messages
   * now, and this is the same check: a value the server can send with no words
   * here would show the raw code.
   */
  it('has words for every value of the vocabularies the screens show', () => {
    const missing = (prefix: string, values: Record<string, string>) =>
      Object.values(values).filter((value) => !(`${prefix}.${value}` in MESSAGES.en));
    expect(missing('reason', CloseReason)).toEqual([]);
    expect(missing('kyc.status', KycStatus)).toEqual([]);
    expect(missing('kyc.kind', KycDocumentKind)).toEqual([]);
    expect(missing('category', NotificationCategory)).toEqual([]);
    expect(missing('orders.kind', OrderType)).toEqual([]);
    expect(missing('account.status', AccountStatus)).toEqual([]);
  });
});
