'use client';

import { useEffect, useState } from 'react';
import { cn } from '@tp/ui';
import { useMarkAllRead, useMarkRead, useNotifications } from '@/lib/queries';
import { relativeTime } from '@/lib/format';
import { Button } from './primitives';

/**
 * What the platform has told this trader, whether or not they were looking.
 *
 * The bell is the *record*; the toast strip is the nudge. That division is the
 * whole point of writing notifications to the database: a margin call raised
 * while somebody was away from their desk is still here when they come back,
 * and one that only ever existed as a toast would not be.
 */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const notifications = useNotifications(open);
  const markRead = useMarkRead();
  const markAll = useMarkAllRead();

  const unread = (notifications.data ?? []).filter((row) => row.readAt === null).length;

  // Close on Escape, like every other transient surface in the terminal.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={unread === 0 ? 'Notifications' : `Notifications, ${unread} unread`}
        className={cn(
          'relative rounded px-1.5 py-0.5 text-[13px] leading-none transition-colors',
          unread > 0 ? 'text-terminal-warning' : 'text-terminal-muted hover:text-terminal-text',
        )}
      >
        ●
        {unread === 0 ? null : (
          <span className="numeric absolute -right-1 -top-1 rounded-full bg-terminal-warning px-1 text-[9px] font-medium text-terminal-bg">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {!open ? null : (
        <div className="absolute right-0 z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded border border-terminal-border bg-terminal-surface shadow-lg shadow-black/40">
          <div className="flex items-center justify-between border-b border-terminal-border px-3 py-1.5">
            <span className="text-[10px] uppercase tracking-wider text-terminal-muted">
              Notifications
            </span>
            <Button
              variant="ghost"
              className="px-2 py-0.5"
              disabled={unread === 0 || markAll.isPending}
              onClick={() => markAll.mutate()}
            >
              Mark all read
            </Button>
          </div>

          <div className="max-h-80 overflow-auto">
            {notifications.isLoading ? (
              <p className="px-3 py-3 text-[11px] text-terminal-muted">Loading…</p>
            ) : (notifications.data ?? []).length === 0 ? (
              <p className="px-3 py-3 text-[11px] text-terminal-muted">Nothing yet.</p>
            ) : (
              (notifications.data ?? []).map((row) => (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => {
                    if (row.readAt === null) markRead.mutate({ id: row.id });
                  }}
                  className={cn(
                    'block w-full border-t border-terminal-border/60 px-3 py-2 text-left transition-colors first:border-t-0 hover:bg-terminal-raised/40',
                    row.readAt === null && 'bg-terminal-raised/20',
                  )}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span
                      className={cn(
                        'text-[11px] font-medium',
                        row.severity === 'CRITICAL'
                          ? 'text-terminal-short'
                          : row.severity === 'WARNING'
                            ? 'text-terminal-warning'
                            : 'text-terminal-text',
                      )}
                    >
                      {row.title}
                    </span>
                    <span className="shrink-0 text-[9px] text-terminal-muted">
                      {relativeTime(row.createdAt)}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[10px] leading-relaxed text-terminal-muted">
                    {row.body}
                  </p>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
