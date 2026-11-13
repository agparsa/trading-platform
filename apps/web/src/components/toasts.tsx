'use client';

import { useCallback, useEffect, useState } from 'react';
import { cn } from '@tp/ui';
import { TOAST_FADE_MS, TOAST_TTL_MS, useToasts, type Toast } from '@/lib/toasts';
import { useT } from '@/lib/use-locale';

/**
 * The toast strip.
 *
 * Bottom-right and narrow, so it never covers the order ticket or the price. A
 * notification that obscures the thing a trader is about to click is worse than
 * no notification.
 */
export function Toasts({
  placement = 'corner',
}: {
  /**
   * `top` on a phone: under the header, over the chart's upper edge — the
   * bottom of a phone screen is the Buy and Sell buttons and the tab bar,
   * which is exactly what a toast must never cover.
   */
  placement?: 'corner' | 'top';
}) {
  const toasts = useToasts((state) => state.toasts);
  const dismiss = useToasts((state) => state.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div
      className={cn(
        'pointer-events-none fixed z-50 flex flex-col gap-2',
        placement === 'top' ? 'inset-x-3 top-16' : 'bottom-3 end-3 w-80 max-w-[calc(100vw-1.5rem)]',
      )}
      data-testid="toasts"
    >
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
      ))}
    </div>
  );
}

const TONE: Record<Toast['tone'], string> = {
  info: 'border-terminal-border bg-terminal-surface text-terminal-text',
  success: 'border-terminal-long/50 bg-terminal-surface text-terminal-long',
  warning: 'border-terminal-warning/50 bg-terminal-surface text-terminal-warning',
  danger: 'border-terminal-short/50 bg-terminal-surface text-terminal-short',
};

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const t = useT();
  const [shown, setShown] = useState(false);
  const [leaving, setLeaving] = useState(false);
  /** Fades, then goes: the same exit for the timer and the ×. */
  const leave = useCallback(() => {
    setLeaving(true);
    setTimeout(onDismiss, TOAST_FADE_MS);
  }, [onDismiss]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    // A sticky toast is one the trader must actually acknowledge — a stop-out
    // or a refusal, not a fill. Fading it away would be the platform deciding
    // they had read it. Errors are sticky for the same reason.
    if (toast.sticky || toast.tone === 'danger') return;
    setLeaving(false);
    // `at` changes when the same news replaces the toast: the ten seconds restart.
    const timer = setTimeout(leave, TOAST_TTL_MS);
    return () => clearTimeout(timer);
  }, [toast.sticky, toast.tone, toast.id, toast.at, leave]);

  return (
    <div
      role={toast.tone === 'danger' ? 'alert' : 'status'}
      className={cn(
        'pointer-events-auto rounded border px-3 py-2 shadow-lg shadow-black/30 transition-all duration-200 ease-out motion-reduce:transition-none',
        shown && !leaving ? 'translate-y-0 opacity-100' : '-translate-y-1 opacity-0',
        TONE[toast.tone],
      )}
      data-testid="toast"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-caption font-medium">{toast.title}</p>
        <button
          type="button"
          onClick={leave}
          aria-label={t('toast.dismiss')}
          className="shrink-0 text-caption leading-none text-terminal-muted transition-colors hover:text-terminal-text"
        >
          ×
        </button>
      </div>
      {toast.body === undefined ? null : (
        <p className="mt-1 text-label leading-relaxed text-terminal-muted">{toast.body}</p>
      )}
    </div>
  );
}
