'use client';

import { useCallback } from 'react';
import { DomainError } from '@tp/shared-types';
import { END_ISOLATE, LTR_ISOLATE, type MessageKey } from './messages';
import { useLocale, useT } from './use-locale';

/**
 * The server's refusal codes, in words a trader reads. The server writes its
 * messages in English, and they carry the specifics — "A BUY stop loss must sit
 * below 4584.6". In Persian the code's sentence comes first and the server's
 * own message follows, isolated left to right, so the number is not lost. In
 * English the server's message is already the best one.
 */
export const ERROR_WORDS: Readonly<Record<string, MessageKey>> = {
  INSUFFICIENT_MARGIN: 'err.INSUFFICIENT_MARGIN',
  MARKET_CLOSED: 'err.MARKET_CLOSED',
  STALE_QUOTE: 'err.STALE_QUOTE',
  NO_QUOTE_AVAILABLE: 'err.NO_QUOTE_AVAILABLE',
  INVALID_STOP_LOSS: 'err.INVALID_STOP_LOSS',
  INVALID_TAKE_PROFIT: 'err.INVALID_TAKE_PROFIT',
  INVALID_VOLUME: 'err.INVALID_VOLUME',
  INVALID_PRICE: 'err.INVALID_PRICE',
  MAX_POSITION_SIZE_EXCEEDED: 'err.MAX_POSITION_SIZE_EXCEEDED',
  MAX_EXPOSURE_EXCEEDED: 'err.MAX_EXPOSURE_EXCEEDED',
  MAX_OPEN_POSITIONS_EXCEEDED: 'err.MAX_OPEN_POSITIONS_EXCEEDED',
  POSITION_NOT_FOUND: 'err.POSITION_NOT_FOUND',
  POSITION_ALREADY_CLOSING: 'err.POSITION_ALREADY_CLOSING',
  PARTIAL_CLOSE_EXCEEDS_VOLUME: 'err.PARTIAL_CLOSE_EXCEEDS_VOLUME',
  ACCOUNT_NOT_TRADEABLE: 'err.ACCOUNT_NOT_TRADEABLE',
  TRADING_HALTED: 'err.TRADING_HALTED',
  SYMBOL_NOT_TRADEABLE: 'err.SYMBOL_NOT_TRADEABLE',
  RATE_LIMITED: 'err.RATE_LIMITED',
  CONCURRENT_MODIFICATION: 'err.CONCURRENT_MODIFICATION',
  SERVICE_UNAVAILABLE: 'err.SERVICE_UNAVAILABLE',
  FEATURE_DISABLED: 'err.FEATURE_DISABLED',
};

/** The words for a refusal: `code` and `message` as the server sent them. */
export function explainError(
  code: string | undefined,
  message: string,
  locale: string,
  t: (key: MessageKey) => string,
): string {
  const key = code === undefined ? undefined : ERROR_WORDS[code];
  if (locale !== 'fa' || key === undefined) return message;
  return message === '' ? t(key) : `${t(key)} — ${LTR_ISOLATE}${message}${END_ISOLATE}`;
}

/** `explainError` for whatever a mutation threw, in the reader's language. */
export function useExplain(): (error: unknown, fallback: string) => string {
  const { locale } = useLocale();
  const t = useT();
  return useCallback(
    (error: unknown, fallback: string) => {
      if (error instanceof DomainError) return explainError(error.code, error.message, locale, t);
      return error instanceof Error ? error.message : fallback;
    },
    [locale, t],
  );
}
