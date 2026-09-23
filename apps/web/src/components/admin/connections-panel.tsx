'use client';

import { useMemo, useState } from 'react';
import { cn } from '@tp/ui';
import { Button, Field, inputClass } from '@/components/primitives';
import {
  useBrokerCatalogue,
  useBrokerConnections,
  useBrokerConnectors,
  useBrokerInbox,
  useBrokerMappings,
  useCreateBrokerConnection,
  useMapInstrument,
  useReplayInboundEvent,
  useSetBrokerConnectionEnabled,
  useSetBrokerCredentials,
  useSetMappingEnabled,
  useSyncMappings,
  useTestBrokerConnection,
  type BrokerConnectionRow,
  type ConnectorRow,
} from '@/lib/admin-queries';
import { usePermissions } from '@/lib/queries';
import { utcTime } from '@/lib/format';
import { ErrorLine, Head, Loading, ReasonedAction, Table } from './shared';

const STATE_TONE: Record<string, string> = {
  CONNECTED: 'text-terminal-long',
  DEGRADED: 'text-terminal-warning',
  RATE_LIMITED: 'text-terminal-warning',
  CONNECTING: 'text-terminal-muted',
  UNKNOWN: 'text-terminal-muted',
  DISCONNECTED: 'text-terminal-short',
  AUTH_FAILED: 'text-terminal-short',
};

/** The words a person uses, not the enum. */
const STATE_WORDS: Record<string, string> = {
  CONNECTED: 'Connected',
  DEGRADED: 'Connected, late',
  CONNECTING: 'Connecting',
  UNKNOWN: 'Not checked yet',
  DISCONNECTED: 'Not connected',
  AUTH_FAILED: 'Credentials refused',
  RATE_LIMITED: 'Rate limited',
};

/**
 * A firm's venue connections.
 *
 * The credential form sends its values once and never receives them back:
 * what this screen shows afterwards is a fingerprint and the non-secret
 * fields, because that is all the server has to give. The capability list is
 * what the venue itself said it supports, read at the last test — not a guess
 * and not a setting.
 */
