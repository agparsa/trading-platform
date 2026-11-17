'use client';

import { useState } from 'react';
import { useCreateInstrument, type NewInstrumentInput } from '@/lib/admin-queries';
import { ErrorLine } from './shared';

type Draft = Omit<NewInstrumentInput, 'pricePrecision' | 'volumePrecision'> & {
  pricePrecision: string;
  volumePrecision: string;
};

const EMPTY: Draft = {
  code: '',
  description: '',
  category: 'Crypto',
  quoteCurrency: 'USD',
  contractSize: '1',
  tickSize: '0.01',
  pricePrecision: '2',
  volumeStep: '0.01',
  volumePrecision: '2',
  minVolume: '0.01',
  maxVolume: '100',
  marginRate: '0.1',
  session: 'crypto',
  reason: '',
};

/**
 * Starting points — a coin, a currency pair, a metal — so the contract is
 * filled in the shape the platform's own instruments have. Every field stays
 * editable; nothing here is a price.
 */
const TEMPLATES: Record<string, Partial<Draft>> = {
  'Crypto (like BTCUSD)': {
    category: 'Crypto',
    contractSize: '1',
    tickSize: '0.01',
    pricePrecision: '2',
    volumeStep: '0.01',
    volumePrecision: '2',
    minVolume: '0.01',
    maxVolume: '100',
    marginRate: '0.1',
    session: 'crypto',
  },
  'Forex (like EURUSD)': {
    category: 'FX',
    contractSize: '100000',
    tickSize: '0.00001',
    pricePrecision: '5',
    volumeStep: '0.01',
    volumePrecision: '2',
    minVolume: '0.01',
    maxVolume: '100',
    marginRate: '0.01',
    session: 'fx',
  },
  'Metal (like XAUUSD)': {
    category: 'Metals',
    contractSize: '100',
    tickSize: '0.01',
    pricePrecision: '2',
    volumeStep: '0.01',
    volumePrecision: '2',
    minVolume: '0.01',
    maxVolume: '50',
    marginRate: '0.02',
    session: 'metals',
  },
};

const FIELDS: ReadonlyArray<[keyof Draft, string]> = [
  ['contractSize', 'Contract size'],
  ['tickSize', 'Tick'],
  ['pricePrecision', 'Price decimals'],
  ['volumeStep', 'Volume step'],
  ['volumePrecision', 'Volume decimals'],
  ['minVolume', 'Min lots'],
  ['maxVolume', 'Max lots'],
  ['marginRate', 'Margin rate'],
];

const input =
  'rounded border border-terminal-border bg-terminal-bg px-2 py-1 text-xs text-terminal-text';

/**
 * Adding an instrument — SOLUSD, a new pair. It is created **suspended**: it has
 * no price until a live source is configured for it (`MARKET_LIVE_BINANCE`,
 * `MARKET_LIVE_FASTFOREX`…), and trading is resumed from its row once Market
 * data shows its price live. The server checks the contract hangs together and
 * records who added it and why.
 */
