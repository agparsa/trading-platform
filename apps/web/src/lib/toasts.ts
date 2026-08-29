'use client';

import { create } from 'zustand';

/**
 * Transient messages.
 *
 * Deliberately thin, and deliberately **not** where anything important lives. A
 * toast is a thing that appears and goes away; the record of what happened is
 * the notification the server wrote, the position table, and the ledger. If the
 * only place a trader could learn they were on margin call was a strip that
 * faded after eight seconds, the platform would have told them nothing.
 *
 * So this is the *nudge*, and the bell beside it is the record.
 */

export type ToastTone = 'info' | 'warning' | 'danger' | 'success';

export interface Toast {
  id: string;
  tone: ToastTone;
  title: string;
  body?: string;
  /** Set for a toast that must be dismissed by hand rather than fading. */
  sticky: boolean;
  at: number;
}

/** Enough to see a burst; few enough that the screen is not a wall of them. */
const MAX_TOASTS = 4;

interface ToastState {
  toasts: Toast[];
  push: (toast: Omit<Toast, 'id' | 'at'> & { id?: string }) => void;
  dismiss: (id: string) => void;
  clear: () => void;
}

export const useToasts = create<ToastState>((set) => ({
  toasts: [],

  /**
   * Adds one, replacing any toast that shares its id.
   *
   * The id is how a repeated event stays one message: an account crossing back
   * and forth over its margin-call level should update the strip on screen, not
   * stack four of them.
   */
  push: (toast) =>
    set((state) => {
      const id = toast.id ?? crypto.randomUUID();
      const next: Toast = { ...toast, id, at: Date.now() };
      return { toasts: [next, ...state.toasts.filter((t) => t.id !== id)].slice(0, MAX_TOASTS) };
    }),

  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
  clear: () => set({ toasts: [] }),
}));

/** How long a non-sticky toast stays. Long enough to read a sentence twice. */
export const TOAST_TTL_MS = 8_000;
