'use client';

import { useState } from 'react';
import { cn } from '@tp/ui';
import { Button, inputClass } from '@/components/primitives';
import {
  useCreateWebhook,
  useDeleteWebhook,
  useReplayWebhookDelivery,
  useRotateWebhookSecret,
  useSetWebhookEnabled,
  useWebhookDeliveries,
  useWebhookEventTypes,
  useWebhooks,
  type WebhookDeliveryRow,
  type WebhookEndpointRow,
} from '@/lib/admin-queries';
import { utcTime } from '@/lib/format';
import { ErrorLine, Head, Loading, Table } from './shared';

/**
 * Where this firm's events are sent (§49).
 *
 * The secret appears exactly once, in the response to registering or
 * rotating, and the panel keeps it on screen until dismissed because the
 * person now has to go and paste it somewhere. After that the platform holds
 * it sealed and shows the last four characters, which is enough to tell two
 * endpoints apart and not enough to sign anything.
 *
 * Nothing here is a control. The server decides who may register an endpoint
 * and refuses addresses it will not call; the panel shows the refusal.
 */
export function WebhooksPanel() {
  const endpoints = useWebhooks();
  const [selected, setSelected] = useState<string | null>(null);
  const [shown, setShown] = useState<{ url: string; secret: string; note: string } | null>(null);

  return (
    <div className="flex flex-col" data-testid="webhooks">
      {shown === null ? null : (
        <div
          className="m-3 space-y-2 rounded border border-terminal-warning/60 bg-terminal-raised p-3"
          data-testid="webhook-secret"
        >
          <p className="text-[11px] text-terminal-warning">
            This is the only time the signing secret for {shown.url} will be shown. Put it in the
            receiver now; the platform keeps it sealed and cannot show it again. {shown.note}
          </p>
          <pre className="whitespace-pre-wrap break-all rounded bg-terminal-bg px-3 py-2 font-mono text-[11px] text-terminal-text">
            {shown.secret}
          </pre>
          <Button variant="ghost" className="px-2 py-0.5" onClick={() => setShown(null)}>
            I have copied it
          </Button>
        </div>
      )}

      <Register onSecret={(url, secret) => setShown({ url, secret, note: '' })} />
      <ErrorLine error={endpoints.error} />
      {endpoints.isLoading ? (
        <Loading />
      ) : (endpoints.data ?? []).length === 0 ? (
        <Loading>No endpoints. Nothing is sent anywhere until one is registered.</Loading>
      ) : (
        <Endpoints
          rows={endpoints.data ?? []}
          selected={selected}
          onSelect={setSelected}
          onSecret={(url, secret, until) =>
            setShown({
              url,
              secret,
              note: `The previous secret keeps signing until ${utcTime(until)}, so the receiver can switch over without dropping anything.`,
            })
          }
        />
      )}
      {selected === null ? null : <Deliveries endpointId={selected} />}
    </div>
  );
}

function Register({ onSecret }: { onSecret: (url: string, secret: string) => void }) {
  const create = useCreateWebhook();
  const types = useWebhookEventTypes();
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [events, setEvents] = useState<string[]>([]);
  const ready = url.trim().length > 0 && description.trim().length > 0;

  return (
    <div className="border-b border-terminal-border px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          className={cn(inputClass, 'w-72 py-1 text-xs')}
          placeholder="https://… — the receiver"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <input
          className={cn(inputClass, 'min-w-48 flex-1 py-1 text-xs')}
          placeholder="What it is for — the back office, the CRM…"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
        <Button
          variant="neutral"
          className="px-2 py-0.5"
          disabled={!ready || create.isPending}
          onClick={() => {
            create.mutate(
              { url: url.trim(), description: description.trim(), events },
              {
                onSuccess: (result) => {
                  onSecret(result.endpoint.url, result.secret);
                  setUrl('');
                  setDescription('');
                  setEvents([]);
                },
              },
            );
          }}
        >
          {create.isPending ? 'Registering…' : 'Register endpoint'}
        </Button>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-terminal-muted">
        <span>Events:</span>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={events.length === 0} onChange={() => setEvents([])} />
          everything, including events added later
        </label>
        {(types.data?.events ?? []).map((type) => (
          <label key={type} className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={events.includes(type)}
              onChange={(event) =>
                setEvents(
                  event.target.checked ? [...events, type] : events.filter((item) => item !== type),
                )
              }
            />
            <span className="font-mono">{type}</span>
          </label>
        ))}
      </div>
      <ErrorLine error={create.error} />
    </div>
  );
}