export function AddInstrument() {
  const create = useCreateInstrument();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [done, setDone] = useState<string | null>(null);
  const set = (patch: Partial<Draft>) => setDraft((now) => ({ ...now, ...patch }));
  const ready =
    /^[A-Z0-9]{3,12}$/.test(draft.code.trim().toUpperCase()) &&
    draft.description.trim().length >= 3 &&
    draft.reason.trim().length >= 8;

  if (!open) {
    return (
      <button
        type="button"
        className="mt-3 rounded border border-terminal-border px-3 py-1 text-xs text-terminal-text disabled:opacity-40"
        onClick={() => setOpen(true)}
        disabled={!create.allowed}
        title={create.allowed ? undefined : `Your role does not carry ${create.requires}`}
        data-testid="add-instrument-open"
      >
        + Add instrument
      </button>
    );
  }

  return (
    <form
      className="mt-3 space-y-3 rounded border border-terminal-border p-3"
      data-testid="add-instrument"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        setDone(null);
        create.mutate(
          {
            ...draft,
            code: draft.code.trim().toUpperCase(),
            quoteCurrency: draft.quoteCurrency.trim().toUpperCase(),
            pricePrecision: Number(draft.pricePrecision),
            volumePrecision: Number(draft.volumePrecision),
            reason: draft.reason.trim(),
          },
          {
            onSuccess: (result) => {
              setDone(
                `${result.code} added, suspended, with ${result.sessionWindows} session window(s). Configure its price source, then resume it here.`,
              );
              setDraft(EMPTY);
            },
          },
        );
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-label uppercase tracking-wider text-terminal-muted">Start from</span>
        {Object.entries(TEMPLATES).map(([name, template]) => (
          <button
            key={name}
            type="button"
            className="rounded border border-terminal-border px-2 py-1 text-xs text-terminal-text"
            onClick={() => set(template)}
          >
            {name}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <label className="flex flex-col gap-1">
          <span className="text-label uppercase tracking-wider text-terminal-muted">Code</span>
          <input
            className={input}
            value={draft.code}
            placeholder="SOLUSD"
            onChange={(event) => set({ code: event.target.value })}
            data-testid="add-instrument-code"
          />
        </label>
        <label className="col-span-2 flex flex-col gap-1">
          <span className="text-label uppercase tracking-wider text-terminal-muted">
            Description
          </span>
          <input
            className={input}
            value={draft.description}
            placeholder="Solana vs US Dollar"
            onChange={(event) => set({ description: event.target.value })}
            data-testid="add-instrument-description"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-label uppercase tracking-wider text-terminal-muted">Quoted in</span>
          <input
            className={input}
            value={draft.quoteCurrency}
            onChange={(event) => set({ quoteCurrency: event.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-label uppercase tracking-wider text-terminal-muted">Class</span>
          <select
            className={input}
            value={draft.category}
            onChange={(event) => set({ category: event.target.value as Draft['category'] })}
          >
            {['FX', 'Metals', 'Crypto', 'Indices', 'Commodities'].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-label uppercase tracking-wider text-terminal-muted">Week</span>
          <select
            className={input}
            value={draft.session}
            onChange={(event) => set({ session: event.target.value as Draft['session'] })}
          >
            <option value="crypto">Always open</option>
            <option value="fx">Sun 22:00 – Fri 21:00 UTC</option>
            <option value="metals">Metals (Sun 22:00 – Fri 21:00 UTC)</option>
            <option value="none">None yet (set it after)</option>
          </select>
        </label>
        {FIELDS.map(([key, label]) => (
          <label key={key} className="flex flex-col gap-1">
            <span className="text-label uppercase tracking-wider text-terminal-muted">{label}</span>
            <input
              className={`${input} numeric`}
              value={draft[key]}
              inputMode="decimal"
              onChange={(event) => set({ [key]: event.target.value } as Partial<Draft>)}
            />
          </label>
        ))}
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-label uppercase tracking-wider text-terminal-muted">
          Reason — goes in the audit trail
        </span>
        <input
          className={input}
          value={draft.reason}
          placeholder="Why this instrument is being added"
          onChange={(event) => set({ reason: event.target.value })}
          data-testid="add-instrument-reason"
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={!ready || create.isPending || !create.allowed}
          className="rounded bg-terminal-accent px-3 py-1 text-xs font-medium text-terminal-bg disabled:opacity-40"
          data-testid="add-instrument-save"
        >
          {create.isPending ? 'Adding…' : 'Add, suspended'}
        </button>
        <button
          type="button"
          className="rounded border border-terminal-border px-3 py-1 text-xs text-terminal-muted"
          onClick={() => setOpen(false)}
        >
          Close
        </button>
        {ready ? null : (
          <span className="text-caption text-terminal-muted">
            A code, a description and a reason of at least 8 characters are required.
          </span>
        )}
      </div>
      {create.isError ? <ErrorLine error={create.error} /> : null}
      {done === null ? null : (
        <p className="text-caption text-terminal-long" role="status">
          {done}
        </p>
      )}
    </form>
  );
}
