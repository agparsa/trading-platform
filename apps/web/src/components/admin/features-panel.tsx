'use client';

import { useState } from 'react';
import { cn } from '@tp/ui';
import { inputClass } from '@/components/primitives';
import {
  useAdminFeatures,
  useBrokerFeatures,
  useBrokers,
  useSetFeature,
  type FeatureRow,
} from '@/lib/admin-queries';
import { utcTime } from '@/lib/format';
import { ErrorLine, Head, Loading, ReasonedAction, Table } from './shared';

/**
 * Feature flags (§95).
 *
 * The catalogue decides who may flip each flag; the screen shows that rather
 * than hiding the ones this caller cannot. A firm sees its platform flags as
 * facts about its plan, with the platform named as the party that sets them.
 * The platform, on its own tenant, picks a broker and sets that broker's
 * platform flags — never a broker's own product choices.
 *
 * Every flag says how it is enforced. A client-enforced flag is a product
 * choice the apps honour, not a control; saying so here is what stops
 * somebody reading "mobile trading: off" as a security guarantee.
 */
export function FeaturesPanel() {
  const brokers = useBrokers();
  const isPlatform = brokers.isSuccess;
  const [brokerId, setBrokerId] = useState<string | null>(null);

  return (
    <div className="flex flex-col" data-testid="features">
      {isPlatform ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-terminal-border px-3 py-2 text-[11px]">
          <span className="text-terminal-muted">
            Acting as the platform. Set a broker’s platform flags:
          </span>
          <select
            aria-label="Broker"
            className={cn(inputClass, 'w-auto py-1 text-xs')}
            value={brokerId ?? ''}
            onChange={(event) => setBrokerId(event.target.value === '' ? null : event.target.value)}
          >
            <option value="">— this tenant’s own flags —</option>
            {(brokers.data?.brokers ?? []).map((broker) => (
              <option key={broker.id} value={broker.id}>
                {broker.name} ({broker.slug})
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {brokerId === null ? <OwnFlags /> : <BrokerFlags brokerId={brokerId} />}
    </div>
  );
}

function OwnFlags() {
  const flags = useAdminFeatures();
  return (
    <Flags rows={flags.data ?? []} loading={flags.isLoading} error={flags.error} authority="FIRM" />
  );
}

function BrokerFlags({ brokerId }: { brokerId: string }) {
  const flags = useBrokerFeatures(brokerId);
  return (
    <Flags
      rows={flags.data ?? []}
      loading={flags.isLoading}
      error={flags.error}
      authority="PLATFORM"
      brokerId={brokerId}
    />
  );
}

function Flags({
  rows,
  loading,
  error,
  authority,
  brokerId,
}: {
  rows: FeatureRow[];
  loading: boolean;
  error: unknown;
  /** Which flags this screen may write: the firm's own, or a broker's platform flags. */
  authority: 'FIRM' | 'PLATFORM';
  brokerId?: string;
}) {
  const set = useSetFeature();
  return (
    <>
      <ErrorLine error={error ?? set.error} />
      {loading ? (
        <Loading />
      ) : (
        <Table>
          <Head columns={['Feature', 'What it does', 'Set by', 'Enforced', 'State', '']} />
          <tbody>
            {rows.map((row) => {
              const writable = row.authority === authority;
              return (
                <tr key={row.key} className="border-t border-terminal-border/60 align-top">
                  <td className="px-3 py-1.5">
                    <div className="text-terminal-text">{row.name}</div>
                    <div className="font-mono text-[10px] text-terminal-muted">{row.key}</div>
                  </td>
                  <td className="max-w-md px-3 py-1.5 text-terminal-muted">{row.description}</td>
                  <td className="px-3 py-1.5 text-terminal-muted">
                    {row.authority === 'PLATFORM' ? 'the platform' : 'the firm'}
                  </td>
                  <td className="px-3 py-1.5">
                    {row.enforcement === 'SERVER' ? (
                      <span className="text-terminal-text">by the server</span>
                    ) : (
                      <span
                        className="text-terminal-muted"
                        title="A product choice the apps honour; the server has no action to guard."
                      >
                        by the apps
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    <span
                      className={row.enabled ? 'text-terminal-success' : 'text-terminal-danger'}
                    >
                      {row.enabled ? 'on' : 'off'}
                    </span>
                    {row.override === null ? (
                      <span className="ml-1 text-[10px] text-terminal-muted">(default)</span>
                    ) : (
                      <div
                        className="text-[10px] text-terminal-muted"
                        title={utcTime(row.override.updatedAt)}
                      >
                        {row.override.note}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    {writable ? (
                      <ReasonedAction
                        label={row.enabled ? 'Switch off' : 'Switch on'}
                        title="Why — read a year from now"
                        variant={row.enabled ? 'danger' : 'neutral'}
                        busy={set.isPending}
                        onConfirm={(note) =>
                          set.mutate({ key: row.key, enabled: !row.enabled, note, brokerId })
                        }
                      />
                    ) : (
                      <span className="text-[10px] text-terminal-muted">
                        {row.authority === 'PLATFORM'
                          ? 'set by the platform'
                          : 'the broker’s own choice'}
                      </span>
                    )}
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