export function ConnectionsPanel() {
  const connectors = useBrokerConnectors();
  const list = useBrokerConnections();
  const create = useCreateBrokerConnection();
  const setEnabled = useSetBrokerConnectionEnabled();
  const test = useTestBrokerConnection();
  const permissions = usePermissions();
  const mayManage = permissions.data?.permissions.includes('broker_connections.manage') ?? false;

  const [name, setName] = useState('');
  const [kind, setKind] = useState('');
  const rows = list.data?.connections ?? [];
  const available = connectors.data?.connectors ?? [];
  const chosen = kind === '' ? available[0] : available.find((row) => row.kind === kind);

  return (
    <div className="flex flex-col" data-testid="connections-panel">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <p className="text-[11px] text-terminal-muted">
          Where this firm&apos;s orders execute when an account is set to an external broker. A
          connection&apos;s credentials are sealed on arrival and never shown again.
        </p>
        <span className="text-[10px] text-terminal-muted">
          {rows.length} {rows.length === 1 ? 'connection' : 'connections'}
        </span>
      </div>
      <ErrorLine error={list.error ?? setEnabled.error ?? test.error} />

      {list.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Loading>No venue is connected. Accounts execute on the internal engine.</Loading>
      ) : (
        <Table>
          <Head columns={['Connection', 'State', 'Last heard', 'Credentials', 'Supports', '']} />
          <tbody>
            {rows.map((row) => (
              <ConnectionRow
                key={row.id}
                row={row}
                mayManage={mayManage}
                connector={available.find((one) => one.kind === row.adapterKind)}
                onTest={() => test.mutate(row.id)}
                testing={test.isPending}
                onEnabled={(enabled, reason) => setEnabled.mutate({ id: row.id, enabled, reason })}
                busy={setEnabled.isPending}
              />
            ))}
          </tbody>
        </Table>
      )}

      {mayManage ? (
        <div className="space-y-3 border-t border-terminal-border px-3 py-3">
          <p className="text-[10px] uppercase tracking-wider text-terminal-muted">New connection</p>
          <ErrorLine error={create.error ?? connectors.error} />
          {available.length === 0 ? (
            <p className="text-[11px] text-terminal-muted">
              This build has no venue connectors. One is added by writing it against a venue&apos;s
              published API and registering it — see docs/broker-integration.md.
            </p>
          ) : (
            <>
              <div className="grid gap-3 md:grid-cols-2">
                <Field label="Name" hint="what this venue is called here">
                  <input
                    className={cn(inputClass, 'py-1 text-xs')}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Primary liquidity"
                  />
                </Field>
                <Field label="Connector">
                  <select
                    className={cn(inputClass, 'py-1 text-xs')}
                    value={chosen?.kind ?? ''}
                    onChange={(event) => setKind(event.target.value)}
                  >
                    {available.map((connector: ConnectorRow) => (
                      <option key={connector.kind} value={connector.kind}>
                        {connector.displayName}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              {chosen !== undefined && chosen.documentation === '' ? (
                <p className="text-[11px] text-terminal-warning">
                  {chosen.displayName} is not a real venue. It behaves like one so the platform can
                  be exercised; it executes nothing.
                </p>
              ) : chosen !== undefined ? (
                <p className="text-[10px] text-terminal-muted">
                  Written against {chosen.documentation}
                </p>
              ) : null}
              <Button
                onClick={() =>
                  create.mutate(
                    { name: name.trim(), adapterKind: chosen?.kind ?? '' },
                    { onSuccess: () => setName('') },
                  )
                }
                disabled={name.trim().length === 0 || chosen === undefined || create.isPending}
              >
                {create.isPending ? 'Creating…' : 'Create connection'}
              </Button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function ConnectionRow({
  row,
  connector,
  mayManage,
  onTest,
  testing,
  onEnabled,
  busy,
}: {
  row: BrokerConnectionRow;
  connector: ConnectorRow | undefined;
  mayManage: boolean;
  onTest: () => void;
  testing: boolean;
  onEnabled: (enabled: boolean, reason: string) => void;
  busy: boolean;
}) {
  const [pane, setPane] = useState<Pane>(null);
  const live = row.credentials.find((credential) => credential.revokedAt === null);
  const supports = useMemo(() => {
    const capabilities = row.capabilities ?? {};
    const named = Object.entries(capabilities)
      .filter(([key, value]) => key.startsWith('supports') && value === true)
      .map(([key]) => key.replace(/^supports/, ''));
    return named.length === 0 ? '—' : named.join(', ');
  }, [row.capabilities]);

  return (
    <>
      <tr className="border-t border-terminal-border/60 align-top">
        <td className="px-3 py-1.5">
          <p className="text-terminal-text">{row.name}</p>
          <p className="font-mono text-[10px] text-terminal-muted">
            {connector?.displayName ?? row.adapterKind}
            {row.enabled ? '' : ' · disabled'}
          </p>
        </td>
        <td className={cn('px-3 py-1.5', STATE_TONE[row.status] ?? 'text-terminal-muted')}>
          {STATE_WORDS[row.status] ?? row.status}
          {row.lastError === null ? null : (
            <p className="text-[10px] text-terminal-muted">{row.lastError}</p>
          )}
          {row.circuitOpenUntil === null ? null : (
            <p className="text-[10px] text-terminal-muted">
              Backing off until {utcTime(row.circuitOpenUntil)}
            </p>
          )}
        </td>
        <td className="numeric px-3 py-1.5 text-[10px] text-terminal-muted">
          {row.lastHeartbeatAt === null ? 'never' : utcTime(row.lastHeartbeatAt)}
          {row.latencyMs === null ? '' : ` · ${row.latencyMs}ms`}
        </td>
        <td className="px-3 py-1.5 font-mono text-[10px] text-terminal-muted">
          {live === undefined ? (
            <span className="text-terminal-warning">none set</span>
          ) : (
            <>
              {live.fingerprint}
              <p>
                {Object.entries(live.visible ?? {})
                  .map(([key, value]) => `${key}=${value}`)
                  .join(' ')}
              </p>
            </>
          )}
        </td>
        <td className="px-3 py-1.5 text-[10px] text-terminal-muted">{supports}</td>
        <td className="space-x-2 px-3 py-1.5 text-right">
          <Button variant="ghost" onClick={() => setPane(toggle('instruments'))}>
            Instruments
          </Button>
          <Button variant="ghost" onClick={() => setPane(toggle('inbox'))}>
            Inbox
          </Button>
          {mayManage ? (
            <>
              <Button variant="ghost" onClick={() => setPane(toggle('credentials'))}>
                {pane === 'credentials'
                  ? 'Close'
                  : live === undefined
                    ? 'Set credentials'
                    : 'Rotate'}
              </Button>
              <Button variant="neutral" onClick={onTest} disabled={testing || live === undefined}>
                {testing ? 'Testing…' : 'Test'}
              </Button>
              <ReasonedAction
                label={row.enabled ? 'Disable' : 'Enable'}
                variant={row.enabled ? 'danger' : 'neutral'}
                title="Why"
                minLength={4}
                busy={busy}
                onConfirm={(reason) => onEnabled(!row.enabled, reason)}
              />
            </>
          ) : null}
        </td>
      </tr>
      {pane === null ? null : (
        <tr className="border-t border-terminal-border/30 bg-terminal-raised/40">
          <td colSpan={6} className="px-3 py-3">
            {pane === 'credentials' && mayManage ? (
              <CredentialForm row={row} connector={connector} onDone={() => setPane(null)} />
            ) : pane === 'instruments' ? (
              <MappingsPane connectionId={row.id} mayManage={mayManage} />
            ) : (
              <InboxPane connectionId={row.id} mayManage={mayManage} />
            )}
          </td>
        </tr>
      )}
    </>
  );

  function toggle(next: Exclude<Pane, null>) {
    return (was: Pane) => (was === next ? null : next);
  }
}

type Pane = null | 'credentials' | 'instruments' | 'inbox';

/**
 * What this venue calls each instrument.
 *
 * Nothing here maps anything by itself. The suggestions column offers a
 * candidate by normalised name and a person confirms it, because a venue with
 * both a spot and a futures gold contract would make "obvious" matching a way
 * to trade the wrong one. An instrument with no mapping simply cannot be
 * traded on this connection — the order path refuses it by name.
 */
function MappingsPane({ connectionId, mayManage }: { connectionId: string; mayManage: boolean }) {
  const mappings = useBrokerMappings(connectionId);
  const catalogue = useBrokerCatalogue(connectionId);
  const map = useMapInstrument();
  const setEnabled = useSetMappingEnabled();
  const sync = useSyncMappings();

  const [symbolCode, setSymbolCode] = useState('');
  const [externalSymbol, setExternalSymbol] = useState('');

  const rows = mappings.data?.mappings ?? [];
  const instruments = catalogue.data?.instruments ?? [];
  const unmapped = instruments.filter((instrument) => instrument.mappedTo === null);

  return (
    <div className="space-y-3" data-testid="broker-mappings">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] text-terminal-muted">
          An instrument with no mapping cannot be traded on this connection. Nothing here is
          inferred from a name that looks similar.
        </p>
        {mayManage ? (
          <Button
            variant="neutral"
            onClick={() => sync.mutate(connectionId)}
            disabled={sync.isPending}
          >
            {sync.isPending ? 'Reading…' : "Re-read the venue's terms"}
          </Button>
        ) : null}
      </div>
      <ErrorLine error={mappings.error ?? catalogue.error ?? map.error ?? sync.error} />

      {sync.data === undefined ? null : (
        <div className="border border-terminal-border px-3 py-2 text-[11px]">
          <p className="text-terminal-muted">
            Checked {sync.data.checked} {sync.data.checked === 1 ? 'mapping' : 'mappings'}.
          </p>
          {sync.data.changed.map((change) => (
            <p key={change.symbolCode} className="text-terminal-warning">
              {change.symbolCode}: {change.differences.join(', ')}
            </p>
          ))}
          {sync.data.missing.length === 0 ? null : (
            <p className="text-terminal-short">
              The venue no longer lists {sync.data.missing.join(', ')}. Left as it is — what a
              vanished instrument means is your decision, not a sweep&apos;s.
            </p>
          )}
        </div>
      )}

      {mappings.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Loading>Nothing is mapped. No account on this connection can trade yet.</Loading>
      ) : (
        <Table>
          <Head columns={['Instrument', 'Called there', "Venue's terms", 'Last read', '']} />
          <tbody>
            {rows.map((mapping) => (
              <tr key={mapping.id} className="border-t border-terminal-border/60">
                <td className="px-3 py-1.5 text-terminal-text">
                  {mapping.symbolCode}
                  {mapping.enabled ? '' : ' · off'}
                </td>
                <td className="px-3 py-1.5 font-mono text-[11px]">{mapping.externalSymbol}</td>
                <td className="px-3 py-1.5 text-[10px] text-terminal-muted">
                  contract {mapping.contractSize ?? '—'} · step {mapping.volumeStep ?? '—'} ·{' '}
                  {mapping.minVolume ?? '—'}–{mapping.maxVolume ?? '—'} lots
                </td>
                <td className="numeric px-3 py-1.5 text-[10px] text-terminal-muted">
                  {mapping.syncedAt === null ? 'never' : utcTime(mapping.syncedAt)}
                </td>
                <td className="px-3 py-1.5 text-right">
                  {mayManage ? (
                    <Button
                      variant={mapping.enabled ? 'danger' : 'neutral'}
                      onClick={() =>
                        setEnabled.mutate({
                          id: connectionId,
                          symbolCode: mapping.symbolCode,
                          enabled: !mapping.enabled,
                        })
                      }
                      disabled={setEnabled.isPending}
                    >
                      {mapping.enabled ? 'Turn off' : 'Turn on'}
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {mayManage ? (
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Our instrument" hint="the platform's code, e.g. XAUUSD">
            <input
              className={cn(inputClass, 'py-1 text-xs')}
              value={symbolCode}
              onChange={(event) => setSymbolCode(event.target.value)}
              placeholder="XAUUSD"
            />
          </Field>
          <Field label="Called there" hint={`${unmapped.length} unmapped at the venue`}>
            <select
              className={cn(inputClass, 'py-1 text-xs')}
              value={externalSymbol}
              onChange={(event) => setExternalSymbol(event.target.value)}
            >
              <option value="">choose…</option>
              {instruments.map((instrument) => (
                <option key={instrument.externalSymbol} value={instrument.externalSymbol}>
                  {instrument.externalSymbol}
                  {instrument.mappedTo === null ? '' : ` (mapped to ${instrument.mappedTo})`}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex items-end">
            <Button
              onClick={() =>
                map.mutate(
                  { id: connectionId, symbolCode: symbolCode.trim(), externalSymbol },
                  {
                    onSuccess: () => {
                      setSymbolCode('');
                      setExternalSymbol('');
                    },
                  },
                )
              }
              disabled={symbolCode.trim() === '' || externalSymbol === '' || map.isPending}
            >
              {map.isPending ? 'Mapping…' : 'Map instrument'}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const INBOX_TONE: Record<string, string> = {
  APPLIED: 'text-terminal-long',
  PENDING: 'text-terminal-muted',
  SKIPPED: 'text-terminal-muted',
  FAILED: 'text-terminal-short',
};

/**
 * What the venue has sent.
 *
 * A redelivery is not shown twice and a failure is not hidden: an event the
 * platform choked on is the first thing an investigation wants, so it stays
 * here with its reason and can be put back to be applied by corrected code.
 * Nothing on this screen deletes one.
 */
function InboxPane({ connectionId, mayManage }: { connectionId: string; mayManage: boolean }) {
  const inbox = useBrokerInbox(connectionId);
  const replay = useReplayInboundEvent();
  const events = inbox.data?.events ?? [];

  return (
    <div className="space-y-3" data-testid="broker-inbox">
      <p className="text-[11px] text-terminal-muted">
        Recorded before it is acted on, once per event however many times the venue sends it.
      </p>
      <ErrorLine error={inbox.error ?? replay.error} />
      {inbox.isLoading ? (
        <Loading />
      ) : events.length === 0 ? (
        <Loading>This venue has sent nothing yet.</Loading>
      ) : (
        <Table>
          <Head columns={['Happened', 'What', 'Account', 'Handling', '']} />
          <tbody>
            {events.map((event) => (
              <tr key={event.id} className="border-t border-terminal-border/60 align-top">
                <td className="numeric px-3 py-1.5 text-[10px] text-terminal-muted">
                  {utcTime(event.occurredAt)}
                  {event.sequence === null ? '' : ` · #${event.sequence}`}
                </td>
                <td className="px-3 py-1.5">
                  <p className="text-terminal-text">{event.kind}</p>
                  <p className="font-mono text-[10px] text-terminal-muted">
                    {event.externalEventId}
                  </p>
                </td>
                <td className="px-3 py-1.5 font-mono text-[10px] text-terminal-muted">
                  {event.externalAccountId ?? '—'}
                </td>
                <td
                  className={cn('px-3 py-1.5', INBOX_TONE[event.status] ?? 'text-terminal-muted')}
                >
                  {event.status}
                  {event.lastError === null ? null : (
                    <p className="text-[10px] text-terminal-muted">{event.lastError}</p>
                  )}
                  {event.skipReason === null ? null : (
                    <p className="text-[10px] text-terminal-muted">{event.skipReason}</p>
                  )}
                </td>
                <td className="px-3 py-1.5 text-right">
                  {mayManage && event.status === 'FAILED' ? (
                    <Button
                      variant="neutral"
                      onClick={() => replay.mutate({ id: connectionId, eventId: event.id })}
                      disabled={replay.isPending}
                    >
                      Replay
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}

function CredentialForm({
  row,
  connector,
  onDone,
}: {
  row: BrokerConnectionRow;
  connector: ConnectorRow | undefined;
  onDone: () => void;
}) {
  const save = useSetBrokerCredentials();
  const [fields, setFields] = useState<Record<string, string>>({});
  const wanted = connector?.credentialFields ?? [];
  const complete = wanted.every((field) => (fields[field.key] ?? '').length > 0);

  if (connector === undefined) {
    return (
      <p className="text-[11px] text-terminal-short">
        This build has no connector of kind {row.adapterKind}, so it cannot say what credentials it
        needs.
      </p>
    );
  }

  return (
    <div className="space-y-3" data-testid="broker-credential-form">
      <p className="text-[11px] text-terminal-muted">
        These go to the server once and are sealed there. Nothing sends them back — afterwards this
        screen shows a fingerprint. Setting them revokes whatever this connection was using.
      </p>
      <ErrorLine error={save.error} />
      <div className="grid gap-3 md:grid-cols-3">
        {wanted.map((field) => (
          <Field key={field.key} label={field.label}>
            <input
              className={cn(inputClass, 'py-1 text-xs')}
              type={field.secret ? 'password' : 'text'}
              autoComplete="off"
              value={fields[field.key] ?? ''}
              onChange={(event) =>
                setFields((current) => ({ ...current, [field.key]: event.target.value }))
              }
            />
          </Field>
        ))}
      </div>
      <Button
        onClick={() =>
          save.mutate(
            { id: row.id, kind: kindFor(connector), fields },
            {
              onSuccess: () => {
                setFields({});
                onDone();
              },
            },
          )
        }
        disabled={!complete || save.isPending}
      >
        {save.isPending ? 'Sealing…' : 'Save credentials'}
      </Button>
    </div>
  );
}

/** What kind of credential the connector's fields amount to. */
function kindFor(connector: ConnectorRow): string {
  const keys = new Set(connector.credentialFields.map((field) => field.key));
  if (keys.has('password') && keys.has('server')) return 'LOGIN_PASSWORD_SERVER';
  if (keys.has('certificate')) return 'CERTIFICATE';
  if (keys.has('secret')) return 'API_KEY_SECRET';
  return 'API_TOKEN';
}
