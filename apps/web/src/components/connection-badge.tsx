'use client';

import { cn } from '@tp/ui';
import { useRealtime, type ConnectionStatus } from '@/lib/realtime-store';

const LABEL: Record<ConnectionStatus, string> = {
  idle: 'Offline',
  connecting: 'Connecting',
  live: 'Live',
  reconnecting: 'Reconnecting',
  offline: 'Offline',
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

  return (
    <span
      className={cn('numeric rounded border px-2 py-0.5 text-[11px]', STYLE[status])}
      title={`${frames} frames received on this connection`}
    >
      <span
        className={cn(
          'mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle',
          status === 'live' ? 'bg-terminal-long' : 'bg-current',
          status === 'connecting' || status === 'reconnecting' ? 'animate-pulse' : '',
        )}
      />
      {LABEL[status]}
    </span>
  );
}
