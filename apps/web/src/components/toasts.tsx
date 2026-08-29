'use client';

import { useEffect } from 'react';
import { cn } from '@tp/ui';
import { TOAST_TTL_MS, useToasts, type Toast } from '@/lib/toasts';

/**
 * The toast strip.
 *
 * Bottom-right and narrow, so it never covers the order ticket or the price. A
 * notification that obscures the thing a trader is about to click is worse than
 * no notification.
 */
export function Toasts() {
  const toasts = useToasts((state) => state.toasts);
  const dismiss = useToasts((state) => state.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-3 right-3 z-50 flex w-80 max-w-[calc(100vw-1.5rem)] flex-col gap-2">
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
  useEffect(() => {
    // A sticky toast is one the trader must actually acknowledge — a stop-out,
    // not a fill. Fading it away would be the platform deciding they had read it.
    if (toast.sticky) return;
    const timer = setTimeout(onDismiss, TOAST_TTL_MS);
    return () => clearTimeout(timer);
  }, [toast.sticky, toast.id, onDismiss]);

  return (
    <div
      role="status"
      className={cn(
        'pointer-events-auto rounded border px-3 py-2 shadow-lg shadow-black/30',
        TONE[toast.tone],
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-[11px] font-medium">{toast.title}</p>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="shrink-0 text-[11px] leading-none text-terminal-muted transition-colors hover:text-terminal-text"
        >
          ×
        </button>
      </div>
      {toast.body === undefined ? null : (
        <p className="mt-1 text-[10px] leading-relaxed text-terminal-muted">{toast.body}</p>
      )}
    </div>
  );
}