function Endpoints({
  rows,
  selected,
  onSelect,
  onSecret,
}: {
  rows: WebhookEndpointRow[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  onSecret: (url: string, secret: string, until: string) => void;
}) {
  const toggle = useSetWebhookEnabled();
  const rotate = useRotateWebhookSecret();
  const remove = useDeleteWebhook();
  return (
    <>
      <ErrorLine error={toggle.error ?? rotate.error ?? remove.error} />
      <Table>
        <Head columns={['Receiver', 'For', 'Events', 'Secret', 'State', 'Added', '']} />
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              className={cn(
                'cursor-pointer border-t border-terminal-border/60 align-top',
                selected === row.id ? 'bg-terminal-raised' : '',
                row.enabled ? '' : 'opacity-60',
              )}
              onClick={() => onSelect(selected === row.id ? null : row.id)}
            >
              <td className="px-3 py-1.5 font-mono text-terminal-text">{row.url}</td>
              <td className="px-3 py-1.5 text-terminal-muted">{row.description}</td>
              <td className="px-3 py-1.5 font-mono text-terminal-muted">
                {row.events.length === 0 ? 'all' : row.events.join(', ')}
              </td>
              <td className="px-3 py-1.5 font-mono text-terminal-muted">…{row.secretHint}</td>
              <td className="px-3 py-1.5">
                {row.enabled ? (
                  <span className="text-terminal-success">on</span>
                ) : (
                  <span className="text-terminal-danger" title={row.disabledReason ?? ''}>
                    off
                    {row.disabledReason?.startsWith('switched off by the platform')
                      ? ' — by the platform'
                      : ''}
                  </span>
                )}
                {row.consecutiveFailures > 0 ? (
                  <span className="ml-1 text-[10px] text-terminal-warning">
                    {row.consecutiveFailures} failed in a row
                  </span>
                ) : null}
              </td>
              <td className="numeric px-3 py-1.5 text-terminal-muted">{utcTime(row.createdAt)}</td>
              <td className="px-3 py-1.5" onClick={(event) => event.stopPropagation()}>
                <div className="flex items-center justify-end gap-1">
                  <Button
                    variant="ghost"
                    className="px-2 py-0.5"
                    disabled={toggle.isPending}
                    onClick={() => toggle.mutate({ id: row.id, enabled: !row.enabled })}
                  >
                    {row.enabled ? 'Turn off' : 'Turn on'}
                  </Button>
                  <Button
                    variant="ghost"
                    className="px-2 py-0.5"
                    disabled={rotate.isPending}
                    onClick={() =>
                      rotate.mutate(
                        { id: row.id },
                        {
                          onSuccess: (result) =>
                            onSecret(row.url, result.secret, result.previousSecretValidUntil),
                        },
                      )
                    }
                  >
                    Rotate secret
                  </Button>
                  <Button
                    variant="danger"
                    className="px-2 py-0.5"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate({ id: row.id })}
                  >
                    Remove
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </>
  );
}

const STATUS_TONE: Record<WebhookDeliveryRow['status'], string> = {
  PENDING: 'text-terminal-muted',
  DELIVERED: 'text-terminal-success',
  FAILED: 'text-terminal-warning',
  EXHAUSTED: 'text-terminal-danger',
};

function Deliveries({ endpointId }: { endpointId: string }) {
  const deliveries = useWebhookDeliveries(endpointId);
  const replay = useReplayWebhookDelivery();
  const rows = deliveries.data ?? [];
  return (
    <div className="border-t border-terminal-border" data-testid="webhook-deliveries">
      <div className="flex items-center justify-between px-3 py-1.5 text-[10px] uppercase tracking-wide text-terminal-muted">
        <span>Deliveries, newest first</span>
        <span>{rows.length}</span>
      </div>
      <ErrorLine error={deliveries.error ?? replay.error} />
      {deliveries.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Loading>Nothing has been sent to this endpoint yet.</Loading>
      ) : (
        <Table>
          <Head columns={['When', 'Event', 'State', 'Attempts', 'Receiver said', 'Took', '']} />
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-terminal-border/60 align-top">
                <td className="numeric px-3 py-1.5 text-terminal-muted">
                  {utcTime(row.createdAt)}
                </td>
                <td className="px-3 py-1.5 font-mono">
                  {row.eventType}
                  {row.replayOfId !== null ? (
                    <span className="ml-1 text-[10px] text-terminal-muted">(replay)</span>
                  ) : null}
                </td>
                <td className={cn('px-3 py-1.5', STATUS_TONE[row.status])}>
                  {row.status.toLowerCase()}
                  {row.status === 'FAILED' && row.nextAttemptAt !== null ? (
                    <span className="ml-1 text-[10px] text-terminal-muted">
                      next {utcTime(row.nextAttemptAt)}
                    </span>
                  ) : null}
                </td>
                <td className="numeric px-3 py-1.5 text-terminal-muted">{row.attempts}</td>
                <td className="px-3 py-1.5 text-terminal-muted">
                  {row.responseStatus !== null ? (
                    <span className="numeric">{row.responseStatus} </span>
                  ) : null}
                  {row.lastError ?? (row.responseBody ? row.responseBody.slice(0, 80) : '')}
                </td>
                <td className="numeric px-3 py-1.5 text-terminal-muted">
                  {row.durationMs !== null ? `${row.durationMs} ms` : '—'}
                </td>
                <td className="px-3 py-1.5 text-right">
                  <Button
                    variant="ghost"
                    className="px-2 py-0.5"
                    disabled={replay.isPending}
                    onClick={() => replay.mutate({ id: row.id })}
                  >
                    Send again
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
