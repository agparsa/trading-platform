'use client';

import { cn } from '@tp/ui';
import { useRealtime, type ConnectionStatus } from '@/lib/realtime-store';
import type { MessageKey } from '@/lib/messages';
import { useT } from '@/lib/use-locale';

const LABEL: Record<ConnectionStatus, MessageKey> = {
  idle: 'conn.offline',
  connecting: 'conn.connecting',
  live: 'conn.live',
  reconnecting: 'conn.reconnecting',
  offline: 'conn.offline',
};

const STYLE: Record<ConnectionStatus, string> = {
  idle: 'border-terminal-border bg-terminal-raised text-terminal-muted',
  connecting: 'border-terminal-warning/40 bg-terminal-warning/10 text-terminal-warning',
  live: 'border-terminal-long/40 bg-terminal-long/10 text-terminal-long',
  reconnecting: 'border-terminal-warning/40 bg-terminal-warning/10 text-terminal-warning',
  offline: 'border-terminal-short/40 bg-terminal-short/10 text-terminal-short',
};

/**
 * Connection state, always visible.
 *
 * A terminal that has quietly lost its feed looks exactly like a quiet market.
 * The trader has to be able to tell those apart at a glance, so this is never
 * hidden and never optimistic — 'Live' means frames are arriving now.
 */
export function ConnectionBadge() {
  const status = useRealtime((state) => state.status);
  const frames = useRealtime((state) => state.framesReceived);
  const t = useT();

  return (
    <span
      className={cn('rounded border px-2 py-0.5 text-caption', STYLE[status])}
      title={t('conn.frames', { frames })}
    >
      <span
        className={cn(
          'me-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle',
          status === 'live' ? 'bg-terminal-long' : 'bg-current',
          status === 'connecting' || status === 'reconnecting' ? 'animate-pulse' : '',
        )}
      />
      {t(LABEL[status])}
    </span>
  );
}
