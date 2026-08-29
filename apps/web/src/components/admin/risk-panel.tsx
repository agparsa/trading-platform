'use client';

import { useState } from 'react';
import { cn } from '@tp/ui';
import { Tabs } from '@/components/primitives';
import { useAtRisk, useExposure, useIntegritySignals, useRiskEvents } from '@/lib/admin-queries';
import { money, percent, signedMoney, toneClass, toneOf, utcTime, volume } from '@/lib/format';
import { ErrorLine, Head, Loading, SeverityPill, Table } from './shared';

type RiskTab = 'at-risk' | 'exposure' | 'events' | 'integrity';

/** The risk manager's console. */
export function RiskPanel() {
  const [tab, setTab] = useState<RiskTab>('at-risk');

  return (
    <div className="flex flex-col">
      <div className="border-b border-terminal-border px-3 py-2">
        <Tabs<RiskTab>
          active={tab}
          onChange={setTab}
          tabs={[
            { id: 'at-risk', label: 'At risk' },
            { id: 'exposure', label: 'Exposure' },
            { id: 'events', label: 'Events' },
            { id: 'integrity', label: 'Integrity' },
          ]}
        />
      </div>
      {tab === 'at-risk' ? <AtRisk /> : null}
      {tab === 'exposure' ? <Exposure /> : null}
      {tab === 'events' ? <Events /> : null}
      {tab === 'integrity' ? <Signals /> : null}
    </div>
  );
}

/**
 * Accounts near their thresholds, valued live.
 *
 * Live rather than from the last snapshot, and refreshed on an interval — this
 * is the one screen in the application where polling is the right mechanism.
 * Nothing pushes a margin level for an account this browser does not own, and a
 * risk manager looking at an account is looking at it *now*.
 */
