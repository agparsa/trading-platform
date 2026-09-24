'use client';

import { useState } from 'react';
import { cn } from '@tp/ui';
import { DomainError } from '@tp/shared-types';
import { Button, type ButtonGate, inputClass } from '@/components/primitives';

/**
 * The pieces every administrative panel needs, in one place.
 *
 * Chiefly: how a refusal is shown. Every one of these endpoints can answer 403,
 * and a console that renders "Something went wrong" for a permission refusal
 * teaches its operators to retry rather than to ask for the access they need.
 */

export function ErrorLine({ error }: { error: unknown }) {
  if (error === null || error === undefined) return null;
  const message =
    error instanceof DomainError
      ? error.code === 'FORBIDDEN'
        ? 'Your role does not include this. Nothing was changed.'
        : error.message
      : error instanceof Error
        ? error.message
        : 'The request failed. Nothing was changed.';
  return <p className="px-3 py-2 text-[11px] text-terminal-short">{message}</p>;
}

export function Loading({ children = 'Loading…' }: { children?: React.ReactNode }) {
  return <p className="px-3 py-3 text-[11px] text-terminal-muted">{children}</p>;
}

export function SearchBox({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <input
      className={cn(inputClass, 'max-w-xs py-1 text-xs')}
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'ACTIVE'
      ? 'bg-terminal-long/15 text-terminal-long'
      : status === 'CLOSED' || status === 'SUSPENDED' || status === 'REVOKED'
        ? 'bg-terminal-short/15 text-terminal-short'
        : 'bg-terminal-warning/15 text-terminal-warning';
  return (
    <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', tone)}>{status}</span>
  );
}

export function SeverityPill({ severity }: { severity: string }) {
  const tone =
    severity === 'CRITICAL'
      ? 'bg-terminal-short/15 text-terminal-short'
      : severity === 'WARNING'
        ? 'bg-terminal-warning/15 text-terminal-warning'
        : 'bg-terminal-raised text-terminal-muted';
  return (
    <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', tone)}>{severity}</span>
  );
}

/**
 * An action that will not proceed without a reason.
 *
 * The reason is not decoration. Every one of these endpoints stores it on the
 * audit record, and "who did this and why" is the first question asked
 * afterwards — an answer that lives in somebody's memory is not an answer.
 *
 * It asks for the reason *before* doing the thing, deliberately. A prompt that
 * appears afterwards gets an empty sentence typed into it.
 */
export function ReasonedAction({
  label,
  title,
  variant = 'neutral',
  minLength = 4,
  busy = false,
  gate,
  onConfirm,
}: {
  label: string;
  title: string;
  variant?: 'neutral' | 'danger' | 'ghost';
  minLength?: number;
  busy?: boolean;
  /** The capability the action needs; not held, the action is offered disabled. */
  gate?: ButtonGate;
  onConfirm: (reason: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');

  if (!open) {
    return (
      <Button variant={variant} className="px-2 py-0.5" gate={gate} onClick={() => setOpen(true)}>
        {label}
      </Button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      <input
        className={cn(inputClass, 'w-56 py-1 text-xs')}
        placeholder={title}
        value={reason}
        autoFocus
        onChange={(event) => setReason(event.target.value)}
      />
      <Button
        variant={variant}
        className="px-2 py-0.5"
        disabled={busy || reason.trim().length < minLength}
        onClick={() => {
          onConfirm(reason.trim());
          setOpen(false);
          setReason('');
        }}
      >
        {busy ? 'Working…' : 'Confirm'}
      </Button>
      <Button
        variant="ghost"
        className="px-2 py-0.5"
        onClick={() => {
          setOpen(false);
          setReason('');
        }}
      >
        Cancel
      </Button>
    </div>
  );
}

export function Table({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[48rem] border-collapse text-xs">{children}</table>
    </div>
  );
}

export function Head({
  columns,
}: {
  columns: ReadonlyArray<string | { label: string; right?: boolean }>;
}) {
  return (
    <thead className="sticky top-0 z-10 bg-terminal-surface">
      <tr className="text-left text-[10px] uppercase tracking-wider text-terminal-muted">
        {columns.map((column) => {
          const label = typeof column === 'string' ? column : column.label;
          const right = typeof column === 'string' ? false : column.right === true;
          return (
            <th key={label} className={cn('px-2 py-1.5 font-medium', right && 'text-right')}>
              {label}
            </th>
          );
        })}
      </tr>
    </thead>
  );
}
