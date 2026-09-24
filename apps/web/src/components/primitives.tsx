'use client';

import { cn } from '@tp/ui';

/** A bordered surface with an optional header strip. */
export function Panel({
  title,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section
      className={cn(
        'flex min-h-0 flex-col overflow-hidden rounded-lg border border-terminal-border bg-terminal-surface',
        className,
      )}
    >
      {title === undefined ? null : (
        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-terminal-border px-3 py-2">
          <h2 className="text-xs font-medium uppercase tracking-wider text-terminal-muted">
            {title}
          </h2>
          {actions}
        </header>
      )}
      <div className={cn('min-h-0 flex-1 overflow-auto', bodyClassName)}>{children}</div>
    </section>
  );
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: ReadonlyArray<{ id: T; label: string; count?: number }>;
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div role="tablist" className="flex items-center gap-1">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === active}
          onClick={() => onChange(tab.id)}
          className={cn(
            'rounded px-2.5 py-1 text-xs transition-colors',
            tab.id === active
              ? 'bg-terminal-raised text-terminal-text'
              : 'text-terminal-muted hover:text-terminal-text',
          )}
        >
          {tab.label}
          {tab.count === undefined ? null : (
            <span className="numeric ml-1.5 text-[10px] text-terminal-muted">{tab.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center justify-between text-[11px] uppercase tracking-wider text-terminal-muted">
        {label}
        {hint}
      </span>
      {children}
    </label>
  );
}

export const inputClass =
  'numeric w-full rounded border border-terminal-border bg-terminal-bg px-2.5 py-1.5 text-sm text-terminal-text outline-none transition-colors focus:border-terminal-muted disabled:opacity-50';

/**
 * What a control needs the signed-in person to hold. Given, and not held, the
 * button is disabled and says which capability — rather than being pressed and
 * answered with a 403. The server refuses either way; this is the courtesy of
 * saying so first. See `Gate` in lib/admin-queries.ts.
 */
export interface ButtonGate {
  readonly allowed: boolean;
  readonly requires: string;
}

export function Button({
  variant = 'neutral',
  className,
  gate,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'neutral' | 'long' | 'short' | 'ghost' | 'danger';
  gate?: ButtonGate;
}) {
  const refused = gate !== undefined && !gate.allowed;
  const variants: Record<string, string> = {
    neutral:
      'border border-terminal-border bg-terminal-raised text-terminal-text hover:border-terminal-muted',
    long: 'bg-terminal-long text-terminal-bg hover:opacity-90',
    short: 'bg-terminal-short text-terminal-bg hover:opacity-90',
    ghost: 'text-terminal-muted hover:text-terminal-text',
    danger: 'border border-terminal-short/40 text-terminal-short hover:bg-terminal-short/10',
  };
  return (
    <button
      {...props}
      disabled={props.disabled === true || refused}
      title={refused ? `Your role does not carry ${gate.requires}` : props.title}
      data-requires={refused ? gate.requires : undefined}
      className={cn(
        'rounded px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        variants[variant],
        className,
      )}
    />
  );
}

/** A labelled read-only figure. Used everywhere account state is displayed. */
export function Stat({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: React.ReactNode;
  tone?: string;
  title?: string;
}) {
  return (
    <div className="min-w-0" title={title}>
      <p className="text-[10px] uppercase tracking-wider text-terminal-muted">{label}</p>
      <p className={cn('numeric mt-0.5 truncate text-sm', tone ?? 'text-terminal-text')}>{value}</p>
    </div>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-24 items-center justify-center p-6 text-center text-xs text-terminal-muted">
      {children}
    </div>
  );
}

export function SideBadge({ side }: { side: 'BUY' | 'SELL' }) {
  return (
    <span
      className={cn(
        'rounded px-1.5 py-0.5 text-[10px] font-medium',
        side === 'BUY'
          ? 'bg-terminal-long/15 text-terminal-long'
          : 'bg-terminal-short/15 text-terminal-short',
      )}
    >
      {side}
    </span>
  );
}