function AtRisk() {
  const [below, setBelow] = useState<number | null>(150);
  const rows = useAtRisk(below);

  return (
    <>
      <div className="flex items-center gap-2 border-b border-terminal-border px-3 py-2">
        <label className="flex items-center gap-2 text-[11px] text-terminal-muted">
          Margin level at or below
          <select
            className="rounded border border-terminal-border bg-terminal-bg px-2 py-1 text-[11px] text-terminal-text"
            value={below ?? 'all'}
            onChange={(event) =>
              setBelow(event.target.value === 'all' ? null : Number(event.target.value))
            }
          >
            {[100, 150, 200, 500, 1_000].map((value) => (
              <option key={value} value={value}>
                {value}%
              </option>
            ))}
            {/*
              "All" omits the threshold entirely rather than passing a large
              number: a well-capitalised account sits at several hundred
              thousand percent, and a filter that meant "anything" by passing
              100,000 would hide the very accounts it claimed to show.
            */}
            <option value="all">any level (every account holding margin)</option>
          </select>
        </label>
        <span className="text-[10px] text-terminal-muted">
          {rows.data === undefined
            ? ''
            : `${rows.data.length} account(s)${rows.data.length === 200 ? ' (capped)' : ''} · refreshed live`}
        </span>
      </div>

      <ErrorLine error={rows.error} />
      {rows.isLoading ? (
        <Loading>Valuing accounts…</Loading>
      ) : (rows.data ?? []).length === 0 ? (
        <Loading>
          {below === null
            ? 'No account is holding margin right now.'
            : `No account is at or below ${below}%.`}
        </Loading>
      ) : (
        <Table>
          <Head
            columns={[
              'Account',
              'Owner',
              { label: 'Margin level', right: true },
              { label: 'Equity', right: true },
              { label: 'Used margin', right: true },
              { label: 'Free margin', right: true },
              { label: 'Floating', right: true },
              { label: 'Positions', right: true },
              'Thresholds',
            ]}
          />
          <tbody>
            {(rows.data ?? []).map((row) => {
              const level = Number(row.marginLevel);
              const stopOut = Number(row.stopOutLevelPercent ?? 0);
              const marginCall = Number(row.marginCallLevelPercent ?? 0);
              const tone =
                level <= stopOut
                  ? 'text-terminal-short font-medium'
                  : level <= marginCall
                    ? 'text-terminal-warning'
                    : 'text-terminal-text';

              return (
                <tr key={row.accountId} className="border-t border-terminal-border/60">
                  <td className="numeric px-2 py-1.5 text-terminal-text">{row.number}</td>
                  <td className="px-2 py-1.5 text-terminal-muted">{row.email}</td>
                  <td className={cn('numeric px-2 py-1.5 text-right', tone)}>
                    {percent(row.marginLevel)}
                  </td>
                  <td className="numeric px-2 py-1.5 text-right text-terminal-text">
                    {money(row.equity, row.currency)}
                  </td>
                  <td className="numeric px-2 py-1.5 text-right text-terminal-muted">
                    {money(row.usedMargin, row.currency)}
                  </td>
                  <td className="numeric px-2 py-1.5 text-right text-terminal-muted">
                    {money(row.freeMargin, row.currency)}
                  </td>
                  <td
                    className={cn(
                      'numeric px-2 py-1.5 text-right',
                      toneClass[toneOf(row.floatingPnl)],
                    )}
                  >
                    {signedMoney(row.floatingPnl, row.currency)}
                  </td>
                  <td className="numeric px-2 py-1.5 text-right text-terminal-muted">
                    {row.openPositions}
                  </td>
                  <td className="numeric px-2 py-1.5 text-[10px] text-terminal-muted">
                    {row.marginCallLevelPercent ?? '—'}% / {row.stopOutLevelPercent ?? '—'}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </>
  );
}

/**
 * Where the book actually is.
 *
 * Volume, not notional. Notional would need every position converted at a live
 * rate, which turns a summary into a valuation of the whole book; the question
 * this answers is "what are we all long of", which volume answers directly.
 */
function Exposure() {
  const rows = useExposure();

  return (
    <>
      <ErrorLine error={rows.error} />
      {rows.isLoading ? (
        <Loading />
      ) : (rows.data ?? []).length === 0 ? (
        <Loading>Nothing is open.</Loading>
      ) : (
        <Table>
          <Head
            columns={[
              'Instrument',
              { label: 'Long', right: true },
              { label: 'Short', right: true },
              { label: 'Net', right: true },
              { label: 'Positions', right: true },
            ]}
          />
          <tbody>
            {(rows.data ?? []).map((row) => (
              <tr key={row.symbol} className="border-t border-terminal-border/60">
                <td className="px-2 py-1.5 font-medium text-terminal-text">{row.symbol}</td>
                <td className="numeric px-2 py-1.5 text-right text-terminal-long">
                  {volume(row.longVolume)}
                </td>
                <td className="numeric px-2 py-1.5 text-right text-terminal-short">
                  {volume(row.shortVolume)}
                </td>
                <td
                  className={cn('numeric px-2 py-1.5 text-right', toneClass[toneOf(row.netVolume)])}
                >
                  {volume(row.netVolume)}
                </td>
                <td className="numeric px-2 py-1.5 text-right text-terminal-muted">
                  {row.positions}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <p className="px-3 py-2 text-[10px] text-terminal-muted">
        Lots, not notional. Converting every position at a live rate would turn a summary into a
        valuation of the whole book; the money figures are on the At risk tab.
      </p>
    </>
  );
}

function Events() {
  const [severity, setSeverity] = useState('');
  const rows = useRiskEvents(severity);

  return (
    <>
      <div className="flex items-center gap-2 border-b border-terminal-border px-3 py-2">
        <select
          className="rounded border border-terminal-border bg-terminal-bg px-2 py-1 text-[11px] text-terminal-text"
          value={severity}
          onChange={(event) => setSeverity(event.target.value)}
          aria-label="Severity"
        >
          <option value="">Every severity</option>
          <option value="CRITICAL">Critical</option>
          <option value="WARNING">Warning</option>
          <option value="INFO">Info</option>
        </select>
      </div>

      <ErrorLine error={rows.error} />
      {rows.isLoading ? (
        <Loading />
      ) : (rows.data ?? []).length === 0 ? (
        <Loading>No risk decisions recorded.</Loading>
      ) : (
        <Table>
          <Head columns={['When (UTC)', 'Account', 'Severity', 'Rule', 'Code', 'What happened']} />
          <tbody>
            {(rows.data ?? []).map((row) => (
              <tr key={row.id} className="border-t border-terminal-border/60 align-top">
                <td className="numeric px-2 py-1.5 text-terminal-muted">
                  {utcTime(row.createdAt)}
                </td>
                <td className="numeric px-2 py-1.5 text-terminal-text">{row.accountNumber}</td>
                <td className="px-2 py-1.5">
                  <SeverityPill severity={row.severity} />
                </td>
                <td className="px-2 py-1.5 text-terminal-muted">{row.rule}</td>
                <td className="px-2 py-1.5 text-terminal-muted">{row.code}</td>
                <td className="px-2 py-1.5 text-terminal-text">{row.message}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}

/**
 * Integrity signals — observations, never verdicts.
 *
 * The wording matters. Nothing here says a trader did anything wrong; it says a
 * pattern was observed often enough to be worth a person's attention, and a
 * person decides.
 */
function Signals() {
  const rows = useIntegritySignals();

  return (
    <>
      <ErrorLine error={rows.error} />
      {rows.isLoading ? (
        <Loading />
      ) : (rows.data ?? []).length === 0 ? (
        <Loading>Nothing has been flagged.</Loading>
      ) : (
        <Table>
          <Head
            columns={[
              'First seen',
              'Last seen',
              { label: 'Times', right: true },
              'Severity',
              'State',
              'Signal',
              'What was observed',
            ]}
          />
          <tbody>
            {(rows.data ?? []).map((row) => (
              <tr key={row.id} className="border-t border-terminal-border/60 align-top">
                <td className="numeric px-2 py-1.5 text-terminal-muted">
                  {utcTime(row.firstSeenAt)}
                </td>
                <td className="numeric px-2 py-1.5 text-terminal-muted">
                  {utcTime(row.lastSeenAt)}
                </td>
                <td className="numeric px-2 py-1.5 text-right text-terminal-text">
                  {row.occurrences}
                </td>
                <td className="px-2 py-1.5">
                  <SeverityPill severity={row.severity} />
                </td>
                <td className="px-2 py-1.5 text-terminal-muted">{row.status}</td>
                <td className="px-2 py-1.5 text-terminal-muted">{row.code}</td>
                <td className="px-2 py-1.5 text-terminal-text">{row.message}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <p className="px-3 py-2 text-[10px] text-terminal-muted">
        These are observations, not verdicts. A signal says a pattern was seen often enough to be
        worth looking at; what it means is for a person to decide.
      </p>
    </>
  );
}
